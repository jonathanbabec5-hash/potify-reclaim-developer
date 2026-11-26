import { createApp } from './app.ts';
import { makeScanner } from './inspection.ts';
import { createDevnetPaymentGate } from './devnet-payment.ts';

// Bind to loopback for local development. This prototype is not a public deployment.
const port = Number(process.env.PORT || 4021);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');
const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const mode = process.env.PAYMENTS_MODE || 'disabled';
if (!['disabled','devnet'].includes(mode)) throw new Error('Only disabled or devnet payments are supported.');
if (mode === 'devnet' && !process.env.DEVNET_PAYMENT_RECIPIENT) throw new Error('DEVNET_PAYMENT_RECIPIENT is required for the test payment flow.');
const premiumGate = mode === 'devnet' ? createDevnetPaymentGate(process.env.DEVNET_PAYMENT_RECIPIENT!) : undefined;
createApp(makeScanner(rpcUrl), {premiumGate, paymentMode:mode as 'disabled'|'devnet'}).listen(port, '127.0.0.1', () => {
  console.log(`POTIFY Roots Agent Gateway listening at http://127.0.0.1:${port}`);
});
