/**
 * The capture-volume preflight (`sonia-gtk4/audio.ts`).
 *
 * A hardware mic left far below its usable range is a *silent* failure on this
 * client: the SOF mic emits digital zeros, the level dot still twitches on the odd
 * blip that slips through, and no word ever reaches the harness. The client lifts
 * such a source at startup — see the volume table in the module's comment.
 *
 * `pactl` is faked (same trick as mic.test.ts's `pw-record`): the tests assert what
 * the client *asks PipeWire for*, never a real sound card.
 */
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fixLowCaptureVolume, hardwareCaptureSources } from "../../sonia-gtk4/audio";

const REAL_PATH = process.env.PATH ?? "";
const dirs: string[] = [];

/** A `pactl` that prints `sources` and appends each `set-source-volume` to `log`. */
function fakePactl(sources: unknown[], opts: { failSet?: boolean } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sonia-fake-pactl-"));
  dirs.push(dir);
  const log = path.join(dir, "calls.log");
  const json = path.join(dir, "sources.json");
  fs.writeFileSync(json, JSON.stringify(sources));
  fs.writeFileSync(
    path.join(dir, "pactl"),
    `#!/bin/sh
if [ "$1" = "--format=json" ]; then cat '${json}'; exit 0; fi
if [ "$1" = "set-source-volume" ]; then
  echo "$2 $3" >> '${log}'
  ${opts.failSet ? "exit 1;" : "exit 0;"}
fi
exit 0
`,
  );
  fs.chmodSync(path.join(dir, "pactl"), 0o755);
  process.env.PATH = `${dir}:${REAL_PATH}`;
  return log;
}

/** One source as `pactl --format=json list sources` would report it. */
const source = (name: string, percent: number, extra: Record<string, unknown> = {}) => ({
  name,
  description: `desc ${name}`,
  mute: false,
  state: "RUNNING",
  volume: {
    "front-left": { value: (65536 * percent) / 100, value_percent: `${percent}%` },
    "front-right": { value: (65536 * percent) / 100, value_percent: `${percent}%` },
  },
  ...extra,
});

const calls = (log: string): string => {
  try {
    return fs.readFileSync(log, "utf-8").trim();
  } catch {
    return "";
  }
};

afterEach(() => {
  process.env.PATH = REAL_PATH;
  delete process.env.SONIA_MIC_VOLUME_FIX;
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("capture volume preflight", () => {
  test("lists only hardware mics, with the louder channel's volume", () => {
    fakePactl([
      source("fd_ec_source", 100),
      source("alsa_input.pci-mic", 21, {
        volume: {
          "front-left": { value_percent: "21%" },
          "front-right": { value_percent: "30%" },
        },
      }),
      { name: "monitor-of-something" },
    ]);
    const found = hardwareCaptureSources();
    expect(found.length).toBe(1);
    expect(found[0]!.name).toBe("alsa_input.pci-mic");
    expect(found[0]!.percent).toBe(30);
  });

  test("lifts a mic that sits below the usable range", () => {
    const log = fakePactl([source("alsa_input.pci-mic", 21)]);
    const fixed = fixLowCaptureVolume();
    expect(fixed).toEqual([
      { name: "alsa_input.pci-mic", description: "desc alsa_input.pci-mic", from: 21, to: 80 },
    ]);
    expect(calls(log)).toBe("alsa_input.pci-mic 80%");
  });

  test("leaves an already sane mic alone", () => {
    const log = fakePactl([source("alsa_input.pci-mic", 72)]);
    expect(fixLowCaptureVolume()).toEqual([]);
    expect(calls(log)).toBe("");
  });

  test("never un-mutes a mic: that is the user's decision, not a volume accident", () => {
    const log = fakePactl([source("alsa_input.pci-mic", 0, { mute: true })]);
    expect(fixLowCaptureVolume()).toEqual([]);
    expect(calls(log)).toBe("");
  });

  test("SONIA_MIC_VOLUME_FIX=0 turns it off", () => {
    const log = fakePactl([source("alsa_input.pci-mic", 21)]);
    process.env.SONIA_MIC_VOLUME_FIX = "0";
    expect(fixLowCaptureVolume()).toEqual([]);
    expect(calls(log)).toBe("");
  });

  test("a failing pactl changes nothing and reports nothing", () => {
    fakePactl([source("alsa_input.pci-mic", 21)], { failSet: true });
    expect(fixLowCaptureVolume()).toEqual([]);
  });

  test("no pactl at all (a box without PipeWire) is not a crash", () => {
    process.env.PATH = "/nonexistent";
    expect(hardwareCaptureSources()).toEqual([]);
    expect(fixLowCaptureVolume()).toEqual([]);
  });
});
