import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import plugin from '../index.ts';
import { CODEX_CREDENTIAL_KEY } from '../src/openai-codex/protocol.ts';

const CODEX_COMMAND_ERROR = 'OpenAI Codex authentication request failed';

class MemorySettings implements SettingsStore {
  values = new Map<string, string>();
  failSecrets = false;
  save(key: string, value: string) { this.values.set(key, value); }
  get(key: string) { return this.values.get(key) ?? null; }
  delete(key: string) { return this.values.delete(key); }
  listByPrefix(prefix: string) {
    return [...this.values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value, updatedAt: '2026-11-03T00:00:00+00:00' }));
  }
  deleteByPrefix(prefix: string) { let n = 0; for (const key of [...this.values.keys()]) if (key.startsWith(prefix)) { this.values.delete(key); n++; } return n; }
  async saveSecret(key: string, value: string) { if (this.failSecrets) throw new Error('secret backend unavailable'); this.save(key, value); }
  async getSecret(key: string) { if (this.failSecrets) throw new Error('secret backend unavailable'); return this.get(key); }
  async deleteSecret(key: string) { if (this.failSecrets) throw new Error('secret backend unavailable'); return this.delete(key); }
}

async function host(settings = new MemorySettings()) {
  const test = await createTestHost({ plugins: [plugin], provide: { settings }, app: { version: '0.11.0' } });
  return { host: test, settings };
}

describe('openai_codex commands', () => {
  it('auth_status reports the signed-out Rust shape', async () => {
    const { host: test } = await host();
    try {
      expect(await test.invoke('openai_codex_auth_status')).toEqual({
        phase: 'signed_out', hasUsableSession: false, accountHint: null, email: null, planType: null,
        isFedramp: false, expiresAtUnixMs: null, generation: 1, activeLoginKind: null, activeAttemptId: null,
        authorizationUrl: null, verificationUrl: null, userCode: null, pollIntervalSeconds: null, lastError: null,
      });
    } finally { await test.dispose(); }
  });

  it('auth_status reports credential-store load failures as the Rust error phase', async () => {
    const settings = new MemorySettings();
    settings.failSecrets = true;
    const { host: test } = await host(settings);
    try {
      const status = await test.invoke<{ phase: string; hasUsableSession: boolean; lastError: { code: string } | null }>('openai_codex_auth_status');
      expect(status.phase).toBe('error');
      expect(status.hasUsableSession).toBe(false);
      expect(status.lastError?.code).toBe('credential_store_failed');
    } finally { await test.dispose(); }
  });

  it('login_start rejects flows Rust does not know with the exact string', async () => {
    const { host: test } = await host();
    try {
      await expect(test.invoke('openai_codex_login_start', { flow: 'password' }))
        .rejects.toBe('Unsupported OpenAI Codex login flow');
    } finally { await test.dispose(); }
  });

  it('login_cancel maps an unknown attempt to the fixed command error after logging', async () => {
    const { host: test } = await host();
    try {
      await expect(test.invoke('openai_codex_login_cancel', { attemptId: 'missing' }))
        .rejects.toBe(CODEX_COMMAND_ERROR);
    } finally { await test.dispose(); }
  });

  it('logout is idempotent while signed out and clears the stored credential', async () => {
    const settings = new MemorySettings();
    settings.save(CODEX_CREDENTIAL_KEY, 'not json');
    const { host: test } = await host(settings);
    try {
      await expect(test.invoke('openai_codex_logout')).resolves.toBeNull();
      expect(settings.values.has(CODEX_CREDENTIAL_KEY)).toBe(false);
    } finally { await test.dispose(); }
  });

  it('usage maps the signed-out error exactly like Rust command_error', async () => {
    const { host: test } = await host();
    try {
      await expect(test.invoke('openai_codex_usage')).rejects.toBe(CODEX_COMMAND_ERROR);
    } finally { await test.dispose(); }
  });
});
