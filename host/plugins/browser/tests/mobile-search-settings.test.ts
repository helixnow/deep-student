import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import mobileWebSearch from '../mobile-search.ts';

it('reads provider strategies and custom whitelist from SQLite after reopening the mobile host', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dstu-mobile-search-'));
  const path = join(dataDir, 'settings.db');
  const open = async () => {
    const db = new Database(path);
    db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');
    const statement = (sql: string) => db.prepare(sql.replace(/\?\d+/g, '?'));
    const executor = {
      run: (sql: string, params: string[]) => statement(sql).run(...params),
      pluck: (sql: string, params: string[]) => statement(sql).pluck().get(...params),
    } as unknown as SqlExecutor;
    const settings = createSettingsStore({ db: () => executor, secureStore: () => null, isSensitiveKey: () => false });
    const host = await createTestHost({
      app: { dataDir },
      plugins: [mobileWebSearch],
      provide: { settings, http: {} },
    });
    return { db, host, settings };
  };
  const first = await open();
  try {
    expect(await first.host.invoke('get_provider_strategies_config')).toMatchObject({
      provider_strategies: { bing_rss: { timeout_ms: 10000 } },
    });
    expect(await first.host.invoke('save_provider_strategies_config', {
      strategies: { default: {}, bing_rss: { timeout_ms: 7312, max_retries: 0 } },
    })).toBe(true);
    await expect(first.host.invoke('save_provider_strategies_config', {
      strategies: { default: {}, bing_rss: { timeout_ms: -1 } },
    })).rejects.toMatch(/invalid args .*strategies.*invalid number/);
    first.settings.save('web_search.cn_whitelist.enabled', 'true');
    first.settings.save('web_search.cn_whitelist.use_default', 'false');
    first.settings.save('web_search.cn_whitelist.custom_sites', 'example.org, sample.net');
  } finally {
    await first.host.dispose();
    first.db.close();
  }
  const second = await open();
  try {
    const strategy = { timeout_ms: 7312, max_retries: 0 };
    const whitelist = { enabled: true, use_default_list: false, custom_sites: ['example.org', 'sample.net'] };
    expect(await second.host.invoke('get_provider_strategies_config')).toMatchObject({
      provider_strategies: { bing_rss: strategy },
    });
    expect(await second.host.invoke('get_cn_whitelist_config')).toMatchObject({ user_config: whitelist });
    expect(await second.host.ctx.webSearch.loadConfig(second.settings)).toMatchObject({
      provider_strategies: { bing_rss: strategy },
      provider_strategies_overridden: true,
      cn_whitelist: whitelist,
    });
  } finally {
    await second.host.dispose();
    second.db.close();
  }
});
