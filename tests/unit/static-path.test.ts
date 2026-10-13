/**
 * The `GET /static/<path>` guard in `src/web.ts`.
 *
 * The old check was `path.join(STATIC_DIR, rel).startsWith(STATIC_DIR)`: `path.join`
 * resolves `..` away *before* the test, and `startsWith` without the trailing separator
 * accepts a sibling directory whose name merely begins with `static`
 * (`/…/static-old/index.html`.startsWith(`/…/static`) is true).
 */
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { ROOT } from "../../src/config";
import { contentTypeFor, resolveStatic } from "../../src/web";

const STATIC = path.join(ROOT, "static");

describe("resolveStatic (the path is decoded here, so the tests decode too)", () => {
  test("a plain file resolves inside static/", () => {
    expect(resolveStatic("index.html")).toBe(path.join(STATIC, "index.html"));
    expect(resolveStatic("sub/dir/a.js")).toBe(path.join(STATIC, "sub", "dir", "a.js"));
  });

  test("the empty path is the directory itself (serveStatic then 404s it: not a file)", () => {
    expect(resolveStatic("")).toBe(STATIC);
    expect(resolveStatic(".")).toBe(STATIC);
  });

  test("`..` is rejected before the join, in every spelling", () => {
    expect(resolveStatic("../.env")).toBeNull();
    expect(resolveStatic("sub/../../.env")).toBeNull();
    expect(resolveStatic("..%2f.env")).toBeNull(); // encoded separator
    expect(resolveStatic("%2e%2e/.env")).toBeNull(); // encoded dots
    expect(resolveStatic("../static/../../.env")).toBeNull();
  });

  test("a sibling directory sharing the prefix is outside", () => {
    expect(resolveStatic("../static-old/index.html")).toBeNull();
    expect(resolveStatic("../statics/index.html")).toBeNull();
  });

  test("an absolute path cannot replace the root", () => {
    expect(resolveStatic("/etc/passwd")).toBeNull();
    expect(resolveStatic("//etc/passwd")).toBeNull();
  });

  test("a malformed escape or a NUL resolves to nothing, without throwing", () => {
    expect(resolveStatic("%zz")).toBeNull();
    expect(resolveStatic("%")).toBeNull();
    expect(resolveStatic("a%00b")).toBeNull();
  });
});

describe("contentTypeFor (every response carries a type)", () => {
  test("the types static/ can hold", () => {
    expect(contentTypeFor("index.html")).toBe("text/html; charset=utf-8");
    expect(contentTypeFor("app.js")).toBe("text/javascript; charset=utf-8");
    expect(contentTypeFor("style.css")).toBe("text/css; charset=utf-8");
    expect(contentTypeFor("logo.svg")).toBe("image/svg+xml");
    expect(contentTypeFor("data.json")).toBe("application/json; charset=utf-8");
  });

  test("an unknown extension is bytes, never sniffed", () => {
    expect(contentTypeFor("model.bin")).toBe("application/octet-stream");
    expect(contentTypeFor("no-extension")).toBe("application/octet-stream");
  });

  test("the extension is matched regardless of case", () => {
    expect(contentTypeFor("INDEX.HTML")).toBe("text/html; charset=utf-8");
  });
});
