/**
 * A miniature harness for developing and testing the GTK client without the full
 * stack (no llama-server, no audio.cpp): it speaks the real `/ws` protocol subset —
 * hello, scripted answers with sine-wave PCM at the TTS rate, tool cards, command
 * approval, a countdown task, rewind, reset — and prints the upgrade request headers
 * (to check what a non-browser client sends: the server's originAllowed rule 1).
 *
 *   bun run sonia-gtk4/mock-server.ts [port]      (default 8765)
 *   HARNESS_URL=http://127.0.0.1:8765 bun run sonia-gtk4/main.ts
 */

const PORT = Number(process.argv[2] ?? 8765);
const RATE = 24000;
let nextId = 1;

type HistoryMsg = { role: string; content: string; id?: number };
type WsData = { history: HistoryMsg[]; mic: number };
type Socket = Bun.ServerWebSocket<WsData>;
type Client = { ws: Socket; history: HistoryMsg[] };

const clients = new Set<Client>();

const _server = Bun.serve<WsData>({
  port: PORT,
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname !== "/ws") return new Response("sonia mock harness", { status: 200 });
    console.log(
      `[mock] upgrade ${url.pathname} · Origin=${req.headers.get("origin") ?? "(none)"} ` +
        `· User-Agent=${(req.headers.get("user-agent") ?? "(none)").slice(0, 60)}`,
    );
    const ok = srv.upgrade(req, { data: { history: [], mic: 0 } });
    if (ok) return undefined as unknown as Response;
    return new Response("no ws", { status: 400 });
  },
  websocket: {
    open(ws) {
      // a single client slot, like the real harness
      for (const c of clients) {
        try {
          c.ws.send(JSON.stringify({ type: "session_taken" }));
          c.ws.close(1000, "replaced by a new client");
        } catch {
          /* ignore */
        }
      }
      const client: Client = { ws, history: ws.data.history };
      clients.add(client);
      ws.send(
        JSON.stringify({
          type: "hello",
          rate: RATE,
          model: "qwen3.5-4b-mtp-q4_k_m",
          voice: "giulia",
          voices: ["giulia", "giovanni", "marco", "sara", "luca"],
          state: "listening",
          history: [
            { role: "user", content: "Che ore sono?", id: 1 },
            { role: "assistant", content: "Sono le tre del pomeriggio.", id: 2 },
          ],
          models: [
            "qwen3.5-4b-mtp-q4_k_m",
            "qwen3.5-4b-q8_0",
            "gemma-4-12b-it-q4",
            "llama-4-8b-instruct",
            "phi-4-mini",
            "mistral-small-3.2",
          ],
          config: {
            half_duplex: false,
            barge_in: true,
            decision_mode: "auto",
            cmd_mode: "ask",
            llm_via_pi: false,
            thinking: true,
          },
          context: { used: 1480, total: 32768 },
          pending_command: null,
          tasks: [{ id: "timer-1", kind: "timer", label: "timer 42 s", due_in_ms: 42_000 }],
          skills_dir: "/home/g/.pi/agent/skills",
          skills: [
            { name: "websurfx", description: "Ricerca web", active: true },
            { name: "hackernews", description: "HN", active: false },
            { name: "reddit", description: "Reddit", active: true },
          ],
        }),
      );
      client.history.push(
        { role: "user", content: "Che ore sono?", id: 1 },
        { role: "assistant", content: "Sono le tre del pomeriggio.", id: 2 },
      );
    },

    message(ws, data) {
      const client = [...clients].find((c) => c.ws === ws);
      if (!client) return;
      if (typeof data === "string") {
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(data) as Record<string, unknown>;
        } catch {
          return;
        }
        handleCommand(client, ev);
      } else {
        // binary = mic PCM; count it so the test can verify the capture path
        ws.data.mic += 1;
        if (ws.data.mic % 60 === 0) console.log(`[mock] mic frames: ${ws.data.mic}`);
      }
    },

    close(ws) {
      const client = [...clients].find((c) => c.ws === ws);
      if (client) clients.delete(client);
    },
  },
});

function handleCommand(c: Client, ev: Record<string, unknown>): void {
  const send = (o: unknown) => c.ws.send(JSON.stringify(o));
  // one line per client command: the test harness reads this to verify the flow
  // even when the screenshot is stale (a windowed nested session stops rendering
  // while it is occluded).
  const brief = (v: unknown) => (typeof v === "string" && v.length > 60 ? `${v.slice(0, 60)}…` : v);
  console.log(
    `[mock] <- ${ev.type} ${JSON.stringify(brief(ev.text) ?? ev.id ?? ev.model ?? "")}`.trimEnd(),
  );
  switch (ev.type) {
    case "text": {
      const text = String(ev.text ?? "");
      const id = nextId++;
      send({ type: "user", text, id });
      if (/reset|cancell|clear/i.test(text)) return;
      send({ type: "state", state: "thinking" });
      // 💭 reasoning, then a streamed answer + sine PCM, like the real pipeline
      let reasoning = "";
      const thinkTimer = setInterval(() => {
        reasoning += " ok, vediamo…";
        send({ type: "reasoning", text: " pondero" });
        if (reasoning.length > 30) clearInterval(thinkTimer);
      }, 120);
      setTimeout(() => {
        clearInterval(thinkTimer);
        send({ type: "state", state: "speaking" });
        const sentences = [
          `Ecco, ti rispondo a "${text}".`,
          "Questo è un flusso di frasi, come lo manderebbe l'assistente vero.",
          "Puoi interrompermi, ma qui funziona solo il pulsante stop.",
        ];
        let i = 0;
        const t0 = performance.now();
        const speak = setInterval(() => {
          if (i < sentences.length) {
            send({ type: "assistant", text: sentences[i]! });
            sendPcm(c, 440 + i * 110, 0.9); // ~0.9 s of sine per sentence
            i++;
          } else {
            clearInterval(speak);
            const aid = nextId++;
            send({ type: "assistant_done", text: sentences.join(" "), id: aid });
            send({
              type: "latency",
              first_token_ms: Math.round(performance.now() - t0 - 500),
              first_audio_ms: Math.round(performance.now() - t0 - 200),
            });
            send({ type: "context", used: 1500 + nextId * 30, total: 32768 });
            send({ type: "state", state: "listening" });
            c.history.push({ role: "user", content: text, id });
            c.history.push({ role: "assistant", content: sentences.join(" "), id: aid });
          }
        }, 1000);
      }, 700);
      if (/tool/i.test(text)) {
        setTimeout(() => {
          send({
            type: "tool",
            phase: "start",
            origin: "harness",
            id: `t${nextId}`,
            tool: "run_command",
            summary: "uptime",
            args: { cmd: "uptime" },
          });
          setTimeout(() => {
            send({
              type: "tool",
              phase: "end",
              origin: "harness",
              id: `t${nextId - 1}` || "t",
              tool: "run_command",
              summary: "uptime",
              result: " 18:42:07 up 3 days, load average: 0.42, 0.51, 0.63",
              info: "exit 0 · 12 ms",
            });
          }, 800);
        }, 300);
        setTimeout(() => {
          send({
            type: "tool",
            phase: "start",
            origin: "harness",
            id: `g${nextId}`,
            tool: "run_command",
            summary: "rm -rf /",
            args: { cmd: "rm -rf /" },
          });
          send({
            type: "tool",
            phase: "end",
            origin: "harness",
            id: `g${nextId}`,
            tool: "run_command",
            summary: "rm -rf /",
            blocked: true,
          });
        }, 1500);
      }
      if (/comando|command/i.test(text)) {
        const cid = nextId++;
        setTimeout(() => {
          send({
            type: "command_request",
            id: cid,
            command: "ls -la /tmp",
            reason: "l'utente ha chiesto i file di /tmp",
          });
        }, 1200);
        pendingApprovals.set(cid, c);
      }
      if (/timer/i.test(text)) {
        setTimeout(() => {
          send({
            type: "tasks",
            tasks: [
              { id: "timer-1", kind: "timer", label: "timer 42 s", due_in_ms: 42_000 },
              { id: "timer-2", kind: "timer", label: "timer 90 s", due_in_ms: 90_000 },
            ],
          });
        }, 1000);
      }
      return;
    }
    case "stop":
      send({ type: "assistant_cancel" });
      send({ type: "flush" });
      send({ type: "state", state: "listening" });
      return;
    case "reset":
      c.history = [];
      send({ type: "chat_reset" });
      return;
    case "rewind": {
      const id = Number(ev.id);
      const idx = c.history.findIndex((m) => m.id === id);
      if (idx < 0) {
        send({ type: "chat_rewound", ok: false, history: c.history });
        return;
      }
      c.history = c.history.slice(0, idx + 1);
      send({ type: "chat_rewound", ok: true, history: c.history });
      return;
    }
    case "task_cancel":
      send({
        type: "tasks",
        tasks: [{ id: "timer-1", kind: "timer", label: "timer 42 s", due_in_ms: 42_000 }],
      });
      return;
    case "approve": {
      const cid = Number(ev.id);
      const ok = Boolean(ev.ok);
      send({ type: "command_resolved", id: cid });
      if (!ok) {
        send({
          type: "command_result",
          id: cid,
          command: "ls -la /tmp",
          status: "denied",
          output: "",
        });
        return;
      }
      send({ type: "command_start", id: cid, command: "ls -la /tmp", auto: false });
      setTimeout(() => {
        send({
          type: "command_result",
          id: cid,
          command: "ls -la /tmp",
          status: "exit 0",
          output:
            "total 0\ndrwx------ 1 g g 128 Oct 15 18:00 systemd-private-aaa\ndrwx------ 1 g g  96 Oct 15 18:42 tmp-sonia",
        });
      }, 900);
      return;
    }
    case "models_refresh":
      send({
        type: "models",
        models: [
          "qwen3.5-4b-mtp-q4_k_m",
          "gemma-4-12b-it-q4",
          "llama-4-8b-instruct",
          "phi-4-mini",
          "mistral-small-3.2",
          "qwen3.5-14b-q4_k_m",
        ],
        current: "qwen3.5-4b-mtp-q4_k_m",
        via_pi: false,
      });
      return;
    case "model":
      send({ type: "model_loading", model: String(ev.model) });
      setTimeout(() => send({ type: "model_ready", model: String(ev.model), seconds: 3 }), 1200);
      return;
    case "skills_refresh":
      send({
        type: "skills",
        dir: "/home/g/.pi/agent/skills",
        skills: [
          { name: "websurfx", description: "Ricerca web", active: true },
          { name: "hackernews", description: "HN", active: false },
          { name: "reddit", description: "Reddit", active: true },
        ],
      });
      return;
    case "config":
      console.log("[mock] config:", JSON.stringify(ev));
      return;
  }
}

const pendingApprovals = new Map<number, Client>();

/** ~dur s of a sine wave, sent as the server would: 20 ms slices, paced. */
function sendPcm(c: Client, freq: number, dur: number): void {
  const total = Math.floor(RATE * dur);
  const slice = Math.floor(RATE * 0.02);
  let sent = 0;
  const timer = setInterval(() => {
    if (sent >= total || c.ws.readyState !== WebSocket.OPEN) {
      clearInterval(timer);
      if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify({ type: "flush" }));
      return;
    }
    const pcm = new Int16Array(slice);
    for (let i = 0; i < slice; i++) {
      const t = (sent + i) / RATE;
      pcm[i] =
        Math.sin(2 * Math.PI * freq * t) *
        8000 *
        (0.4 + 0.6 * Math.abs(Math.sin(2 * Math.PI * 2 * t)));
    }
    c.ws.send(new Uint8Array(pcm.buffer));
    sent += slice;
  }, 20);
}

console.log(`sonia mock harness on http://127.0.0.1:${PORT} (ws: /ws)`);
