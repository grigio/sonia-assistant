import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import { contentSecurityPolicy, SECURITY_HEADERS, stampIndexHtml } from "../../src/web";

describe("HTTP hardening", () => {
  test("every response carries the baseline security headers", () => {
    expect(SECURITY_HEADERS).toMatchObject({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Permissions-Policy": expect.stringContaining("microphone=(self)"),
    });
  });

  test("the CSP allows the inline UI script only through its nonce", () => {
    const csp = contentSecurityPolicy("abc123", "127.0.0.1:8095");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'nonce-abc123' blob:");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    // the WebSocket is same-host: an exact source, not `ws:` (exfiltration) or only 'self'
    // (browsers do not consistently match ws:// with 'self')
    expect(csp).toContain("connect-src 'self' ws://127.0.0.1:8095 wss://127.0.0.1:8095");
    expect(csp).not.toContain("connect-src 'self' ws: ");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    // a header value that could break out of the directive never reaches it
    const odd = contentSecurityPolicy("n", "evil;script-src *");
    expect(odd).not.toContain("evil");
    expect(odd).toContain("connect-src 'self';");
  });

  test("the page keeps the nonce marker for the per-response stamp", () => {
    const raw = fs.readFileSync(new URL("../../static/index.html", import.meta.url), "utf8");
    expect(raw).toContain('<script nonce="__CSP_NONCE__">');
    // stamping the catalogue/locale must not consume the nonce marker
    expect(stampIndexHtml(raw, "it")).toContain("__CSP_NONCE__");
  });
});
