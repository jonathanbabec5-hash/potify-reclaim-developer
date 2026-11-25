/**
 * Public, synthetic account data for browser regression tests only.
 * Run with tsx and intercept JSON-RPC in the testing browser. No keys,
 * signatures, faucet requests, or real submissions are created here.
 */
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { AccountLayout, MintLayout, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

const wallet = new PublicKey(process.argv[2] ?? "2z8pKLbUNX2KYNCgd8kqdtChLdUacvhvRTCDfX9hxVxF");
const address = (label: string) => new PublicKey(createHash("sha256").update(`potify-ui-regression:${label}`).digest());
const accounts: Record<string, object[]> = {};
const infos: Record<string, object> = {};
const metadata: object[] = [];

for (const [label, program] of [["SPL", TOKEN_PROGRAM_ID], ["Token-2022", TOKEN_2022_PROGRAM_ID]] as const) {
  const mint = address(`${label}-mint`);
  const mintData = Buffer.alloc(MintLayout.span);
  MintLayout.encode({
    mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 100_000_000n,
    decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default,
  }, mintData);
  infos[mint.toBase58()] = {
    data: [mintData.toString("base64"), "base64"], executable: false,
    lamports: 1_461_600, owner: program.toBase58(), rentEpoch: 0, space: MintLayout.span,
  };
  accounts[program.toBase58()] = [];
  for (const kind of ["empty", "burnable", "unsupported"] as const) {
    const pubkey = address(`${label}-${kind}`);
    const amount = kind === "empty" ? 0n : 100_000_000n;
    const data = Buffer.alloc(AccountLayout.span);
    AccountLayout.encode({
      mint, owner: wallet, amount, delegateOption: 0, delegate: PublicKey.default,
      state: kind === "unsupported" ? 2 : 1,
      isNativeOption: 0, isNative: 0n, delegatedAmount: 0n,
      closeAuthorityOption: 0, closeAuthority: PublicKey.default,
    }, data);
    const account = {
      data: [data.toString("base64"), "base64"], executable: false,
      lamports: 2_039_280, owner: program.toBase58(), rentEpoch: 0, space: AccountLayout.span,
    };
    infos[pubkey.toBase58()] = account;
    accounts[program.toBase58()].push({ pubkey: pubkey.toBase58(), account });
    metadata.push({ program: label, kind, pubkey: pubkey.toBase58(), mint: mint.toBase58() });
  }
}
console.log(JSON.stringify({
  wallet: wallet.toBase58(), walletBytes: [...wallet.toBytes()], accounts, infos, metadata,
  blockhash: address("blockhash").toBase58(), lastValidBlockHeight: 999_999_999,
}));
