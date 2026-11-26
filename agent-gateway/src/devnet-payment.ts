import { PublicKey } from '@solana/web3.js';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactSvmScheme } from '@x402/svm/exact/server';

// Testnet only. Mainnet payments must not be enabled until recipient setup,
// end-to-end settlement, abuse controls, and production hosting are verified.
export function createDevnetPaymentGate(recipient: string) {
  const payTo = new PublicKey(recipient).toBase58();
  const network = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
  const facilitator = new HTTPFacilitatorClient({url:'https://facilitator.payai.network'});
  const server = new x402ResourceServer(facilitator).register(network, new ExactSvmScheme());
  return paymentMiddleware({
    'POST /api/v1/reclaim-details': {
      accepts:[{scheme:'exact', price:'$0.002', network, payTo}],
      description:'Testnet-only POTIFY Reclaim candidate details. No actual SOL is recovered.',
      mimeType:'application/json',
    },
  }, server);
}
