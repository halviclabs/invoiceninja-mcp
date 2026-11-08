/** Shared limits apply before expensive validation and to both transports. */
export const MAX_INPUT_ELEMENTS = 10_000;
export const MAX_DEPTH = 20;
export const MAX_STRING = 16_384;
export const MAX_COLLECTION = 1_000;

/** Only messages constructed by this application are safe to return to a caller. */
export class InputError extends Error {}

/** Hash IDs must occupy exactly one path segment; encoding alone does not reject dot segments. */
export function pathSegment(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new InputError("Invalid record identifier.");
  return encodeURIComponent(value);
}

export function checkInput(value: unknown): void {
  let count = 0;
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  while (pending.length) {
    const item = pending.pop()!;
    if (++count > MAX_INPUT_ELEMENTS || item.depth > MAX_DEPTH) throw new InputError("Request is too complex.");
    if (typeof item.value === "string" && item.value.length > MAX_STRING) throw new InputError("Request string is too long.");
    if (item.value && typeof item.value === "object") {
      const entries = Object.entries(item.value);
      if (entries.length > MAX_COLLECTION) throw new InputError("Request collection is too large.");
      for (const [key, child] of entries) {
        if (key.length > 128 || key === "__proto__" || key === "prototype" || key === "constructor") {
          throw new InputError("Invalid request key.");
        }
        pending.push({ value: child, depth: item.depth + 1 });
      }
    }
  }
}
