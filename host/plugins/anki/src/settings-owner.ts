/**
 * `settings` 表归 F4（decisions.md D1）。Rust 的 `save_setting` / `get_setting` /
 * `set_default_template` / `get_default_template`（`dstu-storage/src/database/mod.rs:4108-4131,
 * 7225-7254`）都在主库同一张表上，F4 `SettingsWithConn` 用同一条 SQL 与 chrono RFC 3339
 * 时间；本 lane 把自己的 `mistakes` 连接传过去，不再自写该表。
 */
import type { Context } from '../../../kernel/api.ts';
import type { SettingsWithConn } from '../../../platform/settings/api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { syncOptionsFromSettings, type AnkiConnectSyncOptions } from './anki-connect.ts';
import { throwApp } from './plugin-runtime.ts';

export function requireSettingsOwner(ctx: Context): SettingsWithConn {
  const settings = ctx.get('settings') as Partial<SettingsWithConn> | undefined;
  if (
    settings === undefined
    || typeof settings.getWithConn !== 'function'
    || typeof settings.saveWithConn !== 'function'
  ) {
    throwApp('Configuration', 'settings 服务不可用：F4 未提供 SettingsWithConn');
  }
  return settings as SettingsWithConn;
}

export const DEFAULT_TEMPLATE_SETTING_KEY = 'default_template_id';

/**
 * AnkiConnect 同步参数（`chatanki_executor.rs:6325-6334`、`cmd/anki_connect.rs:309,1412`）：
 * `db.get_setting(..).ok().flatten()`，读失败按未设置处理。
 */
export function readAnkiConnectSyncOptions(ctx: Context, db: SqlExecutor): AnkiConnectSyncOptions {
  const settings = requireSettingsOwner(ctx);
  const settingOrNull = (key: string): string | null => {
    try {
      return settings.getWithConn(db, key);
    } catch {
      return null;
    }
  };
  return syncOptionsFromSettings(
    settingOrNull('anki_connect_batch_size'),
    settingOrNull('anki_connect_retry_times'),
    settingOrNull('anki_connect_media_mode'),
  );
}
