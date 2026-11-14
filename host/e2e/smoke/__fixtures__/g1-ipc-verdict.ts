/** Recorded renderer call shape used by window-driver.mjs (not a product IPC contract). */
export interface G1Call {
  phase?: string;
  cmd: string;
  outcome: string;
  payload?: { contentType?: string; data?: string };
  body?: { kind?: string; data?: string };
}

/** Only the two deliberate negative probes are exempt, never their whole phase. */
export function isExpectedPlatformProbeFailure(call: G1Call): boolean {
  if (call.phase !== 'platform-probes' || call.outcome !== 'error'
    || call.payload?.contentType !== 'application/json' || call.body?.kind !== 'json') return false;
  try {
    const args = JSON.parse(call.payload.data ?? 'null');
    const error: unknown = JSON.parse(call.body.data ?? 'null');
    if (!args || Array.isArray(args) || Object.keys(args).length !== 1) return false;
    // Scope rejection for the deliberately invalid URL, not an arbitrary opener failure.
    if (call.cmd === 'plugin:opener|open_url') {
      return args.url === 'x1-invalid-url' && error === 'Not allowed to open url x1-invalid-url';
    }
    // Actual Electron/Node range validation observed with this probe; a transport/Host error is not exempt.
    return call.cmd === 'plugin:updater|check' && args.timeout === -1
      && error === 'The value of "delay" is out of range. It must be >= 0 && <= 4294967295. Received -1';
  } catch {
    return false;
  }
}

export function unexpectedIpcFailures<T extends G1Call>(calls: readonly T[]): T[] {
  return calls.filter(call => call.outcome !== 'result' && !isExpectedPlatformProbeFailure(call));
}
