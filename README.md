# Project Reclaim

[Complete repository directory tree](docs/DIRECTORY.md)

**Recovered service handoff.** Help wallet owners understand the documented rent-recovery fee and preview before trying the service.

### Setup and usage

Use Node.js 24 for the included checks.

```sh
node examples/quote.mjs
```

Inspect the fee example. 

### Developer entry points

The source route forwards to the official service with a bounded set of placement tags. The public example expresses the fixed 18% fee in integer units. Explore `app/`, `examples/`, `src/`, `tests/` in the full tree.

### Verification

Two upstream redirect tests and one new fee arithmetic test passed. No account scan, burn, signature, transfer or on-chain reclaim was attempted.

```sh
node --test tests/project.test.mjs
node --test tests/service-route.test.mjs
```

### Release scope

The transaction builder, Solflare review and original Replit server remain outside this package. No wallet action is part of the example. potify-reclaim at `ea60921eab412290ddbcb8bc7416b30a1985f2a7`. Official service redirect and existing regression tests. Added integer-lamport illustration. Actual fee rounding and network costs need confirmation against the original Replit builder.

[Technical whitepaper](docs/WHITEPAPER.md) · [Marketing and sales plan](docs/MARKETING.md) · [Dated developer log](docs/BUILD-LOG.md)

Existing asset and code terms remain applicable. Public access to a recording, illustration, brand or manuscript does not itself grant commercial reuse rights.
