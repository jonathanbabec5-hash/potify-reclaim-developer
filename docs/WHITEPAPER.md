# Project Reclaim
## Whitepaper · public developer edition

**November 25, 2026 · Original wallet engine and verification source**

### Goal and audience

Help wallet owners understand the documented rent-recovery fee and preview before trying the service. The immediate audience is solana wallet educators and users with old token accounts.

### Design and implementation

The original wallet engine scans token accounts, constructs a reviewable quote, handles wallet-added assertions and verifies submitted transaction contents. The service handoff and integer fee illustration are separate from the original policy package. Quote the gross recoverable rent, 18% service fee, network cost and net separately. The synthetic calculation is explanatory and cannot identify closable accounts.

### What a contributor can establish

The original wallet and verification sources passed 58 offline engine tests. The independent fee illustration and two service redirect tests also passed. No wallet connection or on-chain action was performed. A marketing page and a successful redirect cannot confirm wallet compatibility, ownership, support review or a mainnet reclaim. Review the real builder independently.

### Evidence and outstanding work

Public engine and verification source recovered from the original private repository. Mainnet operation, support review and live wallet compatibility remain unverified. No transaction or wallet action was performed. The next acceptance case is concrete. Verify redirect behavior and a sample gross, service fee and net before any real wallet interaction.

### Place in POTIFY

Count only reconciled service fees from confirmed real reclaims after wallet review and source parity. The marketing plan gives the test window and the evidence for a commercial outcome.

[Source provenance](source.json) · [Build log](BUILD-LOG.md) · [Marketing plan](MARKETING.md)
