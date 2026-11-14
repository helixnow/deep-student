import type { SettingsStore, SettingRow } from '../../../platform/settings/api.ts';
import type { CloudStorage } from '../../sync-providers/api.ts';
import type { FilePayloadCodec } from './payload.ts';
import { isSyncableSettingKey } from './classification-data/settings.ts';
import { ensureFileUploadEncryptionPolicy } from './file-transfer.ts';

export async function syncPreferences(storage: CloudStorage, settings: SettingsStore, deviceId: string, direction: string, codec: FilePayloadCodec): Promise<void> {
  const prefix = 'data_governance/preferences';
  const local = settings.listByPrefix('').filter(row => isSyncableSettingKey(row.key));
  const winners = new Map(local.map(row => [row.key, row]));
  const listing = await storage.listOutcome(prefix);
  if (listing.truncated) throw new Error('偏好设置清单被截断');
  for (const file of listing.files.filter(file => file.key.endsWith('.json'))) {
    const bytes = await storage.get(file.key);
    if (!bytes) continue;
    const rows: SettingRow[] = JSON.parse(new TextDecoder().decode(await codec.decode(bytes)));
    if (!Array.isArray(rows)) throw new Error('偏好设置清单格式错误');
    for (const row of rows) {
      if (!isSyncableSettingKey(row.key) || typeof row.value !== 'string' || typeof row.updatedAt !== 'string' || !Number.isFinite(Date.parse(row.updatedAt))) continue;
      const existing = winners.get(row.key);
      if (!existing || Date.parse(row.updatedAt) > Date.parse(existing.updatedAt)
        || (row.updatedAt === existing.updatedAt && row.value > existing.value)) winners.set(row.key, row);
    }
  }
  if (direction !== 'Upload') for (const row of winners.values()) if (settings.get(row.key) !== row.value) settings.save(row.key, row.value);
  if (direction !== 'Download') {
    await ensureFileUploadEncryptionPolicy(storage, codec.encrypted);
    await storage.put(`${prefix}/${encodeURIComponent(deviceId)}.json`, await codec.encode(new TextEncoder().encode(JSON.stringify([...winners.values()]))));
  }
}
