import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import bs58 from "bs58";
import { LIGHTHOUSE_PROGRAM, LIGHTHOUSE_NOOP } from "@workspace/reclaim-policy";
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  type ParsedTransactionWithMeta,
  type TransactionInstruction,
} from "@solana/web3.js";
import { verifyReclaimSignature, verifyTransactionContents } from "./reclaim-verification";

const wallet = new PublicKey(Buffer.alloc(32, 1));
const treasury = new PublicKey(Buffer.alloc(32, 2));
const tokenAccount = new PublicKey(Buffer.alloc(32, 3));
const mint = new PublicKey(Buffer.alloc(32, 4));
const tokenProgram = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);

function makeTransaction(feeLamports = 180_000) {
  return {
    blockTime: 1_700_000_000,
    meta: {
      err: null,
      fee: 5_000,
      innerInstructions: null,
      preBalances: [5_000_000, 1_000_000, 0, 0],
       postBalances: [5_815_000, 0, 180_000, 0],
      },
    transaction: {
      message: {
        accountKeys: [
          { pubkey: wallet, signer: true, writable: true },
          { pubkey: tokenAccount, signer: false, writable: true },
          { pubkey: treasury, signer: false, writable: true },
          { pubkey: mint, signer: false, writable: false },
        ],
        instructions: [
          {
            program: "spl-token",
            programId: tokenProgram,
            parsed: {
              type: "burnChecked",
              info: {
                account: tokenAccount.toBase58(),
                mint: mint.toBase58(),
                authority: wallet.toBase58(),
                 tokenAmount: { amount: "5000000", decimals: 6, uiAmountString: "5" },
              },
            },
          },
          {
            program: "spl-token",
            programId: tokenProgram,
            parsed: {
              type: "closeAccount",
              info: {
                account: tokenAccount.toBase58(),
                destination: wallet.toBase58(),
                owner: wallet.toBase58(),
              },
            },
          },
          {
            program: "system",
            programId: SystemProgram.programId,
            parsed: {
              type: "transfer",
              info: {
                 source: wallet.toBase58(),
                 destination: treasury.toBase58(),
                lamports: feeLamports,
              },
            },
          },
        ],
        recentBlockhash: "test-blockhash",
      },
        signatures: ["confirmed-test-signature"],
    },
  } as unknown as ParsedTransactionWithMeta;
}

function rawInstruction(instruction: TransactionInstruction) {
  return {
    programId: instruction.programId,
    accounts: instruction.keys.map((key) => key.pubkey),
    data: bs58.encode(instruction.data),
  };
}

function withBudget(transaction = makeTransaction(), units = 50_000, microLamports = 1_000) {
  transaction.transaction.message.instructions.unshift(
    rawInstruction(ComputeBudgetProgram.setComputeUnitLimit({ units })),
    rawInstruction(ComputeBudgetProgram.setComputeUnitPrice({ microLamports })),
  );
  transaction.transaction.message.accountKeys.push({
    pubkey: ComputeBudgetProgram.programId, signer: false, writable: false,
  });
  transaction.meta!.preBalances.push(0);
  transaction.meta!.postBalances.push(0);
  transaction.meta!.fee = 5_050;
  transaction.meta!.postBalances[0]! -= 50;
  return transaction;
}

function withWalletGuard(transaction = withBudget(), opcode = 5, logLevel = 0) {
  transaction.transaction.message.instructions[0] = rawInstruction(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }));
  transaction.transaction.message.instructions[1] = rawInstruction(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }));
  const oldFee = transaction.meta!.fee;
  transaction.meta!.fee = 15_000;
  transaction.meta!.postBalances[0]! += oldFee - 15_000;
  transaction.transaction.message.instructions.push({
    programId: new PublicKey(LIGHTHOUSE_PROGRAM), accounts: [wallet],
    // CompactU64 (LEB128) array length, followed by Lamports/u64/operator.
    data: bs58.encode(Buffer.from([opcode, logLevel, ...(opcode === 6 ? [1] : []), 0, 0, 0, 0, 0, 0, 0, 0, 0, 4])),
  });
  transaction.transaction.message.accountKeys.push({ pubkey: new PublicKey(LIGHTHOUSE_PROGRAM), signer: false, writable: false });
  transaction.meta!.preBalances.push(0);
  transaction.meta!.postBalances.push(0);
  return transaction;
}

const validArgs = () => ({
  transaction: makeTransaction(),
  signature: "confirmed-test-signature",
  walletAddress: wallet.toBase58(),
  network: "mainnet-beta" as const,
  treasuryAddress: treasury.toBase58(),
  serviceFeeBps: 1_800,
});

test("derives closed-account, burn, gross, and fee totals from confirmed instructions", () => {
  const receipt = verifyTransactionContents(validArgs());

  assert.equal(receipt.accountCount, 1);
  assert.equal(receipt.burnCount, 1);
  assert.equal(receipt.grossLamports, "1000000");
  assert.equal(receipt.feeLamports, "180000");
  assert.equal(receipt.confirmedAt.toISOString(), "2023-11-14T22:13:20.000Z");
});

test("accepts bounded raw RPC compute-budget instructions without counting them as reclaims", () => {
  const receipt = verifyTransactionContents({ ...validArgs(), transaction: withBudget() });
  assert.equal(receipt.accountCount, 1);
  assert.equal(receipt.burnCount, 1);
  assert.equal(receipt.grossLamports, "1000000");
  assert.equal(receipt.feeLamports, "180000");
});

test("rejects excessive, duplicate, incomplete, late or unsupported compute-budget instructions", () => {
  for (const transaction of [
    withBudget(makeTransaction(), 1_400_001),
    withBudget(makeTransaction(), 0),
    withBudget(makeTransaction(), 50_000, 100_000_001),
  ]) {
    assert.throws(() => verifyTransactionContents({ ...validArgs(), transaction }), /compute-budget/);
  }
  const duplicate = withBudget();
  duplicate.transaction.message.instructions.unshift(rawInstruction(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 })));
  assert.throws(() => verifyTransactionContents({ ...validArgs(), transaction: duplicate }), /duplicate compute-budget/);
  const incomplete = withBudget();
  incomplete.transaction.message.instructions.shift();
  assert.throws(() => verifyTransactionContents({ ...validArgs(), transaction: incomplete }), /incomplete compute-budget/);
  const late = withBudget();
  late.transaction.message.instructions.push(late.transaction.message.instructions.shift()!);
  assert.throws(() => verifyTransactionContents({ ...validArgs(), transaction: late }), /must precede/);
  const unsupported = withBudget();
  unsupported.transaction.message.instructions[0] = rawInstruction(ComputeBudgetProgram.requestHeapFrame({ bytes: 32_768 }));
  assert.throws(() => verifyTransactionContents({ ...validArgs(), transaction: unsupported }), /compute-budget/);
  const malformed = withBudget();
  (malformed.transaction.message.instructions[0] as any).data = "not base58!";
  assert.throws(() => verifyTransactionContents({ ...validArgs(), transaction: malformed }), /compute-budget/);
});

test("compute-budget instructions cannot hide a changed treasury transfer", () => {
  const transaction = withBudget();
  (transaction.transaction.message.instructions[4] as any).parsed.info.destination = wallet.toBase58();
  assert.throws(() => verifyTransactionContents({ ...validArgs(), transaction }), /configured treasury/);
});

test("records provider-shaped wallet-adjusted receipts without changing recovered rent, burn totals or treasury payment", () => {
  for (const withBurn of [true, false]) {
    const tx = makeTransaction();
    if (!withBurn) tx.transaction.message.instructions.shift();
    const receipt = verifyTransactionContents({ ...validArgs(), transaction: withWalletGuard(withBudget(tx)) });
    assert.equal(receipt.accountCount, 1);
    assert.equal(receipt.burnCount, withBurn ? 1 : 0);
    assert.equal(receipt.grossLamports, "1000000");
    assert.equal(receipt.feeLamports, "180000");
  }
});

test("Lighthouse is not a blanket program whitelist: memory, unrelated accounts, permissions and non-suffix guards are rejected", () => {
  for (const opcode of [0, 1, 4, 15, 255]) {
    assert.throws(() => verifyTransactionContents({ ...validArgs(), transaction: withWalletGuard(withBudget(), opcode) }), /unsupported wallet assertion/);
  }
  const badAccount = withWalletGuard();
  (badAccount.transaction.message.instructions.at(-1) as any).accounts = [new PublicKey(Buffer.alloc(32, 81))];
  assert.throws(() => verifyTransactionContents({ ...validArgs(), transaction: badAccount }), /unrelated account/);
  const writable = withWalletGuard();
  writable.transaction.message.accountKeys.at(-1)!.writable = true;
  assert.throws(() => verifyTransactionContents({ ...validArgs(), transaction: writable }), /unexpected permissions/);
  const reordered = withWalletGuard();
  reordered.transaction.message.instructions.splice(3, 0, reordered.transaction.message.instructions.pop()!);
  assert.throws(() => verifyTransactionContents({ ...validArgs(), transaction: reordered }), /must follow/);
  const excessive = withWalletGuard();
  for (let i = 0; i < 8; i++) excessive.transaction.message.instructions.push(excessive.transaction.message.instructions.at(-1)!);
  assert.throws(() => verifyTransactionContents({ ...validArgs(), transaction: excessive }), /unsupported wallet assertion/);
  const wrongTreasury = withWalletGuard();
  (wrongTreasury.transaction.message.instructions[4] as any).parsed.info.destination = wallet.toBase58();
  assert.throws(() => verifyTransactionContents({ ...validArgs(), transaction: wrongTreasury }), /configured treasury/);
  assert.throws(() => verifyTransactionContents({ ...validArgs(), transaction: withWalletGuard(), network: "devnet" }), /unsupported wallet assertion/);
});

test("operation-6 burn-close-transfer receipts accept all wire logging modes and reject internal Rust discriminants", () => {
  for (const logLevel of [0, 1, 2, 3, 4, 5, 6]) {
    const transaction = withWalletGuard(withBudget(), 6, logLevel);
    const receipt = verifyTransactionContents({ ...validArgs(), transaction });
    assert.equal(receipt.burnCount, 1);
    assert.equal(receipt.accountCount, 1);
    assert.equal(receipt.grossLamports, "1000000");
    assert.equal(receipt.feeLamports, "180000");
  }
  for (const logLevel of [16, 17, 18, 255]) {
    assert.throws(() => verifyTransactionContents({
      ...validArgs(), transaction: withWalletGuard(withBudget(), 6, logLevel),
    }), /unsupported wallet assertion/);
  }
  for (const data of [Buffer.from([6, 0]), Buffer.alloc(513, 6)]) {
    const transaction = withWalletGuard(withBudget(), 6);
    (transaction.transaction.message.instructions.at(-1) as any).data = bs58.encode(data);
    assert.throws(() => verifyTransactionContents({ ...validArgs(), transaction }), /unsupported wallet assertion/);
  }
});

test("only account-free fixed Noop logging beneath an approved Lighthouse logging operation is accepted", () => {
  for (const logLevel of [3, 6]) {
  const tx = withWalletGuard(withBudget(), 6, logLevel);
  (tx.transaction.message.instructions.at(-1) as any).accounts.push(new PublicKey(LIGHTHOUSE_NOOP));
  tx.transaction.message.accountKeys.push({ pubkey: new PublicKey(LIGHTHOUSE_NOOP), signer: false, writable: false });
  tx.meta!.preBalances.push(0);
  tx.meta!.postBalances.push(0);
  const nested = { programId: new PublicKey(LIGHTHOUSE_NOOP), accounts: [] as PublicKey[], data: bs58.encode(Buffer.from([1])) };
  tx.meta!.innerInstructions = [{ index: tx.transaction.message.instructions.length - 1, instructions: [nested] }];
  assert.equal(verifyTransactionContents({ ...validArgs(), transaction: tx }).accountCount, 1);
  nested.accounts = [wallet];
  assert.throws(() => verifyTransactionContents({ ...validArgs(), transaction: tx }), /nested instructions/);
  nested.accounts = [];
  nested.programId = SystemProgram.programId;
  assert.throws(() => verifyTransactionContents({ ...validArgs(), transaction: tx }), /nested instructions/);
  nested.programId = new PublicKey(LIGHTHOUSE_NOOP);
  tx.meta!.innerInstructions[0]!.index = 3;
  assert.throws(() => verifyTransactionContents({ ...validArgs(), transaction: tx }), /nested instructions/);
  }
});

test("rejects a transaction that underpays the configured treasury fee", () => {
  assert.throws(
    () =>
      verifyTransactionContents({
        ...validArgs(),
        transaction: makeTransaction(179_999),
      }),
    /configured service fee/,
  );
});

test("rejects a close directed to a wallet other than the signer", () => {
  const transaction = makeTransaction();
  const closeInstruction = transaction.transaction.message.instructions[1];
  if (!closeInstruction || !("parsed" in closeInstruction)) {
    throw new Error("Test transaction is missing its parsed close instruction.");
  }
  closeInstruction.parsed.info.destination = treasury.toBase58();

  assert.throws(
    () => verifyTransactionContents({ ...validArgs(), transaction }),
    /closed back to the signing wallet/,
  );
});

test("rejects a transfer to any address other than the configured community treasury", () => {
  const transaction = makeTransaction();
  const transfer = transaction.transaction.message.instructions[2] as any;
  transfer.parsed.info.destination = wallet.toBase58();
  assert.throws(() => verifyTransactionContents({ ...validArgs(), transaction }), /configured treasury/);
});

test("accepts an empty account close without a burn, using actual RPC transfer fields", () => {
  const transaction = makeTransaction();
  transaction.transaction.message.instructions.shift();
  assert.equal(verifyTransactionContents({ ...validArgs(), transaction }).burnCount, 0);
});

test("rejects failed or unrecognized instructions rather than inventing a receipt", () => {
  const transaction = makeTransaction();
  transaction.meta!.err = "InvalidAccountData";
  assert.throws(() => verifyTransactionContents({ ...validArgs(), transaction }), /did not complete/);
  const malformed = makeTransaction();
  const burn = malformed.transaction.message.instructions[0] as any;
  delete burn.parsed.info.tokenAmount;
  burn.parsed.info.amount = "5";
  assert.throws(() => verifyTransactionContents({ ...validArgs(), transaction: malformed }), /checked-burn/);
});

test("verifies actual jsonParsed RPC shapes and the full mainnet genesis, rejecting devnet", async () => {
  let genesis = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const rpc = JSON.parse(body);
    const result = rpc.method === "getGenesisHash" ? genesis
      : rpc.method === "getSignatureStatuses" ? { context: { slot: 1 }, value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: "confirmed" }] }
       : { ...withWalletGuard(), slot: 1 };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test RPC did not bind");
    const args = {
      signature: "confirmed-test-signature", walletAddress: wallet.toBase58(),
      network: "mainnet-beta" as const, serviceFeeBps: 1800,
      configuredTreasury: treasury.toBase58(),
      mainnetRpc: new URL(`http://127.0.0.1:${address.port}`),
    };
    const receipt = await verifyReclaimSignature(args);
    assert.equal(receipt.feeLamports, "180000");
    assert.equal(receipt.burnCount, 1);
    genesis = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
    await assert.rejects(verifyReclaimSignature(args), /expected Solana network/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
