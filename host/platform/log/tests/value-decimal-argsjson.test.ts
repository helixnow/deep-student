/**
 * V08-05：前端日志命令的 Value 字段（`report_frontend_log` 的 `payload.extra`、`write_debug_logs` 的 `logs[].data`）
 * 走生产 invoke 路径（argsJson）时，小数和大整数按数字落盘，不被 `Object.entries` 展开成 `{"rawJSON":"12.5"}`。
 */
import { expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestHost } from '../../../kernel/testing.ts';
import { createPaths } from '../../paths/index.ts';
import log from '../index.ts';

function logText(dir: string): string {
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter(name => name.endsWith('.log'))
    .map(name => readFileSync(join(dir, name), 'utf8'))
    .join('\n');
}

it('V08-05: decimals in frontend log Value fields are written as numbers, never as {"rawJSON": …}', async () => {
  const host = await createTestHost();
  try {
    host.ctx.reflect.provide('paths', createPaths({ dataDir: host.app.dataDir, platform: host.app.platform, env: { HOME: host.app.dataDir, USERPROFILE: host.app.dataDir, APPDATA: host.app.dataDir, LOCALAPPDATA: host.app.dataDir } }));
    await host.install(log);
    const source = { window: 'main', webview: 'main' };
    const report = { payload: { level: 'error', message: 'v08-05 report', extra: { ms: 12.5, big: 9007199254740993, nested: [{ ratio: 0.25 }] } } };
    expect(await host.runtime.dispatchInvoke({ id: 'v08-05-a', cmd: 'report_frontend_log', args: {}, argsJson: JSON.stringify(report), source }))
      .toEqual({ kind: 'ok', value: null });
    const entry = { timestamp: '2026-11-07T00:00:00Z', level: 'INFO', module: 'frontend', operation: 'v08-05 batch', data: { ratio: 0.5, latency: 1.75 }, context: null, stackTrace: null };
    expect(await host.runtime.dispatchInvoke({ id: 'v08-05-b', cmd: 'write_debug_logs', args: {}, argsJson: JSON.stringify({ logs: [entry] }), source }))
      .toEqual({ kind: 'ok', value: null });
    await host.ctx.log.structured.flush();
    const text = logText(host.ctx.log.logDir);
    expect(text).toContain('v08-05 report');
    expect(text).toContain('v08-05 batch');
    expect(text).toContain('"ms":12.5');
    expect(text).toContain('"big":9007199254740992');
    expect(text).toContain('"ratio":0.25');
    expect(text).toContain('"ratio":0.5');
    expect(text).toContain('"latency":1.75');
    expect(text).not.toContain('rawJSON');
  } finally { await host.dispose(); }
});
