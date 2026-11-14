import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createPaths } from '../../paths/index.ts';
import log from '../index.ts';

// debug_log_service.rs:83-126 inserts each JSON key as data in serde_json::Map.
it('F4-V2-13 frontend log redaction preserves own JSON keys while redacting nested credentials', async () => {
  const host = await createTestHost();
  try {
    host.ctx.provide('paths', createPaths({ dataDir: host.app.dataDir, platform: host.app.platform,
      env: { HOME: host.app.dataDir, USERPROFILE: host.app.dataDir, APPDATA: host.app.dataDir, LOCALAPPDATA: host.app.dataDir } }));
    await host.install(log);
    const extra = JSON.parse('{"__proto__":{"api_key":"dummy-value","note":"kept"},"constructor":{"password":"dummy-value"},"keep":true}');
    await host.invoke('report_frontend_log', { payload: { message: 'own-key-case', level: 'ERROR', extra } });
    const directory = join(host.ctx.log.logDir, 'frontend');
    const files = (await readdir(directory)).filter(name => name.endsWith('.log'));
    const entries = (await Promise.all(files.map(name => readFile(join(directory, name), 'utf8'))))
      .flatMap(text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
    const entry = entries.find(value => value.data?.message === 'own-key-case');
    expect(entry).toBeDefined();
    expect(Object.hasOwn(entry.data.extra, '__proto__')).toBe(true);
    expect(entry.data.extra).toEqual(JSON.parse('{"__proto__":{"api_key":"[REDACTED]","note":"kept"},"constructor":{"password":"[REDACTED]"},"keep":true}'));
    expect(JSON.stringify(entry.data.extra)).not.toContain('dummy-value');
  } finally { await host.dispose(); }
});
