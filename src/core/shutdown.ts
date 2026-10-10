/** Cooperative shutdown: stop scheduling new work, let in-flight work reach a safe point. */
export class ShutdownController {
  private _reason: string | null = null;
  private listeners: Array<(reason: string) => void> = [];
  readonly abort = new AbortController();

  get requested(): boolean {
    return this._reason !== null;
  }
  get reason(): string | null {
    return this._reason;
  }
  request(reason: string): void {
    if (this._reason) return;
    this._reason = reason;
    for (const l of this.listeners) l(reason);
  }
  /** Hard abort of in-flight network/IO (used after the grace period expires). */
  abortInFlight(): void {
    this.abort.abort();
  }
  onRequest(cb: (reason: string) => void): void {
    this.listeners.push(cb);
    if (this._reason) cb(this._reason);
  }
}

/** Install SIGINT/SIGTERM handlers. Returns an uninstall function. */
export function installSignalHandlers(ctrl: ShutdownController, signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM']): () => void {
  const handlers = signals.map((sig) => {
    const h = () => ctrl.request(sig);
    process.on(sig, h);
    return [sig, h] as const;
  });
  return () => handlers.forEach(([sig, h]) => process.off(sig, h));
}
