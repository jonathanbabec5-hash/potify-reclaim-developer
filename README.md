# POTIFY Roots Agent Gateway

[Complete tracked tree](docs/DIRECTORY.md) · [Whitepaper](docs/WHITEPAPER.md) · [Marketing and sales plan](docs/MARKETING.md) · [Source revisions](docs/SOURCES.md)

An agent supplies a public Solana address to receive a read-only estimate of rent in eligible empty token accounts. The HTTP and MCP summary both report gross lamports before fees. See the source revision notes for the exact Reclaim scanner behind the estimate.

## Run locally

Use Node.js 24 and npm. From the repository root:

```sh
npm ci
npm test
npm start
```

The server binds to 127.0.0.1:4021. Offline tests use synthetic inputs and a local HTTP server. Live preview calls require a reachable Solana RPC. Payments default to disabled.

## Use the REST endpoint

```bash
curl -X POST http://127.0.0.1:4021/api/v1/reclaim-preview \
  -H 'Content-Type: application/json' \
  -d '{"wallet":"8Z5EqQdqR7efqXEFuHiZnepWPX9PPcWMoCujrctW3cdS"}'
```

The example takes a public address. The response includes `candidateCount`, `estimatedGrossLamports`, a timestamp, explicit limitations, and POTIFY/Reclaim links. The summary deliberately omits individual account details. Different RPC reads can occur at different slots. No candidate is proof of closeability; recheck the source and obtain the wallet owner's approval before any real action.

## Use the MCP tool

Connect an MCP client with Streamable HTTP to `http://127.0.0.1:4021/mcp` and call `potify_reclaim_preview` with `{"wallet":"<public-address>"}`. The server uses a stateless JSON transport. Tests exercise a real SDK client against the local server.

## Payment experiment

`POST /api/v1/reclaim-details` is disabled by default. Setting `PAYMENTS_MODE=devnet` and `DEVNET_PAYMENT_RECIPIENT=<public-devnet-address>` enables an **x402 devnet** challenge at a provisional test price of $0.002 for that endpoint. It uses mainnet RPC only for read-only source data and devnet for the payment experiment. It is not configured to accept real USDC, and the challenge test does not prove a successful settlement. Never add a seed phrase or private key.

## Before a public or paid launch

See [payments](docs/PAYMENTS.md), [whitepaper](docs/WHITEPAPER.md), and [discovery plan](docs/MARKETING.md). Production needs a separately reviewed deployment, durable rate and abuse limits, bounded RPC workloads and suitable provider capacity, proper MCP origin controls, monitored failures, verified USDC account and key recovery, payment replay/idempotency and end-to-end settlement tests, public documentation, and actual marketplace or registry listings. A public Solana RPC and in-memory limiter alone are not a production service.

## Publish a fresh GitHub repository

From a new directory containing this edition’s files, use a GitHub account that can create repositories under the intended owner.

```sh
git init -b main
git add .
git commit -m "Publish standalone POTIFY Roots Agent Gateway"
gh repo create jonathanbabec5-hash/potify-roots-agent-gateway --public --source=. --remote=origin --push
```
