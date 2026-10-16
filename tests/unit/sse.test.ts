import { describe, expect, test } from "bun:test";
import { LineSplitter, sseData } from "../../src/clients/sse";

async function* chunks(...parts: string[]): AsyncGenerator<Uint8Array> {
  for (const p of parts) yield Buffer.from(p);
}

async function collect(it: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const v of it) out.push(v);
  return out;
}

describe("sseData", () => {
  test("simple data lines", async () => {
    const out = await collect(sseData(chunks('data: {"a":1}\n\ndata: {"b":2}\n\n')));
    expect(out).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("splits across arbitrary chunk boundaries", async () => {
    const out = await collect(sseData(chunks('data: {"ty', 'pe":"delta"}\n', "\ndata: x\n", "\n")));
    expect(out).toEqual(['{"type":"delta"}', "x"]);
  });

  test("multi-line data is joined with \\n", async () => {
    const out = await collect(sseData(chunks("data: line1\ndata: line2\n\n")));
    expect(out).toEqual(["line1\nline2"]);
  });

  test("comments and other fields are ignored", async () => {
    const out = await collect(sseData(chunks(": keep-alive\nevent: foo\ndata: real\n\n")));
    expect(out).toEqual(["real"]);
  });

  test("[DONE] is yielded as-is", async () => {
    const out = await collect(sseData(chunks("data: x\n\ndata: [DONE]\n\n")));
    expect(out).toEqual(["x", "[DONE]"]);
  });

  test("trailing data without blank line is flushed", async () => {
    const out = await collect(sseData(chunks("data: last\n")));
    expect(out).toEqual(["last"]);
  });

  test("CRLF line endings", async () => {
    const out = await collect(sseData(chunks("data: crlf\r\n\r\n")));
    expect(out).toEqual(["crlf"]);
  });
});

describe("LineSplitter", () => {
  test("buffers partial lines", () => {
    const s = new LineSplitter();
    expect(s.push(Buffer.from("abc\nde"))).toEqual(["abc"]);
    expect(s.push(Buffer.from("f\nghi"))).toEqual(["def"]);
    expect(s.flush()).toEqual(["ghi"]);
  });

  test("flush on empty buffer", () => {
    expect(new LineSplitter().flush()).toEqual([]);
  });
});
