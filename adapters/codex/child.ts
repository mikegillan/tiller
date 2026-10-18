import type { ChildProcess } from 'node:child_process';

/** Observe the actual child handle from spawn: neither a sent signal nor closed stdio proves exit. */
export class ManagedChild {
  readonly exit: Promise<void>;
  private exited = false;
  private stopping = false;
  private stopTask?: Promise<boolean>;

  constructor(private readonly child: ChildProcess) {
    this.exit = new Promise((resolve) => {
      const done = () => { this.exited = true; resolve(); };
      child.once('exit', done);
      child.once('error', () => { if (child.pid === undefined) done(); }); // failed spawn: no process exists
      if ((child.exitCode !== null && child.exitCode !== undefined) || child.signalCode != null) done();
    });
  }

  beginStop(): void {
    if (this.stopping) return;
    this.stopping = true;
    this.signal('SIGTERM');
  }

  /** Escalation stays on the unreaped ChildProcess handle; never look up a potentially reused PID. */
  terminate(): Promise<boolean> {
    return this.stopTask ??= this.stop();
  }

  private async stop(): Promise<boolean> {
    this.beginStop();
    if (await this.wait(250)) return true;
    this.signal('SIGKILL');
    return this.wait(1000);
  }

  private signal(signal: NodeJS.Signals): void {
    if (this.exited) return;
    try { this.child.kill(signal); } catch { /* Exit must still be observed; the deadline fails closed. */ }
  }

  private async wait(ms: number): Promise<boolean> {
    if (this.exited) return true;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([this.exit, new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]);
      return this.exited;
    } finally { clearTimeout(timer); }
  }
}
