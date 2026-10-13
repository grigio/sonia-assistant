/** The full-duplex ASR client against a fake chunked+SSE server (no audio.cpp needed). */

import { describe, expect, test } from "bun:test";
import net from "node:net";
import { LiveTranscription } from "../../src/clients/audiocpp";

type Fake = {
  port: number;
  requests: string[];
  bodies: Buffer[];
  close: () => Promise<void>;
};

function startFakeAsr(opts: { status?: string; chunked?: boolean } = {}): Promise<Fake> {
  const chunked = opts.chunked !== false;
  return new Promise((resolve) => {
    const requests: string[] = [];
    const bodies: Buffer[] = [];

    const server = net.createServer((sock) => {
      let head = Buffer.alloc(0);
      let inBody = false;
      let bodyBuf = Buffer.alloc(0);
      let sent = false;

      const handleBody = (data: Buffer): void => {
        if (!chunked) return;
        bodyBuf = Buffer.concat([bodyBuf, data]);
        for (;;) {
          const nl = bodyBuf.indexOf("\r\n");
          if (nl < 0) return;
          const size = parseInt(bodyBuf.subarray(0, nl).toString("latin1"), 16);
          if (Number.isNaN(size)) return;
          if (bodyBuf.length < nl + 2 + size + 2) return;
          if (size === 0) {
            if (!sent) {
              sent = true;
              const sse =
                'data: {"type":"transcript.text.delta","delta":"ciao "}\n\n' +
                'data: {"type":"transcript.text.delta","delta":"mondo"}\n\n' +
                'data: {"type":"transcript.text.done","text":"ciao mondo"}\n\n' +
                "data: [DONE]\n\n";
              if (chunked) {
                const frame = (payload: string) =>
                  Buffer.byteLength(payload).toString(16) + "\r\n" + payload + "\r\n";
                sock.write(frame(sse) + "0\r\n\r\n");
              } else {
                sock.write(sse);
              }
            }
            return;
          }
          bodyBuf = bodyBuf.subarray(nl + 2 + size + 2);
        }
      };

      sock.on("data", (d: Buffer) => {
        if (!inBody) {
          head = Buffer.concat([head, d]);
          const idx = head.indexOf("\r\n\r\n");
          if (idx < 0) return;
          requests.push(head.subarray(0, idx).toString("latin1"));
          inBody = true;
          const rest = head.subarray(idx + 4);
          sock.write(`${opts.status ?? "HTTP/1.1 200 OK"}\r\n`);
          if (chunked) sock.write("Transfer-Encoding: chunked\r\n");
          sock.write("Content-Type: text/event-stream\r\n\r\n");
          bodies.push(rest);
          handleBody(rest);
          sock.on("data", (d2: Buffer) => {
            bodies.push(d2);
            handleBody(d2);
          });
        }
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({
        port,
        requests,
        bodies,
        close: () =>
          new Promise((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}

describe("LiveTranscription", () => {
  test("full-duplex: chunked request out, SSE transcript in, finish() returns final text", async () => {
    const fake = await startFakeAsr();
    const partials: string[] = [];
    const lt = new LiveTranscription(
      `http://127.0.0.1:${fake.port}`,
      "voxtral",
      "",
      (t) => partials.push(t),
    );

    await lt.open();
    lt.send(new Uint8Array(1024)); // silence
    const text = await lt.finish(0, 5000);

    expect(text).toBe("ciao mondo");
    expect(partials).toEqual(["ciao ", "ciao mondo"]);
    expect(lt.text).toBe("ciao mondo");

    const head = fake.requests[0]!;
    expect(head).toStartWith("POST /v1/audio/transcriptions/live?");
    expect(head).toContain("model=voxtral");
    expect(head).toContain("Transfer-Encoding: chunked");
    await fake.close();
  });

  test("non-200 status resolves with what we have instead of crashing", async () => {
    const fake = await startFakeAsr({ status: "HTTP/1.1 503 unavailable" });
    const lt = new LiveTranscription(`http://127.0.0.1:${fake.port}`, "voxtral");
    await lt.open();
    const text = await lt.finish(0, 3000);
    expect(text).toBe("");
    await fake.close();
  });

  test("send() before open() is buffered, not lost", async () => {
    const fake = await startFakeAsr();
    const lt = new LiveTranscription(`http://127.0.0.1:${fake.port}`, "voxtral");
    lt.send(new Uint8Array(200)); // before open
    await lt.open();
    const text = await lt.finish(0, 3000);
    expect(text).toBe("ciao mondo");
    await fake.close();
  });
});
