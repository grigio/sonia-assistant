/**
 * Liveness of the audio.cpp servers (`:8091` ASR, `:8092` TTS, `:8093` Smart Turn).
 *
 * The harness used to assume they stayed up: an ASR socket error was a `console.error`,
 * nothing re-checked the servers after warmup, and the UI happily sat on "listening"
 * with a dead pipeline. `Assistant` polls `probeAll()` every 10 s while it runs (see
 * `startHealthPoll()`) and flips the UI to `offline` while ASR or TTS is unreachable —
 * Smart Turn only degrades turn-taking (the VAD gap still ends the turn), so its death
 * is logged and the state stays.
 */

export type Target = { name: string; url: string };

/** The endpoint every audio.cpp server answers; `scripts/runtime-check.ts` reads it too. */
export function healthUrl(base: string): string {
  return base.replace(/\/+$/, "") + "/health";
}

/**
 * Any HTTP answer (even 404) means the server is up — only a transport error (refused,
 * reset, DNS) or a timeout means "down".
 */
export async function probe(url: string, timeoutMs = 2000): Promise<boolean> {
  try {
    await fetch(url, { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

/** Names of the targets that did not answer, in the order given. */
export async function probeAll(targets: Target[], timeoutMs = 2000): Promise<string[]> {
  const results = await Promise.all(
    targets.map(async (t) => ((await probe(t.url, timeoutMs)) ? null : t.name)),
  );
  return results.filter((n): n is string => n !== null);
}
