/**
 * `TTS` (the audio.cpp `:8092` server) on the failure the harness has to survive:
 *
 *  - a refused connection must *name* the endpoint (`String(err)` on Bun's bare
 *    `TypeError` loses the URL, and that is all the log would show);
 *  - an aborted request must keep its AbortError shape, so `responseTaskDone` reads it
 *    as a cancellation instead of a failure.
 *
 * The transport error escaping un-wrapped was half of a crash: the other half was the
 * unhandled rejection in `runResponse` (see `tests/ws-skills.test.ts`).
 */
import { describe, expect, test } from "bun:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { TTS } from "../../src/clients/audiocpp";
import { isAbortError } from "../../src/harness/queues";

async function collect(g: AsyncGenerator<Uint8Array, void, unknown>): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for await (const c of g) out.push(c);
  return out;
}

describe("TTS.stream — a server that is not there", () => {
  test("the refusal names the endpoint it tried", async () => {
    // a port nothing listens on: the connection is refused, like a killed :8092
    const srv = http.createServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as AddressInfo).port;
    await new Promise<void>((r) => srv.close(() => r()));

    const tts = new TTS(`http://127.0.0.1:${port}`, "pocket-it", "eponine");
    await expect(collect(tts.stream("ciao"))).rejects.toThrow(
      `TTS http://127.0.0.1:${port}`,
    );
  });

  test("an aborted request stays an AbortError (a barge-in, not a broken server)", async () => {
    const srv = http.createServer(() => {
      /* never answers: only the abort can end this request */
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const { port } = srv.address() as AddressInfo;

    const ctl = new AbortController();
    const tts = new TTS(`http://127.0.0.1:${port}`, "pocket-it", "eponine");
    const next = tts.stream("ciao", ctl.signal).next();
    setTimeout(() => ctl.abort(), 20);
    let err: unknown = null;
    try {
      await next;
    } catch (e) {
      err = e;
    }
    await new Promise<void>((r) => srv.close(() => r()));

    expect(err).not.toBeNull();
    expect(isAbortError(err)).toBe(true);
  });
});
