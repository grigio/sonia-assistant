/**
 * `src/command-policy.ts` — the trust rules *behind* `run_command`, at the corners
 * tools.test does not cover: the exact meaning of "a trusted skill line" (segmenting,
 * interpreters, helpers, the `cd` rule — and a word that smuggles a separator inside
 * it), the sensitive-path classifier, and the two places the policy turns into
 * behaviour: the `CMD_MODE=auto` refusal (with the `ask`-mode twin at the approval
 * prompt) and the malformed-arguments complaint, driven through `Tools` the way the
 * harness drives it.
 */

import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isSafeCommand, isSensitiveCommand, isTrustedSkillLine } from "../../src/command-policy";
import { t } from "../../src/i18n";
import { Tools } from "../../src/tools";

const S = "/tmp/fd-policy-skills"; // absolute; the trust rules never touch the disk

describe("isTrustedSkillLine", () => {
  test("the line every skill README writes: fetch outside, run the skill's script", () => {
    expect(
      isTrustedSkillLine(`curl -s https://x.io/f.html && python3 ${S}/ddg.py out.html`, S),
    ).toBe(true);
  });

  test("a `cd` *into* the skills dir unlocks the relative paths that follow", () => {
    expect(isTrustedSkillLine(`cd ${S}/demo && bun run scripts/x.ts`, S)).toBe(true);
    // a quoted name with spaces stays one word — still one interpreter target
    expect(isTrustedSkillLine(`python3 ${S}/ddg.py "peak hour.csv"`, S)).toBe(true);
  });

  test("a `cd` that goes anywhere else is a wall", () => {
    expect(isTrustedSkillLine(`cd /tmp && cat ${S}/x`, S)).toBe(false);
    expect(isTrustedSkillLine(`cd ~ && grep -q x ${S}/y`, S)).toBe(false);
    // …and what arrives after a *legal* cd is checked in the cd'd cwd: rm is rm
    expect(isTrustedSkillLine(`cd ${S}/demo && rm -rf .`, S)).toBe(false);
    expect(isTrustedSkillLine(`cd ${S}/demo && sudo cat /etc/shadow`, S)).toBe(false);
  });

  test("interpreters trust a skills file only — never inline code, never a foreign file", () => {
    expect(isTrustedSkillLine(`python3 -c 'print(1)' ${S}/x.py`, S)).toBe(false);
    expect(isTrustedSkillLine(`node --eval ${S}/x.js`, S)).toBe(false);
    expect(isTrustedSkillLine(`bash /tmp/evil.sh ${S}/y`, S)).toBe(false);
  });

  test("what the segments may contain is one fixed vocabulary", () => {
    // the read-only/fetch helpers chain around the skill's own script
    expect(isTrustedSkillLine(`grep -q pattern ${S}/x && head -n 3 ${S}/x`, S)).toBe(true);
    expect(isTrustedSkillLine(`curl https://x.io && rm -rf /tmp/z`, S)).toBe(false);
  });

  test("segment boundaries work with and without the space (`;` glued to the word)", () => {
    expect(isTrustedSkillLine(`cat ${S}/x; cat ${S}/y`, S)).toBe(true); // the spaced form
    expect(isTrustedSkillLine(`cat ${S}/x &&`, S)).toBe(false); // trailing separator
    expect(isTrustedSkillLine(`&& cat ${S}/x`, S)).toBe(false); // leading separator
    expect(isTrustedSkillLine(`; cat ${S}/x`, S)).toBe(false); // an empty first segment
  });

  test("a word that carries a separator inside it is refused — the shell would obey it", () => {
    // these *used* to parse as one `cat` segment and were trusted (`rm` never seen here)
    expect(isTrustedSkillLine(`cat ${S}/x;rm -rf ~`, S)).toBe(false);
    expect(isTrustedSkillLine(`cat ${S}/x&&rm -rf ~`, S)).toBe(false);
    expect(isTrustedSkillLine(`cat ${S}/x &&rm -rf ~`, S)).toBe(false);
    expect(isTrustedSkillLine(`cat ${S}/x&rm -rf ~`, S)).toBe(false); // background, too
    // a quoted separator is inert spelling, not control flow: one read of a funny name
    expect(isTrustedSkillLine(`cat "${S}/a;b.txt"`, S)).toBe(true);
    // …but a quoted word *continuing* into an unquoted one is the glued case again
    expect(isTrustedSkillLine(`cat "${S}/a;b.txt";rm -rf ~`, S)).toBe(false);
  });

  test("isSafeCommand inherits the rule: the glued line lands at the approval prompt", () => {
    expect(isSafeCommand(`cat ${S}/x;rm -rf ~`, S)).toBe(false);
    expect(isSafeCommand(`cat ${S}/x&&rm -rf ~`, S)).toBe(false);
    // …while the honest spelling of the same two reads stays unattended
    expect(isSafeCommand(`cat ${S}/x && cat ${S}/y`, S)).toBe(true);
  });
});

describe("isSensitiveCommand", () => {
  test("the paths nothing may touch unattended", () => {
    expect(isSensitiveCommand("cat ~/.ssh/id_rsa")).toBe(true);
    expect(isSensitiveCommand("ls ~/.gnupg")).toBe(true);
    expect(isSensitiveCommand("cat .env")).toBe(true);
    expect(isSensitiveCommand("stat /etc/shadow")).toBe(true);
    expect(isSensitiveCommand("cp ~/.aws/credentials /tmp/x")).toBe(true);
    expect(isSensitiveCommand("cat ~/.mozilla/firefox/cookies.sqlite")).toBe(true);
    // deliberately loose on *words*: "password"/"token" even mid-line
    expect(isSensitiveCommand("echo password")).toBe(true);
    expect(isSensitiveCommand("grep TOKEN ~/.bashrc")).toBe(true);
  });

  test("it keeps out of the ordinary's way", () => {
    expect(isSensitiveCommand("ls ~/Documents")).toBe(false);
    expect(isSensitiveCommand("cat .envrc")).toBe(false); // the `\b` in `.env\b`
    expect(isSensitiveCommand("systemctl --environment dev status x")).toBe(false);
  });
});

describe("CMD_MODE=auto refuses sensitive commands (the ask twin still prompts)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fd-policy-"));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const clean = path.join(tmp, "clean.txt");
  fs.writeFileSync(clean, "hello\n");

  /** Tools whose approval prompt *records* instead of approving (a refusal never reaches it). */
  const asking = (dataDir: string, approveCalls: string[]) =>
    new Tools({
      dataDir,
      announce: () => {},
      approve: async (cmd: string) => {
        approveCalls.push(cmd);
        return false;
      },
      cmdMode: "ask",
    });

  test("auto: refused before anything runs, with a `denied` card for the UI", async () => {
    const events: unknown[] = [];
    const approveCalls: string[] = [];
    const tools = new Tools({
      dataDir: path.join(tmp, "auto"),
      announce: () => {},
      approve: async (cmd: string) => {
        approveCalls.push(cmd);
        return false;
      },
      emit: (ev) => events.push(ev),
      cmdMode: "auto",
    });
    expect(await tools.runCommand("cat ~/.ssh/id_rsa")).toBe(t("it", "cmd.sensitive"));
    expect(approveCalls).toEqual([]); // auto has no one to ask: it refuses, it does not queue
    const denied = events.filter(
      (ev) =>
        typeof ev === "object" &&
        ev !== null &&
        (ev as { type?: unknown }).type === "command_result" &&
        (ev as { status?: unknown }).status === "denied",
    );
    expect(denied).toHaveLength(1);
  });

  test("auto: an ordinary read-only keeps running unattended", async () => {
    const tools = new Tools({
      dataDir: path.join(tmp, "auto-ok"),
      announce: () => {},
      cmdMode: "auto",
    });
    expect(await tools.runCommand(`cat ${clean}`)).toContain("exit code 0");
  });

  test("ask: the same command reaches the approval prompt; declining says so", async () => {
    const approveCalls: string[] = [];
    const tools = asking(path.join(tmp, "ask"), approveCalls);
    expect(await tools.runCommand("cat ~/.ssh/id_rsa")).toBe(t("it", "cmd.denied"));
    expect(approveCalls).toEqual(["cat ~/.ssh/id_rsa"]);
    // read-only runs *without* the prompt in ask mode — exactly one call for two commands
    expect(await tools.runCommand(`cat ${clean}`)).toContain("exit code 0");
    expect(approveCalls).toHaveLength(1);
  });

  test("auto: a *watch* over a sensitive path is refused too — a watch repeats", async () => {
    const approveCalls: string[] = [];
    const tools = new Tools({
      dataDir: path.join(tmp, "watch"),
      announce: () => {},
      approve: async (cmd: string) => {
        approveCalls.push(cmd);
        return false;
      },
      cmdMode: "auto",
    });
    await tools.call(
      "start_watch",
      JSON.stringify({ every: 60, command: "tail ~/.env", label: "env" }),
    );
    expect(approveCalls).toEqual([]);
    // the refusal must happen *before* the booking: no task chip for a watch that
    // never gets its first tick
    expect((tools as unknown as { watches: Map<string, unknown> }).watches.size).toBe(0);
  });

  test("ask: a watch over a sensitive path prompts once, and a denial books nothing", async () => {
    const approveCalls: string[] = [];
    const tools = asking(path.join(tmp, "watch-ask"), approveCalls);
    expect(
      await tools.call(
        "start_watch",
        JSON.stringify({ every: 60, command: "tail ~/.env", label: "env" }),
      ),
    ).toBe(t("it", "cmd.denied"));
    expect(approveCalls).toEqual(["tail ~/.env"]);
    expect((tools as unknown as { watches: Map<string, unknown> }).watches.size).toBe(0);
  });
});

describe("malformed tool arguments are *said*, not swallowed", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fd-badargs-"));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const tools = new Tools({ dataDir: tmp, announce: () => {}, cmdMode: "auto" });

  test("a broken JSON blob comes back as a complaint naming the tool", async () => {
    expect(await tools.call("set_timer", "{oops")).toBe(
      t("it", "tool.badArgs", { name: "set_timer" }),
    );
  });

  test("JSON that is not an object is the same story", async () => {
    expect(await tools.call("set_timer", "[1,2]")).toBe(
      t("it", "tool.badArgs", { name: "set_timer" }),
    );
    expect(await tools.call("set_timer", "null")).toBe(
      t("it", "tool.badArgs", { name: "set_timer" }),
    );
  });

  test("nothing else changed for an empty args string", async () => {
    // the healthy "no args" — the old behaviour kept working for it
    const out = await tools.call("get_datetime", "");
    expect(out).not.toBe(t("it", "tool.badArgs", { name: "get_datetime" }));
  });
});
