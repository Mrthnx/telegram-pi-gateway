/**
 * Runs tasks one at a time per key.
 *
 * The Pi SDK rejects a prompt while the agent is still streaming, and it
 * broadcasts the session events to every subscriber, so two prompts running
 * at the same time make the second one fail and mix the answers. This keeps
 * one turn per session at a time and lets the queued one wait its turn.
 */
export class SerialQueue {
  private readonly chains = new Map<string, Promise<void>>();

  /**
   * @param onQueued Called when the task has to wait for an earlier one.
   */
  async run<T>(key: string, task: () => Promise<T>, onQueued?: () => void): Promise<T> {
    const previous = this.chains.get(key);
    if (previous) onQueued?.();

    const base = previous ?? Promise.resolve();
    const run = base.then(task);
    const settled: Promise<void> = run.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, settled);

    try {
      return await run;
    } finally {
      if (this.chains.get(key) === settled) {
        this.chains.delete(key);
      }
    }
  }

  /** Whether a task is already running or waiting for this key. */
  isBusy(key: string): boolean {
    return this.chains.has(key);
  }
}
