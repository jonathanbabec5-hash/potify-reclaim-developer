# Project Reclaim
## Whitepaper · public developer edition

**November 25, 2026 · Recovered service handoff**

### Goal and audience

Help wallet owners understand the documented rent-recovery fee and preview before trying the service. The immediate audience is solana wallet educators and users with old token accounts.

### Design and implementation

The source route forwards to the official service with a bounded set of placement tags. The public example expresses the fixed 18% fee in integer units. Quote the gross recoverable rent, 18% service fee, network cost and net separately. The synthetic calculation is explanatory and cannot identify closable accounts.

### What a contributor can establish

Two upstream redirect tests and one new fee arithmetic test passed. No account scan, burn, signature, transfer or on-chain reclaim was attempted. A marketing page and a successful redirect cannot confirm wallet compatibility, ownership, support review or a mainnet reclaim. Review the real builder independently.

### Evidence and outstanding work

The transaction builder, Solflare review and original Replit server remain outside this package. No wallet action is part of the example. The next acceptance case is concrete. Verify redirect behavior and a sample gross, service fee and net before any real wallet interaction.

### Place in POTIFY

Count only reconciled service fees from confirmed real reclaims after wallet review and source parity. The marketing plan gives the test window and the evidence for a commercial outcome.

[Source provenance](source.json) · [Build log](BUILD-LOG.md) · [Marketing plan](MARKETING.md)
