/** commands_sync.rs:35-80. Policy storage is deliberately separate from row/file storage. */
import { CloudSyncManager, type CloudStorage, type CloudSyncManagerOptions, type RuntimeCloudStorageConfig, type SyncProviderService } from '../../sync-providers/api.ts';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export function configEncryptionPassword(config: { encryptionPassword?: string | null }): string | null {
  return config.encryptionPassword == null || config.encryptionPassword === '' ? null : config.encryptionPassword;
}
export async function enforceRecordUploadEncryptionPolicy(
  storage: CloudStorage, deviceId: string, password: string | null, crypto: CloudSyncManagerOptions,
): Promise<void> {
  try { await new CloudSyncManager(storage, deviceId, crypto).enforceEncryptionPolicyBeforeUploadWithPassword(password); }
  catch (error) { throw new Error(`同步加密一致性检查未通过: ${message(error)}`); }
}
export async function enforceRecordUploadEncryptionPolicyForConfig(
  provider: SyncProviderService, config: RuntimeCloudStorageConfig, deviceId: string, crypto: CloudSyncManagerOptions,
): Promise<void> {
  let storage;
  try { storage = await provider.createStorage(config); }
  catch (error) { throw new Error(`创建云存储失败: ${message(error)}`); }
  await enforceRecordUploadEncryptionPolicy(storage, deviceId, configEncryptionPassword(config), crypto);
}
