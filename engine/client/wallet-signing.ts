import bs58 from "bs58";
import { ComputeBudgetProgram, Transaction, VersionedTransaction, type Connection } from "@solana/web3.js";
import { LIGHTHOUSE_PROGRAM, LIGHTHOUSE_NOOP, usesNoopLogging, validateWalletInstructions } from "@workspace/reclaim-policy";
import { assertReturnedTransactionFits, assertUnsignedWalletHandoff } from "./transaction-limits";

export type WalletCompatibility = {
  quotedNetworkFeeLamports: bigint;
  lastValidBlockHeight: number;
  approveNetworkFee: (networkFeeLamports: bigint) => Promise<void>;
};

export type SigningProvider = {
  wallet: string;
  path: "wallet-standard" | "solflare-sdk" | "wallet-adapter";
};
type PublicInstruction = {
  index: number; program: string; operation: string; accountCount: number;
  dataLength?: number; loggingMode?: number;
};
export type WalletSigningReport = {
  format: "potify-wallet-check-v1";
  provider: SigningProvider;
  mode: "inspect-only" | "claim";
  changed: boolean;
  reason: string | null;
  broadcastAttempted: false;
  expectedCount: number;
  returnedCount: number;
  added: PublicInstruction[];
  removed: PublicInstruction[];
  expected: PublicInstruction[];
  returned: PublicInstruction[];
  truncated: boolean;
};
export class WalletReviewError extends Error {
  constructor(message: string, readonly report: WalletSigningReport) {
    super(message);
    this.name = "WalletReviewError";
  }
}

/** Compare effective instructions and permissions, not wallet-specific key ordering. */
function reviewedMessage(transaction: Transaction) {
  const message = transaction.compileMessage();
  return {
    feePayer: message.accountKeys[0]?.toBase58(),
    blockhash: message.recentBlockhash,
    accounts: message.accountKeys.map((key, index) => ({
      address: key.toBase58(),
      signer: message.isAccountSigner(index),
      writable: message.isAccountWritable(index),
    })).sort((a, b) => a.address.localeCompare(b.address)),
    instructions: message.instructions.map((instruction) => ({
      program: message.accountKeys[instruction.programIdIndex]!.toBase58(),
      accounts: instruction.accounts.map((index) => message.accountKeys[index]!.toBase58()),
      data: instruction.data,
    })),
  };
}

type Snapshot = ReturnType<typeof reviewedMessage>;
function publicInstruction(instruction: Snapshot["instructions"][number], index: number): PublicInstruction {
  let operation = "unrecognized";
  let lighthouseMetadata: { dataLength: number; loggingMode?: number } | undefined;
  // Decode only known operation tags. Never publish raw bytes or memo contents.
  if (instruction.data.length <= 710) {
    try {
      const data = bs58.decode(instruction.data);
      if (instruction.program === ComputeBudgetProgram.programId.toBase58()) {
        operation = ({ 2: "compute-unit-limit", 3: "compute-unit-price" } as Record<number, string>)[data[0]!] ?? "other-compute-budget";
      } else if (instruction.program === LIGHTHOUSE_PROGRAM) {
        operation = [0, 1].includes(data[0]!) ? "lighthouse-memory-write-or-close" : `lighthouse-operation-${data[0]}`;
        lighthouseMetadata = { dataLength: data.length, loggingMode: data[1] };
      } else if (instruction.program === "11111111111111111111111111111111" && data.length >= 4) {
        const tag = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true);
        operation = tag === 2 ? "system-transfer" : "other-system";
      } else if (["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"].includes(instruction.program)) {
        operation = ({ 9: "close-account", 15: "burn-checked" } as Record<number, string>)[data[0]!] ?? "other-token";
      }
    } catch { /* An undecodable operation remains unrecognized and blocked. */ }
  }
  return { index: index + 1, program: instruction.program, operation, accountCount: instruction.accounts.length, ...lighthouseMetadata };
}

function validateWalletMessage(expected: Snapshot, actual: Snapshot) {
  if (expected.feePayer !== actual.feePayer || expected.blockhash !== actual.blockhash) {
    throw new Error("The wallet changed the fee payer or validity blockhash.");
  }
  const decode = (instructions: Snapshot["instructions"]) => instructions.map((instruction) => ({
    ...instruction, data: bs58.decode(instruction.data),
  }));
  const assertions = validateWalletInstructions(decode(expected.instructions), decode(actual.instructions));
  const originalAccounts = new Map(expected.accounts.map((account) => [account.address, account]));
  const returnedAccounts = new Map(actual.accounts.map((account) => [account.address, account]));
  for (const original of expected.accounts) {
    const returned = returnedAccounts.get(original.address);
    if (!returned || original.signer !== returned.signer || original.writable !== returned.writable) {
      throw new Error("The wallet changed a reviewed account or permission.");
    }
  }
  for (const account of actual.accounts) {
    if (originalAccounts.has(account.address)) continue;
    const permittedProgram = (account.address === LIGHTHOUSE_PROGRAM && assertions.length > 0) ||
      (account.address === LIGHTHOUSE_NOOP && assertions.some(usesNoopLogging));
    if (!permittedProgram || account.signer || account.writable) throw new Error("The wallet added an account or permission outside the assertion policy.");
  }
  if (assertions.some((instruction) => !originalAccounts.has(instruction.accounts[0]!))) {
    throw new Error("The wallet assertion targets an unreviewed account.");
  }
}

function unmatchedInstructions(before: Snapshot["instructions"], after: Snapshot["instructions"]) {
  const remaining = before.map((instruction) => JSON.stringify(instruction));
  return after.flatMap((instruction, index) => {
    const match = remaining.indexOf(JSON.stringify(instruction));
    if (match === -1) return [publicInstruction(instruction, index)];
    remaining.splice(match, 1);
    return [];
  }).slice(0, 64);
}

function publicReport(expected: Snapshot, actual: Snapshot, reason: string | null, args: {
  provider?: SigningProvider; inspectOnly?: boolean;
}): WalletSigningReport {
  return {
    format: "potify-wallet-check-v1",
    provider: args.provider ?? { wallet: "unknown", path: "wallet-adapter" },
    mode: args.inspectOnly ? "inspect-only" : "claim",
    changed: reason !== null, reason, broadcastAttempted: false,
    expectedCount: expected.instructions.length, returnedCount: actual.instructions.length,
    added: unmatchedInstructions(expected.instructions, actual.instructions),
    removed: unmatchedInstructions(actual.instructions, expected.instructions),
    expected: expected.instructions.slice(0, 64).map(publicInstruction),
    returned: actual.instructions.slice(0, 64).map(publicInstruction),
    truncated: expected.instructions.length > 64 || actual.instructions.length > 64,
  };
}

function describeChange(expected: ReturnType<typeof reviewedMessage>, actual: ReturnType<typeof reviewedMessage>): string | null {
  if (expected.feePayer !== actual.feePayer) return "fee payer changed";
  if (expected.blockhash !== actual.blockhash) return "validity blockhash changed";

  if (expected.instructions.length !== actual.instructions.length) {
    const computeProgram = ComputeBudgetProgram.programId.toBase58();
    const countCompute = (instructions: typeof expected.instructions) =>
      instructions.filter((instruction) => instruction.program === computeProgram).length;
    if (countCompute(actual.instructions) > countCompute(expected.instructions)) {
      return "wallet added a compute-budget instruction";
    }
    const added = unmatchedInstructions(expected.instructions, actual.instructions);
    return actual.instructions.length > expected.instructions.length
      ? `wallet added an instruction${added[0] ? `: ${added[0].operation} (${added[0].program})` : ""}`
      : "wallet removed an instruction";
  }
  for (let i = 0; i < expected.instructions.length; i += 1) {
    const before = expected.instructions[i]!;
    const after = actual.instructions[i]!;
    if (before.program !== after.program) return `instruction ${i + 1} changed program`;
    if (JSON.stringify(before.accounts) !== JSON.stringify(after.accounts)) {
      return `instruction ${i + 1} changed an account or recipient`;
    }
    if (before.data !== after.data) return `instruction ${i + 1} changed its amount or operation`;
  }

  const expectedAccounts = new Map(expected.accounts.map((account) => [account.address, account]));
  const actualAccounts = new Map(actual.accounts.map((account) => [account.address, account]));
  const short = (address: string) => `${address.slice(0, 5)}…${address.slice(-5)}`;
  for (const account of expected.accounts) {
    const returned = actualAccounts.get(account.address);
    if (!returned) return `account ${short(account.address)} was removed`;
    if (account.signer !== returned.signer) return `signer permission changed for ${short(account.address)}`;
    if (account.writable !== returned.writable) return `writable permission changed for ${short(account.address)}`;
  }
  for (const account of actual.accounts) {
    if (!expectedAccounts.has(account.address)) return `account ${short(account.address)} was added`;
  }
  return null;
}

/** Persist only the public signature BEFORE any network write can be attempted. */
export async function signAndBroadcast(args: {
  connection: Pick<Connection, "sendRawTransaction"> & Partial<Pick<Connection, "simulateTransaction" | "getFeeForMessage" | "getBlockHeight">>;
  transaction: Transaction;
  signTransaction: (transaction: Transaction) => Promise<Transaction>;
  beforeBroadcast: (signature: string) => void;
  provider?: SigningProvider;
  inspectOnly?: boolean;
  compatibility?: WalletCompatibility;
  requireUnsigned?: boolean;
}): Promise<string> {
  if (args.requireUnsigned || args.compatibility) assertUnsignedWalletHandoff(args.transaction);
  // Snapshot strings before approval: injected wallets may mutate the input in place.
  const message = reviewedMessage(args.transaction);
  const signed = await args.signTransaction(args.transaction);
  // Measure before SDK serialization (which itself rejects oversized packets).
  // Never trim assertions, rebuild, or mutate a wallet-approved transaction.
  assertReturnedTransactionFits(signed);
  // Freeze/verify the exact signed wire message. Do not reserialize a mutable
  // wallet-owned object after an async fee review.
  const locked = Transaction.from(signed.serialize({ verifySignatures: false, requireAllSignatures: false }));
  const returnedMessage = reviewedMessage(locked);
  const changed = describeChange(message, returnedMessage);
  let policyError: string | null = null;
  if (args.compatibility && !args.inspectOnly) {
    try { validateWalletMessage(message, returnedMessage); }
    catch (error) { policyError = error instanceof Error ? error.message : "Unsupported wallet change."; }
  }
  if ((changed && (!args.compatibility || args.inspectOnly)) || policyError) {
    const reason = policyError ?? changed!;
    throw new WalletReviewError(
      `The wallet changed the reviewed transaction (${reason}). Nothing was broadcast.`,
      publicReport(message, returnedMessage, reason, args),
    );
  }
  const raw = locked.serialize(); // Require valid signatures only after classifying mutations.
  if (!locked.signature) throw new Error("The wallet did not sign the transaction.");
  if (args.inspectOnly) {
    throw new WalletReviewError(
      "Wallet check passed. Nothing was broadcast.",
      publicReport(message, returnedMessage, null, args),
    );
  }
  if (args.compatibility) {
    const { quotedNetworkFeeLamports, lastValidBlockHeight, approveNetworkFee } = args.compatibility;
    if (!args.connection.getFeeForMessage || !args.connection.simulateTransaction || !args.connection.getBlockHeight ||
        !Number.isSafeInteger(lastValidBlockHeight) || lastValidBlockHeight < 1) {
      throw new Error("Wallet-adjusted transactions require full network validation. Nothing was broadcast.");
    }
    const estimate = await args.connection.getFeeForMessage(locked.compileMessage(), "confirmed");
    if (estimate.value === null || !Number.isSafeInteger(estimate.value) || estimate.value < 0) {
      throw new Error("The wallet's network cost could not be verified. Nothing was broadcast.");
    }
    const networkFee = BigInt(estimate.value);
    const simulation = await args.connection.simulateTransaction(VersionedTransaction.deserialize(raw), {
      sigVerify: true, commitment: "confirmed",
    });
    if (simulation.value.err) throw new Error("The wallet-adjusted transaction failed simulation. Nothing was broadcast.");
    if (networkFee !== quotedNetworkFeeLamports) {
      await approveNetworkFee(networkFee);
      const recheck = await args.connection.getFeeForMessage(locked.compileMessage(), "confirmed");
      if (recheck.value !== estimate.value) throw new Error("The network estimate changed or expired. Nothing was broadcast.");
    }
    if (await args.connection.getBlockHeight("confirmed") > lastValidBlockHeight) {
      throw new Error("The wallet approval expired. Refresh accounts before trying again. Nothing was broadcast.");
    }
  }
  const signature = bs58.encode(locked.signature);
  args.beforeBroadcast(signature); // Storage failure must prevent broadcasting.
  const returned = await args.connection.sendRawTransaction(raw, {
    skipPreflight: false,
    preflightCommitment: "confirmed",
    maxRetries: 3,
  });
  if (returned !== signature) throw new Error("The RPC returned a different signature. Check the saved transaction before retrying.");
  return signature;
}
