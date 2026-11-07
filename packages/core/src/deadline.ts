/*
Deadline enforces one total time budget for a set of operations.
 It is used to ensure that a request does not exceed a certain time limit,
 even if multiple operations are performed in sequence.
*/

export class Deadline {
  readonly requestedMs: number;
  readonly expiredAt: number;
  readonly signal: AbortSignal;

  constructor(requestedMs: number, parentSignal?: AbortSignal) {
    if (!Number.isFinite(requestedMs) || requestedMs < 0) {
      throw new TypeError("Deadline requestedMs must be a non-negative number");
    }

    this.requestedMs = requestedMs;
    this.expiredAt = performance.now() + requestedMs;

    const timeoutSignal = AbortSignal.timeout(requestedMs);
    this.signal = parentSignal ? AbortSignal.any([parentSignal, timeoutSignal]) : timeoutSignal;
  }

  get remainingMs(): number {
    return Math.max(0, this.expiredAt - performance.now());
  }

  get expired(): boolean {
    return this.remainingMs === 0;
  }

  throwIfExpired(): void {
    if (this.expired) throw new DeadlineExceededError(this.requestedMs);
  }

  /** Why work under this deadline must stop (cancellation or expiry), or undefined to continue. */
  stopReason(): unknown {
    if (this.signal.aborted)
      return this.signal.reason ?? new DeadlineExceededError(this.requestedMs);
    if (this.expired) return new DeadlineExceededError(this.requestedMs);
  }

  throwIfStopped(): void {
    const reason = this.stopReason();
    if (reason !== undefined) throw reason;
  }

  clamp(timeoutMs: number): number {
    return Math.min(Math.max(0, timeoutMs), this.remainingMs);
  }
}

export class DeadlineExceededError extends Error {
  readonly code = "DEADLINE_EXCEEDED";
  constructor(readonly timeoutMs: number) {
    super(`Operation timeout after ${timeoutMs}ms`);
    this.name = "DeadlineExceededError";
  }
}
