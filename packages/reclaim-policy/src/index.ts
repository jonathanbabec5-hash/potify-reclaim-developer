export const LIGHTHOUSE_PROGRAM = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";
export const LIGHTHOUSE_NOOP = "noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV";
export const COMPUTE_PROGRAM = "ComputeBudget111111111111111111111111111111";
export const MAX_PRIORITY_LAMPORTS = 100_000n;
export const MAX_WALLET_ASSERTIONS = 8;
export type PolicyInstruction = { program: string; accounts: string[]; data: Uint8Array };

// The mainnet Lighthouse program is immutable. These enum branches only assert
// on ONE target; an optional fixed read-only Noop program supports logging.
// 0/1 write/close memory and 4 (delta) are intentionally excluded.
// See docs/solflare-signing.md for source and read-only deployment evidence.
const READ_ONLY_ASSERTIONS = new Set([2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17]);
// Borsh 0.10 / generated client wire ordinals, NOT Rust's repr(u8)
// discriminants. Failed* modes serialize as 4/5/6, not 0x10/0x11/0x12.
const LOG_LEVELS = new Set([0, 1, 2, 3, 4, 5, 6]);
export function lighthouseAssertionError(instruction: PolicyInstruction): string | null {
  if (instruction.program !== LIGHTHOUSE_PROGRAM) return "unsupported program";
  const noopLogger = instruction.accounts.length === 2 &&
    instruction.accounts[1] === LIGHTHOUSE_NOOP && [3, 6].includes(instruction.data[1]!);
  if (instruction.accounts.length !== 1 && !noopLogger) return `expected one target with optional Noop logger, received ${instruction.accounts.length}`;
  if (instruction.data.length < 3 || instruction.data.length > 512) return `invalid payload length ${instruction.data.length}`;
  if (!READ_ONLY_ASSERTIONS.has(instruction.data[0]!)) return `unsupported operation ${instruction.data[0]}`;
  if (!LOG_LEVELS.has(instruction.data[1]!)) return `invalid logging mode ${instruction.data[1]}`;
  return null;
}
export function isLighthouseAssertion(instruction: PolicyInstruction): boolean {
  return lighthouseAssertionError(instruction) === null;
}
export function usesNoopLogging(instruction: PolicyInstruction): boolean {
  return isLighthouseAssertion(instruction) && [3, 6].includes(instruction.data[1]!);
}

export function decodeComputeBudget(instructions: PolicyInstruction[]) {
  if (instructions.length !== 2) throw new Error("Two explicit compute settings are required.");
  let units: number | undefined;
  let price: bigint | undefined;
  for (const instruction of instructions) {
    if (instruction.program !== COMPUTE_PROGRAM || instruction.accounts.length) throw new Error("Invalid compute-budget accounts or program.");
    const data = instruction.data;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (data[0] === 2 && data.length === 5 && units === undefined) units = view.getUint32(1, true);
    else if (data[0] === 3 && data.length === 9 && price === undefined) price = view.getBigUint64(1, true);
    else throw new Error("Unsupported or duplicate compute-budget setting.");
  }
  if (units === undefined || price === undefined || units < 1 || units > 1_400_000) throw new Error("Invalid compute-unit limit.");
  const priorityLamports = (BigInt(units) * price + 999_999n) / 1_000_000n;
  if (priorityLamports > MAX_PRIORITY_LAMPORTS) throw new Error("Wallet priority cost exceeds the safety limit.");
  return { units, price, priorityLamports };
}

function sameInstruction(a: PolicyInstruction, b: PolicyInstruction) {
  return a.program === b.program &&
    a.accounts.length === b.accounts.length && a.accounts.every((key, i) => key === b.accounts[i]) &&
    a.data.length === b.data.length && a.data.every((byte, i) => byte === b.data[i]);
}

/** Only budget replacements and a bounded suffix of pure assertions may differ. */
export function validateWalletInstructions(expected: PolicyInstruction[], actual: PolicyInstruction[]) {
  decodeComputeBudget(expected.slice(0, 2));
  decodeComputeBudget(actual.slice(0, 2));
  const body = expected.slice(2);
  if (!body.length || actual.length < expected.length ||
      !body.every((instruction, i) => sameInstruction(instruction, actual[i + 2]!))) {
    throw new Error("The wallet changed a reviewed reclaim instruction.");
  }
  const assertions = actual.slice(expected.length);
  if (assertions.length > MAX_WALLET_ASSERTIONS) {
    throw new Error("The wallet added too many assertions.");
  }
  for (const [index, instruction] of assertions.entries()) {
    const error = lighthouseAssertionError(instruction);
    if (error) throw new Error(`Wallet instruction ${expected.length + index + 1}: ${error}.`);
  }
  return assertions;
}
