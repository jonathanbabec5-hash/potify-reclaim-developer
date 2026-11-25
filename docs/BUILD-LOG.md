# November 25, 2026 · Project Reclaim

**Question.** Help wallet owners understand the documented rent-recovery fee and preview before trying the service.

**Source and change.** potify-reclaim at `ea60921eab412290ddbcb8bc7416b30a1985f2a7`. Official service redirect and existing regression tests. Added integer-lamport illustration. Actual fee rounding and network costs need confirmation against the original Replit builder. Original wallet engine, signature verification, assertion policy, review and offline tests recovered from potify-project-reclaim main at 5552c730cf5479c71a03220f6a83d3746b71746b.

**Observed result.** The original wallet and verification sources passed 58 offline engine tests. The independent fee illustration and two service redirect tests also passed. No wallet connection or on-chain action was performed.

```sh
node --test tests/project.test.mjs
node --test tests/service-route.test.mjs
npm run test:engine
```

**Next acceptance check.** Verify redirect behavior and a sample gross, service fee and net before any real wallet interaction.

**Owner and decision.** Chance owns the public release and approves campaign copy. Public engine and verification source recovered from the original private repository. Mainnet operation, support review and live wallet compatibility remain unverified. No transaction or wallet action was performed.

This dated record describes the developer package. Verify remote commit and tree in the publication receipt before announcing a GitHub release.
