/**
 * The banner above the chat: every timer still to ring, every command still running and
 * every watch still checking, each chip with a ✕ (a `task_cancel` from the page) that
 * stops *that* task and nothing else.
 *
 * What is pinned here is the contract `static/index.html` relies on:
 *   - the list is sent whole, on every change (`{type:"tasks", tasks:[…]}`);
 *   - `due_in_ms` is relative to the moment of the send (the page counts it down itself);
 *   - cancelling a timer makes it never ring; cancelling a command kills the shell and
 *     answers the model instead of failing the turn; cancelling a watch ends the loop;
 *   - a watch is a read-only check repeated at an interval until the user stops it: it
 *     reports the value at every check, or (with `match`) only when the condition starts
 *     holding — and it is never more frequent than MIN_WATCH_S;
 *   - stopping a task also takes back what it had already queued to say: a watch that was
 *     closed must not keep reporting from the announcer's backlog (measured in the live
 *     log: a stale «Controllo di tmp-check» spoken 2.5 min after its ✕);
 *   - 🧹 (chat cleared, page reloaded) leaves the pending timers alone: a timer is a
 *     promise made to the user, and the banner is the only place it is visible;
 *   - an unknown id changes nothing and says nothing.
 */
import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Config } from "../../src/config";
import type { TaskInfo } from "../../src/events";
import { Assistant } from "../../src/harness/assistant";
import { MAX_TIMER_S, MAX_WATCH_S, MIN_WATCH_S, Tools } from "../../src/tools";

type Ev = { type: string; tasks?: TaskInfo[]; status?: string; id?: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fd-tasks-"));

/** Poll until `cond` holds — the shell has to be *in* the list before it can be cancelled. */
async function until(cond: () => boolean, what: string, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await sleep(20);
  }
}

function fixture(opts: { locale?: "it" | "en"; timeoutS?: number; minWatchS?: number } = {}) {
  const dir = tmp();
  const seen: Ev[] = [];
  const rings: string[] = [];
  const tools = new Tools({
    dataDir: dir,
    announce: (text) => rings.push(text),
    cmdMode: "auto",
    cmdTimeoutS: opts.timeoutS ?? 30,
    ...(opts.minWatchS === undefined ? {} : { minWatchS: opts.minWatchS }),
    epoch: () => 0,
    emit: (ev) => seen.push(ev as Ev),
    ...(opts.locale ? { locale: opts.locale } : {}),
  });
  const lastTasks = () => [...seen].reverse().find((e) => e.type === "tasks")?.tasks ?? null;
  const done = () => {
    tools.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { tools, dir, seen, rings, lastTasks, done };
}

/** An `Assistant` wearing this `Tools` — enough to run `resetConversation()` on it. */
function assistantOver(tools: Tools): Assistant {
  const a = new Assistant(Config.fromEnv(), null, "null");
  a.log = () => {};
  a.tools = tools;
  return a;
}

describe("the timer chip", () => {
  test("appears with its own countdown, and the ✕ makes it never ring", async () => {
    const { tools, seen, rings, lastTasks, done } = fixture();
    expect(tools.tasks()).toEqual([]);

    await tools.call("set_timer", JSON.stringify({ seconds: 30, label: "caffè" }));
    const afterSet = seen.at(-1)!;
    expect(afterSet.type).toBe("tasks");
    const [task] = afterSet.tasks!;
    expect(task).toMatchObject({ id: "timer-1", kind: "timer", label: "caffè" });
    expect(task!.due_in_ms).toBeGreaterThan(25_000);
    expect(task!.due_in_ms).toBeLessThanOrEqual(30_000);

    expect(tools.cancelTask("timer-1")).toEqual({
      id: "timer-1",
      kind: "timer",
      label: "caffè",
    });
    expect(tools.tasks()).toEqual([]); // the ✕ is answered with an empty list
    expect(lastTasks()).toEqual([]); // …over the wire too
    expect(tools.cancelTask("timer-1")).toBeNull(); // a second ✕ has nothing left to hit

    await sleep(1500);
    expect(rings).toEqual([]); // it really never rang
    done();
  });

  test("rings on time: the chip goes and the announcement is queued", async () => {
    const { tools, seen, rings, lastTasks, done } = fixture();
    await tools.call("set_timer", JSON.stringify({ seconds: 1, label: "caffè" }));
    expect(tools.tasks()).toHaveLength(1);
    // Poll for the ring rather than sleeping past it: a fixed `sleep(1300)` over a 1 s
    // timer leaves only 300 ms of slack, so a loaded CI box reports "did not ring yet"
    // as a failure. `until` waits as long as it takes and fails only when it cannot.
    await until(() => rings.length >= 1, "the timer to ring");
    expect(tools.tasks()).toEqual([]);
    expect(lastTasks()).toEqual([]); // the ring took the chip with it
    expect(rings).toEqual(["Il caffè è scaduto."]);
    expect(seen.map((e) => e.type)).toEqual(["tasks", "tasks"]);
    done();
  });

  test("🧹 keeps the chip: a timer belongs to the user, not to the chat", async () => {
    const { tools, lastTasks, done } = fixture();
    await tools.call("set_timer", JSON.stringify({ seconds: 60, label: "riso" }));
    expect(tools.tasks()).toHaveLength(1);
    // 🧹 = the page was reloaded or the chat cleared: the banner is the only place this
    // timer is visible, and wiping it with the chat is how one silently never rang
    assistantOver(tools).resetConversation();
    expect(tools.tasks()).toHaveLength(1);
    expect(lastTasks()!.map((t) => t.label)).toEqual(["riso"]);
    done();
  });

  test("a ring that comes due after the chat was cleared still rings", async () => {
    const { tools, rings, done } = fixture();
    await tools.call("set_timer", JSON.stringify({ seconds: 1, label: "caffè" }));
    assistantOver(tools).resetConversation();
    await until(() => rings.length >= 1, "the ring after a cleared chat");
    expect(rings).toEqual(["Il caffè è scaduto."]);
    done();
  });
});

describe("the chip of a running command", () => {
  test("is listed while the shell runs, with its timeout as the deadline", async () => {
    const { tools, done } = fixture({ timeoutS: 25 });
    const run = tools.runCommand("sleep 5");
    await until(() => tools.tasks().length === 1, "the command to be listed");
    const [task] = tools.tasks();
    expect(task).toMatchObject({ id: "cmd-1", kind: "command", label: "sleep 5" });
    expect(task!.due_in_ms).toBeGreaterThan(20_000);
    expect(task!.due_in_ms).toBeLessThanOrEqual(25_000);
    tools.cancelTask("cmd-1");
    await run;
    done();
  });

  test("the ✕ kills the shell, empties the banner and tells the model why", async () => {
    const { tools, seen, done } = fixture({ locale: "en" });
    const run = tools.runCommand("sleep 5 && echo NEVER");
    await until(() => tools.tasks().length === 1, "the command to be listed");

    const t0 = Date.now();
    expect(tools.cancelTask("cmd-1")).toMatchObject({
      kind: "command",
      label: "sleep 5 && echo NEVER",
    });
    expect(tools.tasks()).toEqual([]); // gone from the banner straight away
    const out = await run;
    expect(Date.now() - t0).toBeLessThan(4000); // no waiting for the 5 s sleep

    expect(out).toContain("Command cancelled by the user");
    expect(out).not.toContain("NEVER"); // the process group really was killed
    // the card still gets its own line, and the banner's last word is "empty"
    expect(seen.map((e) => e.type)).toEqual(["command_start", "tasks", "tasks", "command_result"]);
    expect(seen.at(-1)!.status).toBe("cancelled");
    done();
  });

  test("an unknown id changes nothing and announces nothing", async () => {
    const { tools, seen, done } = fixture();
    await tools.call("set_timer", JSON.stringify({ seconds: 60, label: "caffè" }));
    const before = seen.length;
    expect(tools.cancelTask("timer-404")).toBeNull();
    expect(seen.length).toBe(before); // no event for a ✕ that hit nothing
    expect(tools.tasks()).toHaveLength(1);
    done();
  });
});

describe("several tasks at once", () => {
  test("the soonest to end comes first, whatever kind it is", async () => {
    const { tools, done } = fixture();
    await tools.call("set_timer", JSON.stringify({ seconds: 300, label: "lungo" }));
    const run = tools.runCommand("sleep 3");
    await until(() => tools.tasks().length === 2, "both tasks listed");
    await tools.call("set_timer", JSON.stringify({ seconds: 10, label: "breve" }));

    const list = tools.tasks();
    expect(list.map((t) => t.label)).toEqual(["breve", "sleep 3", "lungo"]);
    expect(new Set(list.map((t) => t.id)).size).toBe(3); // three chips, three ids

    for (const id of list.map((t) => t.id)) tools.cancelTask(id);
    await run;
    expect(tools.tasks()).toEqual([]);
    done();
  });

  test("a watch is one more chip, sorted by its next check like any other deadline", async () => {
    const { tools, done } = fixture({ locale: "en", minWatchS: 0 });
    await tools.call("set_timer", JSON.stringify({ seconds: 300, label: "lungo" }));
    await tools.call(
      "start_watch",
      JSON.stringify({ command: "echo 42%", every: 1, label: "battery" }),
    );
    await tools.call("set_timer", JSON.stringify({ seconds: 10, label: "breve" }));
    expect(tools.tasks().map((t) => t.label)).toEqual(["battery", "breve", "lungo"]);
    for (const id of tools.tasks().map((t) => t.id)) tools.cancelTask(id);
    expect(tools.tasks()).toEqual([]);
    done();
  });
});

describe("the watch chip — a check repeated at an interval, forever", () => {
  test("checks right away and keeps checking, announcing the value each time", async () => {
    const { tools, rings, lastTasks, done } = fixture({ locale: "en", minWatchS: 0 });
    const said = await tools.call(
      "start_watch",
      JSON.stringify({ command: "echo 42%", every: 0.2, label: "battery" }),
      undefined,
      "check the battery",
    );
    expect(said).toContain("battery");

    expect(tools.tasks()).toMatchObject([{ id: "watch-1", kind: "watch", label: "battery" }]);
    expect(tools.taskLocale("watch-1")).toBe("en"); // its checks speak in the request's language
    await until(() => rings.length >= 2, "two checks reported");
    expect(rings[0]).toBe("Check of battery: 42%");
    // the chip counts down to the NEXT check: it is never stuck at a deadline it passed
    expect(lastTasks()![0]!.due_in_ms).toBeGreaterThan(0);

    expect(tools.cancelTask("watch-1")).toEqual({
      id: "watch-1",
      kind: "watch",
      label: "battery",
    });
    expect(tools.tasks()).toEqual([]);
    const saidAfter = rings.length;
    await sleep(600);
    expect(rings.length).toBe(saidAfter); // the loop really ended, no more checks
    done();
  });

  test("with `match` it stays quiet until the condition holds, then says it once", async () => {
    const { tools, dir, rings, done } = fixture({ locale: "en", minWatchS: 0 });
    const flag = path.join(dir, "done.flag");
    await tools.call(
      "start_watch",
      JSON.stringify({
        command: `cat ${flag} 2>/dev/null || echo pending`,
        every: 0.2,
        label: "download",
        match: "done",
      }),
      undefined,
      "tell me when the download is done",
    );
    // Negative assertions need *more* slack than positive ones, not less: these watch
    // "nothing happened" across a 200 ms poll period, so the window is three periods
    // (600 ms) — a loaded box that stretches a tick cannot flip the result.
    await sleep(600);
    expect(rings).toEqual([]); // still pending: nothing worth saying

    fs.writeFileSync(flag, "done ✓\n");
    await until(() => rings.length >= 1, "the condition to be announced");
    expect(rings[0]).toBe("Heads-up, download: done ✓");

    await sleep(600); // it keeps matching: it does NOT say it again
    expect(rings).toHaveLength(1);
    tools.cancelTask("watch-1");
    done();
  });

  test("stop_watch: no label lists what is running, a fragment stops that one", async () => {
    const { tools, done } = fixture({ locale: "en", minWatchS: 0 });
    const start = (label: string) =>
      tools.call("start_watch", JSON.stringify({ command: `echo ${label}`, every: 0.2, label }));
    await start("download");
    await start("battery level");
    expect(tools.tasks()).toHaveLength(2);

    const inventory = await tools.call("stop_watch", "{}");
    expect(inventory).toContain("download");
    expect(inventory).toContain("battery level");
    expect(tools.tasks()).toHaveLength(2); // listing is not stopping

    const stopped = await tools.call("stop_watch", JSON.stringify({ label: "batt" }));
    expect(stopped).toContain("battery level"); // a fragment is enough
    expect(tools.tasks().map((t) => t.label)).toEqual(["download"]);

    const miss = await tools.call("stop_watch", JSON.stringify({ label: "nothing" }));
    expect(miss).toContain("No watch matches");
    expect(tools.tasks()).toHaveLength(1);

    const last = await tools.call("stop_watch", JSON.stringify({ label: "download" }));
    expect(last).toContain("download");
    expect(tools.tasks()).toEqual([]);
    expect(await tools.call("stop_watch", "{}")).toContain("No watch is running");
    done();
  });

  test("the ✕ line follows the watch's language, like a timer's ring", async () => {
    const { tools, rings, done } = fixture({ minWatchS: 0 });
    await tools.call(
      "start_watch",
      JSON.stringify({ command: "echo 42%", every: 0.2, label: "batteria" }),
      undefined,
      "controlla la batteria",
    );
    const events: string[] = [];
    const a = assistantOver(tools);
    a.emit = (ev) => events.push(String((ev as { text?: string }).text ?? ""));
    await until(() => rings.length >= 1, "the first check to be reported");
    expect(rings.join("\n")).toContain("Controllo di batteria: 42%");
    expect(a.cancelTask("watch-1")).toMatchObject({ kind: "watch", label: "batteria" });
    expect(events.join("\n")).toContain("⏹ controllo «batteria» fermato");
    done();
  });

  test("🧹 keeps the watch (like a timer); close() is what ends it", async () => {
    const { tools, done } = fixture({ locale: "en", minWatchS: 0 });
    await tools.call(
      "start_watch",
      JSON.stringify({ command: "echo 42%", every: 0.2, label: "battery" }),
    );
    assistantOver(tools).resetConversation();
    expect(tools.tasks()).toHaveLength(1);
    tools.close(); // the process is going away
    expect(tools.tasks()).toEqual([]);
    done();
  });

  test("no command → refused; an out-of-range `every` is answered, not silently changed", async () => {
    const { tools, done } = fixture({ locale: "en" }); // minWatchS defaults to MIN_WATCH_S
    expect(await tools.call("start_watch", JSON.stringify({ every: 30 }))).toContain(
      "No command to watch",
    );
    expect(
      await tools.call(
        "start_watch",
        JSON.stringify({ command: "echo 42%", every: 1, label: "battery" }),
      ),
    ).toContain(`between ${MIN_WATCH_S} and ${MAX_WATCH_S}`);
    expect(tools.tasks()).toHaveLength(0);
    done();
  });

  test("a check slower than the interval never overlaps the next one", async () => {
    const { tools, dir, done } = fixture({ locale: "en", minWatchS: 0 });
    const ticks = path.join(dir, "ticks.txt");
    await tools.call(
      "start_watch",
      JSON.stringify({
        command: `echo x >> ${ticks}; sleep 0.5`,
        every: 0.1,
        label: "slow",
      }),
    );
    await sleep(300); // several old-style ticks would have started by now
    const started = fs.existsSync(ticks) ? fs.readFileSync(ticks, "utf8").trim().split("\n") : [];
    expect(started).toHaveLength(1); // one in flight, the next booked only after it ends
    tools.cancelTask("watch-1");
    await sleep(50);
    done();
  });
});

describe("timer and watch bounds", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fd-bounds-"));
  const tools = new Tools({ dataDir: tmp, announce: () => {}, cmdMode: "auto", locale: "en" });
  afterAll(() => {
    tools.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("a timer outside 1…24 h is answered, not clamped", async () => {
    for (const seconds of [0, -5, 1e12, "abc"]) {
      expect(await tools.call("set_timer", JSON.stringify({ seconds, label: "x" }))).toContain(
        `between 1 and ${MAX_TIMER_S}`,
      );
    }
    expect(tools.tasks()).toEqual([]);
    // the boundary itself is accepted (then cancelled: no need to wait a day)
    expect(
      await tools.call("set_timer", JSON.stringify({ seconds: MAX_TIMER_S, label: "max" })),
    ).toContain("86400");
    tools.cancelTask("timer-1");
  });

  test("a watch outside 5…86400 s is answered, not clamped", async () => {
    for (const every of [0, 1, 1e12, "abc"]) {
      expect(
        await tools.call("start_watch", JSON.stringify({ command: "echo x", every, label: "x" })),
      ).toContain(`between ${MIN_WATCH_S} and ${MAX_WATCH_S}`);
    }
    expect(tools.tasks()).toEqual([]);
  });
});

describe("a task's queued voice", () => {
  /** The announcer's queue belongs to the Assistant: hand this Tools its two verbs. */
  function wired(tools: Tools) {
    const a = assistantOver(tools);
    tools.announce = (text, key) => a.announce(text, key);
    tools.withdraw = (key) => a.withdrawAnnouncements(key);
    return a;
  }

  test("a watch has at most one report waiting — and the ✕ takes even that away", async () => {
    const { tools, done } = fixture({ locale: "en", minWatchS: 0 });
    const a = wired(tools);
    await tools.call(
      "start_watch",
      JSON.stringify({ command: "echo 42%", every: 0.2, label: "battery" }),
    );
    await until(() => a.announcements.length >= 1, "a first report");
    await sleep(250); // several more checks while it is "speaking"
    expect(a.announcements).toHaveLength(1); // the newest value, never a backlog
    expect(a.announcements[0]!.text).toBe("Check of battery: 42%");

    tools.cancelTask("watch-1");
    expect(a.announcements).toEqual([]); // what it had queued goes with it
    await sleep(250);
    expect(a.announcements).toEqual([]); // and nothing new arrives: the loop is over
    done();
  });

  test("a check still in flight when the ✕ lands says nothing either", async () => {
    const { tools, done } = fixture({ locale: "en", minWatchS: 0 });
    const a = wired(tools);
    await tools.call(
      "start_watch",
      JSON.stringify({ command: "sleep 0.4 && echo LATE", every: 0.2, label: "slow" }),
    );
    tools.cancelTask("watch-1"); // the ✕ lands while the first check is still running
    await sleep(900);
    expect(a.announcements).toEqual([]); // its output was killed with it, not reported
    expect(tools.tasks()).toEqual([]);
    done();
  });
});
