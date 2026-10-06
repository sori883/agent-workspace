export const utf8 = (value: string) => new TextEncoder().encode(value);
export const decodeUtf8 = (value: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(value);
export function hex(value: Uint8Array): string { return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(""); }
export function unhex(value: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/.test(value)) throw new Error("invalid_bytes");
  return Uint8Array.from(value.match(/../g) ?? [], (byte) => parseInt(byte, 16));
}
export async function sha256(value: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(value))));
}
export function canonical(value: unknown, compact = false, sorted = true): string {
  const separator = compact ? "," : ", ";
  const colon = compact ? ":" : ": ";
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item, compact, sorted)).join(separator)}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (sorted) keys.sort((a, b) => {
      const left = Array.from(a, (x) => x.codePointAt(0)!);
      const right = Array.from(b, (x) => x.codePointAt(0)!);
      for (let i = 0; i < Math.min(left.length, right.length); i++) if (left[i] !== right[i]) return left[i] - right[i];
      return left.length - right.length;
    });
    return `{${keys.map((key) => `${JSON.stringify(key)}${colon}${canonical(record[key], compact, sorted)}`).join(separator)}}`;
  }
  throw new Error("invalid_canonical_value");
}
export const submissionKey = (owner: string | null, key: string) => sha256(utf8(canonical([owner, key], true)));
export const payloadHash = (payload: unknown, chat = false) => sha256(utf8(canonical(payload, chat)));
export function fingerprint(request: Record<string, unknown>, image: string) {
  const { run_id: _, ...body } = request;
  return sha256(utf8(canonical({ ...body, image })));
}
export function historyJson(history: { role: string; content: string }[]) {
  return canonical(history, true, false);
}
