import { expect, it } from 'vitest';
import { createBackupCrypto } from '../../../platform/secrets/backup-crypto.ts';
import type { CloudStorage } from '../../sync-providers/api.ts';
import { configEncryptionPassword, enforceRecordUploadEncryptionPolicy } from '../src/upload-policy.ts';

const backup = createBackupCrypto();
function remote() {
  const files = new Map<string, Uint8Array>();
  const cloud = {
    providerName: () => 'memory', instanceBindingHint: () => 'policy-test',
    get: async (key: string) => files.get(key) ?? null,
    getBounded: async (key: string) => files.get(key) ?? null,
    put: async (key: string, bytes: Uint8Array) => { files.set(key, bytes.slice()); },
    delete: async (key: string) => { files.delete(key); },
    list: async (prefix: string) => [...files].filter(([key]) => key.startsWith(prefix)).map(([key, bytes]) => ({ key, size: bytes.length, lastModified: new Date().toISOString() })),
    listOutcome: async (prefix: string) => ({ files: await cloud.list(prefix), truncated: false }),
    stat: async (key: string) => files.has(key) ? { key, size: files.get(key)!.length } : null,
    supportsConditionalPut: () => false,
    supportsPrefixRead: () => false,
  };
  return { files, enforce: (device: string, password: string | null) => enforceRecordUploadEncryptionPolicy(cloud as unknown as CloudStorage, device, password, { backup }) };
}
it('config_encryption_password_ignores_empty_password', () => {
  expect(configEncryptionPassword({})).toBeNull();
  expect(configEncryptionPassword({ encryptionPassword: '' })).toBeNull();
  expect(configEncryptionPassword({ encryptionPassword: 'pw' })).toBe('pw');
});
it('record_upload_policy_allows_plaintext_without_marker', async () => {
  const f = remote(); await f.enforce('device-a', null);
  expect(f.files.has('.encryption-marker')).toBe(false);
});
it('record_upload_policy_writes_marker_with_verifier_when_encrypted', async () => {
  const f = remote(); await f.enforce('device-a', 'pw');
  const marker = JSON.parse(Buffer.from(f.files.get('.encryption-marker')!).toString());
  expect(marker.keyVerifier).not.toBeNull(); expect(marker.keyVerifier).toBeDefined();
});
it('record_upload_policy_rejects_plaintext_when_marker_exists', async () => {
  const f = remote(); await f.enforce('device-a', 'pw');
  const error = await f.enforce('device-b', null).catch(error => error as Error);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain('已存在端到端加密备份');
  expect((error as Error).message).toContain('加密密码');
});
it('record_upload_policy_allows_same_password_when_marker_exists', async () => {
  const f = remote(); await f.enforce('device-a', 'pw'); await f.enforce('device-b', 'pw');
});
it('record_upload_policy_rejects_wrong_password_before_upload', async () => {
  const f = remote(); await f.enforce('device-a', 'correct-pw');
  const original = f.files.get('.encryption-marker')!.slice();
  const error = await f.enforce('device-b', 'wrong-pw').catch(error => error as Error);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain('密码'); expect((error as Error).message).toContain('不一致');
  expect(f.files.get('.encryption-marker')).toEqual(original);
});
