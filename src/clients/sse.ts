/** Shared SSE (`text/event-stream`) parsing: bytes → `data:` payload strings. */

/**
 * Async-iterate an SSE byte stream and yield the payload of every `data:` line.
 * Multi-line `data:` concatenation per the spec; `[DONE]` is yielded as-is.
 */
export async function* sseData(
  source: AsyncIterable<Uint8Array>,
): AsyncGenerator<string, void, unknown> {
  let buf = "";
  let dataLines: string[] = [];
  // One decoder for the whole stream: a multi-byte UTF-8 character (an Italian accent,
  // an emoji) may be split across two TCP chunks, and per-chunk decoding turns it into
  // replacement characters.
  const dec = new TextDecoder("utf-8");

  const consume = (line: string): string | null => {
    if (line === "") {
      if (dataLines.length) {
        const data = dataLines.join("\n");
        dataLines = [];
        return data;
      }
      return null;
    }
    if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    // comments (`: …`) and other fields (event:, id:, retry:) are ignored
    return null;
  };

  for await (const chunk of source) {
    buf += dec.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      const data = consume(line);
      if (data !== null) yield data;
    }
  }
  buf += dec.decode(); // flush the last bytes of a split character
  if (buf) {
    const data = consume(buf.replace(/\r$/, ""));
    if (data !== null) yield data;
  }
  if (dataLines.length) yield dataLines.join("\n");
}

/**
 * Line-at-a-time splitter for byte chunks (used where we hand-roll HTTP and
 * need raw lines, not spec-compliant SSE events — e.g. the ASR client).
 */
export class LineSplitter {
  private buf = "";
  private readonly dec = new TextDecoder("utf-8");
  push(chunk: Uint8Array): string[] {
    this.buf += this.dec.decode(chunk, { stream: true });
    const lines: string[] = [];
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      lines.push(this.buf.slice(0, idx).replace(/\r$/, ""));
      this.buf = this.buf.slice(idx + 1);
    }
    return lines;
  }
  flush(): string[] {
    this.buf += this.dec.decode();
    if (!this.buf) return [];
    const rest = this.buf;
    this.buf = "";
    return [rest];
  }
}
