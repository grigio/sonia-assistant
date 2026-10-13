/**
 * `bun run src/cli.ts` — full-duplex Italian voice assistant (Stack A, route R2).
 */

import { parseArgs } from "node:util";
import fs from "node:fs";
import { Config } from "./config";
import { Harness } from "./harness/harness";
import { PipeWireMic, WavMic, type MicSource } from "./audio/mic";
import { sleep } from "./util";

type CliArgs = {
  web: boolean;
  noBrowser: boolean;
  host: string;
  port: number;
  text: boolean;
  inputWav: string[];
  outputWav?: string;
  noSpeaker: boolean;
  stats?: string;
  debug: boolean;
};

export function parseCli(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      web: { type: "boolean", default: false },
      "no-browser": { type: "boolean", default: false },
      host: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: "8095" },
      text: { type: "boolean", default: false },
      "input-wav": { type: "string", multiple: true, default: [] },
      "output-wav": { type: "string" },
      "no-speaker": { type: "boolean", default: false },
      stats: { type: "string" },
      debug: { type: "boolean", default: false },
    },
  });
  return {
    web: values["web"]!,
    noBrowser: values["no-browser"]!,
    host: values["host"]!,
    port: parsePort(values["port"]),
    text: values["text"]!,
    inputWav: values["input-wav"] as string[],
    outputWav: values["output-wav"] as string | undefined,
    noSpeaker: values["no-speaker"]!,
    stats: values["stats"] as string | undefined,
    debug: values["debug"]!,
  };
}

/** `--port` must be a usable TCP port: `Number()` alone happily yields NaN/0/-1. */
function parsePort(raw: string | undefined): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`--port: not a TCP port number: ${raw}`);
  }
  return port;
}

function parseInputWav(items: string[]): [number, string][] {
  return items.map((item) => {
    if (item.includes(":")) {
      const idx = item.lastIndexOf(":");
      const delay = item.slice(0, idx);
      const path = item.slice(idx + 1);
      return [Number(delay || 1.0), path] as [number, string];
    }
    return [1.0, item] as [number, string];
  });
}

export async function amain(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseCli(argv);
  const cfg = Config.fromEnv();
  cfg.debug = cfg.debug || args.debug;

  if (args.web) {
    await runWeb(cfg, args);
    return;
  }

  let mic: MicSource | null;
  if (args.text) {
    mic = null;
  } else if (args.inputWav.length) {
    mic = new WavMic(parseInputWav(args.inputWav), 15.0);
  } else {
    mic = new PipeWireMic(cfg.micTarget);
  }

  const a = new Harness(
    cfg,
    mic,
    args.noSpeaker ? "null" : "pipewire",
    args.outputWav ?? null,
  );
  await a.start();
  a.log(
    "Ready. " +
      (args.text
        ? "Type a message."
        : "Speak (Ctrl+C to quit). Use headphones or the echo-cancel setup for barge-in."),
  );

  const main = args.text ? a.runText() : a.runAudio();

  let stop!: () => void;
  const stopped = new Promise<void>((res) => (stop = res));
  const onSignal = () => stop();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  let completed = false;
  let exitCode = 0;
  try {
    await Promise.race([
      main.then(() => {
        completed = true;
      }),
      stopped,
    ]);
    if (completed) {
      // let the last answer finish (file-input runs)
      while (a.resp !== null) await sleep(200);
    }
  } catch (e) {
    exitCode = 1;
    console.error("\n[fatal]", e);
  } finally {
    if (args.stats) {
      fs.writeFileSync(
        args.stats,
        JSON.stringify({ turns: a.stats, history: a.history }, null, 1),
      );
    }
    await a.close();
    process.exit(exitCode);
  }
}

async function runWeb(cfg: Config, args: CliArgs): Promise<void> {
  if (!("PLAYBACK_LATENCY_MS" in process.env)) {
    cfg.playbackLatencyMs = 150; // browser jitter buffer needs a bit more lead
  }
  const { WebApp } = await import("./web");
  const app = new WebApp(cfg, args.host, args.port);
  const runPromise = app.run(!args.noBrowser);

  let stop!: () => void;
  const stopped = new Promise<void>((res) => (stop = res));
  process.on("SIGINT", () => stop());
  process.on("SIGTERM", () => stop());

  let exitCode = 0;
  try {
    await Promise.race([runPromise, stopped]);
  } catch (e) {
    // a startup failure (EADDRINUSE, warmup, LLM/TTS down) must not look like a success:
    // scripts/run.ts and any caller see a non-zero exit code
    exitCode = 1;
    console.error("\n[fatal]", e);
  } finally {
    await app.close();
    process.exit(exitCode);
  }
}

if (import.meta.main) {
  amain().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
