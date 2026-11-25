# Project Reclaim

[Complete repository directory tree](docs/DIRECTORY.md)

**Original wallet engine and verification source.** Help wallet owners understand the documented rent-recovery fee and preview before trying the service.

### Setup and usage

Node.js 24 and npm. Run the install command before running the build checks. Run npm ci before npm run test:engine. The quote example itself uses only Node.js.

```sh
node examples/quote.mjs
```

Inspect the fee example. 

### Developer entry points

The original wallet engine scans token accounts, constructs a reviewable quote, handles wallet-added assertions and verifies submitted transaction contents. The service handoff and integer fee illustration are separate from the original policy package. Explore `app/`, `engine/`, `examples/`, `packages/`, `src/`, `tests/` in the full tree.

### Verification

The original wallet and verification sources passed 58 offline engine tests. The independent fee illustration and two service redirect tests also passed. No wallet connection or on-chain action was performed.

```sh
node --test tests/project.test.mjs
node --test tests/service-route.test.mjs
npm run test:engine
```

### Release scope

Public engine and verification source recovered from the original private repository. Mainnet operation, support review and live wallet compatibility remain unverified. No transaction or wallet action was performed. potify-reclaim at `ea60921eab412290ddbcb8bc7416b30a1985f2a7`. Official service redirect and existing regression tests. Added integer-lamport illustration. Actual fee rounding and network costs need confirmation against the original Replit builder. Original wallet engine, signature verification, assertion policy, review and offline tests recovered from potify-project-reclaim main at 5552c730cf5479c71a03220f6a83d3746b71746b.

[Technical whitepaper](docs/WHITEPAPER.md) · [Marketing and sales plan](docs/MARKETING.md) · [Dated developer log](docs/BUILD-LOG.md)

Existing asset and code terms remain applicable. Public access to a recording, illustration, brand or manuscript does not itself grant commercial reuse rights.
