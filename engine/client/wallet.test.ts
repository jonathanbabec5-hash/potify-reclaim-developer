import assert from "node:assert/strict";
import { createPrivateKey, sign as signEd25519 } from "node:crypto";
import test from "node:test";
import bs58 from "bs58";
import { AccountLayout, MintLayout, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ExtensionType, decodeBurnCheckedInstruction } from "@solana/spl-token";
import { PublicKey, SystemInstruction, Keypair, Message, Transaction, TransactionInstruction, SystemProgram, ComputeBudgetProgram, ComputeBudgetInstruction, type Connection } from "@solana/web3.js";
import {
  evaluateAccountSafety,
  feeForGross,
  fmtSol,
  partitionSelections,
  quoteFingerprint,
  type ReclaimQuote,
  scanWallet,
  prepareQuote,
  assertRpcNetwork,
  GENESIS_HASHES,
} from "./wallet";
import { absentAfterExpiry, signatureState } from "./transaction-status";
import { signAndBroadcast, WalletReviewError } from "./wallet-signing";

test("calculates the 18% service fee with integer lamports", () => {
  assert.equal(feeForGross(2_039_280n, 1_800), 367_070n);
  assert.equal(feeForGross(1n, 1_800), 0n);
  assert.equal(fmtSol(1_234_567_890n), "1.234567");
});

test("partitions selections without dropping or duplicating entries", () => {
  const groups = partitionSelections([1, 2, 3, 4, 5], 2);
  assert.deepEqual(groups, [[1, 2], [3, 4], [5]]);
  assert.deepEqual(groups.flat(), [1, 2, 3, 4, 5]);
});

test("processed signatures do not unlock a replacement transaction", () => {
  assert.equal(signatureState({ slot: 1, confirmations: 0, err: null, confirmationStatus: "processed" }), "pending");
  assert.equal(signatureState({ slot: 1, confirmations: 1, err: null, confirmationStatus: "confirmed" }), "confirmed");
  assert.equal(signatureState(null), "pending");
  assert.equal(signatureState({ slot: 1, confirmations: 1, err: "AccountNotFound", confirmationStatus: "processed" }), "failed");
  assert.equal(absentAfterExpiry(null, 101, 100), true);
  assert.equal(absentAfterExpiry(null, 100, 100), false);
  assert.equal(absentAfterExpiry({ slot: 1, confirmations: 0, err: null, confirmationStatus: "processed" }, 101, 100), false);
});

test("refreshed quotes need new review only when their financial consequences change", () => {
  const base = {
    walletAddress: "wallet",
    treasuryAddress: "treasury",
    grossLamports: 1_000_000n,
    feeLamports: 180_000n,
    networkFeeLamports: 5_000n,
    netLamports: 815_000n,
    quotedAt: 1,
    batches: [{
      accountPubkeys: ["account"],
      grossLamports: 1_000_000n, feeLamports: 180_000n, networkFeeLamports: 5_000n,
      serializedBytes: 400, computeUnits: 10_000, blockhash: "old",
    }],
  } as ReclaimQuote;
  const refreshed = {
    ...base, quotedAt: 1_000_000,
    batches: base.batches.map((batch) => ({ ...batch, computeUnits: 10_100, blockhash: "new" })),
  };
  assert.equal(quoteFingerprint(base), quoteFingerprint(refreshed));
  assert.notEqual(quoteFingerprint(base), quoteFingerprint({ ...refreshed, feeLamports: 190_000n }));
  assert.notEqual(quoteFingerprint(base), quoteFingerprint({ ...refreshed, treasuryAddress: "other-treasury" }));
});

test("requires the connected wallet to be the effective close authority", () => {
  const eligible = evaluateAccountSafety({
    connectedOwner: "wallet",
    tokenOwner: "wallet",
    closeAuthority: null,
    frozen: false,
    initialized: true,
    wrappedSol: false,
    extensionTypes: [],
    withheldAmount: 0n,
    amount: 0n,
    mintSupported: true,
  });
  assert.equal(eligible.closeEligible, true);
  assert.equal(eligible.burnEligible, false);

  const delegatedElsewhere = evaluateAccountSafety({
    connectedOwner: "wallet",
    tokenOwner: "wallet",
    closeAuthority: "another-wallet",
    frozen: false,
    initialized: true,
    wrappedSol: false,
    extensionTypes: [],
    withheldAmount: 0n,
    amount: 0n,
    mintSupported: true,
  });
  assert.equal(delegatedElsewhere.closeEligible, false);
});

test("excludes frozen, wrapped SOL, withheld fees and unsafe extensions", () => {
  const base = {
    connectedOwner: "wallet",
    tokenOwner: "wallet",
    closeAuthority: null,
    initialized: true,
    extensionTypes: [] as ExtensionType[],
    amount: 5n,
    mintSupported: true,
  };
  assert.equal(evaluateAccountSafety({ ...base, frozen: true, wrappedSol: false, withheldAmount: 0n }).burnEligible, false);
  assert.equal(evaluateAccountSafety({ ...base, frozen: false, wrappedSol: true, withheldAmount: 0n }).burnEligible, false);
  assert.equal(evaluateAccountSafety({ ...base, frozen: false, wrappedSol: false, withheldAmount: 1n }).burnEligible, false);
  assert.equal(
    evaluateAccountSafety({
      ...base,
      frozen: false,
      wrappedSol: false,
      withheldAmount: 0n,
      extensionTypes: [ExtensionType.ConfidentialTransferAccount],
    }).burnEligible,
    false,
  );
});

test("mainnet quote atomically burns/closes selected accounts and transfers exactly 18% to the community treasury", async () => {
  const ownerSigner = Keypair.generate();
  const owner = ownerSigner.publicKey;
  const treasury = new PublicKey("EyoFvN7FTCibPpxA2SJRqHqQnw7eTbiwq57gm4aAGbe4");
  const mint = new PublicKey(Buffer.alloc(32, 12));
  const mintData = Buffer.alloc(MintLayout.span);
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 100_000_000n, decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, mintData);
  const info = (program: PublicKey, amount: bigint) => {
    const data = Buffer.alloc(AccountLayout.span);
    AccountLayout.encode({ mint, owner, amount, delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
    return { data, owner: program, executable: false, lamports: 2_039_280, rentEpoch: 0 };
  };
  const connection = {
    getGenesisHash: async () => GENESIS_HASHES["mainnet-beta"],
    getTokenAccountsByOwner: async (_owner: PublicKey, filter: { programId: PublicKey }) => ({
      value: [{ pubkey: new PublicKey(Buffer.alloc(32, filter.programId.equals(TOKEN_PROGRAM_ID) ? 13 : 14)), account: info(filter.programId, filter.programId.equals(TOKEN_PROGRAM_ID) ? 0n : 100_000_000n) }],
    }),
    getMultipleAccountsInfo: async () => [{ data: mintData, owner: TOKEN_2022_PROGRAM_ID, executable: false, lamports: 1_461_600, rentEpoch: 0 }],
    getLatestBlockhash: async () => ({ blockhash: mint.toBase58(), lastValidBlockHeight: 500 }),
    simulateTransaction: async () => ({ value: { err: null, unitsConsumed: 10_000 } }),
    getFeeForMessage: async (message: Message) => {
      const instructions = Transaction.populate(message).instructions;
      const { units } = ComputeBudgetInstruction.decodeSetComputeUnitLimit(instructions[0]!);
      const { microLamports } = ComputeBudgetInstruction.decodeSetComputeUnitPrice(instructions[1]!);
      return { value: 5_000 + Number((BigInt(units) * microLamports + 999_999n) / 1_000_000n) };
    },
    getBalance: async () => 1_000_000,
  } as unknown as Connection;
  const accounts = await scanWallet(connection, owner.toBase58());
  const selected = accounts.map((account) => ({ account, burn: !account.isEmpty }));
  const quote = await prepareQuote({ connection, network: "mainnet-beta", walletAddress: owner.toBase58(), treasuryAddress: treasury.toBase58(), serviceFeeBps: 1800, selected });
  assert.equal(quote.batches.length, 1);
  assert.equal(quote.grossLamports, 4_078_560n);
  assert.equal(quote.feeLamports, 734_140n);
  assert.equal(quote.networkFeeLamports, 5_050n);
  assert.equal(quote.netLamports, 3_339_370n);
  const instructions = quote.batches[0]!.transaction.instructions;
  assert.equal(instructions.length, 6);
  assert.equal(ComputeBudgetInstruction.decodeSetComputeUnitLimit(instructions[0]!).units, 50_000);
  assert.equal(ComputeBudgetInstruction.decodeSetComputeUnitPrice(instructions[1]!).microLamports, 1_000n);
  assert.ok(instructions[2]!.programId.equals(TOKEN_PROGRAM_ID));
  assert.equal(decodeBurnCheckedInstruction(instructions[3]!, TOKEN_2022_PROGRAM_ID).data.amount, 100_000_000n);
  assert.ok(instructions[4]!.programId.equals(TOKEN_2022_PROGRAM_ID));
  const transfer = SystemInstruction.decodeTransfer(instructions[5]!);
  assert.ok(transfer.fromPubkey.equals(owner));
  assert.ok(transfer.toPubkey.equals(treasury));
  assert.equal(transfer.lamports, 734_140n);
  assert.ok(quote.batches[0]!.transaction.feePayer!.equals(owner));
  let saved = false;
  const confirmedSignature = await signAndBroadcast({
    transaction: quote.batches[0]!.transaction,
    signTransaction: async (tx) => {
      // Model a wallet supplying defaults only when the dapp omitted its budget.
      if (!tx.instructions.some((instruction) => instruction.programId.equals(ComputeBudgetProgram.programId))) {
        tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }));
      }
      assert.equal(tx.instructions.length, 6, "wallet must receive an explicit, already-quoted budget");
      const wire = tx.serialize({ verifySignatures: false, requireAllSignatures: false });
      const parsed = Transaction.from(wire);
      parsed.sign(ownerSigner);
      return Transaction.from(parsed.serialize());
    },
    beforeBroadcast: () => { saved = true; },
    connection: { sendRawTransaction: async (raw) => {
      assert.equal(saved, true);
      const signed = Transaction.from(raw);
      assert.equal(signed.instructions.length, 6);
      assert.equal(SystemInstruction.decodeTransfer(signed.instructions[5]!).lamports, 734_140n);
      return bs58.encode(signed.signature!);
    } },
  });
  assert.match(confirmedSignature, /^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
  const changed = selected.map((selection) => ({ ...selection, account: { ...selection.account, tokenAmount: 1n } }));
  await assert.rejects(prepareQuote({ connection, network: "mainnet-beta", walletAddress: owner.toBase58(), treasuryAddress: treasury.toBase58(), serviceFeeBps: 1800, selected: changed }), /account changed/i);
});

test("wrong-network RPCs are rejected before preparing wallet approval", async () => {
  await assert.rejects(assertRpcNetwork({ getGenesisHash: async () => GENESIS_HASHES.devnet }, "mainnet-beta"), /Wrong Solana network/);
  await assertRpcNetwork({ getGenesisHash: async () => GENESIS_HASHES["mainnet-beta"] }, "mainnet-beta");
});

test("wallet approval records its public signature before broadcasting, even if the RPC times out", async () => {
  const signer = Keypair.generate(); // Unfunded ephemeral test signer, never persisted.
  const transaction = new Transaction({ feePayer: signer.publicKey, recentBlockhash: PublicKey.default.toBase58() }).add(
    SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: new PublicKey(Buffer.alloc(32, 42)), lamports: 1 }),
  );
  const calls: string[] = [];
  let signature = "";
  await assert.rejects(signAndBroadcast({
    transaction,
    signTransaction: async (tx) => { calls.push("wallet-approval"); tx.sign(signer); return tx; },
    beforeBroadcast: (value) => { signature = value; calls.push("persist"); },
    connection: { sendRawTransaction: async () => { calls.push("broadcast"); throw new Error("HTTP timeout"); } },
  }), /HTTP timeout/);
  assert.match(signature, /^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
  assert.deepEqual(calls, ["wallet-approval", "persist", "broadcast"]);
});

test("wallet may reorder equivalent account keys without changing the reviewed transaction", async () => {
  const signer = Keypair.generate();
  const recipientA = new PublicKey(Buffer.alloc(32, 42));
  const recipientB = new PublicKey(Buffer.alloc(32, 43));
  const transaction = new Transaction({ feePayer: signer.publicKey, recentBlockhash: PublicKey.default.toBase58() })
    .add(SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: recipientA, lamports: 1 }))
    .add(SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: recipientB, lamports: 2 }));
  const originalMessage = transaction.serializeMessage();
  const calls: string[] = [];
  let savedSignature: string | undefined;
  const returned = await signAndBroadcast({
    transaction,
    signTransaction: async (tx) => {
      calls.push("wallet-approval");
      const message = tx.compileMessage();
      const a = message.accountKeys.findIndex((key) => key.equals(recipientA));
      const b = message.accountKeys.findIndex((key) => key.equals(recipientB));
      assert.ok(a > 0 && b > 0);
      const accountKeys = [...message.accountKeys];
      [accountKeys[a], accountKeys[b]] = [accountKeys[b]!, accountKeys[a]!];
      const remap = (index: number) => index === a ? b : index === b ? a : index;
      const reordered = new Message({
        header: message.header,
        recentBlockhash: message.recentBlockhash,
        accountKeys,
        instructions: message.instructions.map((instruction) => ({
          ...instruction,
          programIdIndex: remap(instruction.programIdIndex),
          accounts: instruction.accounts.map(remap),
        })),
      });
      const privateKey = createPrivateKey({
        key: Buffer.concat([
          Buffer.from("302e020100300506032b657004220420", "hex"),
          signer.secretKey.subarray(0, 32),
        ]),
        format: "der",
        type: "pkcs8",
      });
      const signature = signEd25519(null, reordered.serialize(), privateKey);
      const signed = Transaction.populate(reordered, [bs58.encode(signature)]);
      assert.notDeepEqual(signed.serializeMessage(), originalMessage);
      return signed;
    },
    beforeBroadcast: (signature) => { calls.push("persist"); savedSignature = signature; },
    connection: { sendRawTransaction: async (raw) => {
      calls.push("broadcast");
      const landed = Transaction.from(raw);
      assert.equal(landed.instructions.length, 2);
      assert.equal(SystemInstruction.decodeTransfer(landed.instructions[0]!).lamports, 1n);
      assert.equal(SystemInstruction.decodeTransfer(landed.instructions[1]!).lamports, 2n);
      return bs58.encode(landed.signature!);
    } },
  });
  assert.equal(returned, savedSignature);
  assert.deepEqual(calls, ["wallet-approval", "persist", "broadcast"]);
});

test("a Solflare-style legacy wire round trip preserves the reviewed account permissions", async () => {
  const signer = Keypair.generate();
  const transaction = new Transaction({ feePayer: signer.publicKey, recentBlockhash: PublicKey.default.toBase58() })
    .add(SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: new PublicKey(Buffer.alloc(32, 42)), lamports: 1 }));
  let saved = false;
  let broadcast = false;
  await signAndBroadcast({
    transaction,
    signTransaction: async (tx) => {
      const wire = tx.serialize({ verifySignatures: false, requireAllSignatures: false });
      const parsed = Transaction.from(wire);
      parsed.sign(signer);
      return Transaction.from(parsed.serialize());
    },
    beforeBroadcast: () => { saved = true; },
    connection: { sendRawTransaction: async (raw) => {
      broadcast = true;
      return bs58.encode(Transaction.from(raw).signature!);
    } },
  });
  assert.equal(saved, true);
  assert.equal(broadcast, true);
});

test("wallet changes to fee payer, blockhash, transfers, fees or permissions never broadcast", async () => {
  const signer = Keypair.generate();
  const make = () => new Transaction({ feePayer: signer.publicKey, recentBlockhash: PublicKey.default.toBase58() })
    .add(SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: new PublicKey(Buffer.alloc(32, 42)), lamports: 1 }));
  const cases: { name: string; mutate: (tx: Transaction) => void; reason: RegExp }[] = [
    { name: "fee payer", mutate: (tx) => { tx.feePayer = new PublicKey(Buffer.alloc(32, 44)); }, reason: /fee payer changed/ },
    { name: "blockhash", mutate: (tx) => { tx.recentBlockhash = new PublicKey(Buffer.alloc(32, 45)).toBase58(); }, reason: /validity blockhash changed/ },
    { name: "amount", mutate: (tx) => { tx.instructions[0] = SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: new PublicKey(Buffer.alloc(32, 42)), lamports: 2 }); }, reason: /instruction 1 changed its amount or operation/ },
    { name: "recipient", mutate: (tx) => { tx.instructions[0]!.keys[1]!.pubkey = new PublicKey(Buffer.alloc(32, 46)); }, reason: /instruction 1 changed an account or recipient/ },
    { name: "priority fee", mutate: (tx) => { tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 })); }, reason: /wallet added a compute-budget instruction/ },
    { name: "permissions", mutate: (tx) => { tx.instructions[0]!.keys[1]!.isWritable = false; }, reason: /writable permission changed for/ },
  ];
  for (const { name, mutate, reason } of cases) {
    let persisted = false;
    let broadcast = false;
    await assert.rejects(signAndBroadcast({
      transaction: make(),
      signTransaction: async (tx) => { mutate(tx); return tx; },
      beforeBroadcast: () => { persisted = true; },
      connection: { sendRawTransaction: async () => { broadcast = true; return ""; } },
    }), reason, name);
    assert.equal(persisted, false, name);
    assert.equal(broadcast, false, name);
  }
});

test("a wallet cannot override an explicitly quoted compute-unit price", async () => {
  const signer = Keypair.generate();
  const transaction = new Transaction({ feePayer: signer.publicKey, recentBlockhash: PublicKey.default.toBase58() }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
    SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: PublicKey.default, lamports: 1 }),
  );
  let writes = 0;
  await assert.rejects(signAndBroadcast({
    transaction,
    signTransaction: async (tx) => {
      tx.instructions[1] = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 2_000 });
      return tx;
    },
    beforeBroadcast: () => { writes += 1; },
    connection: { sendRawTransaction: async () => { writes += 1; return ""; } },
  }), /instruction 2 changed its amount or operation/);
  assert.equal(writes, 0);
});

test("inspection-only approval never persists a signature or broadcasts even an unchanged valid transaction", async () => {
  const signer = Keypair.generate();
  const transaction = new Transaction({ feePayer: signer.publicKey, recentBlockhash: PublicKey.default.toBase58() }).add(
    SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: new PublicKey(Buffer.alloc(32, 42)), lamports: 1 }),
  );
  let writes = 0;
  await assert.rejects(signAndBroadcast({
    transaction, inspectOnly: true,
    provider: { wallet: "Solflare", path: "wallet-standard" },
    signTransaction: async (tx) => { tx.sign(signer); return Transaction.from(tx.serialize()); },
    beforeBroadcast: () => { writes += 1; },
    connection: { sendRawTransaction: async () => { writes += 1; return ""; } },
  }), (error: unknown) => {
    assert.ok(error instanceof WalletReviewError);
    assert.equal(error.report.changed, false);
    assert.equal(error.report.mode, "inspect-only");
    assert.equal(error.report.broadcastAttempted, false);
    assert.deepEqual(error.report.provider, { wallet: "Solflare", path: "wallet-standard" });
    assert.deepEqual(error.report.added, []);
    return true;
  });
  assert.equal(writes, 0);
});

test("captures the exact unknown added program without disclosing data, memo, signature or wire transaction", async () => {
  const signer = Keypair.generate();
  const unknown = new PublicKey(Buffer.alloc(32, 77));
  const confidentialData = Buffer.from("arbitrary memo contents must never be copied");
  for (const inspectOnly of [false, true]) {
    const transaction = new Transaction({ feePayer: signer.publicKey, recentBlockhash: PublicKey.default.toBase58() }).add(
      SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: PublicKey.default, lamports: 1 }),
    );
    let writes = 0;
    await assert.rejects(signAndBroadcast({
      transaction, inspectOnly,
      provider: { wallet: "Solflare", path: "solflare-sdk" },
      signTransaction: async (tx) => {
        tx.instructions.unshift(new TransactionInstruction({ programId: unknown, keys: [], data: confidentialData }));
        tx.sign(signer);
        return Transaction.from(tx.serialize());
      },
      beforeBroadcast: () => { writes += 1; },
      connection: { sendRawTransaction: async () => { writes += 1; return ""; } },
    }), (error: unknown) => {
      assert.ok(error instanceof WalletReviewError);
      assert.ok(error.message.includes(unknown.toBase58()));
      assert.equal(error.report.changed, true);
      assert.deepEqual(error.report.added, [{
        index: 1, program: unknown.toBase58(), operation: "unrecognized", accountCount: 0,
      }]);
      assert.deepEqual(error.report.removed, []);
      const exported = JSON.stringify(error.report);
      assert.ok(!exported.includes(confidentialData.toString()));
      assert.ok(!exported.includes(bs58.encode(confidentialData)));
      assert.ok(!exported.includes("signature"));
      assert.ok(!exported.includes("blockhash"));
      return true;
    });
    assert.equal(writes, 0);
  }
});

test("inspection remains non-broadcasting for changed amounts, permissions, removals and invalid signatures", async () => {
  const signer = Keypair.generate();
  const recipient = new PublicKey(Buffer.alloc(32, 42));
  const mutations = [
    (tx: Transaction) => { tx.instructions[0] = SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: recipient, lamports: 2 }); },
    (tx: Transaction) => { tx.instructions[0]!.keys[1]!.isWritable = false; },
    (tx: Transaction) => { tx.instructions.shift(); },
    (_tx: Transaction) => { /* Return without signing. */ },
  ];
  for (const mutate of mutations) {
    let writes = 0;
    const transaction = new Transaction({ feePayer: signer.publicKey, recentBlockhash: PublicKey.default.toBase58() }).add(
      SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: recipient, lamports: 1 }),
    );
    await assert.rejects(signAndBroadcast({
      transaction, inspectOnly: true, signTransaction: async (tx) => { mutate(tx); return tx; },
      beforeBroadcast: () => { writes += 1; },
      connection: { sendRawTransaction: async () => { writes += 1; return ""; } },
    }));
    assert.equal(writes, 0);
  }
});

test("wallet rejection, message mutation, or failed public-record storage prevents broadcasting", async () => {
  const signer = Keypair.generate();
  const make = () => new Transaction({ feePayer: signer.publicKey, recentBlockhash: PublicKey.default.toBase58() }).add(SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: PublicKey.default, lamports: 1 }));
  let writes = 0;
  const connection = { sendRawTransaction: async () => { writes++; return ""; } };
  await assert.rejects(signAndBroadcast({ connection, transaction: make(), signTransaction: async () => { throw new Error("User rejected"); }, beforeBroadcast: () => { throw new Error("should not save"); } }), /User rejected/);
  await assert.rejects(signAndBroadcast({ connection, transaction: make(), signTransaction: async (tx) => { tx.add(SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: PublicKey.default, lamports: 1 })); return tx; }, beforeBroadcast: () => {} }), /changed the reviewed transaction/);
  await assert.rejects(signAndBroadcast({ connection, transaction: make(), signTransaction: async (tx) => { tx.sign(signer); return tx; }, beforeBroadcast: () => { throw new Error("Storage blocked"); } }), /Storage blocked/);
  assert.equal(writes, 0);
});
