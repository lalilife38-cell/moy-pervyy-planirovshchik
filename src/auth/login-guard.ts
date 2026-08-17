export class LoginBlockedError extends Error {
  constructor(public readonly remainingSeconds: number) {
    super(`Слишком много попыток. Повторите через ${remainingSeconds} сек.`);
    this.name = "LoginBlockedError";
  }
}

interface AttemptState {
  failures: number;
  blockedUntil: number;
}

export class LoginAttemptGuard {
  private readonly attempts = new Map<string, AttemptState>();

  constructor(private readonly now: () => number = Date.now) {}

  assertAllowed(profileId: string): void {
    const state = this.attempts.get(profileId);
    if (!state?.blockedUntil) return;
    const remainingMs = state.blockedUntil - this.now();
    if (remainingMs <= 0) {
      this.attempts.delete(profileId);
      return;
    }
    throw new LoginBlockedError(Math.ceil(remainingMs / 1000));
  }

  recordFailure(profileId: string): void {
    this.assertAllowed(profileId);
    const state = this.attempts.get(profileId) ?? { failures: 0, blockedUntil: 0 };
    state.failures += 1;
    if (state.failures >= 5) {
      state.blockedUntil = this.now() + 30_000;
    }
    this.attempts.set(profileId, state);
  }

  clear(profileId: string): void {
    this.attempts.delete(profileId);
  }
}
