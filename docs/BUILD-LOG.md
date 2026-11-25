# November 25, 2026 · Project Reclaim

**Question.** Help wallet owners understand the documented rent-recovery fee and preview before trying the service.

**Source and change.** potify-reclaim at `ea60921eab412290ddbcb8bc7416b30a1985f2a7`. Official service redirect and existing regression tests. Added integer-lamport illustration. Actual fee rounding and network costs need confirmation against the original Replit builder.

**Observed result.** Two upstream redirect tests and one new fee arithmetic test passed. No account scan, burn, signature, transfer or on-chain reclaim was attempted.

```sh
node --test tests/project.test.mjs
node --test tests/service-route.test.mjs
```

**Next acceptance check.** Verify redirect behavior and a sample gross, service fee and net before any real wallet interaction.

**Owner and decision.** Chance owns the public release and approves campaign copy. The transaction builder, Solflare review and original Replit server remain outside this package. No wallet action is part of the example.

This dated record describes the developer package. Verify remote commit and tree in the publication receipt before announcing a GitHub release.
