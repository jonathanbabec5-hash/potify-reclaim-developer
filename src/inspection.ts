import { Connection, PublicKey } from '@solana/web3.js';
import { assertRpcNetwork, scanWallet } from './reclaim-scanner.ts';

export class InvalidWalletError extends Error {}
export type Candidate = {
  pubkey: string;
  mint: string;
  program: 'SPL' | 'Token-2022';
  lamports: bigint;
  closeEligible: boolean;
  unsupportedReason?: string;
};
export type Scanner = (wallet: string) => Promise<Candidate[]>;

export function makeScanner(rpcUrl: string): Scanner {
  const rpc = new Connection(rpcUrl, {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
    fetch: (url, init) => fetch(url, {...init, signal: AbortSignal.timeout(12000)}),
  });
  return async wallet => {
    await assertRpcNetwork(rpc, 'mainnet-beta');
    return scanWallet(rpc, wallet);
  };
}

export async function inspectWallet(wallet: unknown, scan: Scanner) {
  if (typeof wallet !== 'string' || wallet.length < 32 || wallet.length > 44) throw new InvalidWalletError();
  let canonical: string;
  try { canonical = new PublicKey(wallet).toBase58(); } catch { throw new InvalidWalletError(); }
  if (canonical !== wallet) throw new InvalidWalletError();
  const accounts = await scan(canonical);
  const candidates = accounts.filter(account => account.closeEligible);
  const gross = candidates.reduce((sum, account) => sum + account.lamports, 0n);
  return {
    project: 'POTIFY Roots Agent Gateway',
    source: 'Project Reclaim account scanner; Solana mainnet RPC',
    wallet: canonical,
    network: 'solana:mainnet',
    observedAt: new Date().toISOString(),
    consistency: 'RPC reads may span multiple slots; recheck before any action.',
    totalTokenAccounts: accounts.length,
    candidateCount: candidates.length,
    estimatedGrossLamports: gross.toString(),
    shownCandidates: candidates.slice(0, 100).map(account => ({
      account: account.pubkey, mint: account.mint, tokenProgram: account.program,
      grossLamports: account.lamports.toString(),
    })),
    omittedCandidateCount: Math.max(0, candidates.length - 100),
    excludedCount: accounts.length - candidates.length,
    limitations: [
      'Read-only estimate, not a transaction or guarantee that an account can be closed.',
      'Gross amount is before service and network fees; it is not the amount the wallet receives.',
      'No wallet connection, signature, token burn, or funds movement is performed.',
      'The source scanner is not a completed live wallet compatibility or security review.',
    ],
    projectLinks: {
      potify: 'https://potifywebsite.com/',
      projectReclaim: 'https://github.com/jonathanbabec5-hash/potify-reclaim-developer',
    },
  };
}
