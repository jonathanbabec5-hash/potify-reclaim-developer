import assert from "node:assert/strict";
import test from "node:test";
import bs58 from "bs58";
import {
  ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, SystemInstruction, Transaction,
  TransactionInstruction, type Connection, type Message, type VersionedTransaction,
} from "@solana/web3.js";
import { createBurnCheckedInstruction, createCloseAccountInstruction, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { decodeComputeBudget, isLighthouseAssertion, usesNoopLogging, LIGHTHOUSE_PROGRAM, LIGHTHOUSE_NOOP } from "@workspace/reclaim-policy";
import { signAndBroadcast, WalletReviewError } from "./wallet-signing";

const treasury = new PublicKey(Buffer.alloc(32, 40));
const tokenAccount = new PublicKey(Buffer.alloc(32, 41));
const program = new PublicKey(LIGHTHOUSE_PROGRAM);
// Published Borsh layout: AssertAccountInfo(5), Silent(0), Lamports(0),
// u64(0), GreaterThanOrEqual(4). Assertion-only; not a memory instruction.
function guard(owner: PublicKey, tag = 5, logLevel = 0) {
  return new TransactionInstruction({
    programId: program, keys: [{ pubkey: owner, isSigner: false, isWritable: false }],
    // Multi uses a CompactU64 (LEB128) vector count: one assertion = 0x01.
    // clients/js/src/hooked.ts + generated/types/accountInfoAssertion.ts.
    data: Buffer.from([tag, logLevel, ...(tag === 6 ? [1] : []), 0, 0, 0, 0, 0, 0, 0, 0, 0, 4]),
  });
}
function prepared(owner: PublicKey) {
  return new Transaction({ feePayer: owner, recentBlockhash: PublicKey.default.toBase58() }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
    createCloseAccountInstruction(tokenAccount, owner, owner, [], TOKEN_2022_PROGRAM_ID),
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: treasury, lamports: 180_000 }),
  );
}
function walletResult(tx: Transaction, owner: PublicKey, sameFee = false) {
  tx.instructions[0] = ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 });
  tx.instructions[1] = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: sameFee ? 500 : 100_000 });
  tx.add(guard(owner));
}
function connection(events: string[], overrides: Record<string, unknown> = {}) {
  return {
    getFeeForMessage: async (message: Message) => {
      events.push("estimate");
      const instructions = Transaction.populate(message).instructions.slice(0, 2).map((instruction) => ({
        program: instruction.programId.toBase58(), accounts: [], data: instruction.data,
      }));
      return { value: 5_000 + Number(decodeComputeBudget(instructions).priorityLamports) };
    },
    simulateTransaction: async (tx: VersionedTransaction, config: { sigVerify: boolean }) => {
      events.push("simulate");
      assert.equal(config.sigVerify, true);
      assert.equal(Transaction.from(tx.serialize()).verifySignatures(), true);
      return { value: { err: null, unitsConsumed: 20_000 } };
    },
    getBlockHeight: async () => { events.push("height"); return 100; },
    sendRawTransaction: async (raw: Uint8Array) => {
      events.push("broadcast");
      const tx = Transaction.from(raw);
      assert.equal(tx.instructions.length, 5);
      assert.equal(tx.instructions[2]!.programId.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58());
      assert.equal(SystemInstruction.decodeTransfer(tx.instructions[3]!).lamports, 180_000n);
      assert.equal(SystemInstruction.decodeTransfer(tx.instructions[3]!).toPubkey.toBase58(), treasury.toBase58());
      assert.equal(tx.verifySignatures(), true);
      return bs58.encode(tx.signature!);
    },
    ...overrides,
  } as unknown as Connection;
}
function compatibility(approveNetworkFee: (fee: bigint) => Promise<void>) {
  return { quotedNetworkFeeLamports: 5_050n, lastValidBlockHeight: 500, approveNetworkFee };
}

test("reproduces reported wallet-standard 4→5 shape: replaced budgets and Lighthouse suffix, with explicit revised-return gating", async () => {
  const owner = Keypair.generate(); // Unfunded, test-only; never persisted or sent to RPC.
  const events: string[] = [];
  let release!: () => void;
  let reached!: () => void;
  const approval = new Promise<void>((resolve) => { release = resolve; });
  const reviewing = new Promise<void>((resolve) => { reached = resolve; });
  let returned: Transaction | undefined;
  const result = signAndBroadcast({
    transaction: prepared(owner.publicKey), connection: connection(events),
    signTransaction: async (tx) => {
      walletResult(tx, owner.publicKey);
      tx.sign(owner);
      returned = tx;
      return tx;
    },
    provider: { wallet: "Solflare", path: "wallet-standard" },
    compatibility: compatibility(async (fee) => {
      assert.equal(fee, 15_000n);
      assert.equal(1_000_000n - 180_000n - fee, 805_000n);
      events.push("review");
      reached();
      await approval;
      events.push("approve");
    }),
    beforeBroadcast: () => { events.push("persist"); },
  });
  await reviewing;
  assert.equal(events.includes("persist"), false);
  assert.equal(events.includes("broadcast"), false);
  // The wallet still owns this object: later mutation must NOT affect the
  // already-verified bytes held privately during the app's revised-return review.
  returned!.instructions[3] = SystemProgram.transfer({
    fromPubkey: owner.publicKey, toPubkey: PublicKey.default, lamports: 999_999,
  });
  release();
  assert.match(await result, /^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
  assert.deepEqual(events, ["estimate", "simulate", "review", "approve", "estimate", "height", "persist", "broadcast"]);
});

test("reported 5→6 burn-close-transfer sequence accepts operation 6 with every serialized logging mode", async () => {
  for (let logLevel = 0; logLevel <= 6; logLevel++) {
    const owner = Keypair.generate();
    const events: string[] = [];
    const tx = prepared(owner.publicKey);
    tx.instructions.splice(2, 0, createBurnCheckedInstruction(
      tokenAccount, treasury, owner.publicKey, 10n, 6, [], TOKEN_2022_PROGRAM_ID,
    ));
    const result = await signAndBroadcast({
      transaction: tx,
      connection: connection(events, {
        sendRawTransaction: async (raw: Uint8Array) => {
          events.push("broadcast");
          const signed = Transaction.from(raw);
          assert.equal(signed.verifySignatures(), true);
          assert.equal(signed.instructions.length, 6);
          assert.equal(signed.instructions[2]!.data[0], 15);
          assert.equal(signed.instructions[2]!.data.readBigUInt64LE(1), 10n);
          assert.equal(signed.instructions[3]!.data[0], 9);
          assert.equal(SystemInstruction.decodeTransfer(signed.instructions[4]!).lamports, 180_000n);
          assert.equal(SystemInstruction.decodeTransfer(signed.instructions[4]!).toPubkey.toBase58(), treasury.toBase58());
          assert.deepEqual(signed.instructions[5]!.data, guard(owner.publicKey, 6, logLevel).data);
          return bs58.encode(signed.signature!);
        },
      }),
      signTransaction: async (transaction) => {
        transaction.instructions[0] = ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 });
        transaction.instructions[1] = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 });
        transaction.add(guard(owner.publicKey, 6, logLevel));
        if ([3, 6].includes(logLevel)) {
          transaction.instructions[5]!.keys.push({
            pubkey: new PublicKey(LIGHTHOUSE_NOOP), isSigner: false, isWritable: false,
          });
        }
        transaction.sign(owner);
        return transaction;
      },
      compatibility: compatibility(async (fee) => { assert.equal(fee, 15_000n); events.push("approve"); }),
      beforeBroadcast: () => { events.push("persist"); },
    });
    assert.ok(result);
    assert.deepEqual(events, ["estimate", "simulate", "approve", "estimate", "height", "persist", "broadcast"]);
    const instruction = guard(owner.publicKey, 6, logLevel);
    const policy = { program: LIGHTHOUSE_PROGRAM, accounts: [owner.publicKey.toBase58()], data: instruction.data };
    assert.equal(isLighthouseAssertion(policy), true);
    assert.equal(usesNoopLogging(policy), [3, 6].includes(logLevel));
  }
});

test("the optional Noop logger cannot add targets, writable accounts or signers", async () => {
  for (const [name, logLevel, pubkey, isSigner, isWritable] of [
    ["other target", 3, treasury, false, false],
    ["non-logging mode", 0, new PublicKey(LIGHTHOUSE_NOOP), false, false],
    ["writable logger", 3, new PublicKey(LIGHTHOUSE_NOOP), false, true],
    ["signing logger", 6, new PublicKey(LIGHTHOUSE_NOOP), true, false],
  ] as const) {
    const owner = Keypair.generate();
    const events: string[] = [];
    await assert.rejects(signAndBroadcast({
      transaction: prepared(owner.publicKey), connection: connection(events),
      signTransaction: async (tx) => {
        const assertion = guard(owner.publicKey, 6, logLevel);
        assertion.keys.push({ pubkey, isSigner, isWritable });
        tx.add(assertion);
        return tx;
      },
      compatibility: compatibility(async () => { assert.fail(name); }),
      beforeBroadcast: () => { events.push("persist"); },
    }), undefined, name);
    assert.deepEqual(events, [], name);
  }
});

test("invalid wire enums and malformed headers fail before simulation, approval or broadcast with public diagnostics", async () => {
  for (const [name, data, accountCount] of [
    ["logging mode 16", Buffer.from([6, 16, 1]), 1],
    ["logging mode 17", Buffer.from([6, 17, 1]), 1],
    ["logging mode 18", Buffer.from([6, 18, 1]), 1],
    ["logging mode 255", Buffer.from([6, 255, 1]), 1],
    ["payload length 2", Buffer.from([6, 0]), 1],
    ["payload length 513", Buffer.alloc(513, 6), 1],
    ["expected one target", Buffer.from([6, 0, 1]), 0],
  ] as const) {
    const owner = Keypair.generate();
    const events: string[] = [];
    await assert.rejects(signAndBroadcast({
      transaction: prepared(owner.publicKey), connection: connection(events),
      signTransaction: async (tx) => {
        const assertion = guard(owner.publicKey, 6);
        assertion.data = Buffer.from(data);
        if (accountCount === 0) assertion.keys = [];
        tx.add(assertion);
        return tx;
      },
      compatibility: compatibility(async () => { assert.fail("unsafe header reached approval"); }),
      beforeBroadcast: () => { events.push("persist"); },
    }), (error: unknown) => {
      assert.ok(error instanceof WalletReviewError);
      assert.ok(error.message.includes(name), error.message);
      const descriptor = error.report.returned.at(-1)!;
      assert.equal(descriptor.dataLength, data.length);
      assert.equal(descriptor.loggingMode, data[1]);
      assert.equal("data" in descriptor, false);
      return true;
    });
    assert.deepEqual(events, []);
  }
});

test("read-only guard and budget replacements do not require a second app approval when the net is unchanged", async () => {
  const owner = Keypair.generate();
  const events: string[] = [];
  await signAndBroadcast({
    transaction: prepared(owner.publicKey), connection: connection(events),
    signTransaction: async (tx) => { walletResult(tx, owner.publicKey, true); tx.sign(owner); return tx; },
    compatibility: compatibility(async () => { assert.fail("unchanged return must not repeat approval"); }),
    beforeBroadcast: () => { events.push("persist"); },
  });
  assert.deepEqual(events, ["estimate", "simulate", "height", "persist", "broadcast"]);
});

test("cancelled review, failed simulation, unavailable/changed fee, or expired approval never persists or broadcasts", async () => {
  const cases = [
    { name: "cancel", overrides: {}, approve: async () => { throw new Error("Cancelled"); } },
    { name: "simulation", overrides: { simulateTransaction: async () => ({ value: { err: "AssertionFailed" } }) } },
    { name: "missing estimate", overrides: { getFeeForMessage: async () => ({ value: null }) } },
    { name: "expired", overrides: { getBlockHeight: async () => 501 } },
    { name: "changed estimate", overrides: { getFeeForMessage: (() => { let calls = 0; return async () => ({ value: ++calls === 1 ? 15_000 : 15_001 }); })() } },
  ];
  for (const item of cases) {
    const owner = Keypair.generate();
    const events: string[] = [];
    await assert.rejects(signAndBroadcast({
      transaction: prepared(owner.publicKey), connection: connection(events, item.overrides),
      signTransaction: async (tx) => { walletResult(tx, owner.publicKey); tx.sign(owner); return tx; },
      compatibility: compatibility(item.approve ?? (async () => {})),
      beforeBroadcast: () => { events.push("persist"); },
    }), undefined, item.name);
    assert.equal(events.includes("persist"), false, item.name);
    assert.equal(events.includes("broadcast"), false, item.name);
  }
});

test("wallet compatibility is not an exemption for changed economics, permissions, memory operations, or unknown programs", async () => {
  const owner = Keypair.generate();
  const mutations: [string, (tx: Transaction) => void][] = [
    ["extra transfer", (tx) => { tx.add(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: treasury, lamports: 1 })); }],
    ["changed transfer", (tx) => { tx.instructions[3] = SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: treasury, lamports: 180_001 }); }],
    ["changed recipient", (tx) => { tx.instructions[3]!.keys[1]!.pubkey = PublicKey.default; }],
    ["changed close destination", (tx) => { tx.instructions[2]!.keys[1]!.pubkey = treasury; }],
    ["changed close authority", (tx) => { tx.instructions[2]!.keys[2]!.pubkey = treasury; }],
    ["removed close", (tx) => { tx.instructions.splice(2, 1); }],
    ["fee payer", (tx) => { tx.feePayer = treasury; }],
    ["blockhash", (tx) => { tx.recentBlockhash = treasury.toBase58(); }],
    ["permissions", (tx) => { tx.instructions[3]!.keys[1]!.isWritable = false; }],
    ["memory write", (tx) => { tx.instructions[4] = guard(owner.publicKey, 0); }],
    ["memory close", (tx) => { tx.instructions[4] = guard(owner.publicKey, 1); }],
    ["unknown opcode", (tx) => { tx.instructions[4] = guard(owner.publicKey, 255); }],
    ["unknown program", (tx) => { tx.instructions[4]!.programId = treasury; }],
    ["unreviewed target", (tx) => { tx.instructions[4] = guard(new PublicKey(Buffer.alloc(32, 81))); }],
    ["writable program", (tx) => { tx.instructions[4]!.keys.push({ pubkey: program, isSigner: false, isWritable: true }); }],
    ["excessive guard data", (tx) => { tx.instructions[4]!.data = Buffer.alloc(513, 5); }],
    ["excessive assertions", (tx) => { for (let i = 0; i < 8; i++) tx.add(guard(owner.publicKey)); }],
    ["excessive priority cost", (tx) => { tx.instructions[1] = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000_000 }); }],
    ["duplicate budget", (tx) => { tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 10_000 })); }],
    ["guard inserted before close", (tx) => { const g = tx.instructions.pop()!; tx.instructions.splice(2, 0, g); }],
  ];
  for (const [name, mutate] of mutations) {
    const events: string[] = [];
    await assert.rejects(signAndBroadcast({
      transaction: prepared(owner.publicKey), connection: connection(events),
      signTransaction: async (tx) => { walletResult(tx, owner.publicKey); mutate(tx); return tx; },
      compatibility: compatibility(async () => { assert.fail("unsafe change must not reach approval"); }),
      beforeBroadcast: () => { events.push("persist"); },
    }), undefined, name);
    assert.deepEqual(events, [], name);
  }
});

test("changed burn amount is rejected even alongside a valid Lighthouse assertion", async () => {
  const owner = Keypair.generate();
  const tx = prepared(owner.publicKey);
  const burn = Buffer.alloc(10);
  burn[0] = 15; burn.writeBigUInt64LE(10n, 1); burn[9] = 6;
  tx.instructions.splice(2, 0, new TransactionInstruction({
    programId: TOKEN_2022_PROGRAM_ID,
    keys: [{ pubkey: tokenAccount, isSigner: false, isWritable: true }, { pubkey: treasury, isSigner: false, isWritable: true }, { pubkey: owner.publicKey, isSigner: true, isWritable: false }],
    data: burn,
  }));
  const events: string[] = [];
  await assert.rejects(signAndBroadcast({
    transaction: tx, connection: connection(events),
    signTransaction: async (transaction) => {
      transaction.instructions[2]!.data = Buffer.from(transaction.instructions[2]!.data);
      transaction.instructions[2]!.data.writeBigUInt64LE(11n, 1);
      transaction.add(guard(owner.publicKey));
      return transaction;
    },
    compatibility: compatibility(async () => { assert.fail(); }), beforeBroadcast: () => { events.push("persist"); },
  }), /changed a reviewed reclaim instruction/);
  assert.deepEqual(events, []);
});

test("inspection never submits a supported wallet augmentation; missing/invalid signatures still block claims", async () => {
  const owner = Keypair.generate();
  for (const mode of ["inspect", "unsigned", "bad-signature"] as const) {
    const events: string[] = [];
    await assert.rejects(signAndBroadcast({
      transaction: prepared(owner.publicKey), connection: connection(events),
      inspectOnly: mode === "inspect",
      signTransaction: async (tx) => {
        walletResult(tx, owner.publicKey);
        if (mode !== "unsigned") tx.sign(owner);
        if (mode === "bad-signature") tx.signatures[0]!.signature![0]! ^= 1;
        return tx;
      },
      compatibility: compatibility(async () => { assert.fail("must not reach economic approval"); }),
      beforeBroadcast: () => { events.push("persist"); },
    }), (error: unknown) => {
      if (mode === "inspect") assert.ok(error instanceof WalletReviewError);
      return true;
    });
    assert.deepEqual(events, [], mode);
  }
});
