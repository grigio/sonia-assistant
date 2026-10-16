/** WAV load/parse, linear-interp resample, PCM16 → WAV bytes (typed arrays, no numpy). */

import fs from "node:fs";

export const MIC_RATE = 16000;
export const FRAME_SAMPLES = 512; // 32 ms @ 16 kHz — Silero VAD's native window
export const FRAME_BYTES = FRAME_SAMPLES * 2;

/** Parse a RIFF/WAVE file: returns sample rate, channel count and interleaved int16 samples. */
export function parseWav(buf: Uint8Array): { rate: number; channels: number; samples: Int16Array } {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = String.fromCharCode(buf[0]!, buf[1]!, buf[2]!, buf[3]!);
  if (tag !== "RIFF") throw new Error("not a RIFF file");
  let offset = 12;
  let rate = 0,
    channels = 0,
    bits = 0,
    fmtRead = false,
    dataStart = -1,
    dataLen = 0;

  while (offset + 8 <= buf.length) {
    const id = String.fromCharCode(
      buf[offset]!,
      buf[offset + 1]!,
      buf[offset + 2]!,
      buf[offset + 3]!,
    );
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      channels = view.getUint16(body + 2, true);
      rate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      fmtRead = true;
    } else if (id === "data") {
      dataStart = body;
      dataLen = Math.min(size, buf.length - body);
    }
    offset = body + size + (size % 2);
  }
  if (!fmtRead || dataStart < 0) throw new Error("WAV: missing fmt/data chunk");
  if (bits !== 16) throw new Error(`WAV: need 16-bit PCM, got ${bits}-bit`);

  const samples = new Int16Array(buf.buffer, buf.byteOffset + dataStart, Math.floor(dataLen / 2));
  return { rate, channels, samples: samples.slice() };
}

/** Linear-interp resample of float samples. */
export function resample(x: Float32Array, srIn: number, srOut: number): Float32Array {
  if (srIn === srOut || x.length === 0) return x;
  const nOut = Math.round((x.length * srOut) / srIn);
  const out = new Float32Array(nOut);
  const step = srIn / srOut;
  for (let i = 0; i < nOut; i++) {
    const pos = i * step;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, x.length - 1);
    const frac = pos - i0;
    out[i] = x[i0]! * (1 - frac) + x[i1]! * frac;
  }
  return out;
}

/** Load any WAV file → 16 kHz mono s16 bytes (downmix + resample + clip). */
export function loadWav16kMono(path: string): Uint8Array {
  const buf = fs.readFileSync(path);
  const { rate, channels, samples } = parseWav(buf);

  // downmix to mono floats
  const nMono = Math.floor(samples.length / channels);
  const mono = new Float32Array(nMono);
  if (channels === 1) {
    for (let i = 0; i < nMono; i++) mono[i] = samples[i]!;
  } else {
    for (let i = 0; i < nMono; i++) {
      let sum = 0;
      for (let c = 0; c < channels; c++) sum += samples[i * channels + c]!;
      mono[i] = sum / channels;
    }
  }

  const resampled = resample(mono, rate, MIC_RATE);
  const out = new Uint8Array(resampled.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < resampled.length; i++) {
    const v = Math.max(-32768, Math.min(32767, Math.round(resampled[i]!)));
    view.setInt16(i * 2, v, true);
  }
  return out;
}

/** Wrap raw PCM16 mono bytes in a minimal 44-byte-header WAV. */
export function pcm16ToWavBytes(pcm: Uint8Array, rate: number): Uint8Array {
  const out = new Uint8Array(44 + pcm.length);
  const view = new DataView(out.buffer);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[off + i] = s.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // audio format = PCM
  view.setUint16(22, 1, true); // channels
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}
