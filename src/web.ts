/**
 * Browser front-end: mic + speaker in Chromium (with its echo canceller), harness over
 * WebSocket (node:http + the `ws` package).
 *
 *   browser ──(binary: 16 kHz s16 mic PCM)──► /ws ──► QueueMic ──► harness
 *   browser ◄─(binary: TTS s16 PCM, paced)── /ws ◄── Player(sink=callback)
 *   browser ◄─(text: JSON events)──────────── /ws ◄── Assistant.emit
 *   browser ──(text: {"type":"text"|"reset"|"config"|…})──► /ws ──► commands
 */

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs, { promises as fsp } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { type WebSocket, WebSocketServer } from "ws";
import { QueueMic } from "./audio/mic";
import { type Config, normalizeCmdMode, normalizeDecisionMode, ROOT } from "./config";
import type { ClientCommand, ServerEvent } from "./events";
import { Harness } from "./harness/harness";
import { now } from "./harness/queues";
import { type Locale, t, uiStringsJson } from "./i18n";
import { which } from "./util";

const STATIC_DIR = path.join(ROOT, "static");

/** What the `static/` directory may hold — no sniffing, no guessing on the way out. */
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

export function contentTypeFor(file: string): string {
  return MIME_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

/**
 * The path of a `GET /static/<path>` request, or `null` when it must not be served.
 * `raw` is still percent-encoded (the URL is decoded here, so the tests cover it too).
 *
 * Two separate checks, because each catches what the other misses:
 *  - `..` is rejected *before* the join: `path.join`/`resolve` normalises the segments
 *    away, so the resolved path on its own cannot tell a traversal from a plain name;
 *  - containment needs the trailing separator: `file.startsWith(STATIC_DIR)` also accepts
 *    `/…/static-old/index.html`, a *sibling* of `/…/static`.
 */
export function resolveStatic(raw: string): string | null {
  let rel: string;
  try {
    rel = decodeURIComponent(raw);
  } catch {
    return null; // malformed escape ("%zz", a bare "%") — there is nothing to resolve
  }
  if (rel.includes("\0")) return null;
  if (rel.split("/").includes("..")) return null;
  const file = path.resolve(STATIC_DIR, rel);
  if (file !== STATIC_DIR && !file.startsWith(STATIC_DIR + path.sep)) return null;
  return file;
}

/**
 * The origin a `/ws` upgrade may come from — **the security check the page's own origin
 * never gets from the browser**: WebSocket connections are not subject to the same-origin
 * policy, so *any* site the user visits can open `ws://127.0.0.1:8095/ws` and, through it,
 * read the transcript and push `{type:"text"}` / `{type:"config"}` commands (with
 * `CMD_MODE=auto`, the default, a pushed prompt can reach `run_command`).
 *
 * Rules, in order:
 *
 *  1. **no `Origin` → allowed**: not a browser (curl, a script, the `ws` package) — there
 *     is no page to have come from and no ambient authority to abuse;
 *  2. **same origin as the request itself**: the origin's `host:port` must equal the
 *     `Host` header of this very request, i.e. the page was served by *this* server. The
 *     page and its WebSocket both take the host from `location.host`, so `127.0.0.1` and
 *     `localhost` keep working without being whitelisted;
 *  3. **a name we could have served**: loopback always; the configured `--host` when it
 *     is a real address. A wildcard bind (`0.0.0.0`) accepts IP literals only — a
 *     hostname there is how a DNS-rebinding attacker gets `evil.com:8095` past rule 2.
 */
export function originAllowed(
  origin: string | undefined,
  hostHeader: string | undefined,
  bindHost: string,
): boolean {
  if (origin === undefined || origin === "") return true; // rule 1
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false; // "null", "file://…", garbage: not a page of ours
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = String(hostHeader ?? "");
  if (!host || u.host !== host) return false; // rule 2 (host includes the port)

  let name: string;
  try {
    name = new URL(`http://${host}`).hostname; // "127.0.0.1:8095" → "127.0.0.1"
  } catch {
    return false;
  }
  // WHATWG URLs keep the brackets on an IPv6 literal (`[::1]`); `--host` may be written
  // either way, so compare the bare address
  const bare = name.startsWith("[") && name.endsWith("]") ? name.slice(1, -1) : name;
  if (bare === "localhost" || bare === "::1" || bare === "127.0.0.1") return true; // rule 3
  const bind = String(bindHost ?? "").trim();
  const bindBare = bind.startsWith("[") && bind.endsWith("]") ? bind.slice(1, -1) : bind;
  if (bindBare === bare) return true;
  const wildcard = bindBare === "" || bindBare === "0.0.0.0" || bindBare === "::";
  return wildcard && net.isIP(bare) !== 0;
}

/** What the model dropdown shows: the model of the active leg (API or pi). */
export function modelLabel(cfg: Config): string {
  return cfg.llmViaPi ? cfg.piModel : cfg.llmModel;
}

/** Tag stamped into the served page; it reloads itself when this changes. */
export class WebApp {
  readonly mic = new QueueMic();
  readonly assistant: Harness;
  private ws: WebSocket | null = null;
  private modelsSeq = 0; // only the newest model refresh is allowed to answer
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  /** The heartbeat's "I heard back" set: connect adds the socket, each pong re-adds it,
   *  each sweep takes it out and pings — a socket missing twice in a row is dead. */
  private alive = new WeakSet<WebSocket>();
  /** One stamped page per locale, keyed by static/index.html's mtime: `GET /` only
   *  re-reads and re-stamps when the source file itself changes, not on every load. */
  private pages = new Map<Locale, { mtimeMs: number; html: string }>();
  /** The other `static/` files, same idea, capped (FIFO) so it can never grow wild. */
  private files = new Map<string, { mtimeMs: number; body: Buffer; type: string }>();

  constructor(
    readonly cfg: Config,
    readonly host: string,
    readonly port: number,
  ) {
    this.assistant = new Harness(cfg, this.mic, "callback");
  }

  // ── outbound ──

  private send(payload: string | Uint8Array): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== ws.OPEN) return;
    try {
      ws.send(payload);
    } catch {
      /* connection went away mid-send */
    }
  }

  private sendJson(ev: ServerEvent): void {
    this.send(JSON.stringify(ev));
  }

  // ── handlers ──

  /** `GET /` — the stamped page. Async so a slow or missing file can only fail this one
   *  request, never the process; failures answer 500 (the page is not optional anywhere
   *  else in the app, so there is nothing sensible to fall back to). */
  private async index(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const html = await this.indexHtml();
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(html);
    } catch (e) {
      this.assistant.log(`[page] ${e}`);
      res.writeHead(500).end();
    }
  }

  /**
   * The stamping order matters (the page resolves `UI_STRINGS["__LOCALE__"]` after the
   * swap): the catalogue goes in first, then the `<!--UIVER-->` tag — still a hash of
   * the *raw* file, so it stays a cache-buster for the source — and `__LOCALE__` last.
   */
  private async indexHtml(): Promise<string> {
    const locale = this.cfg.locale;
    const mtimeMs = (await fsp.stat(path.join(STATIC_DIR, "index.html"))).mtimeMs;
    const hit = this.pages.get(locale);
    if (hit && hit.mtimeMs === mtimeMs) return hit.html;
    const raw = await fsp.readFile(path.join(STATIC_DIR, "index.html"), "utf-8");
    // a function replacement, not a string: the catalogue text may contain `$` and `$&`
    // has meaning in a string replacement
    const html = raw
      .replace("__UI_STRINGS__", () => uiStringsJson())
      .replace("<!--UIVER-->", () =>
        crypto.createHash("sha1").update(raw).digest("hex").slice(0, 10),
      )
      // the page's language: `lang="__LOCALE__"` and `UI_STRINGS["__LOCALE__"]` are both
      // stamped, so the browser paints the right language; the unstamped file reads
      // `hasOwn(UI_STRINGS, "__LOCALE__")` → false → stays Italian as a safe default
      .replaceAll("__LOCALE__", locale);
    this.pages.set(locale, { mtimeMs, html });
    return html;
  }

  /**
   * `GET /static/<path>`: boundary-checked (`resolveStatic`), a real file only, and
   * always with a `Content-Type` (table in MIME_TYPES — no sniffing on the way out).
   * Reads through a small mtime-keyed cache; any miss (no file, a directory, unreadable)
   * answers 404 — there is nothing to send either way.
   */
  private async serveStatic(url: string, res: http.ServerResponse): Promise<void> {
    const file = resolveStatic(url.slice("/static/".length));
    if (file === null) {
      res.writeHead(400).end();
      return;
    }
    try {
      const stat = await fsp.stat(file);
      if (!stat.isFile()) {
        res.writeHead(404).end();
        return;
      }
      let body: Buffer;
      let type: string;
      const hit = this.files.get(file);
      if (hit && hit.mtimeMs === stat.mtimeMs) {
        body = hit.body;
        type = hit.type;
      } else {
        body = await fsp.readFile(file);
        type = contentTypeFor(file);
        if (this.files.size >= 16) {
          const oldest = this.files.keys().next().value;
          if (oldest !== undefined) this.files.delete(oldest);
        }
        this.files.set(file, { mtimeMs: stat.mtimeMs, body, type });
      }
      res.writeHead(200, {
        "Content-Type": type,
        "Content-Length": body.length,
        "Cache-Control": "no-store",
      });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  }

  private onUpgrade(
    req: http.IncomingMessage,
    socket: import("node:stream").Duplex,
    head: Buffer,
  ): void {
    const url = (req.url ?? "").split("?")[0];
    if (url !== "/ws") {
      socket.destroy();
      return;
    }
    // a page of another origin may not so much as open the socket (see originAllowed)
    if (!originAllowed(req.headers.origin, req.headers.host, this.host)) {
      this.assistant.log(
        `⛔ ws refused: origin ${String(req.headers.origin)} for host ${String(req.headers.host)}`,
      );
      socket.destroy();
      return;
    }
    this.wss!.handleUpgrade(req, socket, head, (ws) => this.websocket(ws));
  }

  private websocket(ws: WebSocket): void {
    const prev = this.ws;
    if (prev && prev.readyState === prev.OPEN) {
      // Tell the window we are taking the slot from *why* it is going dark: without an
      // event it could only infer it from the close code, and the kicked page is left
      // with a text box that silently swallows whatever is typed into it.
      try {
        prev.send(JSON.stringify({ type: "session_taken" } satisfies ServerEvent));
        prev.close(1000, "replaced by a new client");
      } catch {
        /* ignore */
      }
    }
    this.ws = ws;
    // answers the first sweep's ping for sure; from then on only pongs keep it alive
    this.alive.add(ws);
    ws.on("pong", () => this.alive.add(ws));
    const a = this.assistant;
    a.stopActivity();

    const hello: ServerEvent = {
      type: "hello",
      rate: a.player.rate,
      model: modelLabel(this.cfg),
      voice: this.cfg.ttsVoice,
      voices: a.voiceList(),
      state: a.state,
      // only the chat lines: tool cards travel on their own `tool` events, and a
      // `tool_calls` message must not leak its payload into the transcript. Each line
      // carries its checkpoint id — what the ⟲ button on it sends back as `rewind`.
      history: a.chatLines(),
      models: a.models,
      context: a.contextState(),
      config: {
        half_duplex: this.cfg.halfDuplex,
        barge_in: this.cfg.bargeIn,
        decision_mode: this.cfg.decisionMode,
        cmd_mode: this.cfg.cmdMode,
        llm_via_pi: this.cfg.llmViaPi,
        thinking: !this.cfg.llmDisableThinking,
      },
      pending_command:
        a.pendingApproval !== null
          ? { id: a.pendingApproval.id, command: a.pendingApproval.command }
          : null,
      // the banner over the chat, as it stands right now (a page reload must not lose it)
      tasks: a.tasks(),
      skills_dir: a.skillsDir(),
      skills: a.skillList(),
    };
    ws.send(JSON.stringify(hello));
    a.log("🌐 browser connected");
    // the page (and every reconnect) must see the models pi has *now*, not the
    // snapshot taken at startup: re-read them right after the hello
    void this.refreshModels(true);

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        const bytes =
          data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : Array.isArray(data)
              ? new Uint8Array(Buffer.concat(data as Buffer[]))
              : new Uint8Array(data as Buffer);
        this.mic.push(bytes);
      } else {
        const text = Array.isArray(data)
          ? Buffer.concat(data as Buffer[]).toString("utf-8")
          : (data as Buffer).toString("utf-8");
        try {
          this.onCommand(JSON.parse(text) as ClientCommand);
        } catch (e) {
          a.log(`[ws] bad command: ${e}`);
        }
      }
    });

    ws.on("close", () => {
      if (this.ws === ws) {
        this.ws = null;
        a.stopActivity();
        a.log("🌐 browser disconnected");
      }
    });
    ws.on("error", () => {
      /* handled by close */
    });
  }

  private onCommand(cmd: ClientCommand): void {
    const a = this.assistant;
    switch (cmd.type) {
      case "text": {
        const text = cmd.text.trim();
        if (!text) return;
        if (a.pendingApproval !== null && a.answerApprovalText(text)) {
          // an answer to "may I run it?" is chat the history never holds — a line with no
          // checkpoint of its own, so the page draws no ⟲ on it either
          a.emit({ type: "user", text, info: t(this.cfg.locale, "user.replyConfirm") });
          return;
        }
        // startResponse() cancels any answer still playing, then emits the `user` line —
        // the only place that knows the checkpoint id of the history message it creates
        a.startResponse(text, now(), t(this.cfg.locale, "user.typed"));
        a.setState("thinking");
        return;
      }
      case "reset":
        a.resetConversation();
        // ack: the browser drops every event it had in flight from the erased chat
        this.sendJson({ type: "chat_reset" });
        a.log("🧹 conversation reset");
        return;
      case "rewind": {
        // ⟲ cut the history at a checkpoint: `false` (a stale id) touches nothing, and
        // either way the answer carries the transcript as it stands, so the page can cut
        // its own DOM from the first line the server dropped
        const id = Number(cmd.id);
        const ok = Number.isFinite(id) ? a.rewindTo(id) : false;
        if (!ok) a.log(`⟲ checkpoint #${cmd.id} is not in the history — nothing rewound`);
        this.sendJson({ type: "chat_rewound", ok, history: a.chatLines() });
        return;
      }
      case "stop":
        a.stopActivity();
        return;
      case "approve":
        a.resolveApproval(Boolean(cmd.ok), cmd.id, "via.click");
        return;
      case "model":
        if (cmd.model) void a.switchModel(String(cmd.model));
        return;
      case "models_refresh":
        void this.refreshModels(Boolean(cmd.force ?? true));
        return;
      case "skills_refresh":
        // rescan SKILLS_DIR: a skill may have been installed since the last hello
        this.sendJson({ type: "skills", dir: a.skillsDir(), skills: a.skillList() });
        return;
      case "skills_set":
        a.setActiveSkills(Array.isArray(cmd.active) ? cmd.active.map(String) : []);
        return;
      case "task_cancel":
        a.cancelTask(String(cmd.id ?? "")); // unknown id → nothing announced
        return;
      case "config":
        this.applySettings(cmd);
        return;
    }
  }

  /** The UI toggles: bool switches, enum selects, and the pi/API leg switch. */
  private applySettings(cmd: Extract<ClientCommand, { type: "config" }>): void {
    const a = this.assistant;
    const cfg = this.cfg;
    if (typeof cmd.half_duplex === "boolean") cfg.halfDuplex = cmd.half_duplex;
    if (typeof cmd.barge_in === "boolean") cfg.bargeIn = cmd.barge_in;
    if (typeof cmd.decision_mode === "string") {
      // the shared normalizers, not bare literal comparisons: a hand-crafted ws message
      // with junk here must degrade exactly the way a junk CMD_MODE in .env does —
      // fail-safe default + a warning in the log
      cfg.decisionMode = normalizeDecisionMode(cmd.decision_mode);
    }
    if (typeof cmd.cmd_mode === "string") {
      const mode = normalizeCmdMode(cmd.cmd_mode);
      cfg.cmdMode = mode;
      a.tools.cmdMode = mode;
    }
    if (typeof cmd.llm_via_pi === "boolean" && cmd.llm_via_pi !== cfg.llmViaPi) {
      cfg.llmViaPi = cmd.llm_via_pi;
      a.llm.onModeChange();
      void a.syncContext(true); // the other leg → the other context window
      void this.refreshModels(); // refresh the model dropdown
    }
    // 💭 the master switch: the API leg (chat_template_kwargs) and pi's --thinking level
    if (typeof cmd.thinking === "boolean") cfg.llmDisableThinking = !cmd.thinking;
    // 🔊 the voice selector: validated against the pack, persisted, echoed back as `voices`
    if (typeof cmd.tts_voice === "string") a.setVoice(cmd.tts_voice);
    a.log(
      `⚙ config: half_duplex=${cfg.halfDuplex} barge_in=${cfg.bargeIn} ` +
        `decision=${cfg.decisionMode} commands=${cfg.cmdMode} ` +
        `thinking=${!cfg.llmDisableThinking} ` +
        `llm=${cfg.llmViaPi ? `pi ${cfg.piCmd}` : "api"}`,
    );
  }

  /** Newest-wins sequencing: a drawer refresh, a ↻ click and a pi toggle can overlap. */
  private async refreshModels(force = false): Promise<void> {
    const seq = ++this.modelsSeq;
    let models: string[] | null = null;
    try {
      models = await this.assistant.llm.check(force);
    } catch (e) {
      this.assistant.log(`[models] ${e}`);
      models = null;
    }
    if (seq !== this.modelsSeq) return;
    const a = this.assistant;
    if (models !== null) {
      const added = models.filter((m) => !a.models.includes(m));
      a.models = models;
      if (added.length) {
        a.log(
          `↻ model list refreshed: +${added.length} ` +
            `(${[...added].sort().slice(0, 3).join(", ")}…) — ${models.length} in total`,
        );
      } else if (force) {
        a.log(`↻ model list: ${models.length} entries (unchanged)`);
      }
    }
    this.sendJson({
      type: "models",
      models: a.models,
      current: modelLabel(this.cfg),
      via_pi: this.cfg.llmViaPi,
    });
    void a.syncContext(true); // a fresh model list can carry a context window we missed
  }

  // ── lifecycle ──

  async run(openBrowser: boolean): Promise<void> {
    const a = this.assistant;
    await a.start(); // warms up LLM, TTS, ASR before we go live
    a.emit = (ev) => this.sendJson(ev);
    a.player.writer = (pcm) => this.send(pcm);
    a.player.onFlush = () => this.sendJson({ type: "flush" });

    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: 4 * 1024 * 1024,
    });
    // Heartbeat: a ping every 20 s; a socket that failed to answer the previous one is
    // `terminate()`d. Without this sweep a half-dead page (suspended laptop, dropped
    // wifi, sleep) keeps its slot in this single-connection server forever: the user
    // would look at a silently dead UI with no way back but a reload + a fresh tab.
    this.heartbeat = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== ws.OPEN) return;
      if (!this.alive.has(ws)) {
        a.log("🌐 browser unresponsive — its socket is dead, dropping it");
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
        return;
      }
      this.alive.delete(ws); // answered → only the coming pong may put it back
      try {
        ws.ping();
      } catch {
        /* ignore */
      }
    }, 20_000);

    this.server = http.createServer((req, res) => {
      const url = (req.url ?? "").split("?")[0] ?? "";
      // async handlers catch their own failures, so nothing escapes; the `.catch` is
      // only for a fault in the failure path itself (a throw after the header went out)
      if (url === "/") void this.index(req, res).catch((e) => a.log(`[http] ${e}`));
      else if (url.startsWith("/static/"))
        void this.serveStatic(url, res).catch((e) => a.log(`[http] ${e}`));
      else res.writeHead(404).end();
    });
    this.server.on("upgrade", (req, socket, head) => this.onUpgrade(req, socket, head));

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.port, this.host, resolve);
    });

    const host = this.host === "0.0.0.0" || this.host === "" ? "127.0.0.1" : this.host;
    const url = `http://${host}:${this.port}/`;
    a.log(`✅ ready → ${url}`);
    if (openBrowser) launchChromium(url);

    const audio = a.runAudio();
    try {
      await audio;
    } finally {
      await this.close();
    }
  }

  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.wss?.close();
    await new Promise<void>((res) => {
      if (!this.server) return res();
      this.server.close(() => res());
      this.server = null;
    });
    await this.assistant.close();
  }
}

/** Allow the mic for our origin in the dedicated app profile (no prompt, no warning bar). */
export function pregrantMic(profile: string, url: string): void {
  const u = new URL(url);
  const origin = `${u.protocol}//${u.hostname}:${u.port},*`;
  const prefsPath = path.join(profile, "Default", "Preferences");
  fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
  let prefs: Record<string, any> = {};
  try {
    prefs = JSON.parse(fs.readFileSync(prefsPath, "utf-8"));
  } catch {
    prefs = {};
  }
  const exc = ((prefs.profile ??= {}).content_settings ??= {});
  const exceptions = (exc.exceptions ??= {});
  (exceptions.media_stream_mic ??= {})[origin] = { setting: 1 };
  (prefs.translate ??= {}).enabled = false;
  fs.writeFileSync(prefsPath, JSON.stringify(prefs));
}

export function launchChromium(url: string): void {
  const cands = ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome"];
  const exe = cands.find((c) => which(c));
  if (!exe) {
    console.log(`Chromium not found — open ${url} manually`);
    return;
  }
  const profile = path.join(ROOT, "data", "run", "chromium-profile");
  try {
    pregrantMic(profile, url);
  } catch (e) {
    console.log(`[chromium] pregrant failed: ${e}`);
  }
  const child = spawn(
    exe,
    [
      `--app=${url}`,
      `--user-data-dir=${profile}`,
      "--autoplay-policy=no-user-gesture-required",
      "--disable-features=Translate",
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=900,760",
    ],
    { stdio: "ignore", detached: true },
  );
  child.unref();
}
