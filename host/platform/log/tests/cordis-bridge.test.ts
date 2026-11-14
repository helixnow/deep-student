/**
 * W01：Cordis `ctx.logger` → 主日志桥接。插件日志（以及 kernel 的命令兜底日志）必须与 `ctx.log`
 * 落在同一个 `deep-student.log`；stderr 输出保留且包含 warn。
 */
import { existsSync, readFileSync } from 'node:fs';
import { Context } from '@deepseek-ai/cordis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { definePlugin } from '../../../kernel/api.ts';
import { createStderrExporter } from '../../../kernel/log-export.ts';
import { createTestHost, HandlerPanic, type TestHost } from '../../../kernel/testing.ts';
import { createPaths } from '../../paths/index.ts';
import { bridgeCordisLogger, CORDIS_LOG_TARGET } from '../cordis-bridge.ts';
import log from '../index.ts';

const hosts: TestHost[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const host of hosts.splice(0)) await host.dispose();
});

async function hostWithLog() {
  const host = await createTestHost();
  hosts.push(host);
  host.ctx.reflect.provide('paths', createPaths({
    dataDir: host.app.dataDir,
    platform: host.app.platform,
    env: { HOME: host.app.dataDir, USERPROFILE: host.app.dataDir, APPDATA: host.app.dataDir, LOCALAPPDATA: host.app.dataDir },
  }));
  return host;
}

const mainLog = (host: TestHost) => (existsSync(host.ctx.log.mainLogFile) ? readFileSync(host.ctx.log.mainLogFile, 'utf8') : '');
const LINE = String.raw`^\[\d{4}-\d{2}-\d{2}\]\[\d{2}:\d{2}:\d{2}\]`;

describe('Cordis logger → deep-student.log', () => {
  it('writes plugin logger records with their level and a dstu_host:: target; debug follows the Info filter', async () => {
    const host = await hostWithLog();
    await host.install(log);
    await host.install(definePlugin({
      meta: { id: 'fixture.w01-logs' },
      apply(ctx) {
        const logger = ctx.logger('w01.fixture');
        logger.info('批次 %d 完成', 3);
        logger.warn('warned %s', 'here');
        logger.error(new RangeError('kaput'));
        logger.debug('hidden by the Info filter');
        ctx.logger.warn('default-named record');
      },
    }));
    const text = mainLog(host);
    expect(text).toMatch(new RegExp(`${LINE}\\[INFO\\]\\[${CORDIS_LOG_TARGET}::w01.fixture\\] 批次 3 完成$`, 'm'));
    expect(text).toMatch(new RegExp(`${LINE}\\[WARN\\]\\[${CORDIS_LOG_TARGET}::w01.fixture\\] warned here$`, 'm'));
    expect(text).toMatch(new RegExp(`${LINE}\\[ERROR\\]\\[${CORDIS_LOG_TARGET}::w01.fixture\\] RangeError: kaput\\n\\s+at `, 'm'));
    expect(text).toMatch(new RegExp(`\\[WARN\\]\\[${CORDIS_LOG_TARGET}::[^\\]]+\\] default-named record$`, 'm'));
    expect(text).not.toContain('hidden by the Info filter');
  });

  it('persists the kernel command fallback log with its stack', async () => {
    const host = await hostWithLog();
    await host.install(log);
    host.runtime.commands._registerKernel('plugin:w01|crash', () => { throw new TypeError('kernel-visible crash'); });
    const error = await host.invoke('plugin:w01|crash', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HandlerPanic);
    const text = mainLog(host);
    expect(text).toMatch(new RegExp(`${LINE}\\[ERROR\\]\\[${CORDIS_LOG_TARGET}::commands\\] command "plugin:w01\\|crash" \\(invoke [^)]+\\) threw`, 'm'));
    expect(text).toMatch(/TypeError: kernel-visible crash\n\s+at /);
  });

  it('replays records buffered before the log plugin loaded, exactly once across reloads', async () => {
    const host = await hostWithLog();
    host.ctx.logger('boot').error('profile problem before log was up');
    host.ctx.logger('boot').info('boot info before log was up');
    await host.install(log);
    host.ctx.logger('after').info('after the first load');
    await host.unload('dstu.platform.log');
    host.ctx.logger('gap').info('while log is unloaded');
    await host.install(log);
    const text = mainLog(host);
    const count = (needle: string) => text.split('\n').filter((line) => line.includes(needle)).length;
    expect(count('profile problem before log was up')).toBe(1);
    expect(count('boot info before log was up')).toBe(1);
    expect(count('after the first load')).toBe(1);
    // 卸载期间的记录仍在 Cordis 缓冲中，下次装载时补写。
    expect(count('while log is unloaded')).toBe(1);
    expect(text.indexOf('profile problem before log was up')).toBeLessThan(text.indexOf('after the first load'));
  });

  it('stops writing when the log plugin is unloaded and never throws into the logging plugin', async () => {
    const host = await hostWithLog();
    await host.install(log);
    const file = host.ctx.log.mainLogFile;
    await host.unload('dstu.platform.log');
    expect(() => host.ctx.logger('late').warn('after unload')).not.toThrow();
    expect(readFileSync(file, 'utf8')).not.toContain('after unload');
  });
});

describe('bridgeCordisLogger', () => {
  it('a failing sink is reported once on stderr and does not break the caller', () => {
    const root = new Context();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    bridgeCordisLogger(root, { writeAt() { throw new Error('ENOSPC: no space left on device'); } });
    expect(() => root.logger('x').warn('first')).not.toThrow();
    expect(() => root.logger('x').error('second')).not.toThrow();
    const notes = stderr.mock.calls.map(([chunk]) => String(chunk)).filter((s) => s.includes('ENOSPC'));
    expect(notes).toHaveLength(1);
  });

  it('formats arguments like the stderr exporter and stamps the record time', () => {
    const root = new Context();
    const records: unknown[][] = [];
    bridgeCordisLogger(root, { writeAt: (...args) => void records.push(args) });
    const before = Date.now();
    root.logger('fmt').info('n=%d obj=%o', 7, { a: [1, 2n] });
    expect(records).toHaveLength(1);
    const [level, target, message, epochMs] = records[0] as [string, string, string, number];
    expect([level, target]).toEqual(['info', `${CORDIS_LOG_TARGET}::fmt`]);
    expect(message).toBe("n=7 obj={ a: [ 1, 2n, [length]: 2 ] }");
    expect(epochMs).toBeGreaterThanOrEqual(before);
  });
});

describe('Host stderr exporter', () => {
  it('prints error, warn and info (Cordis drops warn at its default level) and skips debug', () => {
    const root = new Context();
    const lines: string[] = [];
    const defaultLevelTypes: string[] = [];
    // 旧 main.ts 的 exporter 没设 levels：Cordis 默认阈值 INFO 会丢掉 warn。
    root.logger.exporter({ export: (message) => void defaultLevelTypes.push(message.type) });
    root.logger.exporter(createStderrExporter((line) => void lines.push(line)));
    root.logger('host').info('i');
    root.logger('host').warn('w %d', 1);
    root.logger('host').error('e');
    root.logger('host').debug('d');
    expect(defaultLevelTypes).toEqual(['info', 'error']);
    expect(lines).toEqual(['[dstu-host] info [host] i\n', '[dstu-host] warn [host] w 1\n', '[dstu-host] error [host] e\n']);
  });
});
