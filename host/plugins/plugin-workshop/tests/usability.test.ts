import { mkdtemp, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkshopOperations } from '../src/operations.ts';
import { WorkshopCatalog } from '../src/catalog.ts';
import { WorkshopToolExecutor } from '../src/tools.ts';
import { looksTruncated, materializeGeneratedFiles } from '../src/generation.ts';
import { proposalEstimate } from '../src/store.ts';

const app = async (name: string) => ({ dataDir: await mkdtemp(join(tmpdir(), `dstu-usability-${name}-`)), version: '0.20.0', platform: 'darwin' as const, debug: true });
const brief = { title: '番茄钟', description: '25 分钟专注计时，到点响铃', template: 'learning-tool' as const, changes: ['开始 / 暂停'], capabilities: [] };

describe('F13 / F15 / F14 proposal facts', () => {
  it('keeps limits, alternatives and the built-in difference, and estimates the time', async () => {
    const ops = new WorkshopOperations(await app('feasibility'));
    const tools = new WorkshopToolExecutor(ops, new WorkshopCatalog(() => []));
    const card = await tools.invoke('dstu_plugin_propose_install', { ...brief,
      limits: ['  复习界面里没有放按钮的位置  ', 3], alternatives: ['放到状态栏'], builtinDifference: '内置专注计时只计时；这个会把番茄数记进学习记录' }, 'A') as Record<string, unknown>;
    expect(card).toMatchObject({ limits: ['复习界面里没有放按钮的位置'], alternatives: ['放到状态栏'],
      builtinDifference: '内置专注计时只计时；这个会把番茄数记进学习记录', estimate: { minMinutes: 1, maxMinutes: 3 }, generation: null });
    const schema = (tools.schemaTools().find(tool => tool.id === 'dstu_plugin_propose_install')!.schema as { function: { parameters: unknown } }).function.parameters as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(['limits', 'alternatives', 'builtinDifference']));
  });

  it('estimates more time for an app view and a long request', () => {
    expect(proposalEstimate({ ...brief, title: '公式速查', description: '公式速查小应用，列表和搜索', changes: [] })).toEqual({ minMinutes: 2, maxMinutes: 4 });
    expect(proposalEstimate({ ...brief, template: 'host-tool', changes: [] })).toEqual({ minMinutes: 1, maxMinutes: 2 });
    expect(proposalEstimate({ ...brief, changes: ['a', 'b', 'c', 'd', 'e', 'f'] })).toEqual({ minMinutes: 2, maxMinutes: 5 });
  });

  it('records the time and tokens of a generation run', async () => {
    const ops = new WorkshopOperations(await app('stats'));
    ops.bindGeneration({ generate: async () => { throw new Error('WORKSHOP_INVALID: nope'); } });
    const card = await ops.propose({ ...brief, sessionId: 'A' });
    await ops.create(card.id, card.revision);
    let done = await ops.status(card.id);
    for (let i = 0; i < 100 && done.state === 'generating'; i++) { await new Promise(resolve => setTimeout(resolve, 20)); done = await ops.status(card.id); }
    expect(done.state).toBe('failed');
    expect(done.generation).toMatchObject({ attempts: 3 });
    expect(typeof done.generation?.durationMs).toBe('number');
    expect(done.generation?.tokens).toBeUndefined();
  });
});

describe('F7 truncated answers and the minimal version', () => {
  it('detects an answer that was cut off', async () => {
    expect(looksTruncated('{"files":[{"path":"index.ts","content":"export default {', new SyntaxError('Unterminated string in JSON'))).toBe(true);
    expect(looksTruncated('{"files":[{"path":"a","content":"x"}', null)).toBe(true);
    expect(looksTruncated('not json at all', null)).toBe(false);
    const source = join(await mkdtemp(join(tmpdir(), 'dstu-usability-trunc-')), 'source');
    await mkdir(source);
    await expect(materializeGeneratedFiles(source, '{"files":[{"path":"index.ts","content":"export default', new AbortController().signal))
      .rejects.toThrow(/^WORKSHOP_TRUNCATED:/);
  });

  it('re-proposes a failed work as a minimal version of its core', async () => {
    const ops = new WorkshopOperations(await app('reduce'));
    const card = await ops.propose({ ...brief, sessionId: 'A', changes: ['开始 / 暂停', '统计图', '导出'] });
    const failed = await ops.store.update(card.id, card.revision, { state: 'failed', error: 'WORKSHOP_TRUNCATED: cut off' });
    const reduced = await ops.reduce(failed.id, failed.revision);
    expect(reduced).toMatchObject({ id: card.id, state: 'draft', changes: ['开始 / 暂停', '只保留这一项，其余功能以后再加'] });
    expect(reduced.description).toMatch(/^最小版：只做最核心的一件事——开始 \/ 暂停/);
    // Reducing again does not stack the prefix.
    const again = await ops.reduce(reduced.id, reduced.revision);
    expect(again.description.match(/最小版/g)).toHaveLength(1);
  });
});
