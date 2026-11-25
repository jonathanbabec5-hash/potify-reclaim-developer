import type { Connection, SignatureStatus } from "@solana/web3.js";

export function signatureState(status: SignatureStatus | null) {
  if (status?.err) return "failed" as const;
  if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
    return "confirmed" as const;
  }
  return "pending" as const;
}

/** A processed signature is never treated as absent, even after expiry. */
export function absentAfterExpiry(status: SignatureStatus | null, finalizedHeight: number, lastValidHeight: number) {
  return status === null && finalizedHeight > lastValidHeight;
}

/** Confirmation for an HTTP-only JSON-RPC proxy; never opens a WebSocket. */
export async function confirmTransactionHttp(
  connection: Pick<Connection, "getSignatureStatuses" | "getBlockHeight">,
  signature: string,
  lastValidBlockHeight: number,
  options: { pollIntervalMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 90_000);
  do {
    const response = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
    const status = response.value[0];
    if (signatureState(status) === "failed") {
      throw new Error(`The transaction failed on-chain: ${JSON.stringify(status?.err)}. Signature: ${signature}`);
    }
    if (signatureState(status) === "confirmed") return;
    if (await connection.getBlockHeight("confirmed") > lastValidBlockHeight) {
      throw new Error(`Transaction blockhash expired before confirmation was observed. Status will be rechecked before retrying. Signature: ${signature}`);
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs ?? 3_000));
  } while (Date.now() < deadline);
  throw new Error(`Transaction confirmation is still pending. Status will be rechecked. Signature: ${signature}`);
}
