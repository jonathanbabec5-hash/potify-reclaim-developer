# POTIFY Roots Agent Gateway: Technical Paper

## Goal

Make a useful, verifiable part of POTIFY Project Reclaim accessible to software and AI agents: a read-only preview of candidate token accounts and their gross locked lamports. This is a separate POTIFY project connected to Reclaim, not a new token or a claim that the entire ecosystem is complete.

## Data and behavior

The existing Reclaim scanner requests SPL and Token-2022 accounts from a Solana RPC and applies its source rules for account state, authority and supported extensions. It currently excludes wrapped SOL, frozen accounts, unsupported extensions, and other conditions defined in the parent engine. The gateway reports counts and gross amounts, with a maximum of 100 candidate details in the experimental detail route. Numeric lamports are strings to avoid precision loss. Source and timestamp accompany each result; the snapshot can span slots.

An HTTP API and a stateless MCP endpoint expose the free summary. They accept one public address, never private keys. The prototype binds to loopback and includes a small per-process rate limit; neither replaces public origin enforcement, durable rate limiting or provider-side controls. It performs no signing, burn, close, transfer, wallet connection or changes to on-chain state.

## Commercial model

Free summaries are intended to help agents discover the service. Detailed candidate results are reserved for a possible paid route. The included x402 integration accepts only a devnet test challenge; $0.002 is a development assumption, not a live offer. Fee economics, client interoperability, full settlement and replay protection must be independently validated before sale. Gross estimated account value is not a net quote; the separate Reclaim product has its own fee and security review.

## Boundaries and open work

No launch, payment, customer, integration with Potify ID or Green Light Pay, direct wallet recovery, or exchange listing is implied. A live service needs bounded scan work for large wallets; reliable RPC; abuse protection; MCP origin security; privacy-safe observability; resilient idempotency; accurate fee estimates and record freshness; live authorization checks; and clear customer support. Use the existing mainnet wallet only after independent owner recovery is verified.

## Sources

- Project Reclaim scanner: `engine/client/wallet.ts` in the parent repository.
- Solana x402: https://solana.com/developers/docs/payments/agentic-payments/x402
- MCP Registry requirements: https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/official-registry-requirements.md
- Solana RPC limits: https://solana.com/developers/docs/rpc
