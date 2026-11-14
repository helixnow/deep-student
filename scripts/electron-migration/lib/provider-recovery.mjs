// Persisted cooldown: a successful tiny probe does not justify infinite resumes.
export function recoveryDelay(streak, errorType = '') {
  if (/auth|quota/.test(errorType)) return 30 * 60_000;
  return Math.min(30, 2 ** Math.min(Math.max(streak - 1, 0), 5)) * 60_000;
}

export function consumeFailure(s, errorType, now) {
  const run = s.lastResumeAt ?? s.startedAt;
  if (s.failedRun !== run) {
    s.failedRun = run;
    s.providerStreak = (s.providerStreak ?? 0) + 1;
    s.providerNextTryAt = now + recoveryDelay(s.providerStreak, errorType);
  }
  return now >= (s.providerNextTryAt ?? 0);
}
