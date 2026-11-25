import {
  AccountState,
  createBurnCheckedInstruction,
  createCloseAccountInstruction,
  ExtensionType,
  getExtensionTypes,
  getTransferFeeAmount,
  unpackAccount,
  unpackMint,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  type BlockhashWithExpiryBlockHeight,
  type Signer,
} from "@solana/web3.js";
import type { WalletCompatibility } from "./wallet-signing";
import { MAX_TRANSACTION_BYTES, measureAssertionHeadroom } from "./transaction-limits";
export { MAX_TRANSACTION_BYTES } from "./transaction-limits";

export type WalletSendOptions = { inspectOnly?: boolean; compatibility?: WalletCompatibility };

export type WalletOption = { id: string; name: string };
export type WalletState = {
  wallets: WalletOption[];
  active: { name: string } | null;
  address: string | null;
  connecting: boolean;
  error: string | null;
  connect: (wallet: WalletOption) => Promise<void>;
  disconnect: () => Promise<void>;
  sendTransaction: (transaction: Transaction, signers?: Signer[], beforeBroadcast?: (signature: string) => void, options?: WalletSendOptions) => Promise<string>;
  connection: Connection;
};

export const LAMPORTS_PER_SOL = 1_000_000_000n;
export const MAX_COMPUTE_UNITS = 1_400_000;
// Explicit and bounded before quoting/signing; never accept a wallet-added fee.
export const PRIORITY_FEE_MICROLAMPORTS = 1_000n;
export const MAX_ACCOUNTS_PER_BATCH = 12;
export type ReclaimNetwork = "mainnet-beta" | "devnet";
export const GENESIS_HASHES = {
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
} as const;

export async function assertRpcNetwork(connection: Pick<Connection, "getGenesisHash">, network: ReclaimNetwork) {
  if (await connection.getGenesisHash() !== GENESIS_HASHES[network]) {
    throw new Error(`Wrong Solana network. Expected ${network}; no wallet approval or transaction will be requested.`);
  }
}

const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
const SAFE_ACCOUNT_EXTENSIONS = new Set([
  ExtensionType.ImmutableOwner,
  ExtensionType.TransferFeeAmount,
]);
const SAFE_MINT_EXTENSIONS = new Set([
  ExtensionType.TransferFeeConfig,
  ExtensionType.MetadataPointer,
  ExtensionType.TokenMetadata,
  ExtensionType.InterestBearingConfig,
  ExtensionType.ScaledUiAmountConfig,
]);

export type ScannedAccount = {
  pubkey: string;
  mint: string;
  program: "SPL" | "Token-2022";
  programId: string;
  lamports: bigint;
  tokenAmount: bigint;
  decimals: number;
  uiAmount: string;
  rawAmount: string;
  isEmpty: boolean;
  frozen: boolean;
  isWrappedSol: boolean;
  effectiveCloseAuthority: string;
  closeEligible: boolean;
  burnEligible: boolean;
  unsupportedReason?: string;
};

export type SelectionItem = { account: ScannedAccount; burn: boolean };
export type BatchQuote = {
  accountPubkeys: string[];
  transaction: Transaction;
  blockhash: string;
  lastValidBlockHeight: number;
  grossLamports: bigint;
  feeLamports: bigint;
  networkFeeLamports: bigint;
  computeUnits: number;
  serializedBytes: number;
};
export type ReclaimQuote = {
  batches: BatchQuote[];
  walletAddress: string;
  treasuryAddress: string;
  grossLamports: bigint;
  feeLamports: bigint;
  networkFeeLamports: bigint;
  netLamports: bigint;
  quotedAt: number;
};

export function short(addr: string, n = 4) {
  return addr.length > n * 2 + 3
    ? `${addr.slice(0, n)}…${addr.slice(-n)}`
    : addr;
}

export function fmtSol(lamports: bigint, decimals = 6) {
  const negative = lamports < 0n;
  const absolute = negative ? -lamports : lamports;
  const whole = absolute / LAMPORTS_PER_SOL;
  const fraction = (absolute % LAMPORTS_PER_SOL)
    .toString()
    .padStart(9, "0")
    .slice(0, decimals);
  return `${negative ? "-" : ""}${whole.toLocaleString()}.${fraction}`;
}

export function fmtToken(amount: bigint, decimals: number) {
  const unit = 10n ** BigInt(decimals);
  const whole = amount / unit;
  if (decimals === 0) return whole.toLocaleString();
  const fraction = (amount % unit)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return fraction
    ? `${whole.toLocaleString()}.${fraction}`
    : whole.toLocaleString();
}

function accountExtensionsSupported(
  extensionTypes: ExtensionType[],
  withheldAmount: bigint,
) {
  return (
    extensionTypes.every((extension) =>
      SAFE_ACCOUNT_EXTENSIONS.has(extension),
    ) && withheldAmount === 0n
  );
}

function mintExtensionsSupported(extensionTypes: ExtensionType[]) {
  return extensionTypes.every((extension) =>
    SAFE_MINT_EXTENSIONS.has(extension),
  );
}

export function feeForGross(grossLamports: bigint, serviceFeeBps: number) {
  if (!Number.isInteger(serviceFeeBps) || serviceFeeBps < 0 || serviceFeeBps >= 10_000) {
    throw new Error("The configured service fee is invalid.");
  }
  return (grossLamports * BigInt(serviceFeeBps)) / 10_000n;
}

export function evaluateAccountSafety(input: {
  connectedOwner: string;
  tokenOwner: string;
  closeAuthority: string | null;
  frozen: boolean;
  initialized: boolean;
  wrappedSol: boolean;
  extensionTypes: ExtensionType[];
  withheldAmount: bigint;
  amount: bigint;
  mintSupported: boolean;
}) {
  const effectiveAuthority = input.closeAuthority ?? input.tokenOwner;
  const baseSafe =
    effectiveAuthority === input.connectedOwner &&
    input.tokenOwner === input.connectedOwner &&
    !input.frozen &&
    input.initialized &&
    !input.wrappedSol &&
    accountExtensionsSupported(input.extensionTypes, input.withheldAmount);
  return {
    effectiveAuthority,
    closeEligible: baseSafe && input.amount === 0n,
    burnEligible: baseSafe && input.amount > 0n && input.mintSupported,
  };
}

export function partitionSelections<T>(items: T[], maxSize: number) {
  if (!Number.isInteger(maxSize) || maxSize < 1) {
    throw new Error("Batch size must be a positive integer.");
  }
  const groups: T[][] = [];
  for (let i = 0; i < items.length; i += maxSize) {
    groups.push(items.slice(i, i + maxSize));
  }
  return groups;
}

export function quoteFingerprint(quote: ReclaimQuote) {
  return JSON.stringify({
    walletAddress: quote.walletAddress,
    treasuryAddress: quote.treasuryAddress,
    grossLamports: quote.grossLamports.toString(),
    feeLamports: quote.feeLamports.toString(),
    networkFeeLamports: quote.networkFeeLamports.toString(),
    netLamports: quote.netLamports.toString(),
    batches: quote.batches.map((batch) => ({
      accountPubkeys: batch.accountPubkeys,
      grossLamports: batch.grossLamports.toString(),
      feeLamports: batch.feeLamports.toString(),
      networkFeeLamports: batch.networkFeeLamports.toString(),
      serializedBytes: batch.serializedBytes,
    })),
  });
}

function getTokenProgram(programId: string) {
  if (programId === TOKEN_PROGRAM_ID.toBase58()) return TOKEN_PROGRAM_ID;
  if (programId === TOKEN_2022_PROGRAM_ID.toBase58())
    return TOKEN_2022_PROGRAM_ID;
  throw new Error("The token account is owned by an unsupported program.");
}

export function createRpcConnection(proxyPath: string) {
  const url = new URL(proxyPath, window.location.origin);
  if (url.origin !== window.location.origin) {
    throw new Error("The RPC proxy must be on this site.");
  }
  return new Connection(url.toString(), {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 30_000,
  });
}

export async function scanWallet(
  connection: Connection,
  ownerAddress: string,
): Promise<ScannedAccount[]> {
  const wallet = new PublicKey(ownerAddress);
  const tokenPrograms = [
    [TOKEN_PROGRAM_ID, "SPL"],
    [TOKEN_2022_PROGRAM_ID, "Token-2022"],
  ] as const;
  const rawAccounts: Array<{
    address: PublicKey;
    tokenAccount: ReturnType<typeof unpackAccount>;
    programId: PublicKey;
    program: "SPL" | "Token-2022";
    lamports: bigint;
    baseReason?: string;
  }> = [];

  for (const [programId, program] of tokenPrograms) {
    const response = await connection.getTokenAccountsByOwner(
      wallet,
      { programId },
      "confirmed",
    );
    for (const entry of response.value) {
      if (!entry.account.owner.equals(programId)) continue;
      if (!Number.isSafeInteger(entry.account.lamports)) {
        rawAccounts.push({
          address: entry.pubkey,
          tokenAccount: unpackAccount(entry.pubkey, entry.account, programId),
          programId,
          program,
          lamports: 0n,
          baseReason:
            "The account balance exceeds safe integer precision and cannot be quoted.",
        });
        continue;
      }
      rawAccounts.push({
        address: entry.pubkey,
        tokenAccount: unpackAccount(entry.pubkey, entry.account, programId),
        programId,
        program,
        lamports: BigInt(entry.account.lamports),
      });
    }
  }

  const mintAddresses = [
    ...new Set(rawAccounts.map(({ tokenAccount }) => tokenAccount.mint.toBase58())),
  ];
  const mintInfoByAddress = new Map<
    string,
    Awaited<ReturnType<Connection["getAccountInfo"]>>
  >();
  for (let i = 0; i < mintAddresses.length; i += 100) {
    const chunk = mintAddresses.slice(i, i + 100).map((mint) => new PublicKey(mint));
    const infos = await connection.getMultipleAccountsInfo(chunk, "confirmed");
    chunk.forEach((mint, index) =>
      mintInfoByAddress.set(mint.toBase58(), infos[index] ?? null),
    );
  }

  return rawAccounts.map(
    ({ address, tokenAccount, programId, program, lamports, baseReason }) => {
      const mintAddress = tokenAccount.mint.toBase58();
      const accountExtensionTypes =
        programId.equals(TOKEN_2022_PROGRAM_ID)
          ? getExtensionTypes(tokenAccount.tlvData)
          : [];
      const withheldAmount =
        getTransferFeeAmount(tokenAccount)?.withheldAmount ?? 0n;
      const effectiveCloseAuthority = (
        tokenAccount.closeAuthority ?? tokenAccount.owner
      ).toBase58();
      const isEmpty = tokenAccount.amount === 0n;
      const isWrappedSol =
        tokenAccount.isNative || mintAddress === WRAPPED_SOL_MINT;
      const reasons: string[] = [];
      if (baseReason) reasons.push(baseReason);
      if (!tokenAccount.owner.equals(wallet)) {
        reasons.push("The account owner does not match the connected wallet.");
      }
      if (effectiveCloseAuthority !== wallet.toBase58()) {
        reasons.push("The effective close authority is another address.");
      }
      if (tokenAccount.isFrozen || !tokenAccount.isInitialized) {
        reasons.push("The token account is frozen or not initialized.");
      }
      if (isWrappedSol) {
        reasons.push("Wrapped SOL is excluded from automatic cleanup.");
      }
      if (
        !accountExtensionsSupported(accountExtensionTypes, withheldAmount)
      ) {
        reasons.push(
          withheldAmount > 0n
            ? "Withheld transfer fees remain in this account."
            : "This Token-2022 account uses an unsupported extension.",
        );
      }

      let mintDecimals = 0;
      let mintSupported = true;
      if (!isEmpty) {
        const mintInfo = mintInfoByAddress.get(mintAddress);
        if (!mintInfo || !mintInfo.owner.equals(programId)) {
          mintSupported = false;
          reasons.push("The mint could not be verified under its token program.");
        } else {
          try {
            const mint = unpackMint(tokenAccount.mint, mintInfo, programId);
            mintDecimals = mint.decimals;
            if (mint.decimals === 0) {
              mintSupported = false;
              reasons.push(
                "Zero-decimal assets are excluded to avoid burning an NFT or collectible.",
              );
            }
            const mintExtensionTypes =
              programId.equals(TOKEN_2022_PROGRAM_ID)
                ? getExtensionTypes(mint.tlvData)
                : [];
            if (!mintExtensionsSupported(mintExtensionTypes)) {
              mintSupported = false;
              reasons.push("This mint uses an unsupported Token-2022 extension.");
            }
          } catch {
            mintSupported = false;
            reasons.push("The token mint data could not be safely decoded.");
          }
        }
      }

      const safety = evaluateAccountSafety({
        connectedOwner: wallet.toBase58(),
        tokenOwner: tokenAccount.owner.toBase58(),
        closeAuthority: tokenAccount.closeAuthority?.toBase58() ?? null,
        frozen: tokenAccount.isFrozen,
        initialized: tokenAccount.isInitialized,
        wrappedSol: isWrappedSol,
        extensionTypes: accountExtensionTypes,
        withheldAmount,
        amount: tokenAccount.amount,
        mintSupported: mintSupported && !baseReason,
      });
      const closeEligible = safety.closeEligible && !baseReason;
      const burnEligible = safety.burnEligible && !baseReason;

      return {
        pubkey: address.toBase58(),
        mint: mintAddress,
        program,
        programId: programId.toBase58(),
        lamports,
        tokenAmount: tokenAccount.amount,
        decimals: mintDecimals,
        uiAmount: fmtToken(tokenAccount.amount, mintDecimals),
        rawAmount: tokenAccount.amount.toString(),
        isEmpty,
        frozen: tokenAccount.isFrozen,
        isWrappedSol,
        effectiveCloseAuthority,
        closeEligible,
        burnEligible,
        unsupportedReason: reasons[0],
      };
    },
  );
}

function makeTransaction(
  selections: SelectionItem[],
  wallet: PublicKey,
  treasury: PublicKey,
  serviceFeeBps: number,
  blockhash: BlockhashWithExpiryBlockHeight,
) {
  const transaction = new Transaction({
    feePayer: wallet,
    recentBlockhash: blockhash.blockhash,
  }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_COMPUTE_UNITS }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE_MICROLAMPORTS }),
  );
  let grossLamports = 0n;
  for (const selection of selections) {
    const { account, burn } = selection;
    const programId = getTokenProgram(account.programId);
    const tokenAccount = new PublicKey(account.pubkey);
    const mint = new PublicKey(account.mint);
    if (burn) {
      if (!account.burnEligible || account.tokenAmount <= 0n) {
        throw new Error("A selected burn is not eligible after verification.");
      }
      transaction.add(
        createBurnCheckedInstruction(
          tokenAccount,
          mint,
          wallet,
          account.tokenAmount,
          account.decimals,
          [],
          programId,
        ),
      );
    } else if (!account.closeEligible || !account.isEmpty) {
      throw new Error("A selected account is not eligible for closing.");
    }
    transaction.add(
      createCloseAccountInstruction(
        tokenAccount,
        wallet,
        wallet,
        [],
        programId,
      ),
    );
    grossLamports += account.lamports;
  }

  const feeLamports =
    feeForGross(grossLamports, serviceFeeBps);
  if (feeLamports > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("The service fee exceeds safe transaction precision.");
  }
  if (feeLamports > 0n) {
    transaction.add(
      SystemProgram.transfer({
        fromPubkey: wallet,
        toPubkey: treasury,
        lamports: Number(feeLamports),
      }),
    );
  }
  return { transaction, grossLamports, feeLamports };
}

async function prepareBatch(
  connection: Connection,
  selections: SelectionItem[],
  wallet: PublicKey,
  treasury: PublicKey,
  serviceFeeBps: number,
): Promise<BatchQuote[]> {
  const blockhash = await connection.getLatestBlockhash("confirmed");
  const { transaction, grossLamports, feeLamports } = makeTransaction(
    selections,
    wallet,
    treasury,
    serviceFeeBps,
    blockhash,
  );
  const { serializedBytes, withAssertionsBytes } = measureAssertionHeadroom(transaction);
  if (withAssertionsBytes > MAX_TRANSACTION_BYTES) {
    if (selections.length === 1) {
      throw new Error("A selected account cannot fit with reserved wallet security checks. Nothing will be sent for approval.");
    }
    const middle = Math.ceil(selections.length / 2);
    return [
      ...(await prepareBatch(
        connection,
        selections.slice(0, middle),
        wallet,
        treasury,
        serviceFeeBps,
      )),
      ...(await prepareBatch(
        connection,
        selections.slice(middle),
        wallet,
        treasury,
        serviceFeeBps,
      )),
    ];
  }

  const simulation = await connection.simulateTransaction(transaction);
  const computeUnits = simulation.value.unitsConsumed ?? MAX_COMPUTE_UNITS;
  if (
    simulation.value.err ||
    computeUnits > MAX_COMPUTE_UNITS
  ) {
    if (selections.length === 1) {
      throw new Error(
        `A selected account failed transaction simulation: ${JSON.stringify(simulation.value.err ?? "compute limit")}`,
      );
    }
    const middle = Math.ceil(selections.length / 2);
    return [
      ...(await prepareBatch(
        connection,
        selections.slice(0, middle),
        wallet,
        treasury,
        serviceFeeBps,
      )),
      ...(await prepareBatch(
        connection,
        selections.slice(middle),
        wallet,
        treasury,
        serviceFeeBps,
      )),
    ];
  }

  // Include the final budget in getFeeForMessage and in the exact message approved
  // by the wallet. The initial maximum-budget simulation provides the safe limit.
  const computeLimit = Math.min(
    MAX_COMPUTE_UNITS,
    Math.max(50_000, Math.ceil(computeUnits * 1.2) + 10_000),
  );
  transaction.instructions[0] = ComputeBudgetProgram.setComputeUnitLimit({ units: computeLimit });
  const fee = await connection.getFeeForMessage(
    transaction.compileMessage(),
    "confirmed",
  );
  if (fee.value === null || !Number.isSafeInteger(fee.value)) {
    throw new Error("The network fee could not be estimated safely.");
  }
  return [
    {
      accountPubkeys: selections.map(({ account }) => account.pubkey),
      transaction,
      blockhash: blockhash.blockhash,
      lastValidBlockHeight: blockhash.lastValidBlockHeight,
      grossLamports,
      feeLamports,
      networkFeeLamports: BigInt(fee.value),
      computeUnits,
      serializedBytes,
    },
  ];
}

export async function prepareQuote(args: {
  connection: Connection;
  network: ReclaimNetwork;
  walletAddress: string;
  treasuryAddress: string | null;
  serviceFeeBps: number;
  selected: SelectionItem[];
}): Promise<ReclaimQuote> {
  const { connection, walletAddress, treasuryAddress, serviceFeeBps, selected } =
    args;
  if (!treasuryAddress) {
    throw new Error("A valid treasury address is required before quoting.");
  }
  if (selected.length === 0) throw new Error("Select an account first.");
  if (
    !Number.isInteger(serviceFeeBps) ||
    serviceFeeBps < 0 ||
    serviceFeeBps >= 10_000
  ) {
    throw new Error("The configured service fee is invalid.");
  }

  const wallet = new PublicKey(walletAddress);
  const treasury = new PublicKey(treasuryAddress);
  await assertRpcNetwork(connection, args.network);
  const fresh = await scanWallet(connection, walletAddress);
  const freshByAddress = new Map(fresh.map((account) => [account.pubkey, account]));
  const verifiedSelections = selected.map(({ account, burn }) => {
    const latest = freshByAddress.get(account.pubkey);
    if (!latest || latest.lamports !== account.lamports) {
      throw new Error("An account balance changed. Scan again before reviewing.");
    }
    if (
      latest.tokenAmount !== account.tokenAmount ||
      latest.mint !== account.mint ||
      latest.effectiveCloseAuthority !== account.effectiveCloseAuthority
    ) {
      throw new Error("An account changed. Scan again before reviewing.");
    }
    if (burn ? !latest.burnEligible : !latest.closeEligible) {
      throw new Error(
        latest.unsupportedReason ?? "An account is no longer eligible.",
      );
    }
    return { account: latest, burn };
  });

  const initialGroups = partitionSelections(
    verifiedSelections,
    MAX_ACCOUNTS_PER_BATCH,
  );
  const batches: BatchQuote[] = [];
  for (const group of initialGroups) {
    batches.push(
      ...(await prepareBatch(
        connection,
        group,
        wallet,
        treasury,
        serviceFeeBps,
      )),
    );
  }

  const grossLamports = batches.reduce(
    (sum, batch) => sum + batch.grossLamports,
    0n,
  );
  const feeLamports = batches.reduce(
    (sum, batch) => sum + batch.feeLamports,
    0n,
  );
  const networkFeeLamports = batches.reduce(
    (sum, batch) => sum + batch.networkFeeLamports,
    0n,
  );
  const netLamports =
    grossLamports - feeLamports - networkFeeLamports;
  if (grossLamports <= 0n || netLamports <= 0n) {
    throw new Error("Estimated net recovery must be greater than zero.");
  }

  const balance = await connection.getBalance(wallet, "confirmed");
  if (!Number.isSafeInteger(balance) || BigInt(balance) < networkFeeLamports) {
    throw new Error(
      "Your wallet does not have enough SOL to cover the estimated network fee before recovery.",
    );
  }
  return {
    batches,
    walletAddress,
    treasuryAddress: treasury.toBase58(),
    grossLamports,
    feeLamports,
    networkFeeLamports,
    netLamports,
    quotedAt: Date.now(),
  };
}
