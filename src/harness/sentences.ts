/** Cuts streamed LLM text into speakable chunks; the first one is cut early. */

import { hasWords } from "./text";

const END = /([.!?…;:]+["»)\]]?)(\s+|$)/;
const MARKDOWN = /[*_#`>|~]+/g;
const LINK = /\[(.*?)\]\(.*?\)/g;
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;

export class SentenceSplitter {
  private buf = "";
  private first = true;

  static clean(text: string): string {
    let t = text.replace(MARKDOWN, "");
    t = t.replace(LINK, "$1");
    t = t.replace(EMOJI, "");
    return t.replace(/\s+/g, " ").trim();
  }

  feed(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    for (;;) {
      const m = END.exec(this.buf);
      let cut = -1;
      if (m && (m[2] || this.buf.length > m.index + m[0].length)) {
        cut = m.index + m[0].length;
      } else {
        const nl = this.buf.indexOf("\n");
        if (nl >= 0) {
          cut = nl + 1;
        } else if (this.first && this.buf.length > 40 && this.buf.includes(",", 20)) {
          cut = this.buf.indexOf(",", 20) + 1; // speak sooner on the first clause
        } else if (this.buf.length > 220 && this.buf.includes(",", 120)) {
          cut = this.buf.indexOf(",", 120) + 1;
        }
      }
      if (cut < 0) break;
      const piece = SentenceSplitter.clean(this.buf.slice(0, cut));
      this.buf = this.buf.slice(cut);
      if (piece && hasWords(piece)) {
        out.push(piece);
        this.first = false;
      }
    }
    return out;
  }

  flush(): string[] {
    const piece = SentenceSplitter.clean(this.buf);
    this.buf = "";
    return piece && hasWords(piece) ? [piece] : [];
  }
}
