import assert from "node:assert/strict";
import test from "node:test";
import {
  AccountLayout, MintLayout, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  decodeBurnCheckedInstruction, decodeCloseAccountInstruction,
  createCloseAccountInstruction,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram, PublicKey, SystemInstruction, SystemProgram,
  Transaction, TransactionInstruction, type Connection,
} from "@solana/web3.js";
import { LIGHTHOUSE_NOOP, LIGHTHOUSE_PROGRAM, MAX_WALLET_ASSERTIONS, validateWalletInstructions } from "@workspace/reclaim-policy";
import {
  assertReturnedTransactionFits, assertUnsignedWalletHandoff, MAX_TRANSACTION_BYTES,
  measureAssertionHeadroom, transactionWireBytes, WalletTransactionSizeError,
} from "./transaction-limits";
import { feeForGross, GENESIS_HASHES, prepareQuote, scanWallet } from "./wallet";
import { signAndBroadcast } from "./wallet-signing";

// Public deterministic fixtures only. No private keys or cryptographic signing.
const key = (value: number) => {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(value);
  bytes[31] = 99;
  return new PublicKey(bytes);
};
const owner = key(1);
const treasury = new PublicKey("EyoFvN7FTCibPpxA2SJRqHqQnw7eTbiwq57gm4aAGbe4");
const blockhash = key(2).toBase58();
const clone = (tx: Transaction) => new Transaction({ feePayer: tx.feePayer, recentBlockhash: tx.recentBlockhash })
  .add(...tx.instructions.map((ix) => new TransactionInstruction({
    programId: ix.programId, keys: ix.keys.map((meta) => ({ ...meta })), data: Buffer.from(ix.data),
  })));
function guard(target = owner, logging = true) {
  return new TransactionInstruction({
    programId: new PublicKey(LIGHTHOUSE_PROGRAM),
    keys: [
      { pubkey: target, isSigner: false, isWritable: false },
      ...(logging ? [{ pubkey: new PublicKey(LIGHTHOUSE_NOOP), isSigner: false, isWritable: false }] : []),
    ],
    data: Buffer.from([6, logging ? 3 : 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4]),
  });
}
function prepared() {
  return new Transaction({ feePayer: owner, recentBlockhash: blockhash }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
    createCloseAccountInstruction(key(3), owner, owner, [], TOKEN_2022_PROGRAM_ID),
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: treasury, lamports: 367_070 }),
  );
}
const policy = (tx: Transaction) => tx.instructions.map((ix) => ({
  program: ix.programId.toBase58(), accounts: ix.keys.map((meta) => meta.pubkey.toBase58()), data: ix.data,
}));
function envelope(tx: Transaction) {
  const result = clone(tx);
  for (let i = 0; i < MAX_WALLET_ASSERTIONS; i++) result.add(guard(tx.feePayer!));
  return result;
}
function padded(bytes: number) {
  const tx = new Transaction({ feePayer: owner, recentBlockhash: blockhash }).add(
    new TransactionInstruction({ programId: key(10), keys: [], data: Buffer.alloc(0) }),
  );
  for (let length = 0; length < 1_500; length++) {
    tx.instructions[0]!.data = Buffer.alloc(length);
    if (transactionWireBytes(tx) === bytes) return tx;
  }
  throw new Error(`No fixture of ${bytes} bytes`);
}
const noNetwork = (events: string[]) => new Proxy({}, {
  get: (_target, name) => async () => {
    events.push(String(name));
    throw new Error(`Unexpected network operation: ${String(name)}`);
  },
}) as Connection;
const compatibility = {
  quotedNetworkFeeLamports: 5_050n, lastValidBlockHeight: 500,
  approveNetworkFee: async () => { assert.fail("must not request fee review"); },
};

test("wire measurement matches SDK including signatures, short-vector boundaries and additional keys", () => {
  for (const dataLength of [0, 127, 128, 512]) {
    for (const signatures of [1, 2, 4]) {
      const tx = new Transaction({ feePayer: owner, recentBlockhash: blockhash }).add(new TransactionInstruction({
        programId: key(10),
        keys: Array.from({ length: signatures - 1 }, (_, i) => ({
          pubkey: key(20 + i), isSigner: true, isWritable: false,
        })),
        data: Buffer.alloc(dataLength),
      }));
      assert.equal(tx.compileMessage().header.numRequiredSignatures, signatures);
      assert.equal(transactionWireBytes(tx), tx.serialize({ verifySignatures: false, requireAllSignatures: false }).length);
      assert.equal(transactionWireBytes(tx) - tx.serializeMessage().length, 1 + 64 * signatures);
    }
  }
  const manyInstructions = new Transaction({ feePayer: owner, recentBlockhash: blockhash });
  for (let i = 0; i < 128; i++) manyInstructions.add(new TransactionInstruction({ programId: key(10), keys: [], data: Buffer.alloc(0) }));
  assert.equal(transactionWireBytes(manyInstructions), manyInstructions.serialize({ verifySignatures: false, requireAllSignatures: false }).length);
  const crossingCount = new Transaction({ feePayer: owner, recentBlockhash: blockhash });
  for (let i = 0; i < 127; i++) crossingCount.add(new TransactionInstruction({ programId: key(10), keys: [], data: Buffer.alloc(0) }));
  assert.equal(measureAssertionHeadroom(crossingCount).reservedBytes, 209, "instruction-count short vector must grow too");
  assert.equal(measureAssertionHeadroom(crossingCount).withAssertionsBytes, envelope(crossingCount).serialize({ verifySignatures: false, requireAllSignatures: false }).length);
  const tx = prepared();
  const before = tx.serializeMessage().toString("hex");
  const measured = measureAssertionHeadroom(tx);
  const protectedTx = envelope(tx);
  assert.equal(measured.withAssertionsBytes, protectedTx.serialize({ verifySignatures: false, requireAllSignatures: false }).length);
  assert.equal(measured.reservedBytes, 208); // 64 new key bytes + eight 18-byte instructions.
  assert.equal(protectedTx.compileMessage().accountKeys.length - tx.compileMessage().accountKeys.length, 2);
  assert.equal(tx.serializeMessage().toString("hex"), before, "measurement must not insert actual assertions");
  assert.equal(tx.instructions.length, 4);
  validateWalletInstructions(policy(tx), policy(protectedTx));
  console.log(`Measured compact assertion envelope: ${measured.reservedBytes} bytes (8 assertions, 2 additional program keys).`);
});

test("exact packet and measured-headroom boundaries reject only above the limits", () => {
  for (const size of [1_231, 1_232, 1_233]) {
    const tx = padded(size);
    assert.equal(transactionWireBytes(tx), size);
    if (size <= MAX_TRANSACTION_BYTES) assert.doesNotThrow(() => assertReturnedTransactionFits(tx));
    else assert.throws(() => assertReturnedTransactionFits(tx), WalletTransactionSizeError);
  }
  for (const base of [1_023, 1_024, 1_025]) {
    const measurement = measureAssertionHeadroom(padded(base));
    assert.equal(measurement.withAssertionsBytes, base + 208);
    assert.equal(measurement.withAssertionsBytes <= MAX_TRANSACTION_BYTES, base <= 1_024);
  }
});

test("unsigned handoff rejects existing signatures, supplemental signers and extra required signer slots before approval", async () => {
  const variants = [
    () => { const tx = prepared(); tx.signatures = [{ publicKey: owner, signature: Buffer.alloc(64, 1) }]; return tx; },
    () => { const tx = prepared(); tx.instructions[2]!.keys.push({ pubkey: key(20), isSigner: true, isWritable: false }); return tx; },
  ];
  assert.doesNotThrow(() => assertUnsignedWalletHandoff(prepared()));
  assert.throws(() => assertUnsignedWalletHandoff(prepared(), [{}]), /unsigned transaction/);
  for (const make of variants) {
    const events: string[] = [];
    await assert.rejects(signAndBroadcast({
      transaction: make(), connection: noNetwork(events), requireUnsigned: true,
      signTransaction: async () => { assert.fail("wallet must not be invoked"); },
      beforeBroadcast: () => { assert.fail("must not persist"); },
    }), /unsigned transaction/);
    assert.deepEqual(events, []);
  }
});

test("oversized wallet return stops before serialization, persistence or any network call and requests new review", async () => {
  const events: string[] = [];
  const returned = prepared();
  for (let i = 0; i < 8; i++) returned.add(guard());
  // Valid wire layout: Multi with many repeated lamport assertions (not padding).
  returned.instructions[4]!.data = Buffer.from([6, 3, 49, ...Array.from({ length: 49 }, () => [0, 0, 0, 0, 0, 0, 0, 0, 0, 4]).flat()]);
  returned.instructions[5]!.data = Buffer.from(returned.instructions[4]!.data);
  validateWalletInstructions(policy(prepared()), policy(returned));
  assert.ok(transactionWireBytes(returned) > MAX_TRANSACTION_BYTES);
  returned.serialize = () => { assert.fail("oversized return must be measured before SDK serialization"); };
  await assert.rejects(signAndBroadcast({
    transaction: prepared(), connection: noNetwork(events), compatibility,
    signTransaction: async () => returned, // Synthetic unsigned return; no signing performed.
    beforeBroadcast: () => { assert.fail("must not persist"); },
  }), (error: unknown) => {
    assert.ok(error instanceof WalletTransactionSizeError);
    assert.match(error.message, /Nothing was broadcast.*review a new, smaller transaction/);
    return true;
  });
  assert.equal(returned.instructions.length, 12, "must not strip security checks");
  assert.deepEqual(events, []);
});

test("all existing unsafe instruction/permission changes remain blocked with zero network calls", async () => {
  const mutations: [string, (tx: Transaction) => void][] = [
    ["treasury", (tx) => { tx.instructions[3]!.keys[1]!.pubkey = key(50); }],
    ["amount", (tx) => { tx.instructions[3]!.data[4]! ^= 1; }],
    ["close destination", (tx) => { tx.instructions[2]!.keys[1]!.pubkey = treasury; }],
    ["close authority", (tx) => { tx.instructions[2]!.keys[2]!.pubkey = treasury; }],
    ["permission", (tx) => { tx.instructions[3]!.keys[1]!.isWritable = false; }],
    ["payer", (tx) => { tx.feePayer = treasury; }],
    ["blockhash", (tx) => { tx.recentBlockhash = key(51).toBase58(); }],
    ["removed close", (tx) => { tx.instructions.splice(2, 1); }],
    ["extra transfer", (tx) => { tx.add(SystemProgram.transfer({ fromPubkey: owner, toPubkey: treasury, lamports: 1 })); }],
    ["unknown program", (tx) => { tx.instructions[4]!.programId = key(52); }],
    ["unknown target", (tx) => { tx.instructions[4]!.keys[0]!.pubkey = key(53); }],
    ["assertion writable logger", (tx) => { tx.instructions[4]!.keys[1]!.isWritable = true; }],
    ["assertion signer", (tx) => { tx.instructions[4]!.keys[0]!.isSigner = true; tx.instructions[4]!.keys[1]!.isSigner = true; }],
    ["memory write", (tx) => { tx.instructions[4]!.data[0] = 0; }],
    ["memory close", (tx) => { tx.instructions[4]!.data[0] = 1; }],
    ["delta", (tx) => { tx.instructions[4]!.data[0] = 4; }],
    ["logging enum", (tx) => { tx.instructions[4]!.data[1] = 255; }],
    ["too many assertions", (tx) => { for (let i = 0; i < 8; i++) tx.add(guard(owner, false)); }],
    ["oversized assertion", (tx) => { tx.instructions[4]!.data = Buffer.alloc(513, 6); }],
    ["assertion before close", (tx) => { const assertion = tx.instructions.pop()!; tx.instructions.splice(2, 0, assertion); }],
    ["budget cost", (tx) => { tx.instructions[1] = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000_000 }); }],
    ["duplicate budget", (tx) => { tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 })); }],
  ];
  for (const [name, mutate] of mutations) {
    const events: string[] = [];
    await assert.rejects(signAndBroadcast({
      transaction: prepared(), connection: noNetwork(events), compatibility,
      signTransaction: async (tx) => { const returned = clone(tx).add(guard()); mutate(returned); return returned; },
      beforeBroadcast: () => { assert.fail("must not persist"); },
    }), undefined, name);
    assert.deepEqual(events, [], name);
  }
});

test("valid assertions reach unchanged signature verification; missing/invalid signatures never reach RPC", async () => {
  for (const invalid of [false, true]) {
    const events: string[] = [];
    await assert.rejects(signAndBroadcast({
      transaction: prepared(), connection: noNetwork(events), compatibility,
      signTransaction: async (tx) => {
        const returned = clone(tx).add(guard());
        if (invalid) returned.signatures = [{ publicKey: owner, signature: Buffer.alloc(64, 1) }];
        return returned;
      },
      beforeBroadcast: () => { assert.fail("must not persist"); },
    }), /Signature verification failed/);
    assert.deepEqual(events, []);
  }
});

function fixtureConnection(programMode: "SPL" | "Token-2022" | "mixed", kind: "close" | "burn" | "mixed") {
  const infos = new Map<string, { data: Buffer; owner: PublicKey; executable: boolean; lamports: number; rentEpoch: number }>();
  const tokenAccounts: { pubkey: PublicKey; account: ReturnType<typeof infos.get> & {} }[] = [];
  for (let i = 0; i < 24; i++) {
    const program = programMode === "SPL" || (programMode === "mixed" && i % 2 === 0) ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
    const mint = key(1_000 + i);
    const pubkey = key(2_000 + i);
    const amount = kind === "burn" || (kind === "mixed" && i % 3 === 0) ? 100_000_000n : 0n;
    const mintData = Buffer.alloc(MintLayout.span);
    MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 100_000_000n, decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, mintData);
    infos.set(mint.toBase58(), { data: mintData, owner: program, executable: false, lamports: 1_461_600, rentEpoch: 0 });
    const data = Buffer.alloc(AccountLayout.span);
    AccountLayout.encode({ mint, owner, amount, delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
    tokenAccounts.push({ pubkey, account: { data, owner: program, executable: false, lamports: 2_039_280, rentEpoch: 0 } });
  }
  return {
    getGenesisHash: async () => GENESIS_HASHES["mainnet-beta"],
    getTokenAccountsByOwner: async (_owner: PublicKey, filter: { programId: PublicKey }) => ({
      value: tokenAccounts.filter(({ account }) => account.owner.equals(filter.programId)),
    }),
    getMultipleAccountsInfo: async (addresses: PublicKey[]) => addresses.map((address) => infos.get(address.toBase58()) ?? null),
    getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 500 }),
    // Stubbed arithmetic only: no Solana Connection or network simulation.
    simulateTransaction: async (tx: Transaction) => {
      assert.ok(measureAssertionHeadroom(tx).withAssertionsBytes <= MAX_TRANSACTION_BYTES);
      return { value: { err: null, unitsConsumed: 10_000 } };
    },
    getFeeForMessage: async () => ({ value: 5_050 }),
    getBalance: async () => 1_000_000,
  } as unknown as Connection;
}

for (const program of ["SPL", "Token-2022", "mixed"] as const) {
  for (const kind of ["close", "burn", "mixed"] as const) {
    test(`production quote builder: ${program} ${kind} selections split safely and preserve intent`, async () => {
      const connection = fixtureConnection(program, kind);
      const accounts = await scanWallet(connection, owner.toBase58());
      // scanWallet returns program-grouped accounts. Restore alternating fixture
      // order so "mixed" genuinely exercises both programs within each batch.
      accounts.sort((a, b) => new PublicKey(a.pubkey).toBuffer().readUInt32LE() - new PublicKey(b.pubkey).toBuffer().readUInt32LE());
      const quote = await prepareQuote({
        connection, network: "mainnet-beta", walletAddress: owner.toBase58(),
        treasuryAddress: treasury.toBase58(), serviceFeeBps: 1_800,
        selected: accounts.map((account) => ({ account, burn: !account.isEmpty })),
      });
      assert.equal(accounts.length, 24);
      assert.deepEqual(quote.batches.flatMap((batch) => batch.accountPubkeys).sort(), accounts.map((account) => account.pubkey).sort());
      for (const batch of quote.batches) {
        assert.ok(batch.accountPubkeys.length <= 12);
        assertUnsignedWalletHandoff(batch.transaction);
        assert.ok(measureAssertionHeadroom(batch.transaction).withAssertionsBytes <= MAX_TRANSACTION_BYTES);
        assert.equal(batch.serializedBytes, transactionWireBytes(batch.transaction));
        const protectedTx = envelope(batch.transaction);
        assertReturnedTransactionFits(protectedTx);
        if (program === "mixed") {
          assert.ok(batch.transaction.instructions.some((ix) => ix.programId.equals(TOKEN_PROGRAM_ID)));
          assert.ok(batch.transaction.instructions.some((ix) => ix.programId.equals(TOKEN_2022_PROGRAM_ID)));
        }
        validateWalletInstructions(policy(batch.transaction), policy(protectedTx));
        assert.equal(protectedTx.serialize({ verifySignatures: false, requireAllSignatures: false }).length, transactionWireBytes(protectedTx));
        const transfer = SystemInstruction.decodeTransfer(batch.transaction.instructions.at(-1)!);
        assert.ok(transfer.toPubkey.equals(treasury));
        assert.ok(transfer.fromPubkey.equals(owner));
        assert.equal(transfer.lamports, feeForGross(batch.grossLamports, 1_800));
        assert.equal(transfer.lamports, batch.feeLamports);
        for (const address of batch.accountPubkeys) {
          const account = accounts.find((candidate) => candidate.pubkey === address)!;
          const instructions = batch.transaction.instructions.filter((ix) => ix.keys[0]?.pubkey.toBase58() === address);
          assert.equal(instructions.length, account.isEmpty ? 1 : 2);
          const close = decodeCloseAccountInstruction(instructions.at(-1)!, new PublicKey(account.programId));
          assert.ok(close.keys.destination.pubkey.equals(owner));
          assert.ok(close.keys.authority.pubkey.equals(owner));
          if (!account.isEmpty) {
            const burn = decodeBurnCheckedInstruction(instructions[0]!, new PublicKey(account.programId));
            assert.equal(burn.data.amount, account.tokenAmount);
            assert.equal(burn.keys.mint.pubkey.toBase58(), account.mint);
            // Unsafe changes to burns still fail the exact-intent policy.
            const changed = clone(batch.transaction);
            changed.instructions.find((ix) => ix.data[0] === 15)!.data[1]! ^= 1;
            assert.throws(() => validateWalletInstructions(policy(batch.transaction), policy(changed)), /reviewed reclaim instruction/);
          }
        }
      }
      console.log(`${program}/${kind}: 24 accounts -> ${quote.batches.map((batch) => `${batch.accountPubkeys.length} accounts/${batch.serializedBytes}+${measureAssertionHeadroom(batch.transaction).reservedBytes} bytes`).join(", ")}`);
    });
  }
}
