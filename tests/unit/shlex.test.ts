import { describe, expect, test } from "bun:test";
import { shlexSplit } from "../../src/shlex";

describe("shlexSplit", () => {
  test("plain tokens", () => {
    expect(shlexSplit("pi -c")).toEqual(["pi", "-c"]);
    expect(shlexSplit("  a   b\t c ")).toEqual(["a", "b", "c"]);
  });

  test("single quotes preserve everything", () => {
    expect(shlexSplit("echo 'a b  c'")).toEqual(["echo", "a b  c"]);
    expect(shlexSplit("echo 'it'\\''s'")).toEqual(["echo", "it's"]);
  });

  test("double quotes handle escapes", () => {
    expect(shlexSplit('echo "a\\nb"')).toEqual(["echo", "a\nb"]);
    expect(shlexSplit('echo "a b"')).toEqual(["echo", "a b"]);
    expect(shlexSplit('echo "say \\"hi\\""')).toEqual(["echo", 'say "hi"']);
  });

  test("backslash outside quotes escapes the next char", () => {
    expect(shlexSplit("echo a\\ b")).toEqual(["echo", "a b"]);
    expect(shlexSplit("echo \\$HOME")).toEqual(["echo", "$HOME"]);
  });

  test("no comment handling", () => {
    expect(shlexSplit("echo # not a comment")).toEqual(["echo", "#", "not", "a", "comment"]);
  });

  test("unmatched quotes throw", () => {
    expect(() => shlexSplit("echo 'abc")).toThrow("No closing quotation");
    expect(() => shlexSplit('echo "abc')).toThrow("No closing quotation");
  });

  test("empty input → no tokens", () => {
    expect(shlexSplit("")).toEqual([]);
    expect(shlexSplit("   ")).toEqual([]);
  });
});
