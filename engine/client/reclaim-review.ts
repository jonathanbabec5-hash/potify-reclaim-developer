import type {
  ReclaimNetwork,
  ReclaimQuote,
  SelectionItem,
} from "./wallet";
import { quoteFingerprint } from "./wallet";

export type ReclaimReviewContext = {
  walletAddress: string;
  network: ReclaimNetwork;
  treasuryAddress: string;
  serviceFeeBps: number;
  selected: SelectionItem[];
};

/**
 * Binds consent to everything the user is reviewing, as well as the current
 * quote. A new scan, recipient, network, fee, action, balance, or quote cannot
 * inherit an acknowledgement made for older contents.
 */
export function reclaimReviewKey(
  context: ReclaimReviewContext,
  quote: ReclaimQuote,
): string {
  return JSON.stringify({
    walletAddress: context.walletAddress,
    network: context.network,
    treasuryAddress: context.treasuryAddress,
    serviceFeeBps: context.serviceFeeBps,
    selected: context.selected.map(({ account, burn }) => ({
      pubkey: account.pubkey,
      mint: account.mint,
      program: account.program,
      programId: account.programId,
      lamports: account.lamports.toString(),
      tokenAmount: account.tokenAmount.toString(),
      decimals: account.decimals,
      rawAmount: account.rawAmount,
      effectiveCloseAuthority: account.effectiveCloseAuthority,
      burn,
    })),
    quote: quoteFingerprint(quote),
  });
}

export function reviewAcknowledgementsComplete(input: {
  currentKey: string | null;
  acceptedKey: string | null;
  burnKey: string | null;
  hasBurn: boolean;
}): boolean {
  return (
    input.currentKey !== null &&
    input.acceptedKey === input.currentKey &&
    (!input.hasBurn || input.burnKey === input.currentKey)
  );
}

export function totalQuotedNetworkFees(quote: ReclaimQuote): bigint {
  return quote.batches.reduce(
    (total, batch) => total + batch.networkFeeLamports,
    0n,
  );
}
