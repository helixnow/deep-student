/**
 * `ctx.settings` 实现（`dstu-storage/src/database/mod.rs` 4108–4360）。
 */
import { dirname } from '../util/path.ts';
import type { Context } from '@deepseek-ai/cordis';
import { definePlugin } from '../../kernel/api.ts';
import type { SecretsService, SecureStore } from '../secrets/api.ts';
import type { SqlExecutor } from '../storage/api.ts';
import { chronoRfc3339 } from '../time/index.ts';
import { SettingsError, type SettingsService, type SettingsStore, type SettingsWithConn } from './api.ts';
import { deleteSettingRow, deleteSettingRowsByPrefix, getSettingRow, listSettingRowsByPrefix, saveSettingRow } from './repository/settings.ts';

export type * from './api.ts';
export { SettingsError } from './api.ts';

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface SettingsStoreOptions {
  /** 每次调用取执行器（库句柄可能在维护屏障后重新打开）。 */
  db: () => SqlExecutor;
  secureStore: () => SecureStore | null;
  isSensitiveKey: (key: string) => boolean;
  /** 测试注入时钟（返回 chrono RFC3339 字符串）。 */
  now?: () => string;
}

export function createSettingsStore(options: SettingsStoreOptions): SettingsStore & SettingsWithConn {
  const now = options.now ?? (() => chronoRfc3339());
  /** `secret_operation_lock`：每个实例一把，覆盖整次状态转换。 */
  let tail: Promise<unknown> = Promise.resolve();
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const executor = (conn?: SqlExecutor): SqlExecutor => conn ?? options.db();

  const saveWith = (exec: SqlExecutor, key: string, value: string) => saveSettingRow(exec, key, value, now());
  const getWith = getSettingRow;
  const deleteWith = deleteSettingRow;
  const listByPrefixWith = listSettingRowsByPrefix;
  const deleteByPrefixWith = deleteSettingRowsByPrefix;

  const store: SettingsStore & SettingsWithConn = {
    save(key, value) {
      saveWith(executor(), key, value);
    },
    saveWithConn(conn, key, value) {
      saveWith(conn, key, value);
    },
    get(key) {
      return getWith(executor(), key);
    },
    getWithConn(conn, key) {
      return getWith(conn, key);
    },
    delete(key) {
      return deleteWith(executor(), key);
    },
    deleteWithConn(conn, key) {
      return deleteWith(conn, key);
    },
    listByPrefix(prefix) {
      return listByPrefixWith(executor(), prefix);
    },
    listByPrefixWithConn(conn, prefix) {
      return listByPrefixWith(conn, prefix);
    },
    deleteByPrefix(prefix) {
      return deleteByPrefixWith(executor(), prefix);
    },
    deleteByPrefixWithConn(conn, prefix) {
      return deleteByPrefixWith(conn, prefix);
    },

    async saveSecret(key, value) {
      if (!options.isSensitiveKey(key)) return store.save(key, value);
      return locked(() => saveSensitiveLocked(key, value));
    },

    async getSecret(key) {
      if (!options.isSensitiveKey(key)) return store.get(key);
      return locked(async () => {
        const secure = options.secureStore();
        if (secure === null) throw new SettingsError(`安全存储不可用，拒绝读取数据库中的敏感设置: ${key}`);
        let value: string | null;
        try {
          value = await secure.getSecret(key);
        } catch (error) {
          throw new SettingsError(`安全存储读取失败，已拒绝回退到数据库明文: ${key} - ${message(error)}`, { cause: error });
        }
        if (value !== null) return value;
        const legacy = store.get(key);
        if (legacy !== null) {
          try {
            await saveSensitiveLocked(key, legacy);
          } catch (error) {
            throw new SettingsError(`迁移数据库中的旧明文敏感设置失败: ${key}`, { cause: error });
          }
        }
        return legacy;
      });
    },

    async deleteSecret(key) {
      if (!options.isSensitiveKey(key)) return store.delete(key);
      return locked(async () => {
        const secure = options.secureStore();
        let secureError: unknown = null;
        if (secure !== null) {
          try {
            await secure.deleteSecret(key);
          } catch (error) {
            secureError = error;
          }
        }
        let dbError: unknown = null;
        let deleted = false;
        try {
          deleted = store.delete(key);
        } catch (error) {
          dbError = error;
        }
        if (secure === null) {
          if (dbError !== null) throw dbError;
          return deleted;
        }
        if (secureError !== null && dbError !== null) {
          throw new SettingsError(`删除敏感设置失败（安全存储和数据库均未能清理）: ${key} - secure: ${message(secureError)}; database: ${message(dbError)}`);
        }
        if (secureError !== null) throw new SettingsError(`从安全存储删除敏感设置失败（数据库明文已清理）: ${key} - ${message(secureError)}`);
        if (dbError !== null) throw new SettingsError(`从数据库删除旧明文敏感设置失败（安全副本已清理）: ${key} - ${message(dbError)}`);
        return true;
      });
    },
  };

  /** `save_sensitive_secret_locked`。 */
  async function saveSensitiveLocked(key: string, value: string): Promise<void> {
    const secure = options.secureStore();
    if (secure === null) throw new SettingsError(`安全存储不可用，拒绝以明文保存敏感设置: ${key}`);
    let previous: string | null;
    try {
      previous = await secure.getSecret(key);
      await secure.saveSecret(key, value);
    } catch (error) {
      throw new SettingsError(`安全存储写入失败，已拒绝以明文保存敏感设置: ${key} - ${message(error)}`, { cause: error });
    }
    try {
      store.delete(key);
    } catch (dbError) {
      try {
        if (previous === null) await secure.deleteSecret(key);
        else await secure.saveSecret(key, previous);
      } catch (rollbackError) {
        throw new SettingsError(
          `安全存储写入成功，但清理数据库中的旧明文失败，且回滚安全副本也失败: ${key} - ${message(dbError)}; rollback: ${message(rollbackError)}`,
        );
      }
      throw new SettingsError(`安全存储写入成功，但清理数据库中的旧明文失败（已回滚安全副本）: ${key} - ${message(dbError)}`);
    }
  }

  return store;
}

export function createSettingsService(options: {
  db: () => SqlExecutor;
  secureStore: () => SecureStore | null;
  secrets: Pick<SecretsService, 'isSensitiveKey'>;
}): SettingsService & SettingsWithConn {
  const main = createSettingsStore({ db: options.db, secureStore: options.secureStore, isSensitiveKey: options.secrets.isSensitiveKey });
  return {
    ...main,
    bind: (db, secureStore) => createSettingsStore({ db: () => db, secureStore: () => secureStore, isSensitiveKey: options.secrets.isSensitiveKey }),
  };
}

/** Cordis 插件：`ctx.settings`（主库 `mistakes` + 其所在目录的 SecureStore）。 */
export default definePlugin({
  meta: { id: 'dstu.platform.settings', lane: 'F4-platform', provides: ['settings'] },
  inject: ['storage', 'secrets'],
  apply(ctx: Context) {
    let secure: { dir: string; store: SecureStore } | null = null;
    const secureStore = (): SecureStore => {
      const dir = dirname(ctx.storage.pathOf('mistakes'));
      if (secure === null || secure.dir !== dir) secure = { dir, store: ctx.secrets.openStore(dir) };
      return secure.store;
    };
    ctx.reflect.provide('settings', createSettingsService({ db: () => ctx.storage.database('mistakes'), secureStore, secrets: ctx.secrets }));
  },
});
