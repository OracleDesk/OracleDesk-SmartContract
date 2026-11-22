import { createHash } from "node:crypto";

export interface OperationHashInput {
  target: string;
  fn: string;
  argsXdr: string[];
  predecessor?: string;
  salt?: string;
}

export type OperationHashHook = (input: OperationHashInput) => string | undefined;

let hook: OperationHashHook | undefined;
let lastSource: "local-preview" | "hook" = "local-preview";

export function setOperationHashHook(next: OperationHashHook | undefined): void {
  hook = next;
}

export function operationHashSource(): "local-preview" | "hook" {
  return lastSource;
}

/**
 * TODO: replace this preview with the on-chain operation hash when the timelock
 * gains one; see `docs/adr/0008-governance-timelock.md` and issue #261. Until
 * then this is recorded for review only, never used for ordering.
 */
export function hashOperation(input: OperationHashInput): string {
  const fromHook = hook?.(input);
  if (fromHook) return fromHook;
  return createHash("sha256")
    .update(
      JSON.stringify({
        target: input.target,
        fn: input.fn,
        argsXdr: input.argsXdr,
        predecessor: input.predecessor ?? null,
        salt: input.salt ?? null,
      }),
    )
    .digest("hex");
}
