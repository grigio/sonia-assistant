/**
 * The argument parser behind `bun run start` — the one entry point with a whole grammar
 * of its own and, until now, no test at all.
 *
 * What is pinned here:
 *   - every documented flag and its default (README "Run");
 *   - `--port`, whose guard exists precisely because `Number()` "happily yields NaN/0/-1";
 *   - `--input-wav [<seconds>:]<file>`, where a Windows-ish `C:\…` path must not be read
 *     as a delay, and the `lastIndexOf(":")` is what makes that true.
 */
import { describe, expect, test } from "bun:test";
import { parseCli, parseInputWav, parsePort } from "../../src/cli";

describe("parseCli", () => {
  test("no arguments: the browser UI on loopback, nothing else on", () => {
    const a = parseCli([]);
    expect(a.web).toBe(false);
    expect(a.text).toBe(false);
    expect(a.host).toBe("127.0.0.1");
    expect(a.port).toBe(8095);
    expect(a.noBrowser).toBe(false);
    expect(a.noSpeaker).toBe(false);
    expect(a.debug).toBe(false);
    expect(a.inputWav).toEqual([]);
    expect(a.outputWav).toBeUndefined();
    expect(a.stats).toBeUndefined();
  });

  test("every flag the README documents is read", () => {
    const a = parseCli([
      "--web",
      "--no-browser",
      "--host",
      "0.0.0.0",
      "--port",
      "9000",
      "--text",
      "--input-wav",
      "2:a.wav",
      "--input-wav",
      "b.wav",
      "--output-wav",
      "out.wav",
      "--no-speaker",
      "--stats",
      "stats.json",
      "--debug",
    ]);
    expect(a.web).toBe(true);
    expect(a.noBrowser).toBe(true);
    expect(a.host).toBe("0.0.0.0");
    expect(a.port).toBe(9000);
    expect(a.text).toBe(true);
    expect(a.inputWav).toEqual(["2:a.wav", "b.wav"]); // `multiple: true` accumulates
    expect(a.outputWav).toBe("out.wav");
    expect(a.noSpeaker).toBe(true);
    expect(a.stats).toBe("stats.json");
    expect(a.debug).toBe(true);
  });

  test("a positional argument is refused rather than silently ignored", () => {
    // `allowPositionals: false`: a typo like `bun run start --no-brower` must not start a
    // browser-less run the user did not ask for
    expect(() => parseCli(["stray"])).toThrow();
  });
});

describe("parsePort", () => {
  test("accepts the whole usable range", () => {
    expect(parsePort("1")).toBe(1);
    expect(parsePort("8095")).toBe(8095);
    expect(parsePort("65535")).toBe(65535);
  });

  test("refuses everything that is not a TCP port", () => {
    // each of these is a value `Number()` accepts and `net.listen` would not
    for (const bad of ["0", "-1", "65536", "8095.5", "NaN", "", "abc", "8_095", " 8095x"]) {
      expect(() => parsePort(bad)).toThrow();
    }
    expect(() => parsePort(undefined)).toThrow();
  });

  test("a bad --port fails the parse, not the bind", () => {
    expect(() => parseCli(["--port", "0"])).toThrow(/--port/);
  });
});

describe("parseInputWav", () => {
  test("a bare file gets the default 1 s delay", () => {
    expect(parseInputWav(["one.wav"])).toEqual([[1.0, "one.wav"]]);
  });

  test("`[<seconds>:]<file>` splits on the FIRST colon", () => {
    expect(parseInputWav(["2.5:one.wav"])).toEqual([[2.5, "one.wav"]]);
    // an absolute path has no colon of its own…
    expect(parseInputWav(["3:/tmp/one.wav"])).toEqual([[3, "/tmp/one.wav"]]);
    // …but a colon in the *path* must not be mistaken for the separator: this used to
    // parse the delay as Number("0:a") = NaN, which WavMic turns into a zero-length
    // silence, so the 2 clips ran back to back with the gap silently gone
    expect(parseInputWav(["0:a:b.wav"])).toEqual([[0, "a:b.wav"]]);
    expect(parseInputWav(["2:my:recording.wav"])).toEqual([[2, "my:recording.wav"]]);
    // a Windows drive letter is the case that made `lastIndexOf` look tempting: the
    // seconds still come off the front, and the rest is kept whole
    expect(parseInputWav(["3:C:\\clips\\a.wav"])).toEqual([[3, "C:\\clips\\a.wav"]]);
  });

  test("a non-numeric prefix is part of the path, not a delay", () => {
    // `C` is not a number, so this whole string is one filename
    expect(parseInputWav(["C:\\clips\\a.wav"])).toEqual([[1.0, "C:\\clips\\a.wav"]]);
  });

  test("a parsed delay is always a real number (WavMic turns NaN into no gap at all)", () => {
    for (const [delay] of parseInputWav(["2:a.wav", "a:b.wav", ":x.wav", "x.wav"])) {
      expect(Number.isFinite(delay)).toBe(true);
    }
  });

  test("an empty delay falls back to the default", () => {
    expect(parseInputWav([":one.wav"])).toEqual([[1.0, "one.wav"]]);
  });

  test("the pairs keep the order they were given on the command line", () => {
    expect(parseInputWav(["5:late.wav", "early.wav"])).toEqual([
      [5, "late.wav"],
      [1.0, "early.wav"],
    ]);
  });
});
