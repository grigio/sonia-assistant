import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { SERVER_EVENT_TYPES, type ServerEvent } from "../../src/events";

const ROOT = path.resolve(import.meta.dir, "../..");

/** The `type:` literals of the ServerEvent union (ToolEvent included) — the source side. */
function unionTypes(): string[] {
  const src = fs.readFileSync(path.join(ROOT, "src/events.ts"), "utf8");
  const start = src.indexOf("// ── server → browser");
  const end = src.indexOf("// ── browser → server");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const section = src.slice(start, end);
  return [...new Set([...section.matchAll(/type: "([a-z_]+)"/g)].map((m) => m[1]!))].sort();
}

/** Every event a client handles: `case "<event>"` or an early `if (ev.type === "<event>")`. */
function clientCases(file: string): string[] {
  const src = fs.readFileSync(path.join(ROOT, file), "utf8");
  const refs = [
    ...src.matchAll(/case "([a-z_]+)"/g),
    ...src.matchAll(/\.type === "([a-z_]+)"/g),
  ].map((m) => m[1]!);
  return [...new Set(refs)].sort();
}

describe("the /ws event protocol", () => {
  // Type-level half: renames and new variants must be reflected in the runtime list too.
  type Listed = (typeof SERVER_EVENT_TYPES)[number];
  type Exact =
    Exclude<ServerEvent["type"], Listed> extends never
      ? Exclude<Listed, ServerEvent["type"]> extends never
        ? true
        : false
      : false;

  test("SERVER_EVENT_TYPES is exactly the ServerEvent union", () => {
    const exact: Exact = true; // errors when the list and the union disagree
    expect(exact).toBe(true);
    const listed: string[] = [...SERVER_EVENT_TYPES];
    expect(listed.sort()).toEqual(unionTypes());
  });

  test.each([
    ["web", "static/index.html"],
    ["gtk4", "sonia-gtk4/app.ts"],
  ])("the %s client handles every event and nothing else", (_name, file) => {
    const handled = clientCases(file);
    const listed: string[] = [...SERVER_EVENT_TYPES];
    expect(handled).toEqual(listed.sort());
  });
});
