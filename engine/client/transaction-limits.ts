import bs58 from "bs58";
import { PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { LIGHTHOUSE_NOOP, LIGHTHOUSE_PROGRAM, MAX_WALLET_ASSERTIONS } from "@workspace/reclaim-policy";

export const MAX_TRANSACTION_BYTES = 1_232;

function shortVectorBytes(value: number): number {
  let bytes = 1;
  while (value >= 128) { value = Math.floor(value / 128); bytes++; }
  return bytes;
}

/**
 * Exact legacy wire length, including ALL required signature slots. Unlike SDK
 * serialize(), this can measure an oversized message without trying to sign it
 * or first writing it into a packet-sized buffer.
 */
export function transactionWireBytes(transaction: Transaction): number {
  const message = transaction.compileMessage();
  const signatures = message.header.numRequiredSignatures;
  return shortVectorBytes(signatures) + 64 * signatures +
    3 + shortVectorBytes(message.accountKeys.length) + 32 * message.accountKeys.length +
    32 + shortVectorBytes(message.instructions.length) +
    message.instructions.reduce((bytes, instruction) => {
      const dataLength = bs58.decode(instruction.data).length;
      return bytes + 1 + shortVectorBytes(instruction.accounts.length) + instruction.accounts.length +
        shortVectorBytes(dataLength) + dataLength;
    }, 0);
}

/**
 * Measured envelope, NOT a Solflare-specified universal allowance:
 * eight AssertAccountInfoMulti instructions, each with one lamport assertion,
 * EncodedNoop logging, and both permitted assertion program keys.
 * Longer assertions remain policy-eligible but may require smaller batches.
 * These instructions are size probes only; never insert them into a claim.
 */
export function measureAssertionHeadroom(transaction: Transaction) {
  if (!transaction.feePayer) throw new Error("A reclaim transaction requires a fee payer.");
  const probe = new Transaction({
    feePayer: transaction.feePayer,
    recentBlockhash: transaction.recentBlockhash,
  }).add(...transaction.instructions);
  for (let index = 0; index < MAX_WALLET_ASSERTIONS; index++) {
    probe.add(new TransactionInstruction({
      programId: new PublicKey(LIGHTHOUSE_PROGRAM),
      keys: [
        { pubkey: transaction.feePayer, isSigner: false, isWritable: false },
        { pubkey: new PublicKey(LIGHTHOUSE_NOOP), isSigner: false, isWritable: false },
      ],
      // AssertAccountInfoMulti(6), EncodedNoop(3), count(1),
      // Lamports(0), u64(0), GreaterThanOrEqual(4).
      data: Buffer.from([6, 3, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4]),
    }));
  }
  const serializedBytes = transactionWireBytes(transaction);
  const withAssertionsBytes = transactionWireBytes(probe);
  return { serializedBytes, withAssertionsBytes, reservedBytes: withAssertionsBytes - serializedBytes };
}

/** The connected wallet must be the only mainnet signer, and sign first. */
export function assertUnsignedWalletHandoff(transaction: Transaction, additionalSigners: readonly unknown[] = []) {
  if (additionalSigners.length || transaction.signatures.some(({ signature }) => signature !== null) ||
      transaction.compileMessage().header.numRequiredSignatures !== 1) {
    throw new Error("Mainnet approval requires an unsigned transaction with only the connected wallet as signer. Nothing was broadcast.");
  }
}

export class WalletTransactionSizeError extends Error {
  constructor(readonly serializedBytes: number) {
    super(`The wallet-protected transaction is too large (${serializedBytes}/${MAX_TRANSACTION_BYTES} bytes). Nothing was broadcast. Select fewer accounts and review a new, smaller transaction before approving again.`);
    this.name = "WalletTransactionSizeError";
  }
}

export function assertReturnedTransactionFits(transaction: Transaction) {
  const bytes = transactionWireBytes(transaction);
  if (bytes > MAX_TRANSACTION_BYTES) throw new WalletTransactionSizeError(bytes);
}
