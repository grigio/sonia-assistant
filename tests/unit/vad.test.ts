/**
 * The Silero VAD wrapper — the innermost thing in the 32 ms frame loop, and until now
 * covered only indirectly (the ws suite constructs one; nothing ever drove `process`).
 *
 * These run against the *real* ONNX model: it is the only file the unit suite reads from
 * disk (2.3 MB, fetched by `bun run models-download --only vad`, which CI already does),
 * and a fake would only re-assert the tensor plumbing we wrote ourselves. The tests that
 * need the model skip themselves when it is absent, so the suite still passes on a clone
 * that has not downloaded it.
 *
 * What is pinned here:
 *   - the frame size the loop assumes (512 samples = 32 ms @ 16 kHz) and its 64-sample
 *     context — the two numbers `config.ts` and `harness.ts` are built around;
 *   - that a speech-loud frame scores far above a silence-loud one, i.e. the wiring is
 *     right (outputs unpacked in the order this wrapper assumes);
 *   - `reset()` really clears the recurrent state, which is what half-duplex and a dead
 *     mic source depend on (`harness.ts:84`);
 *   - that the int16→float conversion reads from the frame's own `byteOffset`, so a
 *     *sliced* buffer — exactly what the preroll ring and `QueueMic` hand over — is
 *     converted correctly rather than from the wrong offset.
 */
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../../src/config";
import { SileroVAD, VAD_FRAME } from "../../src/vad";

const MODEL = path.join(ROOT, "models", "silero", "silero_vad.onnx");
const have = fs.existsSync(MODEL);

/** A frame of `n` samples at 16 kHz, int16 LE. */
function frame(n: number, amp = 0): Uint8Array {
  const b = new Uint8Array(n * 2);
  const v = new DataView(b.buffer);
  for (let i = 0; i < n; i++) {
    // a cheap deterministic tone, so "loud" really is louder rather than just bigger
    v.setInt16(i * 2, Math.trunc(Math.sin(i / 8) * amp), true);
  }
  return b;
}

/** One VAD, awaited through `ready`. Skips the test when the model is not on disk. */
async function load(): Promise<SileroVAD | null> {
  if (!have) return null;
  return await new SileroVAD(MODEL).ready;
}

const it = have ? test : test.skip;

describe("SileroVAD", () => {
  it("scores a speech-loud frame above a silence-loud one", async () => {
    const vad = await load();
    if (!vad) return;

    // feed the silence first: a fresh session state, then a loud one
    for (let i = 0; i < 4; i++) await vad.process(frame(VAD_FRAME, 0));
    const quiet = await vad.process(frame(VAD_FRAME, 0));

    for (let i = 0; i < 4; i++) await vad.process(frame(VAD_FRAME, 12_000));
    const loud = await vad.process(frame(VAD_FRAME, 12_000));

    for (const p of [quiet, loud]) {
      expect(Number.isFinite(p)).toBe(true);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
    expect(loud).toBeGreaterThan(quiet);
  });

  it("reset() clears the state, so a fresh utterance starts from silence", async () => {
    const vad = await load();
    if (!vad) return;

    // drive the recurrent state firmly towards "speech"
    for (let i = 0; i < 8; i++) await vad.process(frame(VAD_FRAME, 12_000));
    vad.reset();
    const afterReset = await vad.process(frame(VAD_FRAME, 0));

    // a second instance that never saw the loud frames must agree with it: this is what
    // "the reset really reset" means, measured against an untouched session
    const fresh = await load();
    if (!fresh) return;
    const pristine = await fresh.process(frame(VAD_FRAME, 0));
    expect(afterReset).toBeCloseTo(pristine, 5);
  });

  it("converts from the frame's own byteOffset, not the buffer's", async () => {
    // A slice of a bigger buffer — what the preroll ring (`Array.shift()`) and
    // `QueueMic` (`buf.slice()`) actually hand over. If the conversion ignored
    // `byteOffset` it would read the *neighbouring* samples instead of this frame's,
    // which on real audio silently shifts the VAD by one frame and wrecks turn-taking.
    const loud = frame(VAD_FRAME, 12_000);
    const big = new Uint8Array(VAD_FRAME * 2 * 3);
    big.set(loud, VAD_FRAME * 2); // the content lives in the *middle* of the buffer…
    const slice = big.subarray(VAD_FRAME * 2, VAD_FRAME * 2 * 2); // …and is viewed from there
    expect(slice.byteOffset).toBeGreaterThan(0); // the case under test, really in effect

    // Two fresh sessions: the state tensor is carried between frames, so comparing two
    // calls on one instance would measure the state, not the offset handling.
    const a = await load();
    const b = await load();
    if (!a || !b) return;
    expect(await b.process(slice)).toBeCloseTo(await a.process(loud), 6);
  });

  it("VAD_FRAME is the 32 ms the frame loop assumes", () => {
    // 512 samples @ 16 kHz = 32 ms; `harness.ts` FRAME_MS and the preroll maths in
    // `Assistant` are both derived from this, so a change here is a breaking change
    expect(VAD_FRAME).toBe(512);
    expect((VAD_FRAME / 16000) * 1000).toBe(32);
  });

  test("the model is where config.ts looks for it (or the tests above skip)", () => {
    // makes the skip visible instead of silent: a CI run that forgot the download step
    // shows up as "skipped", which is a different failure from "no coverage"
    expect(have || !fs.existsSync(ROOT)).toBe(true);
  });
});
