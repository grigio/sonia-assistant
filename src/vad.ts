/** Silero VAD v5 (ONNX) — 512-sample frames @ 16 kHz with 64 samples of context. */

import * as ort from "onnxruntime-node";

const CONTEXT = 64;
export const VAD_FRAME = 512;

export class SileroVAD {
  private sess!: ort.InferenceSession;
  private state: ort.Tensor;
  private context: Float32Array;
  private outKeys: [string, string] = ["output", "stateN"];

  /** Await `vad.ready` before the first `process()` call. */
  readonly ready: Promise<SileroVAD>;

  constructor(modelPath: string) {
    this.state = new ort.Tensor("float32", new Float32Array(2 * 1 * 128), [2, 1, 128]);
    this.context = new Float32Array(CONTEXT);
    this.ready = ort.InferenceSession.create(modelPath, {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
      intraOpNumThreads: 1,
      interOpNumThreads: 1,
    }).then((s) => {
      this.sess = s;
      // outputs are unpacked positionally: [0] = output, [1] = state
      const names = s.outputNames;
      if (names.length >= 2) this.outKeys = [names[0]!, names[1]!];
      return this;
    });
  }

  reset(): void {
    this.state = new ort.Tensor("float32", new Float32Array(2 * 1 * 128), [2, 1, 128]);
    this.context = new Float32Array(CONTEXT);
  }

  /** frameS16: little-endian int16 PCM → speech probability in [0, 1]. */
  async process(frameS16: Uint8Array): Promise<number> {
    const n = frameS16.byteLength >> 1;
    const x = new Float32Array(n);
    const view = new DataView(frameS16.buffer, frameS16.byteOffset, frameS16.byteLength);
    for (let i = 0; i < n; i++) x[i] = view.getInt16(i * 2, true) / 32768;

    const inp = new Float32Array(CONTEXT + n);
    inp.set(this.context, 0);
    inp.set(x, CONTEXT);

    const feeds: Record<string, ort.Tensor> = {
      input: new ort.Tensor("float32", inp, [1, CONTEXT + n]),
      state: this.state,
      sr: new ort.Tensor("int64", BigInt64Array.from([16000n]), []),
    };
    const out = await this.sess.run(feeds);
    this.state = out[this.outKeys[1]]!;
    this.context = inp.slice(inp.length - CONTEXT);
    return Number(out[this.outKeys[0]]!.data[0]);
  }
}
