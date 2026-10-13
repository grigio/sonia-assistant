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
    process.stdout.write((this.tty ? `\r\x1b[K${msg}` : this.stamp() + msg) + "\n");
  }

  /** A single self-overwriting line (the live transcript / latency readout). */
  status(msg: string): void {
    const text = msg.slice(-160);
    if (this.tty) process.stdout.write(`\r\x1b[K${text}`);
    else if (this.verbose) process.stdout.write(this.stamp() + text + "\n");
  }

  private stamp(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} `;
  }
}
