# POTIFY Roots Agent Gateway

```text
agent-gateway/
├── .env.example
├── .gitignore
├── package.json
├── package-lock.json
├── README.md
├── docs/
│   ├── DIRECTORY.md
│   ├── MARKETING.md
│   ├── PAYMENTS.md
│   └── WHITEPAPER.md
├── src/
│   ├── app.ts
│   ├── devnet-payment.ts
│   ├── inspection.ts
│   └── main.ts
└── test/
    └── gateway.test.ts
```

**Seed → Soil → Solana.** A POTIFY project that makes the existing Project Reclaim account scan usable by software and AI agents. Give it a Solana public wallet address and it returns the number of candidate empty token accounts and their estimated **gross** lamports, before all service and network fees.

## Current status

This is a **local prototype**, staged inside the Project Reclaim repository while a separate POTIFY project repository is unavailable. The REST and MCP summaries work locally. An optional x402 **devnet-only** payment challenge for detailed results exists, but a complete paid settlement has not been verified. Mainnet payments are disabled and no public service or directory listing is claimed.

The original Reclaim scanner does the account evaluation; this gateway does not reproduce or independently certify its rules. Reclaim's mainnet operation, wallet compatibility, and wallet security review remain unverified. The output is a best-effort snapshot, not a final quote or a promise that an account can be closed. No wallet connection, private key, signing, burning or transaction is performed by this gateway.

## Requirements and setup

Node.js 24 and npm. This folder imports the sibling `engine/` source from the parent repository, so both dependency installs are required:

```bash
git clone https://github.com/jonathanbabec5-hash/potify-reclaim-developer.git
cd potify-reclaim-developer
# Check out the branch containing this directory if it is not in main.
npm ci --legacy-peer-deps
cd agent-gateway
npm ci
npm test
npm start
```

The server binds **only to 127.0.0.1**, port 4021 by default. `SOLANA_RPC_URL` can be set to an operator-controlled Solana mainnet RPC; never supply it through an API request. The public endpoint is rate-limited and unsuitable as a production reliability guarantee. Do not put RPC credentials in GitHub or chat.

## Use the REST endpoint

```bash
curl -X POST http://127.0.0.1:4021/api/v1/reclaim-preview \
  -H 'Content-Type: application/json' \
  -d '{"wallet":"8Z5EqQdqR7efqXEFuHiZnepWPX9PPcWMoCujrctW3cdS"}'
```

The public wallet in the example is POTIFY's sponsor address. The response includes `candidateCount`, `estimatedGrossLamports`, a timestamp, explicit limitations, and POTIFY/Reclaim links. The summary deliberately omits individual account details. Different RPC reads can occur at different slots. No candidate is proof of closeability; recheck the source and obtain the wallet owner's approval before any real action.

## Use the MCP tool

Connect an MCP client with Streamable HTTP to `http://127.0.0.1:4021/mcp` and call `potify_reclaim_preview` with `{"wallet":"<public-address>"}`. The server uses a stateless JSON transport. Tests exercise a real SDK client against the local server.

## Payment experiment

`POST /api/v1/reclaim-details` is disabled by default. Setting `PAYMENTS_MODE=devnet` and `DEVNET_PAYMENT_RECIPIENT=<public-devnet-address>` enables an **x402 devnet** challenge at a provisional test price of $0.002 for that endpoint. It uses mainnet RPC only for read-only source data and devnet for the payment experiment. It is not configured to accept real USDC, and the challenge test does not prove a successful settlement. Never add a seed phrase or private key.

## Before a public or paid launch

See [payments](docs/PAYMENTS.md), [whitepaper](docs/WHITEPAPER.md), and [discovery plan](docs/MARKETING.md). Production needs a separately reviewed deployment, durable rate and abuse limits, bounded RPC workloads and suitable provider capacity, proper MCP origin controls, monitored failures, verified USDC account and key recovery, payment replay/idempotency and end-to-end settlement tests, public documentation, and actual marketplace or registry listings. A public Solana RPC and in-memory limiter alone are not a production service.

## Git setup for a separate repository

When the gateway is extracted into its own complete repository, first include the required Reclaim scanner as a properly versioned dependency or package. From that completed repository directory:

```bash
git init
git add .
git commit -m "Add POTIFY Roots agent gateway"
git branch -M main
git remote add origin https://github.com/YOUR-ACCOUNT/YOUR-REPOSITORY.git
git push -u origin main
```
