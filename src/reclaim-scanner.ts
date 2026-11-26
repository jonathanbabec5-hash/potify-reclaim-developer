// Read-only scanner from POTIFY Project Reclaim. See docs/SOURCES.md.
import {
  ExtensionType,
  getExtensionTypes,
  getTransferFeeAmount,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";

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
