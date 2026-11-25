import { createHash, randomBytes } from "node:crypto";

/** RFC 8785 canonical JSON: keys sorted by UTF-16 code units, no whitespace, ECMAScript numbers. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("non-finite number");
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return "[" + value.map((v) => canonicalJson(v === undefined ? null : v)).join(",") + "]";
  const keys = Object.keys(value as object)
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson((value as Record<string, unknown>)[k])).join(",") + "}";
}

/** `sha256:<hex>` of bytes, or of the canonical JSON of a value. */
export function contentHash(content: Uint8Array | string | object): string {
  const bytes =
    content instanceof Uint8Array ? content : typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(canonicalJson(content), "utf8");
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

/** The current time as RFC 3339 in UTC, to the millisecond. */
export function now(): string {
  return new Date().toISOString();
}

/** A random URL-safe token of the given number of bytes. */
export function randomToken(bytes = 16): string {
  return randomBytes(bytes).toString("base64url");
}

/** A promise with its resolve and reject functions. */
export function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Sleeps, or rejects when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Whether a value is a plain JSON object. */
export function isObject(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
