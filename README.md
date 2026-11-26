# Project Reclaim

[Complete repository directory tree](docs/DIRECTORY.md)

## The most useful number is what remains

‘Recoverable’ can sound like money already in your pocket. The useful work in Project Reclaim happens before a signature: what could be recovered, what comes out of it and what would actually remain? A reader should be able to check that arithmetic on paper.

The [integer illustration](src/quote.mjs) gives a small example: 2,000,000 lamports gross, 360,000 for the 18% service fee, and 5,000 assumed network cost leave 1,635,000. The [offline tests](tests/project.test.mjs) and the recovered engine are separate evidence. The recorded 58 engine tests are not a completed live-wallet claim.

Read a fictional quote and identify the gross, service fee, network cost and estimated net. Flag the first label that could be mistaken for the amount received. Reclaim is POTIFY-developed, in Phantom early access. Review the net before signing; optional burns are irreversible. Stop on wallet warnings.

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
