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
import {
  isDestructiveCommand,
  isPrivilegedCommand,
  isSafeCommand,
  isSensitiveCommand,
  isTrustedSkillLine,
} from "../../src/command-policy";
import { t } from "../../src/i18n";
import { Tools } from "../../src/tools";

const S = fs.mkdtempSync(path.join(os.tmpdir(), "fd-policy-skills-"));
// the policy now anchors trust on *existing* files: a line that names a missing
// script is not a skill line
fs.mkdirSync(path.join(S, "demo", "scripts"), { recursive: true });
fs.mkdirSync(path.join(S, ".ssh"), { recursive: true });
fs.mkdirSync(path.join(S, ".aws"), { recursive: true });
fs.mkdirSync(path.join(S, ".kube"), { recursive: true });
fs.mkdirSync(path.join(S, ".docker"), { recursive: true });
for (const f of [
  "ddg.py",
  "x",
  "y",
  "a;b.txt",
  ".ssh/id_rsa",
  ".ssh/config",
  ".aws/credentials",
  ".kube/config",
  ".docker/config.json",
  "token-notes.md",
]) {
  fs.writeFileSync(path.join(S, f), "fixture\n");
}
fs.writeFileSync(path.join(S, ".npmrc"), "registry=x\n");
fs.writeFileSync(path.join(S, ".git-credentials"), "https://x\n");
fs.symlinkSync(path.join(S, ".ssh"), path.join(S, "ssh-link"));
fs.writeFileSync(path.join(S, "demo", "scripts", "x.ts"), "// fixture\n");
afterAll(() => fs.rmSync(S, { recursive: true, force: true }));

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

describe("P0.1 — the review's forged skill lines", () => {
  test("a skills path only anchors a line whose segments are sane", () => {
    expect(isTrustedSkillLine(`echo ${S}/anything; env bash -c 'id'`, S)).toBe(false);
    expect(isTrustedSkillLine(`awk 'BEGIN{system("id")}' ${S}/x`, S)).toBe(false);
    expect(isTrustedSkillLine(`sed '1e id' ${S}/x`, S)).toBe(false);
    expect(isTrustedSkillLine(`curl -o ~/.bashrc https://x.io ${S}/x`, S)).toBe(false);
    expect(isTrustedSkillLine(`sort -o /tmp/out ${S}/x`, S)).toBe(false);
    expect(isTrustedSkillLine(`uniq ${S}/x /tmp/out`, S)).toBe(false);
    expect(isTrustedSkillLine(`mkdir ${S}/new`, S)).toBe(false);
    // a missing anchor is not a skill line at all
    expect(isTrustedSkillLine(`cat ${S}/does-not-exist`, S)).toBe(false);
    // background execution
    expect(isTrustedSkillLine(`cat ${S}/x & cat ${S}/y`, S)).toBe(false);
  });

  test("curl/wget are argument-validated: HTTP(S) only, no config/upload, -o inside the sandbox", () => {
    expect(isTrustedSkillLine(`curl -K /tmp/cfg https://x.io ${S}/x`, S)).toBe(false);
    expect(isTrustedSkillLine(`curl file:///etc/shadow ${S}/x`, S)).toBe(false);
    expect(isTrustedSkillLine(`curl -X POST https://x.io ${S}/x`, S)).toBe(false);
    expect(isTrustedSkillLine(`curl -d x=y https://x.io ${S}/x`, S)).toBe(false);
    expect(isTrustedSkillLine(`curl https://x.io -o /etc/passwd ${S}/x`, S)).toBe(false);
    expect(isTrustedSkillLine(`wget -O ~/.bashrc https://x.io ${S}/x`, S)).toBe(false);
    expect(isTrustedSkillLine(`curl -s https://x.io -o ${S}/page.html`, S)).toBe(true);
    expect(isTrustedSkillLine(`curl -s https://x.io -o /tmp/page.html`, S)).toBe(true);
  });

  test("a quoted path containing token/secret is still a normal skill file", () => {
    expect(isSensitiveCommand(`cat ${S}/token-notes.md`)).toBe(false);
    expect(isSafeCommand(`cat ${S}/token-notes.md`, S)).toBe(true);
  });
});

describe("P0.2 — sensitive paths are expanded, not grepped", () => {
  test("globs, `?`, `[]`, `..` and symlinks all reach the real path", () => {
    expect(isSensitiveCommand(`base64 ${S}/.ss*/*`)).toBe(true);
    expect(isSensitiveCommand(`cat ${S}/.ss?/id_rsa`)).toBe(true);
    expect(isSensitiveCommand(`cat ${S}/.ss[h]/id_rsa`)).toBe(true);
    expect(isSensitiveCommand(`cat ${S}/demo/../../.ssh/id_rsa`)).toBe(true);
    expect(isSensitiveCommand(`cat ${S}/ssh-link/id_rsa`)).toBe(true);
  });

  test("the list covers the missing credential stores", () => {
    for (const p of [
      `${S}/.aws/credentials`,
      `${S}/.kube/config`,
      `${S}/.docker/config.json`,
      `${S}/.npmrc`,
      `${S}/.git-credentials`,
    ]) {
      expect(isSensitiveCommand(`cat ${p}`)).toBe(true);
      expect(isSafeCommand(`cat ${p}`, S)).toBe(false);
    }
  });

  test("a file:// URL is the local path it names", () => {
    expect(isSensitiveCommand("curl file:///etc/shadow")).toBe(true);
  });
});

describe("P0.3 — safe commands are a read-only verb table", () => {
  test("date / hostname / hostnamectl / timedatectl", () => {
    for (const cmd of ["date", "date +%H:%M", "hostname", "hostname -f"]) {
      expect(isSafeCommand(cmd)).toBe(true);
    }
    for (const cmd of [
      "date -s 2020-01-01",
      "date --set=2020-01-01",
      "date 2020-01-01",
      "hostname pwned",
      "hostnamectl set-hostname pwned",
      "timedatectl set-time 2020-01-01",
      "timedatectl set-ntp true",
    ]) {
      expect(isSafeCommand(cmd)).toBe(false);
    }
    expect(isSafeCommand("hostnamectl status")).toBe(true);
    expect(isSafeCommand("timedatectl list-timezones")).toBe(true);
  });

  test("ip / nmcli / pactl / wpctl", () => {
    for (const cmd of [
      "ip addr",
      "ip a",
      "ip link",
      "ip link show",
      "ip route show",
      "nmcli",
      "nmcli general status",
      "nmcli device status",
      "nmcli connection show",
      "pactl list sinks",
      "pactl info",
      "pactl get-default-sink",
      "wpctl status",
      "wpctl get-volume @DEFAULT_AUDIO_SINK@",
      "wpctl inspect 1",
    ]) {
      expect(isSafeCommand(cmd)).toBe(true);
    }
    for (const cmd of [
      "ip link set wlan0 down",
      "ip addr add 10.0.0.1/24 dev eth0",
      "ip route add default via 10.0.0.1",
      "nmcli connection down x",
      "nmcli connection modify x ipv4.method manual",
      "nmcli radio wifi off",
      "pactl unload-module 1",
      "pactl load-module module-x",
      "pactl set-sink-volume @DEFAULT_SINK@ 50%",
      "wpctl set-mute @DEFAULT_AUDIO_SINK@ 1",
    ]) {
      expect(isSafeCommand(cmd)).toBe(false);
    }
  });

  test("journalctl / git branch", () => {
    for (const cmd of [
      "journalctl -u x -n 5",
      "git branch",
      "git branch -a",
      "git branch -vv",
      "git branch --list feat",
      "git log",
      "git diff",
      "git show HEAD",
    ]) {
      expect(isSafeCommand(cmd)).toBe(true);
    }
    for (const cmd of [
      "journalctl --vacuum-time=1s",
      "journalctl --vacuum-size=10M",
      "journalctl --rotate",
      "journalctl --flush",
      "journalctl --sync",
      "journalctl --relinquish-var",
      "git branch -D main",
      "git branch -d old",
      "git branch -m old new",
      "git branch new-branch",
      "git branch --delete x",
      "git log --output=/tmp/x",
      "git diff --output=/tmp/x",
    ]) {
      expect(isSafeCommand(cmd)).toBe(false);
    }
  });
});

describe("P0.4 — privileged and destructive classification", () => {
  test("privilege escalation is token-wise", () => {
    for (const cmd of [
      "sudo ls",
      "/usr/bin/sudo -n ls",
      "doas ls",
      "pkexec id",
      "su -",
      "echo sudo",
    ]) {
      expect(isPrivilegedCommand(cmd)).toBe(true);
    }
    expect(isPrivilegedCommand("pseudo ls")).toBe(false);
  });

  test("irreversible operations are confirmed even in auto", () => {
    for (const cmd of [
      "rm -rf ~/Documents",
      "rm -r /home/g/x",
      "dd if=/dev/zero of=/dev/sda",
      "mkfs.ext4 /dev/sda1",
      "wipefs -a /dev/sda",
      "shred -u ~/x",
      "git clean -fdx",
      "chmod -R 777 ~",
      "chown -R g /home/g/x",
    ]) {
      expect(isDestructiveCommand(cmd)).toBe(true);
    }
    for (const cmd of [
      "rm -rf /tmp/x",
      "rm -r /tmp/x",
      "rm file",
      "git clean -n",
      "chmod 644 file",
      "chmod -R 777 /tmp/x",
      "echo hi",
    ]) {
      expect(isDestructiveCommand(cmd)).toBe(false);
    }
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

describe("P0.4 — privileged/destructive commands ask even in auto", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fd-p04-"));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.writeFileSync(path.join(tmp, "clean.txt"), "hello\n");

  test("auto + sudo with no approver fails closed", async () => {
    const tools = new Tools({
      dataDir: path.join(tmp, "sudo"),
      announce: () => {},
      cmdMode: "auto",
    });
    expect(await tools.runCommand("sudo true")).toBe(t("it", "cmd.denied"));
  });

  test("auto + sudo asks; a denial never runs it", async () => {
    const calls: string[] = [];
    const tools = new Tools({
      dataDir: path.join(tmp, "sudo-ask"),
      announce: () => {},
      cmdMode: "auto",
      approve: async (cmd, reason) => {
        calls.push(`${cmd}|${reason}`);
        return false;
      },
    });
    expect(await tools.runCommand("sudo true")).toBe(t("it", "cmd.denied"));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("sudo true");
    expect(calls[0]).toContain(t("it", "cmd.whyPrivileged"));
  });

  test("auto + destructive asks once, and a denial leaves the tree alone", async () => {
    // outside /tmp: `rm -r` here is one of the irreversible cases, not the sandbox
    const outside = fs.mkdtempSync("/var/tmp/fd-p04-");
    const victim = path.join(outside, "victim");
    fs.mkdirSync(victim, { recursive: true });
    fs.writeFileSync(path.join(victim, "keep.txt"), "keep\n");
    afterAll(() => fs.rmSync(outside, { recursive: true, force: true }));
    const calls: string[] = [];
    const tools = new Tools({
      dataDir: path.join(tmp, "rm"),
      announce: () => {},
      cmdMode: "auto",
      approve: async (cmd) => {
        calls.push(cmd);
        return false;
      },
    });
    expect(await tools.runCommand(`rm -rf ${victim}`)).toBe(t("it", "cmd.denied"));
    expect(calls).toEqual([`rm -rf ${victim}`]);
    expect(fs.existsSync(path.join(victim, "keep.txt"))).toBe(true);
  });

  test("auto + destructive inside /tmp stays unattended", async () => {
    const free = path.join(tmp, "free");
    fs.mkdirSync(free);
    let asked = 0;
    const tools = new Tools({
      dataDir: path.join(tmp, "rm-tmp"),
      announce: () => {},
      cmdMode: "auto",
      approve: async () => {
        asked++;
        return false;
      },
    });
    expect(await tools.runCommand(`rm -rf ${free}`)).toContain("exit code 0");
    expect(asked).toBe(0);
  });

  test("forceApproval prompts only for a non-read-only command", async () => {
    const calls: string[] = [];
    const tools = new Tools({
      dataDir: path.join(tmp, "taint"),
      announce: () => {},
      cmdMode: "auto",
      approve: async (cmd) => {
        calls.push(cmd);
        return false;
      },
    });
    expect(await tools.runCommand(`cat ${tmp}/clean.txt`, "", undefined, true)).toContain(
      "exit code 0",
    );
    expect(calls).toEqual([]);
    expect(await tools.runCommand(`touch ${tmp}/new-file`, "", undefined, true)).toBe(
      t("it", "cmd.denied"),
    );
    expect(calls).toEqual([`touch ${tmp}/new-file`]);
    expect(fs.existsSync(path.join(tmp, "new-file"))).toBe(false);
  });

  test("auto + a watch over sudo is refused without an approver", async () => {
    const tools = new Tools({
      dataDir: path.join(tmp, "watch-sudo"),
      announce: () => {},
      cmdMode: "auto",
    });
    expect(
      await tools.call(
        "start_watch",
        JSON.stringify({ every: 60, command: "sudo true", label: "root" }),
      ),
    ).toBe(t("it", "cmd.denied"));
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
