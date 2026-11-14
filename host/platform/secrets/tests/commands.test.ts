import { expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createPaths } from '../../paths/index.ts';
import log from '../../log/index.ts';
import secrets from '../index.ts';
import { SecretPromptStore } from '../secret-prompt.ts';

it('handles_are_memory_only_ttl_bound_and_one_shot', () => {
  const store = new SecretPromptStore();
  const handle = store.insert('office_document_password', 'correct horse battery staple', 60);
  expect(handle.memoryOnly).toBe(true);
  expect(handle.oneShot).toBe(true);
  expect(handle.consumerAvailable).toBe(false);
  expect(store.contains(handle.handleId)).toBe(true);
  const secret = store.consume(handle.handleId, 'office_document_password');
  expect(secret.toString()).toBe('correct horse battery staple');
  secret.fill(0);
  expect(() => store.consume(handle.handleId, 'office_document_password')).toThrow();
});
it('purpose_mismatch_consumes_and_zeroizes_entry', () => {
  const store = new SecretPromptStore();
  const handle = store.insert('pdf_document_password', 'secret', 60);
  expect(() => store.consume(handle.handleId, 'office_document_password')).toThrow();
  expect(store.contains(handle.handleId)).toBe(false);
});
it('secure commands preserve envelope operations and never return credentials', async () => {
  const host = await createTestHost();
  try {
    host.ctx.reflect.provide('paths', createPaths({ dataDir: host.app.dataDir, platform: host.app.platform, env: { HOME: host.app.dataDir, USERPROFILE: host.app.dataDir, APPDATA: host.app.dataDir, LOCALAPPDATA: host.app.dataDir } }));
    await host.install(log);
    await host.install(secrets);
    expect(await host.invoke('secure_store_is_available')).toBe(true);
    const empty = { webdavPasswordConfigured: false, s3SecretAccessKeyConfigured: false, ftpPasswordConfigured: false, encryptionPasswordConfigured: false };
    expect(await host.invoke('secure_get_cloud_credentials')).toEqual(empty);
    expect(await host.invoke('secure_save_cloud_credentials', { credentials: { webdavPassword: 'transport-secret', s3SecretAccessKey: null } })).toEqual({ ...empty, webdavPasswordConfigured: true });
    await expect(host.invoke('secure_save_cloud_credentials', { credentials: { encryptionPassword: 'short' } })).rejects.toMatchObject({ code: 'E_CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT', data: { operation: 'save_cloud_credentials', retryable: false } });
    expect(await host.invoke('secure_clear_cloud_encryption_password')).toEqual({ ...empty, webdavPasswordConfigured: true });
    expect(await host.invoke('secure_delete_cloud_credentials')).toBe(null);
    expect(await host.invoke('secure_get_cloud_credentials')).toEqual(empty);
    expect(await host.invoke('secure_store_get_keystore_protection')).toMatchObject({ enabled: false, seedInKeystore: false });
    expect(await host.invoke('secure_store_set_keystore_protection', { enabled: false })).toMatchObject({ enabled: false, seedInKeystore: false });
    await expect(host.invoke('secret_prompt_submit', { request: { purpose: 'pdf_document_password', secret: 'secret' } })).rejects.toBe('DECRYPTOR_INTEGRATION_UNAVAILABLE');
    expect(await host.invoke('secret_prompt_status', { handleId: 'missing' })).toEqual({ available: false, consumerAvailable: false, reasonCode: 'DECRYPTOR_INTEGRATION_UNAVAILABLE' });
    expect(await host.invoke('secret_prompt_discard', { handleId: 'missing' })).toBe(false);
    expect(await host.invoke('secret_prompt_capabilities')).toEqual({ memoryOnly: true, oneShot: true, defaultTtlSeconds: 300, maxTtlSeconds: 600, chatToolAvailable: false, decryptorIntegration: { available: false, reasonCode: 'DECRYPTOR_INTEGRATION_UNAVAILABLE' } });
  } finally { await host.dispose(); }
});
