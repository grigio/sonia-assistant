/**
 * Small built-in tool set (function calling): clock, timers, watches (a check repeated at
 * an interval), notes, local shell commands.
 */

import fs from "node:fs";
import path from "node:path";
import { runShell } from "./shell-runner";
import type { Skills } from "./skills";
import { isSafeCommand } from "./command-policy";
import { detectLocale, intlLocale, parseLocale, t, type Locale } from "./i18n";
import type { ChatMessage } from "./clients/llm-types";
import type { TaskInfo } from "./events";
import type { ToolPayload } from "./clients/toolcards";

export {
  isSafeCommand,
  isSkillCommand,
  isTrustedSkillLine,
  SAFE_COMMANDS,
} from "./command-policy";

export const SCHEMAS: Record<string, unknown>[] = [
  {
    type: "function",
    function: {
      name: "get_datetime",
      description: "Current date and time.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "set_timer",
      description:
        "Sets a timer; the user is told out loud when it rings, in the language of their " +
        "request.",
      parameters: {
        type: "object",
        properties: {
          seconds: { type: "integer", description: "Duration in seconds" },
          label: { type: "string", description: "Short name of the timer" },
          lang: {
            type: "string",
            enum: ["it", "en"],
            description:
              "Language of the user's request ('it' or 'en'): the announcement when the " +
              "timer rings is spoken in that language",
          },
        },
        required: ["seconds"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "start_watch",
      description:
        "Repeats a READ-ONLY shell command at an interval, for as long as the user lets " +
        "it (forever — the chip at the top of the chat has a ✕ that stops it, and so does " +
        "stop_watch). With `match` it stays quiet until the command's output contains " +
        "that text and tells the user once, when that starts happening — that is how you " +
        "watch for a condition (battery low, download done, service back up). Without " +
        "`match` it reports the output at every check, for a value the user wants repeated.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Read-only shell command to run at every check (cat, df, curl…)",
          },
          every: { type: "integer", description: "Seconds between checks (minimum 5)" },
          label: { type: "string", description: "Short name: what the user hears and sees" },
          match: {
            type: "string",
            description:
              "Optional: tell the user only when the output starts containing this text",
          },
        },
        required: ["command", "every"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "stop_watch",
      description:
        "Stops one running watch, addressed by its label (the whole label or a fragment). " +
        "Without a label it answers with the watches still running.",
      parameters: {
        type: "object",
        properties: { label: { type: "string", description: "Which watch to stop" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_note",
      description: "Saves a note for the user.",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_note",
      description:
        "Deletes one saved note, addressed by the number list_notes gives it " +
        "(1 = first). Call list_notes right before: the numbers shift when one is removed.",
      parameters: {
        type: "object",
        properties: {
          index: { type: "integer", description: "Number of the note to delete (1 = first)" },
          text: {
            type: "string",
            description:
              "Optional fragment of the note you expect at that number; if it does not " +
              "match, nothing is deleted (the list changed under you).",
          },
        },
        required: ["index"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "clear_notes",
      description:
        "Deletes every saved note at once (irreversible). For the user asking to wipe " +
        "them all: list_notes first, get their yes, then call this with confirm true. " +
        "To delete only one, use remove_note instead.",
      parameters: {
        type: "object",
        properties: {
          confirm: {
            type: "boolean",
            description: "Must be true — the user agreed to lose all the notes",
          },
        },
        required: ["confirm"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_notes",
      description: "Reads the saved notes, numbered (the numbers remove_note expects).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_skills",
      description:
        "Lists the skills the user has activated in the UI (name + what each one is for). " +
        "Skills are packages of instructions and scripts; only the active ones exist for you.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "read_skill",
      description:
        "Returns the full instructions (SKILL.md) of an active skill — read it before " +
        "running that skill's scripts with run_command.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "Skill name, e.g. websurfx" } },
        required: ["name"],
      },
    },
  },
];

export const COMMAND_SCHEMA: Record<string, unknown> = {
  type: "function",
  function: {
    name: "run_command",
    description:
      "Runs a shell command (bash) on the user's local Linux computer " +
      "(Arch-based, sudo available without a password) and returns its output. Use it for " +
      "system info, files, processes, network, packages, and for the scripts of a skill " +
      "(commands inside the skills directory run without confirmation). Non-interactive " +
      "commands only. Depending on the approval policy, anything else may ask the user for " +
      "confirmation first.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The bash command line to run" },
        reason: { type: "string", description: "Short reason, shown to the user" },
      },
      required: ["command"],
    },
  },
};

/**
 * A tool call's arguments as one line for the tool gate to see: whitespace (any
 * newlines in a shell command) collapsed, clipped at `max`. Empty for a no-argument
 * call, so the judge is never shown a bare `{}`.
 */
export function argSummary(raw: string | undefined, max = 160): string {
  const s = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!s || s === "{}") return "";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Tools the **tool gate never judges**: they only load context (a SKILL.md, the list of
 * active skills) and act on nothing — the call that *does* something with them
 * (`run_command`) is still gated, so the dangerous half of the pair keeps its judge.
 *
 * Blocking a read stalls work the user did ask for: data/chat.json 372-381 —
 * "…Usa la skill." → `read_skill` denied (the judge saw a content request plus a trailing
 * skill mention and answered NONE), the turn died on a "Sì, procedi.", and the identical
 * `read_skill` → `run_command` chain ran one confirmation later anyway. A read is cheap
 * and repeat-safe (`Tools.alreadyInContext` refuses the second one), a denial costs a
 * whole user round-trip.
 */
export const GATE_EXEMPT_TOOLS: ReadonlySet<string> = new Set(["list_skills", "read_skill"]);

/** One-line description of a tool by name — what the tool gate is shown. */
export function toolDescription(name: string): string {
  type Fn = { function?: { name?: string; description?: string } };
  for (const s of SCHEMAS as Fn[]) {
    if (s.function?.name === name) return s.function.description ?? "";
  }
  const cmd = COMMAND_SCHEMA as Fn;
  return cmd.function?.name === name ? (cmd.function.description ?? "") : "";
}

export type CmdMode = "off" | "ask" | "auto";

/** A timer the banner can show and stop: when it rings, and what its chip says. */
type TimerTask = {
  timer: ReturnType<typeof setTimeout>;
  label: string;
  dueAt: number;
  /** The language of the request that set it — what its ring and its ✕ line are spoken in. */
  locale: Locale;
};

/** A running `run_command`: its own controller (so a ✕ kills the shell, not the turn). */
type CommandTask = {
  ctl: AbortController;
  command: string;
  /** Set by `cancelTask` — the abort that came from the banner, not from the turn. */
  cancelled: boolean;
  dueAt: number;
};

/**
 * A watch: one read-only command, repeated every `everyS` seconds until the user stops it
 * (a timer with no end — see `startWatch`). `dueAt` is the *next* check, which is what the
 * banner counts down to.
 */
type WatchTask = {
  label: string;
  command: string;
  /** "" = report the output at every check; else tell the user when it starts matching. */
  match: string;
  /** Whether the output currently matches: the announcement is made on the way in. */
  matched: boolean;
  everyS: number;
  dueAt: number;
  /** The language of the request that started it — what its checks are spoken in. */
  locale: Locale;
  /** Kills the check currently running; a fresh one is made for every tick. */
  ctl: AbortController;
  timer: ReturnType<typeof setTimeout> | null;
};

/**
 * A watch may not check more often than this: it runs unattended for as long as the user
 * leaves it, and a 1-second loop of shell commands is a load the user never asked for.
 */
export const MIN_WATCH_S = 5;

/**
 * How much of a long command output the model gets: its first and its last characters,
 * with `cmd.clipped` in between saying how many were dropped.
 *
 * The head is as important as the tail: a page dump is a list whose FIRST entries are the
 * newest ones (grigio.org's home page, data/logs/harness.log 12:31:37 and 12:48:15), so a
 * tail-heavy clip hands the model mostly the oldest posts of the page. Together with the
 * mark spelling out that the second fragment is the *end* of the output — the old
 * "…[troncato]…" let the model read it as the newest part, and it answered with the last
 * entries of the list twice — this is what makes "the latest post" come from the top.
 */
const CLIP_HEAD = 2500;
const CLIP_TAIL = 2500;

type EmitFn = (ev: ToolPayload | Record<string, unknown>) => void;
type ApproveFn = (command: string, reason: string) => Promise<boolean>;

export class Tools {
  readonly notesPath: string;
  /** UI language (LOCALE): a tool's result is shown on its card, so it is localized too. */
  readonly locale: Locale;
  /** Queue a line to say out of a turn; `key` is the task it belongs to, so that a newer
   *  report from the same task replaces the waiting one (and `withdraw` can take it back). */
  announce: (text: string, key?: string) => void;
  /** The task behind `key` is gone: drop whatever it had queued to say — a stopped task
   *  must not ring out of its own backlog after the ✕ (see Assistant.withdrawAnnouncements). */
  withdraw: ((key: string) => void) | null;
  approve: ApproveFn | null;
  emit: EmitFn;
  cmdMode: CmdMode;
  cmdTimeoutS: number;
  /**
   * The floor under a watch' interval: `MIN_WATCH_S` in production (an unattended loop
   * must not be a load the user never asked for); a test passes a smaller one so a
   * recurring check does not have to be waited out at five seconds a tick.
   */
  readonly minWatchS: number;
  /** Skill store (optional): powers list_skills / read_skill and the trusted-dir policy. */
  readonly skills: Skills | null;
  /** The conversation as the model sees it — `read_skill` must not hand out a body twice. */
  private readonly history: () => ChatMessage[];
  private cmdSeq = 0;
  private timerSeq = 0;
  private watchSeq = 0;
  /** Timers still to ring, keyed by the id the banner's ✕ refers to. */
  private readonly timers = new Map<string, TimerTask>();
  /** Shell commands still running (one per `run_command` call in flight). */
  private readonly commands = new Map<string, CommandTask>();
  /** Watches still running: a read-only check, repeated until it is stopped. */
  private readonly watches = new Map<string, WatchTask>();
  /** Optional diagnostic line per check (English — the log never switches language). */
  private readonly log: ((msg: string) => void) | null;
  /** Chat epoch: bumped by 🧹, so late events from the old chat can be recognised. */
  private readonly chatEpoch: () => number;

  constructor(opts: {
    dataDir: string;
    announce: (text: string, key?: string) => void;
    withdraw?: (key: string) => void | null;
    approve?: ApproveFn | null;
    emit?: EmitFn;
    cmdMode?: CmdMode;
    cmdTimeoutS?: number;
    minWatchS?: number;
    epoch?: () => number;
    locale?: Locale;
    skills?: Skills | null;
    history?: () => ChatMessage[];
    log?: (msg: string) => void;
  }) {
    this.notesPath = path.join(opts.dataDir, "notes.json");
    fs.mkdirSync(path.dirname(this.notesPath), { recursive: true });
    this.announce = opts.announce;
    this.withdraw = opts.withdraw ?? null;
    this.approve = opts.approve ?? null;
    this.emit = opts.emit ?? (() => {});
    this.cmdMode = opts.cmdMode ?? "auto";   // same default as CMD_MODE in config.ts
    this.cmdTimeoutS = opts.cmdTimeoutS ?? 30;
    this.minWatchS = opts.minWatchS ?? MIN_WATCH_S;
    this.chatEpoch = opts.epoch ?? (() => 0);
    this.locale = opts.locale ?? "it";        // same default as LOCALE in config.ts
    this.skills = opts.skills ?? null;
    this.history = opts.history ?? (() => []);
    this.log = opts.log ?? null;
  }

  schemas(): Record<string, unknown>[] {
    return this.cmdMode === "off" ? [...SCHEMAS] : [...SCHEMAS, COMMAND_SCHEMA];
  }

  async runCommand(command: string, reason = "", signal?: AbortSignal): Promise<string> {
    const epoch = this.chatEpoch(); // 🧹 while this runs → the whole call is old-chat data
    command = command.trim();
    if (!command) return t(this.locale, "cmd.none");
    if (this.cmdMode === "off") return t(this.locale, "cmd.disabled");

    this.cmdSeq++;
    const cid = this.cmdSeq;
    const safe = isSafeCommand(command, this.skills?.dir);

    if (this.cmdMode === "ask" && !safe) {
      const ok = this.approve ? await this.approve(command, reason) : false;
      if (!ok) {
        if (this.chatEpoch() === epoch)
          this.emit({ type: "command_result", id: cid, command, status: "denied", output: "" });
        return t(this.locale, "cmd.denied");
      }
    }
    if (this.chatEpoch() === epoch)
      this.emit({ type: "command_start", id: cid, command, auto: safe || this.cmdMode === "auto" });

    // The banner's chip for this command. It gets its own controller: a ✕ up there has to
    // kill the shell without killing the turn that is waiting for it, while the turn's own
    // signal (barge-in, 🧹, stop) still reaches the process through `onTurnAbort`.
    const taskId = `cmd-${cid}`;
    const ctl = new AbortController();
    const onTurnAbort = () => ctl.abort();
    signal?.addEventListener("abort", onTurnAbort, { once: true });
    const task: CommandTask = {
      ctl,
      command,
      cancelled: false,
      dueAt: Date.now() + this.cmdTimeoutS * 1000, // it cannot outlive its own timeout
    };
    this.commands.set(taskId, task);
    this.emitTasks();

    try {
      const { rc, output: text, timedOut } = await runShell(command, {
        timeoutS: this.cmdTimeoutS,
        signal: ctl.signal,
      });
      if (this.chatEpoch() === epoch)   // chat cleaned meanwhile → no stale card in the new one
        this.emit({
          type: "command_result",
          id: cid,
          command,
          status: timedOut ? "timeout" : `exit ${rc}`,
          output: text.slice(-20_000),
        });
      const clipped =
        text.length <= CLIP_HEAD + CLIP_TAIL
          ? text
          : text.slice(0, CLIP_HEAD) +
            "\n" +
            t(this.locale, "cmd.clipped", { n: text.length - CLIP_HEAD - CLIP_TAIL }) +
            "\n" +
            text.slice(-CLIP_TAIL);
      const head = timedOut ? t(this.locale, "cmd.timeout", { s: this.cmdTimeoutS }) : "";
      return `${head}exit code ${rc}\n${clipped || t(this.locale, "cmd.noOutput")}`;
    } catch (e) {
      // Only the banner's ✕ lands here as an *answer*: the turn is still alive, so the
      // model gets a sentence it can react to instead of the whole response failing.
      if (task.cancelled && !signal?.aborted) {
        if (this.chatEpoch() === epoch)
          this.emit({
            type: "command_result",
            id: cid,
            command,
            status: "cancelled",
            output: "",
          });
        return t(this.locale, "cmd.cancelled");
      }
      throw e; // the turn itself went away — the caller already knows (stale())
    } finally {
      const wasListed = this.commands.delete(taskId);
      signal?.removeEventListener("abort", onTurnAbort);
      if (wasListed) this.emitTasks(); // …only when there is something new to say
    }
  }

  private notes(): string[] {
    try {
      const v: unknown = JSON.parse(fs.readFileSync(this.notesPath, "utf-8"));
      return Array.isArray(v) ? v.map(String) : [];
    } catch {
      return [];
    }
  }

  /**
   * `langHint` is the user's own request for this call. A timer rings minutes later, out of
   * any context, so the language it rings in has to be the one it was asked in and not the
   * UI's: with `LOCALE=en` and "tra cinque minuti il saluto finale" the ring must read
   * «Il Saluto finale è scaduto.», never "The Saluto finale has expired."
   */
  async call(
    name: string,
    argsJson: string,
    signal?: AbortSignal,
    langHint = "",
  ): Promise<string> {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(argsJson || "{}") as Record<string, unknown>;
    } catch {
      args = {};
    }
    if (name === "get_datetime") {
      const n = new Date();
      const date = new Intl.DateTimeFormat(intlLocale(this.locale), {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      }).format(n);
      const time = `${n.getHours()}:${String(n.getMinutes()).padStart(2, "0")}`;
      return t(this.locale, "date.full", { date, time });
    }
    if (name === "set_timer") {
      const secs = Math.max(1, Number(args["seconds"] ?? 60) || 60);
      const label = String(args["label"] ?? "") || "timer";
      // the model may name the language outright (`lang`), else it is read off the request
      // and off the label — the user's own words — falling back to the session's locale
      const loc =
        parseLocale(String(args["lang"] ?? "")) ??
        detectLocale(`${langHint} ${label}`, this.locale);
      const id = `timer-${++this.timerSeq}`;
      const dueAt = Date.now() + secs * 1000;
      const timer = setTimeout(() => {
        this.timers.delete(id);
        this.emitTasks();   // the chip goes with the ring it was counting down to
        this.announce(t(loc, "announce.timerExpired", { label }), id);
      }, secs * 1000);
      this.timers.set(id, { timer, label, dueAt, locale: loc });
      this.emitTasks();
      return t(loc, "timer.set", { label, s: secs });
    }
    if (name === "start_watch") {
      return await this.startWatch(args, langHint);
    }
    if (name === "stop_watch") {
      return this.stopWatch(String(args["label"] ?? ""));
    }
    if (name === "add_note") {
      const notes = this.notes();
      notes.push(String(args["text"] ?? ""));
      fs.writeFileSync(this.notesPath, JSON.stringify(notes, null, 1));
      return t(this.locale, "note.saved");
    }
    if (name === "remove_note") {
      const notes = this.notes();
      if (!notes.length) return t(this.locale, "note.noneRemove");
      const idx = Math.trunc(Number(args["index"] ?? NaN));
      if (!Number.isFinite(idx) || idx < 1 || idx > notes.length)
        return t(this.locale, "note.index", { n: notes.length });
      const victim = notes[idx - 1]!;
      // the model may act on a stale list (the user removed one by voice meanwhile): the
      // optional `text` is a checksum — no match, no deletion, and the caller is told why.
      const expected = String(args["text"] ?? "").trim();
      if (expected && !victim.includes(expected))
        return t(this.locale, "note.mismatch", { idx, victim });
      notes.splice(idx - 1, 1);
      fs.writeFileSync(this.notesPath, JSON.stringify(notes, null, 1));
      return notes.length
        ? t(this.locale, "note.removed", { idx, victim })
        : t(this.locale, "note.removedLast", { idx, victim });
    }
    if (name === "clear_notes") {
      const notes = this.notes();
      if (!notes.length) return t(this.locale, "note.noneClear");
      const confirm =
        args["confirm"] === true || String(args["confirm"]).toLowerCase() === "true";
      if (!confirm) return t(this.locale, "note.clearAsk", { n: notes.length });
      fs.writeFileSync(this.notesPath, JSON.stringify([], null, 1));
      return t(this.locale, "note.cleared", { n: notes.length }) + notes.map((n, i) => `${i + 1}. ${n}`).join(" | ");
    }
    if (name === "list_notes") {
      const notes = this.notes();
      return notes.length ? notes.map((n, i) => `${i + 1}. ${n}`).join("\n") : t(this.locale, "note.none");
    }
    if (name === "list_skills") {
      if (!this.skills) return "No skills directory is configured.";
      const list = this.skills.list();
      if (!list.length) return `No skills found in ${this.skills.dir}.`;
      return (
        "Skills (the user chooses in the UI which ones are active):\n" +
        list
          .map((s) => `${s.active ? "active" : "OFF  "} ${s.name}: ${s.description}`)
          .join("\n")
      );
    }
    if (name === "read_skill") {
      if (!this.skills) return "No skills directory is configured.";
      const body = this.skills.read(String(args["name"] ?? ""));
      const again = this.alreadyInContext(body);
      if (again) return again;
      return body;
    }
    if (name === "run_command") {
      return await this.runCommand(
        String(args["command"] ?? ""),
        String(args["reason"] ?? ""),
        signal,
      );
    }
    return t(this.locale, "tool.unknown", { name });
  }

  /**
   * The skill body is already in the conversation (a `tool` message of an earlier turn):
   * say so in one line instead of pushing the same SKILL.md through the context a second
   * time. Matched on the head of the file — frontmatter and all — which is unique per skill.
   * `null` when it is not there (first read, or the chat was cleared with 🧹).
   */
  private alreadyInContext(body: string): string | null {
    const key = body.slice(0, 400);
    // an error line ("No skill named 'x' …") is single-line and says nothing to reuse
    if (key.length < 40 || !key.includes("\n")) return null;
    if (
      !this.history().some(
        (m) => typeof m.content === "string" && m.content.includes(key),
      )
    ) {
      return null;
    }
    const fm = /^---[\s\S]*?name:\s*([^\n]+)/.exec(body);
    const id = fm ? fm[1]!.trim() : "this";
    return (
      `SKILL.md of '${id}' is already in the messages above — you have its instructions ` +
      `in this conversation. Do not call read_skill for it again: use what is there.`
    );
  }

  /**
   * The banner above the chat: every timer still to ring, every command still running and
   * every watch still checking, the soonest to end first — which is also the order the
   * user wants to scan them in.
   *
   * `due_in_ms` is deliberately relative to *now* rather than an absolute deadline: the
   * page counts it down on its own clock from the frame it receives (see `TaskInfo`).
   */
  tasks(): TaskInfo[] {
    const nowMs = Date.now();
    const rows: [string, number, TaskInfo][] = [];
    for (const [id, timer] of this.timers)
      rows.push([id, timer.dueAt, {
        id,
        kind: "timer",
        label: timer.label,
        due_in_ms: Math.max(0, timer.dueAt - nowMs),
      }]);
    for (const [id, cmd] of this.commands)
      rows.push([id, cmd.dueAt, {
        id,
        kind: "command",
        label: cmd.command,
        due_in_ms: Math.max(0, cmd.dueAt - nowMs),
      }]);
    for (const [id, watch] of this.watches)
      rows.push([id, watch.dueAt, {
        id,
        kind: "watch",
        label: watch.label,
        due_in_ms: Math.max(0, watch.dueAt - nowMs),
      }]);
    rows.sort((a, b) => a[1] - b[1]);
    return rows.map((r) => r[2]);
  }

  /** The banner changed (a task started, rang, finished or was cancelled) → tell the UI. */
  private emitTasks(): void {
    this.emit({ type: "tasks", tasks: this.tasks() });
  }

  /**
   * ✕ on one chip: stop that task and leave everything else alone. `null` when the id is
   * unknown — it rang a moment ago, or the page is looking at an old frame.
   */
  cancelTask(id: string): TaskInfo | null {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer.timer);      // before it fires: no ring is queued to take back
      this.timers.delete(id);
      this.emitTasks();
      return { id, kind: "timer", label: timer.label };
    }
    const cmd = this.commands.get(id);
    if (cmd) {
      cmd.cancelled = true;          // runCommand turns the abort into a result, not a failure
      this.commands.delete(id);      // the chip goes now, not when the process reports back
      cmd.ctl.abort();
      this.emitTasks();
      return { id, kind: "command", label: cmd.command };
    }
    const watch = this.dropWatch(id);   // same as stop_watch, by id: the loop really ends
    if (watch) return { id, kind: "watch", label: watch.label };
    return null;
  }

  /**
   * The language the task with this id was asked in (its timer's, its watch's), `null` for
   * a command or an unknown id: the ✕ line follows it, like a ring or a check does.
   */
  taskLocale(id: string): Locale | null {
    return this.timers.get(id)?.locale ?? this.watches.get(id)?.locale ?? null;
  }

  /** Stop one watch by id: the check in flight is killed, the chip goes with it — and so
   *  does whatever it had already queued to say, or the ✕ would not silence it. */
  private dropWatch(id: string): WatchTask | null {
    const watch = this.watches.get(id);
    if (!watch) return null;
    if (watch.timer) clearTimeout(watch.timer);
    watch.ctl.abort();
    this.watches.delete(id);
    this.withdraw?.(id);
    this.emitTasks();
    return watch;
  }

  /**
   * `start_watch`: a read-only command, repeated every `everyS` seconds until the user
   * stops it — a timer with no end. The first check runs right away (the user asked to
   * *watch* something: its first value is what they are waiting for); the chip counts down
   * to the second one.
   *
   * The approval, if the policy wants one, is asked once here and never again: an
   * unattended loop cannot knock on the user's door every 30 seconds. Denied → no watch.
   */
  private async startWatch(
    args: Record<string, unknown>,
    langHint: string,
  ): Promise<string> {
    const command = String(args["command"] ?? "").trim();
    if (!command) return t(this.locale, "watch.none");
    if (this.cmdMode === "off") return t(this.locale, "cmd.disabled");
    const raw = Number(args["every"] ?? 60);
    const everyS = Math.max(
      this.minWatchS,
      Math.trunc(Number.isFinite(raw) && raw > 0 ? raw : 60),
    );
    const label = String(args["label"] ?? "").trim() || command;
    const match = String(args["match"] ?? "").trim();
    // its checks speak later, out of any turn: the language of the request that asked
    const loc =
      parseLocale(String(args["lang"] ?? "")) ??
      detectLocale(`${langHint} ${label}`, this.locale);
    const safe = isSafeCommand(command, this.skills?.dir);
    if (this.cmdMode !== "auto" && !safe) {
      const ok = this.approve
        ? await this.approve(command, `watch, every ${everyS}s`)
        : false;
      if (!ok) return t(this.locale, "cmd.denied");
    }
    const id = `watch-${++this.watchSeq}`;
    this.watches.set(id, {
      label,
      command,
      match,
      matched: false,
      everyS,
      dueAt: Date.now(),
      ctl: new AbortController(),
      timer: null,
      locale: loc,
    });
    this.watchTick(id);   // the first check, now — it also books the second one
    return t(loc, "watch.started", { label, s: everyS });
  }

  /**
   * One check is due. The next tick is booked from *here* and not from the end of the
   * check, so a slow check shortens the gap instead of stretching the interval — and the
   * banner is always counting down to a moment that is already taken.
   */
  private watchTick(id: string): void {
    const watch = this.watches.get(id);
    if (!watch) return;
    const everyMs = Math.max(50, watch.everyS * 1000);   // a 0-interval may never spin
    watch.dueAt = Date.now() + everyMs;
    watch.timer = setTimeout(() => this.watchTick(id), everyMs);
    watch.ctl = new AbortController();   // every check can be killed on its own
    this.emitTasks();
    void this.watchCheck(id, watch);
  }

  /** One check: run it, read it, tell the user when there is something to tell. */
  private async watchCheck(id: string, watch: WatchTask): Promise<void> {
    let output = "";
    try {
      const r = await runShell(watch.command, {
        timeoutS: this.cmdTimeoutS,
        signal: watch.ctl.signal,
      });
      output = r.output;
      this.log?.(
        `🔎 watch «${watch.label}» → exit ${r.rc}${r.timedOut ? " (timeout)" : ""}`,
      );
    } catch (e) {
      // a ✕ on the chip, or a check that blew up: the loop's next tick is already booked
      this.log?.(`🔎 watch «${watch.label}» → check failed: ${String(e)}`);
      return;
    }
    if (this.watches.get(id) !== watch) return;   // stopped while it ran → say nothing

    if (watch.match) {
      // quiet until the condition starts holding, and said on the way *in* only: a
      // download that stays done must not announce itself again every 30 seconds
      const hit = output.toLowerCase().includes(watch.match.toLowerCase());
      if (hit && !watch.matched)
        this.announce(
          t(watch.locale, "announce.watchMatched", {
            label: watch.label,
            out: this.speakable(output || watch.match),
          }),
          id,   // a newer report replaces the waiting one: never a backlog
        );
      watch.matched = hit;
      return;
    }
    this.announce(
      t(watch.locale, "announce.watchValue", {
        label: watch.label,
        out: this.speakable(output || t(watch.locale, "cmd.noOutput")),
      }),
      id,   // a newer report replaces the waiting one: never a backlog
    );
  }

  /**
   * A command output as one spoken line: newlines are just spaces, and it stops at `max`
   * characters — a watch reports a value, it never reads a page aloud.
   */
  private speakable(text: string, max = 240): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  }

  /**
   * `stop_watch`: by label — the whole one or a fragment, a small model does not always
   * quote it exactly — or, with no label at all, an inventory of what is still running so
   * the model can work out with the user which one they meant.
   */
  private stopWatch(fragment: string): string {
    const frag = fragment.trim().toLowerCase();
    if (!frag) {
      const running = [...this.watches.values()];
      return running.length
        ? t(this.locale, "watch.runningList", {
            labels: running.map((w) => w.label).join(", "),
          })
        : t(this.locale, "watch.noneRunning");
    }
    const hits = [...this.watches].filter(
      ([, w]) =>
        w.label.toLowerCase().includes(frag) || w.command.toLowerCase().includes(frag),
    );
    if (!hits.length) return t(this.locale, "watch.notFound", { label: fragment });
    for (const [id] of hits) this.dropWatch(id);
    return t(this.locale, "watch.stopped", {
      label: hits.map(([, w]) => w.label).join(", "),
    });
  }

  /**
   * The process is going away: a pending timer is cancelled here, and only here.
   *
   * 🧹 deliberately does *not* — a timer is a promise made to the user («tra quindici
   * minuti ciao mondo»), and the banner is the only place it is visible: clearing the
   * conversation used to take it away silently, and the timer never rang
   * (data/logs/harness.log: set 19:32:56, wiped by the 🧹 at 19:41:45).
   */
  close(): void {
    for (const timer of this.timers.values()) clearTimeout(timer.timer);
    this.timers.clear();
    for (const watch of this.watches.values()) {   // a watch is a loop: it must not outlive
      if (watch.timer) clearTimeout(watch.timer); // the process that would announce it
      watch.ctl.abort();
    }
    this.watches.clear();
  }
}
