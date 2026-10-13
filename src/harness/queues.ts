/** Async primitives: an unbounded FIFO, a monotonic clock, cooperative cancellation. */

import { abortError } from "../util";
export { abortError } from "../util";

/** Unbounded FIFO; a `null` item works as the poison pill (end-of-stream marker). */
export class AsyncQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: ((v: T) => void)[] = [];

  push(v: T): void {
    const w = this.waiters.shift();
    if (w) w(v);
    else this.items.push(v);
  }

  async get(): Promise<T> {
    if (this.items.length) return this.items.shift()!;
    return await new Promise<T>((res) => this.waiters.push(res));
  }

  get size(): number {
    return this.items.length;
  }
}

/** Monotonic seconds. */
export function now(): number {
  return performance.now() / 1000;
}

export function isAbortError(e: unknown): boolean {
  return (
    e instanceof Error &&
    (e.name === "AbortError" || e.message === "aborted" || e.message.includes("aborted"))
  );
}

/** Reject as soon as `signal` aborts — cooperative cancellation of a pending `await`. */
export function withAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Iterate an async generator, aborting mid-`next()` when the signal fires. */
export async function* abortableIter<T>(
  it: AsyncGenerator<T, void, unknown>,
  signal: AbortSignal,
): AsyncGenerator<T, void, unknown> {
  for (;;) {
    if (signal.aborted) throw abortError();
    const next = it.next();
    let result: IteratorResult<T, void>;
    try {
      result = await withAbort(next, signal);
    } catch (e) {
      await it.return?.(undefined).catch?.(() => {});
      throw e;
    }
    if (result.done) return;
    yield result.value;
  }
}
