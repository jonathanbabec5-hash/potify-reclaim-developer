import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey, type Connection } from '@solana/web3.js';
import { AccountLayout, AccountState, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { assertRpcNetwork, GENESIS_HASHES, scanWallet } from '../src/reclaim-scanner.ts';

const owner = new PublicKey(new Uint8Array(32).fill(1));
const mint = new PublicKey(new Uint8Array(32).fill(2));
const address = new PublicKey(new Uint8Array(32).fill(3));

test('both token programs are scanned and an initialized owned empty SPL account is eligible', async () => {
  const programs: string[] = [];
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode({
    mint, owner, amount: 0n, delegateOption: 0, delegate: PublicKey.default,
    state: AccountState.Initialized, isNativeOption: 0, isNative: 0n,
    delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default,
  }, data);
  const rpc = {
    getTokenAccountsByOwner: async (_owner: PublicKey, { programId }: { programId: PublicKey }) => {
      programs.push(programId.toBase58());
      return { value: programId.equals(TOKEN_PROGRAM_ID)
        ? [{pubkey: address, account: {data, owner: programId, lamports: 2039280}}] : [] };
    },
    getMultipleAccountsInfo: async () => [null],
  } as unknown as Connection;
  const rows = await scanWallet(rpc, owner.toBase58());
  assert.deepEqual(programs, [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map(id => id.toBase58()));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].closeEligible, true);
  assert.equal(rows[0].lamports, 2039280n);
});

test('the configured RPC must report the selected genesis hash', async () => {
  const rpc = { getGenesisHash: async () => GENESIS_HASHES.devnet };
  await assertRpcNetwork(rpc, 'devnet');
  await assert.rejects(assertRpcNetwork(rpc, 'mainnet-beta'), /Wrong Solana network/);
});
