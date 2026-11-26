# Payment and wallet readiness

## Founder-directed destination

The requested mainnet recipient is the existing First Cycle sponsor wallet:

`8Z5EqQdqR7efqXEFuHiZnepWPX9PPcWMoCujrctW3cdS`

On November 26, 2026, a read-only finalized RPC check found 0.012995 SOL and no USDC token accounts for that owner. The signer exists in the protected First Cycle site runtime; independent owner-held recovery of the key has not been verified. Do not print, commit, export, paste or share private keys or seed phrases. Receiving in this wallet does not itself establish that Chance can independently recover it.

## Test before real money

1. The gateway currently supports `PAYMENTS_MODE=disabled` (default) and `PAYMENTS_MODE=devnet` only. The latter exposes a real x402 V2 payment challenge for a disposable devnet receiving address; the configured $0.002 is a provisional test price. No successful settlement is asserted by the challenge alone.
2. Use disposable devnet accounts and a compatible x402 V2 client. Confirm the exact asset, network, price and recipient, a successful settlement, the response, repeat/replay behavior, rejected invalid payments and uncharged RPC failures. Keep test credentials outside the repo.
3. For mainnet, independently verify owner recovery of the designated wallet. Verify whether its USDC associated token account exists and the current cost to create it. A November 26 RPC returned 1,488,440 lamports (0.00148844 SOL) for a 165-byte token account, excluding transaction fee. This is an estimate, not a transaction; recheck live. No account was created by this prototype.
4. Verify the facilitator supports x402 V2 exact Solana mainnet, recipient-account handling, its current credits and prices, and confirmation behavior. PayAI's read-only support endpoint advertised the exact Solana mainnet scheme and the sponsor address showed free credits available on November 26. This is not a promise of future free or unlimited settlement. The paid route is deliberately not enabled for mainnet.
5. Use a suitable production RPC, external abuse limits, replay/idempotency controls across instances, secret management and logging controls. Gate public launch on reviewed end-to-end tests and an actual listing, then record a verifiable receipt for the first real payment. Do not charge clients for a failed lookup.

Receiving USDC uses the same owner public address but a separate token account; it is not a direct SOL payment. Facilitator gas sponsorship does not by itself create the recipient token account or guarantee coverage of its rent.

References: https://solana.com/developers/docs/payments/agentic-payments/x402 and https://facilitator.payai.network/.
