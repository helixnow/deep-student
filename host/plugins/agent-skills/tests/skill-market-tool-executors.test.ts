import { describe, expect, it } from 'vitest';
import { CommandError } from '../../../kernel/api.ts';
import type { ExecutionContext, ToolResultInfo } from '../../chat/api.ts';
import {
  SkillMarketInstallToolExecutor, SkillMarketReadToolExecutor, type SkillMarketToolPort,
} from '../src/tools/skill-market-tool-executors.ts';
import { POST_WRITE_TRUST_NEXT_STEP } from '../src/tools/skill-install-executor.ts';

function harness(port: Partial<SkillMarketToolPort>, saveFails = false) {
  const events: unknown[][] = [], saved: ToolResultInfo[] = [], warnings: string[] = [], calls: unknown[][] = [];
  const recording = new Proxy(port, {
    get: (target, key: string) => (...args: unknown[]) => {
      calls.push([key, ...args]);
      const fn = (target as Record<string, (...a: unknown[]) => unknown>)[key];
      if (fn === undefined) throw new Error(`unexpected ${key}`);
      return fn(...args);
    },
  }) as SkillMarketToolPort;
  const deps = { market: () => recording, warn: (message: string) => warnings.push(message) };
  const ctx = { session_id: 'sess_1', block_id: 'blk',
    emitToolCallStart: (...args: unknown[]) => events.push(['start', ...args]),
    emitToolCallEnd: (payload: unknown) => events.push(['end', payload]),
    emitToolCallError: (error: string) => events.push(['error', error]),
    saveToolBlock: (result: ToolResultInfo) => { if (saveFails) throw new Error('disk full'); saved.push(result); } } as unknown as ExecutionContext;
  const read = new SkillMarketReadToolExecutor(deps), install = new SkillMarketInstallToolExecutor(deps);
  const run = (executor: SkillMarketReadToolExecutor | SkillMarketInstallToolExecutor, name: string, args: unknown) =>
    executor.execute({ id: `call_${name}`, name, arguments: args }, ctx);
  return { read, install, run, events, saved, warnings, calls };
}

const ioError = (message: string) => new CommandError(JSON.stringify({ code: 'IO_ERROR', message: `IO error: ${message}` }));

describe('skill_market_client.rs SkillMarketReadToolExecutor', () => {
  it('names, routing, Low sensitivity and ReadOnly concurrency', () => {
    const { read } = harness({});
    expect(read.name()).toBe('SkillMarketReadToolExecutor');
    expect(['builtin-skill_market_search', 'skill_market_skill_detail', 'builtin-skill_market_verify'].map(name => read.canHandle(name)))
      .toEqual([true, true, false]);
    expect([read.sensitivityLevel(), read.concurrencyClass()]).toEqual(['low', 'read_only']);
  });

  it('search maps q|query, limit, nonSuspiciousOnly|non_suspicious_only and sort, and saves the success block', async () => {
    const response = { items: [], nextCursor: null };
    const h = harness({ marketSearch: async () => response as never });
    const result = await h.run(h.read, 'builtin-skill_market_search', { query: 'pdf', limit: 7, non_suspicious_only: false, sort: 'new' });
    expect(h.calls).toEqual([['marketSearch', 'pdf', 7, false, 'new']]);
    expect(result).toMatchObject({ success: true, toolCallId: 'call_builtin-skill_market_search', blockId: 'blk', output: response });
    expect(h.events.map(event => event[0])).toEqual(['start', 'end']);
    expect(h.events[1]![1]).toMatchObject({ result: response });
    expect(h.saved).toEqual([result]);

    await h.run(h.read, 'skill_market_search', { q: 'x', query: 'ignored', nonSuspiciousOnly: true, limit: -1 });
    await h.run(h.read, 'skill_market_search', { q: null, query: 'ignored', limit: 'x', sort: 3 });
    expect(h.calls.slice(1)).toEqual([['marketSearch', 'x', null, true, null], ['marketSearch', null, null, null, null]]);
  });

  it('detail requires a trimmed slug; marketplace failures surface the ChatV2Error display text', async () => {
    const h = harness({ marketDetail: async () => { throw ioError('HTTP 503'); } });
    const missing = await h.run(h.read, 'skill_market_skill_detail', { slug: '  ' });
    expect(missing).toMatchObject({ success: false, error: 'slug is required', output: null });
    expect(h.calls).toEqual([]);
    const failed = await h.run(h.read, 'skill_market_skill_detail', { slug: ' pdf-tools ' });
    expect(h.calls).toEqual([['marketDetail', 'pdf-tools']]);
    expect(failed).toMatchObject({ success: false, error: 'IO error: HTTP 503' });
    expect(h.events.filter(event => event[0] === 'error')).toEqual([['error', 'slug is required'], ['error', 'IO error: HTTP 503']]);
    expect(h.saved).toHaveLength(2);
  });

  it('a save failure is only logged', async () => {
    const h = harness({ marketDetail: async () => ({ slug: 'a' }) as never }, true);
    expect(await h.run(h.read, 'skill_market_skill_detail', { slug: 'a' })).toMatchObject({ success: true });
    expect(h.warnings).toEqual(['[SkillMarketReadToolExecutor] Failed to save tool block: disk full']);
  });
});

describe('skill_market_client.rs SkillMarketInstallToolExecutor', () => {
  it('verify is Low/ReadOnly; download_and_scan is High/Serial with Medium for a scan-only call', () => {
    const { install } = harness({});
    expect(install.name()).toBe('SkillMarketInstallToolExecutor');
    expect(['builtin-skill_market_verify', 'skill_market_download_and_scan', 'skill_market_search'].map(name => install.canHandle(name)))
      .toEqual([true, true, false]);
    expect([install.sensitivityLevel('skill_market_verify'), install.concurrencyClass('skill_market_verify')]).toEqual(['low', 'read_only']);
    expect([install.sensitivityLevel('builtin-skill_market_download_and_scan'), install.concurrencyClass('skill_market_download_and_scan')])
      .toEqual(['high', 'serial']);
    expect([
      install.sensitivityLevelForCall('skill_market_download_and_scan', { install: false }),
      install.sensitivityLevelForCall('skill_market_download_and_scan', { install: 'true' }),
      install.sensitivityLevelForCall('skill_market_download_and_scan', { install: true }),
      install.sensitivityLevelForCall('skill_market_verify', {}),
    ]).toEqual(['medium', 'medium', 'high', 'low']);
    expect([install.hasDynamicSensitivity('skill_market_download_and_scan'), install.hasDynamicSensitivity('skill_market_verify')])
      .toEqual([true, false]);
  });

  it('verify passes the trimmed slug and optional version', async () => {
    const h = harness({ marketVerify: async () => ({ ok: true }) as never });
    expect(await h.run(h.install, 'skill_market_verify', { slug: ' a ', version: '  ' })).toMatchObject({ success: true, output: { ok: true } });
    expect(h.calls).toEqual([['marketVerify', 'a', null]]);
  });

  it('scan-only download adds skill_id and the review next_step; install adds the trust next_step', async () => {
    const scanned = { slug: 'a', version: '1.0.0', installed: false, temp_zip_path: '/t.zip', scan: { skill_id: 'skill-a', risk_level: 'low' } };
    const h = harness({ marketDownloadAndScan: async (...args: unknown[]) => (args[2] === true ? { ...scanned, installed: true } : scanned) as never });
    const scan = await h.run(h.install, 'skill_market_download_and_scan', { slug: 'a', version: '1.0.0', expected_package_sha256: ' abc ' });
    expect(h.calls[0]).toEqual(['marketDownloadAndScan', 'a', '1.0.0', null, null, 'abc', null, null]);
    expect(Object.keys(scan.output as object)).toEqual([...Object.keys(scanned), 'skill_id', 'next_step']);
    expect(scan.output).toMatchObject({ skill_id: 'skill-a',
      next_step: expect.stringMatching(/^Review scan\.risk_level\/risk_signals .* do not use shell or ask for a duplicate text confirmation\.$/) });

    const installed = await h.run(h.install, 'skill_market_download_and_scan', { slug: 'a', install: true, overwrite: true,
      expectedPackageSha256: 'sha', tempZipPath: '/t.zip', declaredRiskLevel: 'low' });
    expect(h.calls[1]).toEqual(['marketDownloadAndScan', 'a', null, true, true, 'sha', '/t.zip', 'low']);
    expect(installed.output).toMatchObject({ installed: true, skill_id: 'skill-a', next_step: POST_WRITE_TRUST_NEXT_STEP });
  });

  it('failures keep the structured command error and return the terminal workflow output', async () => {
    const h = harness({ marketDownloadAndScan: async () => { throw ioError('download failed'); } });
    const failed = await h.run(h.install, 'skill_market_download_and_scan', { slug: 'a', install: null });
    const commandError = JSON.stringify({ code: 'IO_ERROR', message: 'IO error: download failed' });
    expect(failed).toMatchObject({ success: false, error: commandError, output: { status: 'error', slug: 'a', install: null,
      terminal_for_skill_workflow: true,
      next_step: "Stop this candidate skill's workflow and report the error truthfully. Do not retry the same call, substitute shell/web tools, or claim installation success." } });
    expect(h.events.at(-1)).toEqual(['error', commandError]);

    const missing = await h.run(h.install, 'skill_market_verify', {});
    expect(missing).toMatchObject({ success: false, error: 'slug is required', output: { slug: null, install: false } });
    expect(h.saved).toHaveLength(2);
  });
});
