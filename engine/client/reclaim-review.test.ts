import assert from "node:assert/strict";
import test from "node:test";
import type { ReclaimQuote, SelectionItem } from "./wallet";
import {
  reclaimReviewKey,
  reviewAcknowledgementsComplete,
  totalQuotedNetworkFees,
} from "./reclaim-review";

const wallet = "synthetic-wallet-address";
const treasury = "synthetic-treasury-address";
const account = (overrides: Record<string, unknown> = {}) => ({
  pubkey: "synthetic-account",
  mint: "synthetic-mint",
  program: "SPL" as const,
  programId: "synthetic-token-program",
  lamports: 2_039_280n,
  tokenAmount: 100n,
  decimals: 2,
  uiAmount: "1",
  rawAmount: "100",
  isEmpty: false,
  frozen: false,
  isWrappedSol: false,
  effectiveCloseAuthority: wallet,
  closeEligible: true,
  burnEligible: true,
  ...overrides,
});
const selection = (burn = true, accountOverrides: Record<string, unknown> = {}) =>
  [{ account: account(accountOverrides), burn }] as unknown as SelectionItem[];

function quote(overrides: Record<string, unknown> = {}): ReclaimQuote {
  return {
    walletAddress: wallet,
    treasuryAddress: treasury,
    grossLamports: 2_039_280n,
    feeLamports: 367_070n,
    networkFeeLamports: 5_050n,
    netLamports: 1_667_160n,
    quotedAt: 10,
    batches: [{
      accountPubkeys: ["synthetic-account"],
      transaction: {} as ReclaimQuote["batches"][number]["transaction"],
      blockhash: "synthetic-blockhash",
      lastValidBlockHeight: 0,
      grossLamports: 2_039_280n,
      feeLamports: 367_070n,
      networkFeeLamports: 5_050n,
      computeUnits: 100_000,
      serializedBytes: 338,
    }],
    ...overrides,
  } as ReclaimQuote;
}

const context = (overrides: Record<string, unknown> = {}) => ({
  walletAddress: wallet,
  network: "mainnet-beta" as const,
  treasuryAddress: treasury,
  serviceFeeBps: 1_800,
  selected: selection(),
  ...overrides,
});

test("approval is bound to the exact selection, economics, destination, and network", () => {
  const baseQuote = quote();
  const baseContext = context();
  const accepted = reclaimReviewKey(baseContext, baseQuote);
  assert.equal(
    reviewAcknowledgementsComplete({
      currentKey: accepted,
      acceptedKey: accepted,
      burnKey: accepted,
      hasBurn: true,
    }),
    true,
  );

  const changedCases = [
    context({ selected: selection(true, { rawAmount: "101", tokenAmount: 101n }) }),
    context({ selected: selection(false) }),
    context({ treasuryAddress: "different-treasury" }),
    context({ walletAddress: "different-wallet" }),
    context({ network: "devnet" }),
    context({ serviceFeeBps: 1_900 }),
  ];
  for (const changedContext of changedCases) {
    const changedKey = reclaimReviewKey(changedContext, baseQuote);
    assert.notEqual(changedKey, accepted);
    assert.equal(
      reviewAcknowledgementsComplete({
        currentKey: changedKey,
        acceptedKey: accepted,
        burnKey: accepted,
        hasBurn: true,
      }),
      false,
    );
  }

  const changedQuote = quote({
    feeLamports: 367_071n,
    networkFeeLamports: 5_051n,
    netLamports: 1_667_158n,
    batches: [{
      ...baseQuote.batches[0],
      feeLamports: 367_071n,
      networkFeeLamports: 5_051n,
    }],
  });
  const changedQuoteKey = reclaimReviewKey(baseContext, changedQuote);
  assert.notEqual(changedQuoteKey, accepted);
  assert.equal(
    reviewAcknowledgementsComplete({
      currentKey: changedQuoteKey,
      acceptedKey: accepted,
      burnKey: accepted,
      hasBurn: true,
    }),
    false,
  );
});

test("burn acknowledgement is mandatory, while an empty close still needs quote review", () => {
  const currentKey = reclaimReviewKey(
    context({ selected: selection(false, { isEmpty: true, tokenAmount: 0n }) }),
    quote(),
  );
  assert.equal(
    reviewAcknowledgementsComplete({
      currentKey,
      acceptedKey: currentKey,
      burnKey: null,
      hasBurn: false,
    }),
    true,
  );
  assert.equal(
    reviewAcknowledgementsComplete({
      currentKey,
      acceptedKey: currentKey,
      burnKey: null,
      hasBurn: true,
    }),
    false,
  );
  assert.equal(
    reviewAcknowledgementsComplete({
      currentKey,
      acceptedKey: null,
      burnKey: currentKey,
      hasBurn: false,
    }),
    false,
  );
});

test("network cost is the sum of the current individually quoted batches", () => {
  const currentQuote = quote({
    networkFeeLamports: 10_100n,
    batches: [
      { ...quote().batches[0], networkFeeLamports: 5_050n },
      { ...quote().batches[0], networkFeeLamports: 5_050n },
    ],
  });
  assert.equal(totalQuotedNetworkFees(currentQuote), 10_100n);
});
