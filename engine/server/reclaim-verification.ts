import bs58 from "bs58";
import {
  LIGHTHOUSE_PROGRAM, LIGHTHOUSE_NOOP, MAX_WALLET_ASSERTIONS,
  decodeComputeBudget, isLighthouseAssertion, usesNoopLogging, type PolicyInstruction,
} from "@workspace/reclaim-policy";
import {
  ComputeBudgetInstruction,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type ParsedInstruction,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";

export type ReclaimNetwork = "mainnet-beta" | "devnet";

export type VerifiedReclaim = {
  signature: string;
  walletAddress: string;
  network: ReclaimNetwork;
  accountCount: number;
  burnCount: number;
  grossLamports: string;
  feeLamports: string;
  confirmedAt: Date;
};

export class ReclaimVerificationError extends Error {
  constructor(
    message: string,
    readonly statusCode: 409 | 422 | 503,
  ) {
    super(message);
  }
}

const DEVNET_TEST_TREASURY = "CYUfTFL2SLt1Yu2NR8SbP59LRfDQeiJWMcvyirtC7Exo";
const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const SOL_LAMPORTS = 1_000_000_000n;
const MAX_RECLAIM_COMPUTE_UNITS = 1_400_000;

function reject(message: string): never {
  throw new ReclaimVerificationError(message, 422);
}

function verifyComputeBudget(
  raw: ParsedTransactionWithMeta["transaction"]["message"]["instructions"][number],
): "limit" | "price" {
  if (!("data" in raw) || typeof raw.data !== "string" || !Array.isArray(raw.accounts) || raw.accounts.length !== 0) {
    return reject("The compute-budget instruction could not be verified.");
  }
  try {
    const instruction = new TransactionInstruction({
      programId: ComputeBudgetProgram.programId,
      keys: [],
      data: Buffer.from(bs58.decode(raw.data)),
    });
    const type = ComputeBudgetInstruction.decodeInstructionType(instruction);
    if (type === "SetComputeUnitLimit" && instruction.data.length === 5) {
      const { units } = ComputeBudgetInstruction.decodeSetComputeUnitLimit(instruction);
      if (units > 0 && units <= MAX_RECLAIM_COMPUTE_UNITS) return "limit";
    }
    if (type === "SetComputeUnitPrice" && instruction.data.length === 9) {
      const { microLamports } = ComputeBudgetInstruction.decodeSetComputeUnitPrice(instruction);
      if (microLamports >= 0n) return "price";
    }
  } catch {
    return reject("The compute-budget instruction could not be decoded.");
  }
  return reject("The compute-budget instruction exceeds the reclaim policy or is unsupported.");
}

function policyInstruction(raw: ParsedTransactionWithMeta["transaction"]["message"]["instructions"][number]): PolicyInstruction {
  if (!("data" in raw) || typeof raw.data !== "string" || raw.data.length > 710 || !Array.isArray(raw.accounts)) {
    return reject("The wallet instruction could not be decoded.");
  }
  try {
    return { program: raw.programId.toBase58(), accounts: raw.accounts.map((key) => key.toBase58()), data: bs58.decode(raw.data) };
  } catch { return reject("The wallet instruction could not be decoded."); }
}

function isParsedInstruction(
  instruction: ParsedTransactionWithMeta["transaction"]["message"]["instructions"][number],
): instruction is ParsedInstruction {
  return "parsed" in instruction;
}

function toInfo(
  instruction: ParsedInstruction,
): { type: string; info: Record<string, unknown> } {
  const parsed: unknown = instruction.parsed;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("type" in parsed) ||
    typeof parsed.type !== "string" ||
    !("info" in parsed) ||
    typeof parsed.info !== "object" ||
    parsed.info === null
  ) {
    return reject("The transaction contains an instruction that could not be verified.");
  }
  return { type: parsed.type, info: parsed.info as Record<string, unknown> };
}

function infoString(info: Record<string, unknown>, key: string): string {
  const value = info[key];
  if (typeof value !== "string") {
    return reject("The transaction contains incomplete reclaim instruction data.");
  }
  return value;
}

function lamportsFor(info: Record<string, unknown>): bigint {
  const value = info.lamports;
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "number" && !Number.isSafeInteger(value)) ||
    !/^\d+$/.test(String(value))
  ) {
    return reject("The transaction contains an invalid service fee transfer.");
  }
  return BigInt(value);
}

function feeForGross(grossLamports: bigint, serviceFeeBps: number): bigint {
  return (grossLamports * BigInt(serviceFeeBps)) / 10_000n;
}

function solFromLamports(lamports: bigint): string {
  const whole = lamports / SOL_LAMPORTS;
  const fraction = (lamports % SOL_LAMPORTS).toString().padStart(9, "0");
  return `${whole}.${fraction}`;
}

export function toPublicReclaimTransaction(
  receipt: VerifiedReclaim,
): {
  signature: string;
  accountCount: number;
  burnCount: number;
  grossSolRecovered: string;
  confirmedAt: Date;
  explorerUrl: string;
} {
  return {
    signature: receipt.signature,
    accountCount: receipt.accountCount,
    burnCount: receipt.burnCount,
    grossSolRecovered: solFromLamports(BigInt(receipt.grossLamports)),
    confirmedAt: receipt.confirmedAt,
    explorerUrl: `https://solscan.io/tx/${receipt.signature}${
      receipt.network === "devnet" ? "?cluster=devnet" : ""
    }`,
  };
}

function getTransactionTreasury(
  network: ReclaimNetwork,
  configuredTreasury: string | null,
): string {
  if (network === "devnet") return DEVNET_TEST_TREASURY;
  if (!configuredTreasury) {
    throw new ReclaimVerificationError(
      "The reclaim treasury is not configured.",
      503,
    );
  }
  return configuredTreasury;
}

export function verifyTransactionContents(args: {
  transaction: ParsedTransactionWithMeta;
  signature: string;
  walletAddress: string;
  network: ReclaimNetwork;
  treasuryAddress: string;
  serviceFeeBps: number;
}): VerifiedReclaim {
  const { transaction, signature, walletAddress, network, treasuryAddress, serviceFeeBps } = args;
  const metadata = transaction.meta;
  if (!transaction.transaction.signatures.includes(signature)) {
    return reject("The RPC transaction does not match the submitted signature.");
  }
  if (!metadata || metadata.err) {
    return reject("The on-chain transaction did not complete successfully.");
  }
  if (
    transaction.transaction.message.accountKeys[0]?.pubkey.toBase58() !==
    walletAddress
  ) {
    return reject("The submitted wallet is not the transaction fee payer.");
  }
  if (
    !transaction.transaction.message.accountKeys.some(
      (account) => account.signer && account.pubkey.toBase58() === walletAddress,
    )
  ) {
    return reject("The submitted wallet did not sign the transaction.");
  }
  const closedAccounts: string[] = [];
  const burnedAccounts = new Set<string>();
  let serviceTransfers = 0;
  let transferredFee = 0n;
  const budgetSettings = new Set<"limit" | "price">();
  let reclaimStarted = false;
  let guardStarted = false;
  const budgets: PolicyInstruction[] = [];
  const assertions = new Map<number, PolicyInstruction>();
  const reclaimAccounts = new Set([
    walletAddress, treasuryAddress, SPL_TOKEN_PROGRAM, TOKEN_2022_PROGRAM,
    SystemProgram.programId.toBase58(), ComputeBudgetProgram.programId.toBase58(),
  ]);

  for (const [instructionIndex, rawInstruction] of transaction.transaction.message.instructions.entries()) {
    if (rawInstruction.programId.toBase58() === LIGHTHOUSE_PROGRAM) {
      const assertion = policyInstruction(rawInstruction);
      if (network !== "mainnet-beta" || !reclaimStarted || !isLighthouseAssertion(assertion) || assertions.size >= MAX_WALLET_ASSERTIONS) {
        return reject("The transaction contains an unsupported wallet assertion.");
      }
      guardStarted = true;
      assertions.set(instructionIndex, assertion);
      continue;
    }
    if (guardStarted) return reject("Wallet assertions must follow the reviewed reclaim instructions.");
    if (rawInstruction.programId.equals(ComputeBudgetProgram.programId)) {
      if (reclaimStarted) return reject("Compute-budget instructions must precede the reclaim.");
      const setting = verifyComputeBudget(rawInstruction);
      if (budgetSettings.has(setting)) return reject("The transaction contains duplicate compute-budget settings.");
      budgetSettings.add(setting);
      budgets.push(policyInstruction(rawInstruction));
      continue;
    }
    reclaimStarted = true;
    if (!isParsedInstruction(rawInstruction)) {
      return reject("The transaction contains an unrecognized instruction.");
    }
    const { type, info } = toInfo(rawInstruction);
    const programId = rawInstruction.programId.toBase58();

    if (programId === SystemProgram.programId.toBase58() && type === "transfer") {
      serviceTransfers += 1;
      if (
        infoString(info, "source") !== walletAddress ||
        infoString(info, "destination") !== treasuryAddress
      ) {
        return reject("The transaction fee was not sent from the wallet to the configured treasury.");
      }
      transferredFee += lamportsFor(info);
      continue;
    }

    if (
      (programId === SPL_TOKEN_PROGRAM || programId === TOKEN_2022_PROGRAM) &&
      type === "closeAccount"
    ) {
      if (
        infoString(info, "owner") !== walletAddress ||
        infoString(info, "destination") !== walletAddress
      ) {
        return reject("A token account was not closed back to the signing wallet.");
      }
      const account = infoString(info, "account");
      if (closedAccounts.includes(account)) {
        return reject("The transaction closes the same token account more than once.");
      }
      closedAccounts.push(account);
      reclaimAccounts.add(account);
      continue;
    }

    if (
      (programId === SPL_TOKEN_PROGRAM || programId === TOKEN_2022_PROGRAM) &&
      type === "burnChecked"
    ) {
      if (infoString(info, "authority") !== walletAddress) {
        return reject("A token burn was not authorized by the signing wallet.");
      }
      const tokenAmount = info.tokenAmount;
      if (typeof tokenAmount !== "object" || tokenAmount === null || !("amount" in tokenAmount)) {
        return reject("The transaction contains incomplete checked-burn token data.");
      }
      const amount = tokenAmount.amount;
      if (
        (typeof amount !== "number" && typeof amount !== "string") ||
        !/^\d+$/.test(String(amount)) ||
        BigInt(amount) <= 0n
      ) {
        return reject("The transaction contains an invalid token burn amount.");
      }
      const account = infoString(info, "account");
      if (burnedAccounts.has(account)) {
        return reject("The transaction burns the same token account more than once.");
      }
      burnedAccounts.add(account);
      reclaimAccounts.add(account);
      reclaimAccounts.add(infoString(info, "mint"));
      continue;
    }

    return reject("The transaction contains an instruction outside the reclaim flow.");
  }

  if (budgetSettings.size === 1) {
    return reject("The transaction contains incomplete compute-budget settings.");
  }
  if (budgets.length) {
    try { decodeComputeBudget(budgets); }
    catch { return reject("The compute-budget settings exceed the reclaim policy or are invalid."); }
  }
  for (const assertion of assertions.values()) {
    // The shared policy permits only one target plus the fixed Noop logger.
    if (!reclaimAccounts.has(assertion.accounts[0]!)) return reject("A wallet assertion targets an unrelated account.");
  }
  for (const account of transaction.transaction.message.accountKeys) {
    if ([LIGHTHOUSE_PROGRAM, LIGHTHOUSE_NOOP].includes(account.pubkey.toBase58()) && (account.signer || account.writable)) {
      return reject("A wallet assertion program has unexpected permissions.");
    }
  }
  // EncodedNoop logging invokes the fixed SPL Noop program with no accounts.
  // No other nested operation is allowed, including from token/system programs.
  for (const group of metadata.innerInstructions ?? []) {
    if (!group.instructions.length) continue;
    const parent = assertions.get(group.index);
    if (!parent || !usesNoopLogging(parent) || group.instructions.length > 64 ||
        group.instructions.some((instruction) =>
          instruction.programId.toBase58() !== LIGHTHOUSE_NOOP ||
          !("accounts" in instruction) || instruction.accounts.length !== 0 ||
          !("data" in instruction) || typeof instruction.data !== "string" || instruction.data.length > 8192)) {
      return reject("The transaction contains nested instructions outside wallet assertion logging.");
    }
  }
  if (
    closedAccounts.length === 0 ||
    [...burnedAccounts].some((account) => !closedAccounts.includes(account))
  ) {
    return reject("The transaction does not contain a valid set of reclaim closes and burns.");
  }

  const accountKeys = transaction.transaction.message.accountKeys.map((account) =>
    account.pubkey.toBase58(),
  );
  let grossLamports = 0n;
  for (const account of closedAccounts) {
    const index = accountKeys.indexOf(account);
    if (index < 0) return reject("A closed account is missing from the transaction balances.");
    const before = metadata.preBalances[index];
    const after = metadata.postBalances[index];
    if (
      !Number.isSafeInteger(before) ||
      !Number.isSafeInteger(after) ||
      before === undefined ||
      after !== 0 ||
      before <= 0
    ) {
      return reject("A closed account's recovered deposit could not be verified.");
    }
    grossLamports += BigInt(before);
  }

  const expectedFee = feeForGross(grossLamports, serviceFeeBps);
  if (expectedFee > BigInt(Number.MAX_SAFE_INTEGER)) {
    return reject("The configured service fee exceeds the safe transaction precision.");
  }
  const expectedTransferCount = expectedFee > 0n ? 1 : 0;
  if (
    serviceTransfers !== expectedTransferCount ||
    transferredFee !== expectedFee
  ) {
    return reject("The transaction does not pay the configured service fee.");
  }

  return {
    signature,
    walletAddress,
    network,
    accountCount: closedAccounts.length,
    burnCount: burnedAccounts.size,
    grossLamports: grossLamports.toString(),
    feeLamports: expectedFee.toString(),
    confirmedAt: new Date(
      (transaction.blockTime ?? Math.floor(Date.now() / 1000)) * 1000,
    ),
  };
}

export async function verifyReclaimSignature(args: {
  signature: string;
  walletAddress: string;
  network: ReclaimNetwork;
  serviceFeeBps: number;
  configuredTreasury: string | null;
  mainnetRpc: URL;
}): Promise<VerifiedReclaim> {
  const {
    signature,
    walletAddress: rawWalletAddress,
    network,
    serviceFeeBps,
    configuredTreasury,
    mainnetRpc,
  } = args;
  let walletAddress: string;
  try {
    walletAddress = new PublicKey(rawWalletAddress).toBase58();
  } catch {
    throw new ReclaimVerificationError("The wallet address is invalid.", 422);
  }

  const treasuryAddress = getTransactionTreasury(network, configuredTreasury);
  const rpcUrl =
    network === "devnet" ? "https://api.devnet.solana.com" : mainnetRpc.toString();
  const connection = new Connection(rpcUrl, "confirmed");

  let genesisHash: string;
  let status: Awaited<ReturnType<Connection["getSignatureStatuses"]>>["value"][number];
  let transaction: ParsedTransactionWithMeta | null;
  try {
    [genesisHash, status] = await Promise.all([
      connection.getGenesisHash(),
      connection
        .getSignatureStatuses([signature], { searchTransactionHistory: true })
        .then((response) => response.value[0]),
    ]);
    if (!status) {
      throw new ReclaimVerificationError(
        "The signature is not available on the configured Solana network yet.",
        409,
      );
    }
    if (status.err) {
      throw new ReclaimVerificationError(
        "The on-chain transaction failed.",
        422,
      );
    }
    if (
      status.confirmationStatus !== "confirmed" &&
      status.confirmationStatus !== "finalized"
    ) {
      throw new ReclaimVerificationError(
        "The signature has not reached confirmed status.",
        409,
      );
    }
    transaction = await connection.getParsedTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
  } catch (error) {
    if (error instanceof ReclaimVerificationError) throw error;
    throw new ReclaimVerificationError(
      "Solana RPC could not verify this signature. Try again shortly.",
      503,
    );
  }

  const expectedGenesis =
    network === "devnet" ? DEVNET_GENESIS_HASH : MAINNET_GENESIS_HASH;
  if (genesisHash !== expectedGenesis) {
    return reject("The signature was not found on the expected Solana network.");
  }
  if (!transaction) {
    throw new ReclaimVerificationError(
      "The confirmed transaction details are not available from RPC yet.",
      503,
    );
  }

  return verifyTransactionContents({
    transaction,
    signature,
    walletAddress,
    network,
    treasuryAddress,
    serviceFeeBps,
  });
}

