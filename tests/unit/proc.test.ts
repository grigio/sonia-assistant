/**
 * `scripts/proc.ts` — the pure parsing rules of the stop script's process discovery: a
 * pid file, an `ss -tlnpH` line, and what may count as "our harness". The /proc-walking
 * and the `ss` spawn stay in stop.ts — here the *decisions* are tested without touching
 * the disk, which is the part that decides what gets a SIGTERM.
 */
import { describe, expect, test } from "bun:test";
import { isHarnessProcess, parsePidFile, parseSsPid } from "../../scripts/proc";

describe("parsePidFile", () => {
  test("a normal file with its trailing newline", () => {
    expect(parsePidFile("4815\n")).toBe(4815);
    expect(parsePidFile("7")).toBe(7);
  });

  test("junk is never a pid (0 counts as junk: pid 0 is the idle daemon)", () => {
    expect(parsePidFile("")).toBeNull();
    expect(parsePidFile("   \n")).toBeNull();
    expect(parsePidFile("481.5")).toBeNull();
    expect(parsePidFile("cat ate it")).toBeNull();
    expect(parsePidFile("-1")).toBeNull();
    expect(parsePidFile("0")).toBeNull();
  });
});

describe("parseSsPid", () => {
  test("the exact line one `ss -tlnpH` prints for a listener", () => {
    expect(parseSsPid('LISTEN 0 4096 *:8095 *:* users:(("bun",pid=4815,fd=137))')).toBe(4815);
  });

  test("no listener, empty output → no pid", () => {
    expect(parseSsPid("")).toBeNull();
    expect(parseSsPid("State  Recv-Q  Send-Q  Local Address:Port  Process")).toBeNull();
  });

  test("several candidates: the FIRST one wins — like the `ss` ordering shows it", () => {
    expect(parseSsPid('(("bun",pid=4815,fd=137),("node",pid=99,fd=3))')).toBe(4815);
  });
});

describe("isHarnessProcess", () => {
  const ROOT = "/home/g/Code/sonia-assistant"; // any checkout path; nothing consults the real one

  test("the real thing: bun/node, in the checkout, running cli.ts", () => {
    expect(
      isHarnessProcess({ exe: "bun", cwd: ROOT, cmd: `bun ${ROOT}/src/cli.ts --web` }, ROOT, true),
    ).toBe(true);
    // cwd deeper in the checkout + the cmdline naming the checkout root: equally ours
    expect(
      isHarnessProcess(
        { exe: "node", cwd: `${ROOT}/src`, cmd: `/usr/bin/node ${ROOT}/src/cli.ts --web` },
        ROOT,
        true,
      ),
    ).toBe(true);
    // started elsewhere; only the cmdline quotes the checkout
    expect(
      isHarnessProcess(
        { exe: "bun", cwd: "/tmp", cmd: `bun ${ROOT}/src/cli.ts --web` },
        ROOT,
        true,
      ),
    ).toBe(true);
  });

  test("an unrelated process holding the port never passes", () => {
    expect(
      isHarnessProcess(
        { exe: "python", cwd: "/srv", cmd: "python -m http.server 8095" },
        ROOT,
        true,
      ),
    ).toBe(false);
  });

  test("the /proc walk's bait: a line merely *quoting* the repo (grep, `bun test`, a paste)", () => {
    // cwd + cmdline look right, but the interpreter check says: not something
    // executing `cli.ts` — a grep/agent session quoting both strings is not the harness
    expect(
      isHarnessProcess({ exe: "sh", cwd: ROOT, cmd: `grep cli.ts ${ROOT}/README.md` }, ROOT, true),
    ).toBe(false);
    expect(
      isHarnessProcess(
        { exe: "fish", cwd: ROOT, cmd: `bun test ${ROOT}/tests/unit/web-origin.test.ts cli.ts` },
        ROOT,
        true,
      ),
    ).toBe(false);
  });

  test("each guard refuses its own case", () => {
    // not alive (EPERM still counts as alive: it exists, just not ours to signal)
    expect(
      isHarnessProcess({ exe: "bun", cwd: ROOT, cmd: `bun ${ROOT}/src/cli.ts` }, ROOT, false),
    ).toBe(false);
    // exe unreadable (a re-parented /proc entry, a vanished exe) — some other process
    expect(
      isHarnessProcess({ exe: "", cwd: ROOT, cmd: `bun ${ROOT}/src/cli.ts` }, ROOT, true),
    ).toBe(false);
    // the checkout, the interpreter — but no cli.ts in the command line
    expect(
      isHarnessProcess({ exe: "bun", cwd: ROOT, cmd: "bun run scripts/run.ts" }, ROOT, true),
    ).toBe(false);
  });
});
