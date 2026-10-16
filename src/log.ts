/**
 * Timestamped logger for the harness.
 *
 * On a TTY the output is byte-identical to what `Assistant.log()` wrote before
 * (`\r\x1b[K` + line), so the live status line keeps updating in the terminal.
 * Redirected to a file (`data/logs/*.log`, CI) those cursor codes are garbage: there we drop
 * the transient `status()` lines (unless `verbose`, i.e. `--debug`) and prefix a
 * timestamp, which is what makes a barge-in log readable afterwards.
 */

export class Logger {
  /** Write the transient `status()` lines even when stdout is redirected. */
  verbose = false;

  private readonly tty = Boolean(process.stdout.isTTY);

  log(msg: string): void {
    process.stdout.write(`${this.tty ? `\r\x1b[K${msg}` : this.stamp() + msg}\n`);
  }

  /** A single self-overwriting line (the live transcript / latency readout). */
  status(msg: string): void {
    const text = msg.slice(-160);
    if (this.tty) process.stdout.write(`\r\x1b[K${text}`);
    else if (this.verbose) process.stdout.write(`${this.stamp() + text}\n`);
  }

  private stamp(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} `;
  }
}

/**
 * The global safety net for stray async failures — **Bun exits the process on a rejection
 * nobody has subscribed to yet**, which is how a dead TTS server once killed the whole
 * harness instead of failing one response (`harness/assistant.ts`, the `runResponse`
 * comment). The code follows the discipline of catching every background task it spawns
 * (`Assistant.spawn`, the `ttsDone` pattern there); this handler is what a future
 * `void`-ed promise without a `.catch` costs when the discipline is forgotten: one logged
 * line, not a dead assistant mid-conversation.
 *
 * Installing one here is safe on both counts that would normally give pause:
 * startup failures still kill the process (they throw inside `amain()`, which exits
 * non-zero before anything user-visible starts), and the "keep running with corrupt
 * state" risk is bounded — the very next *unawaited* failure lands in the same handler
 * instead, and the health poller already surfaces dead legs in the UI.
 */
export function installCrashGuards(): void {
  const line = (what: string, e: unknown) =>
    console.error(
      `${new Date().toTimeString().slice(0, 8)} [${what}] ${
        e instanceof Error ? (e.stack ?? e.message) : String(e)
      }`,
    );
  process.on("unhandledRejection", (e) => line("unhandled rejection", e));
  process.on("uncaughtException", (e) => line("uncaught exception", e));
}
