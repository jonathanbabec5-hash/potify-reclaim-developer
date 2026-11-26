# Source revisions

The HTTP and MCP gateway, payment experiment and original five tests came from [the gateway revision](https://github.com/jonathanbabec5-hash/potify-reclaim-developer/tree/c73d2688451bfe5f8010865a6712e5d6050e7d72/agent-gateway). The selected read-only scanner declarations came from [the Reclaim wallet module](https://github.com/jonathanbabec5-hash/potify-reclaim-developer/blob/1de4db4fe232a2e7c6074c1c079509c33fb95fa3/engine/client/wallet.ts). This edition carries the scanner in src/reclaim-scanner.ts and imports the Solana dependencies directly. A fresh checkout needs one npm install. No other repository, signer or private key is needed for the tests.

When updating the scanner, compare the upstream network check, extension allowlists, ownership checks, token formatting and scan logic. Run the scanner fixtures and the gateway tests before changing either source revision above.
