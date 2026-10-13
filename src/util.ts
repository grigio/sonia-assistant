/**
 * Small shared helpers — the primitives that used to be copy-pasted per file
 * (`sleep` ×4, `which` ×2, byte-concat ×2) plus abort/timeout composition and a
 * bounded string accumulator (no project logic lives here).
 */

import fs from "node:fs";

/** The rejection used for every cooperative cancellation (`AbortController.abort()`). */
export function abortError(): Error {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

/** `setTimeout` as a promise. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Absolute path of an executable found in `PATH` (executable regular file), or `null`. */
export function which(name: string): string | null {
  for (const d of (process.env["PATH"] ?? "").split(":").filter(Boolean)) {
    const p = `${d}/${name}`;
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/** Concatenate byte chunks into one buffer. */
export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * An `AbortSignal` that fires after `ms` **or** as soon as any of `signals` aborts
 * (whichever comes first). The timeout is what guarantees a stalled HTTP call cannot
 * hang a background task; the caller's signal is what makes cancellation immediate.
 */
export function timeoutSignal(
  ms: number,
  ...signals: (AbortSignal | undefined | null)[]
): AbortSignal {
  const list: AbortSignal[] = [AbortSignal.timeout(ms)];
  for (const s of signals) if (s) list.push(s);
  return list.length === 1 ? list[0]! : AbortSignal.any(list);
}

/**
 * Append `chunk` to `cur`, keeping at most `max` characters — the *tail*, which is where
 * the interesting part of a command's output is. Bounded, so a chatty command cannot
 * grow the string (and the heap) without limit.
 */
export function appendCapped(cur: string, chunk: string, max: number): string {
  const next = cur + chunk;
  if (next.length <= max) return next;
  return next.slice(next.length - max);
}
