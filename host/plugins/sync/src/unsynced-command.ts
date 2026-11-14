/** commands_sync.rs:5813-5908; internal sizes stay exact until the D3 JSON-number boundary. */
import { CommandError } from '../../../kernel/api.ts';
import type { RuntimeCloudStorageConfig } from '../../sync-providers/api.ts';
import type { SyncContext } from './dependencies.ts';
import type { AsyncTombstoneReader } from './tombstone-needs.ts';
import { assertNotInMaintenance } from './cloud-runtime.ts';
import { createPayloadCodec } from './payload.ts';
import { collectUnsyncedItems } from './unsynced-items.ts';

export async function listUnsyncedItemsCommand(ctx: SyncContext, tombstones: AsyncTombstoneReader, config: RuntimeCloudStorageConfig) {
  assertNotInMaintenance(ctx);
  await ctx.backup.hydrateCloudConfig(config);
  const activeDir = ctx.storage.locations.activeDir, appDataDir = ctx.app.dataDir;
  await ctx.paths.deviceId();
  const codec = await createPayloadCodec(ctx.secrets.backup, config.encryptionPassword);
  try {
    let storage;
    try { storage = await ctx.syncProvider.createStorage(config); }
    catch (error) { throw new CommandError(`创建云存储失败: ${error instanceof Error ? error.message : String(error)}`); }
    const report = await collectUnsyncedItems(storage, { activeDir, appDataDir, codec, encryptionEnabled: codec.encrypted, tombstones });
    return { ...report, items: report.items.map(({ size, ...item }) => ({ ...item, ...(size === undefined ? {} : { size: Number(size) }) })) };
  } finally { codec.dispose(); }
}
