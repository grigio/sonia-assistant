import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadWav16kMono,
  parseWav,
  pcm16ToWavBytes,
  resample,
} from "../../src/audio/wav";

function pcmFromSamples(samples: number[]): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  samples.forEach((s, i) => view.setInt16(i * 2, s, true));
  return out;
}

describe("pcm16ToWavBytes / parseWav", () => {
  test("round-trip", () => {
    const samples = [0, 1, -1, 32767, -32768, 1234, -1234];
    const wav = pcm16ToWavBytes(pcmFromSamples(samples), 16000);
    const parsed = parseWav(wav);
    expect(parsed.rate).toBe(16000);
    expect(parsed.channels).toBe(1);
    expect([...parsed.samples]).toEqual(samples);
  });

  test("header fields", () => {
    const wav = pcm16ToWavBytes(new Uint8Array(100), 24000);
    const view = new DataView(wav.buffer);
    expect(Buffer.from(wav.subarray(0, 4)).toString("latin1")).toBe("RIFF");
    expect(Buffer.from(wav.subarray(8, 12)).toString("latin1")).toBe("WAVE");
    expect(view.getUint32(24, true)).toBe(24000);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint16(34, true)).toBe(16);
    expect(wav.length).toBe(144);
  });

  test("rejects non-RIFF", () => {
    expect(() => parseWav(new Uint8Array(64))).toThrow("not a RIFF");
  });
});

describe("resample", () => {
  test("same rate is a no-op (identity)", () => {
    const x = new Float32Array([1, 2, 3]);
    expect(resample(x, 16000, 16000)).toBe(x);
  });

  test("48k → 16k keeps length ratio", () => {
    const x = new Float32Array(4800).map((_, i) => Math.sin(i / 10));
    const y = resample(x, 48000, 16000);
    expect(y.length).toBe(1600);
    expect(y[0]).toBeCloseTo(x[0]!, 5);
  });

  test("up-sampling doubles length", () => {
    const x = new Float32Array([0, 1]);
    const y = resample(x, 8000, 16000);
    expect(y.length).toBe(4);
    expect(y[0]).toBeCloseTo(0, 5);
    expect(y[1]).toBeCloseTo(0.5, 5);
    expect(y[2]).toBeCloseTo(1, 5);
  });

  test("empty input stays empty", () => {
    expect(resample(new Float32Array(0), 44100, 16000).length).toBe(0);
  });
});

describe("loadWav16kMono", () => {
  test("stereo 44.1k → mono 16k", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wavtest-"));
    const file = path.join(dir, "stereo.wav");
    // 4410 samples (0.1 s) of stereo 44.1 kHz
    const n = 4410;
    const raw = new Uint8Array(n * 4);
    const view = new DataView(raw.buffer);
    for (let i = 0; i < n; i++) {
      view.setInt16(i * 4, 1000, true); // L
      view.setInt16(i * 4 + 2, 3000, true); // R
    }
    // build a proper 44-byte header
    const header = pcm16ToWavBytes(new Uint8Array(0), 44100);
    const h = Buffer.from(header);
    h.writeUInt16LE(2, 22); // channels
    h.writeUInt32LE(44100 * 4, 28); // byte rate
    h.writeUInt16LE(4, 32); // block align
    h.writeUInt32LE(raw.length, 40); // data size
    h.writeUInt32LE(36 + raw.length, 4);
    fs.writeFileSync(file, Buffer.concat([h, Buffer.from(raw)]));

    const mono = loadWav16kMono(file);
    expect(mono.length % 2).toBe(0);
    const samples = new Int16Array(mono.buffer, mono.byteOffset, mono.length / 2);
    // 0.1 s @ 16 kHz ≈ 1600 samples
    expect(Math.abs(samples.length - 1600)).toBeLessThan(3);
    // downmix of 1000/3000 = 2000
    expect(Math.abs(samples[100]! - 2000)).toBeLessThanOrEqual(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
