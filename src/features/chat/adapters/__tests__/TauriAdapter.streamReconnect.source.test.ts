import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const tauriAdapterSource = readFileSync(
  resolve(process.cwd(), 'src/features/chat/adapters/TauriAdapter.ts'),
  'utf-8'
);

describe('TauriAdapter stream reconnect source', () => {
  it('stores reconnect progress on the current assistant message instead of showing a reconnect toast', () => {
    expect(tauriAdapterSource).toContain("case 'stream_reconnect':");
    expect(tauriAdapterSource).toContain('streamReconnect: {');
    expect(tauriAdapterSource).toContain('retryAttempt: payload.retryAttempt ?? 1');
    expect(tauriAdapterSource).not.toContain('notifyStreamReconnect(payload)');
  });

  it('clears reconnect state when the stream finishes, fails, or is cancelled', () => {
    expect(tauriAdapterSource).toContain('streamReconnect: undefined');
  });
});
