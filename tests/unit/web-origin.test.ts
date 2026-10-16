/**
 * The `/ws` origin check (`web.ts:originAllowed`) — the only thing standing between the
 * harness and **any webpage the user happens to visit**: browsers do not apply the
 * same-origin policy to WebSockets, so without it a foreign page can open
 * `ws://127.0.0.1:8095/ws`, read the transcript and push commands at an assistant whose
 * default `CMD_MODE=auto` runs shell commands.
 *
 * The three rules, each with the case it exists for:
 *   1. no Origin (not a browser) → allowed;
 *   2. same origin as the request itself → the page must be *this* server's own;
 *   3. a name we could have served → loopback, `--host`, or an IP literal on a wildcard.
 */
import { describe, expect, test } from "bun:test";
import { originAllowed } from "../../src/web";

const HOST = "127.0.0.1:8095";

describe("originAllowed", () => {
  test("no Origin header = not a browser (curl, a script, the ws package)", () => {
    expect(originAllowed(undefined, HOST, "127.0.0.1")).toBe(true);
    expect(originAllowed("", HOST, "127.0.0.1")).toBe(true);
  });

  test("our own page, in either spelling of the loopback address", () => {
    expect(originAllowed("http://127.0.0.1:8095", HOST, "127.0.0.1")).toBe(true);
    expect(originAllowed("http://localhost:8095", "localhost:8095", "127.0.0.1")).toBe(true);
    expect(originAllowed("http://[::1]:8095", "[::1]:8095", "127.0.0.1")).toBe(true);
  });

  test("another site, even one naming our port: refused", () => {
    expect(originAllowed("http://evil.com:8095", HOST, "127.0.0.1")).toBe(false);
    expect(originAllowed("https://evil.com", HOST, "127.0.0.1")).toBe(false);
  });

  test("same site, other port: refused (that port serves something else)", () => {
    expect(originAllowed("http://127.0.0.1:3000", HOST, "127.0.0.1")).toBe(false);
    expect(originAllowed("http://127.0.0.1:8095", "127.0.0.1:3000", "127.0.0.1")).toBe(false);
  });

  test("no browser context at all: file://, sandboxed iframes, garbage", () => {
    expect(originAllowed("null", HOST, "127.0.0.1")).toBe(false);
    expect(originAllowed("file:///tmp/x.html", HOST, "127.0.0.1")).toBe(false);
    expect(originAllowed("not a url", HOST, "127.0.0.1")).toBe(false);
    expect(originAllowed("javascript:alert(1)", HOST, "127.0.0.1")).toBe(false);
  });

  test("--host 0.0.0.0: an IP client gets in, a rebinding hostname does not", () => {
    // the user bound the wildcard: a LAN browser reaching us by address is legitimate …
    expect(originAllowed("http://192.168.1.88:8095", "192.168.1.88:8095", "0.0.0.0")).toBe(true);
    expect(originAllowed("http://127.0.0.1:8095", HOST, "0.0.0.0")).toBe(true);
    // … while `evil.com → 127.0.0.1` (same Host, same Origin) is exactly rule 3's job:
    // a hostname there was never served by us
    expect(originAllowed("http://evil.com:8095", "evil.com:8095", "0.0.0.0")).toBe(false);
  });

  test("--host <a real address>: that address, and only it", () => {
    expect(originAllowed("http://192.168.1.88:8095", "192.168.1.88:8095", "192.168.1.88")).toBe(
      true,
    );
    expect(originAllowed("http://192.168.1.89:8095", "192.168.1.89:8095", "192.168.1.88")).toBe(
      false,
    );
  });
});
