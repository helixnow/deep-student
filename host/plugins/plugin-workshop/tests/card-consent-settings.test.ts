// The film's interaction at the Host level: a proposal is only a card; 开始做 (with the values the card asked for)
// starts generation; progress is visible; a calendar address is checked for real; the Host does the version and
// net:<host> bookkeeping of a modification instead of the Agent.
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { AppInfo } from '../../../kernel/api.ts';
import { WorkshopOperations } from '../src/operations.ts';
import { WorkshopCatalog } from '../src/catalog.ts';
import { WorkshopToolExecutor } from '../src/tools.ts';
import { recipeFiles, recipeFor } from '../src/resources.ts';
import { writeSourceFiles } from '../src/source.ts';
import { fillSettings, nextPatch, normalizeWorkshopSource, versionGreater } from '../src/settings.ts';
import { streamedPaths } from '../src/generation.ts';

const settings = [{ key: 'calendarUrl', title: '课表日历地址（.ics）', kind: 'ics-url' as const }];
const brief = { sessionId: 'owner', title: '查课表', description: '说「查课表」列出今天的课', template: 'host-tool' as const, changes: [], capabilities: [], settings };
const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n';

async function setup() {
  const ops = new WorkshopOperations({ dataDir: await mkdtemp(join(tmpdir(), 'workshop-consent-')), version: '0.20.1', debug: true } as AppInfo);
  const tools = new WorkshopToolExecutor(ops, new WorkshopCatalog(() => []));
  const { files } = await recipeFiles('host-tool');
  const seen: string[][] = [];
  ops.bindGeneration({ async generate(_card, source, _signal, progress) {
    progress?.(['package.json']);
    progress?.(['package.json', 'index.ts']);
    seen.push(['package.json', 'index.ts']);
    await writeSourceFiles(source, Object.entries(files).map(([path, content]) => ({ path, content })));
  } });
  return { ops, tools, seen };
}
async function terminal(ops: WorkshopOperations, id: string) {
  await vi.waitFor(async () => expect((await ops.status(id)).state).not.toBe('generating'), { timeout: 10_000 });
  return ops.status(id);
}

it('starts only from 开始做 with the values the card asked for, reads the calendar once and derives net:<host>', async () => {
  const { ops, tools } = await setup();
  const read = vi.fn(async () => ({ status: 200, ok: true, text: ics }));
  ops.bindLinkReader(read);
  const card = await tools.invoke('dstu_plugin_propose_install', brief, 'owner') as Awaited<ReturnType<WorkshopOperations['status']>>;
  expect(card).toMatchObject({ state: 'draft', generationApproved: false, settings });
  // Missing / unusable address: refused before anything runs.
  await expect(ops.create(card.id, card.revision, {})).rejects.toThrow('WORKSHOP_SETTING_MISSING');
  await expect(ops.create(card.id, card.revision, { calendarUrl: 'http://jw.example.edu.cn/a.ics' })).rejects.toThrow('only https://');
  // The remote call context lands in the same argument when the UI sends no values: it is ignored, not an error source.
  await expect(ops.create(card.id, card.revision, { signal: new AbortController().signal })).rejects.toThrow('WORKSHOP_SETTING_MISSING');
  const started = await ops.create(card.id, card.revision, { calendarUrl: ' https://jw.school.edu.cn/cal/me.ics ' });
  expect(started).toMatchObject({ state: 'generating', generationApproved: true, settings: [{ ...settings[0], value: 'https://jw.school.edu.cn/cal/me.ics' }] });
  // While the Host generates, an Agent edit is refused instead of aborting it.
  await expect(tools.invoke('dstu_plugin_write_source', { id: card.id, revision: started.revision, files: [] }, 'owner')).rejects.toThrow('generating');
  const ready = await terminal(ops, card.id);
  expect(ready.state, ready.error ?? '').toBe('pending-confirmation');
  expect(read).toHaveBeenCalledExactlyOnceWith('https://jw.school.edu.cn/cal/me.ics', expect.any(AbortSignal));
  // The placeholder host of the recipe is replaced by the user's real one.
  expect(ready.declared).toEqual(['让 AI 助手学会新本事「查课表」', '联网读取 jw.school.edu.cn（只读，仅限这个域名）']);
  expect(ready).toMatchObject({ buildStage: null, buildStep: null, buildFiles: null });
  ops.dispose();
});

it('fails before writing code when the address is not a calendar, and lets the user fix it on the card', async () => {
  const { ops, seen } = await setup();
  ops.bindLinkReader(async () => ({ status: 200, ok: true, text: '<html>login</html>' }));
  const card = await ops.propose(brief);
  await ops.create(card.id, card.revision, { calendarUrl: 'https://jw.school.edu.cn/login' });
  const failed = await terminal(ops, card.id);
  expect(failed.state).toBe('failed');
  expect(failed.error).toMatch(/^WORKSHOP_LINK: .*BEGIN:VCALENDAR/);
  expect(seen).toEqual([]);
  // 改好了，再试一次: a failed work starts again with the corrected address.
  ops.bindLinkReader(async () => ({ status: 200, ok: true, text: ics }));
  await ops.create(failed.id, failed.revision, { calendarUrl: 'https://jw.school.edu.cn/cal.ics' });
  expect((await terminal(ops, card.id)).state).toBe('pending-confirmation');
  ops.dispose();
});

it('records progress: files written so far, then compile and test load', async () => {
  const { ops } = await setup();
  ops.bindLinkReader(async () => ({ status: 200, ok: true, text: ics }));
  const ticks: unknown[] = [];
  const progress = ops.store.progress.bind(ops.store);
  vi.spyOn(ops.store, 'progress').mockImplementation(async (id, patch) => { ticks.push(patch); return progress(id, patch); });
  const card = await ops.propose(brief);
  await ops.create(card.id, card.revision, { calendarUrl: 'https://jw.school.edu.cn/cal.ics' });
  await terminal(ops, card.id);
  expect(ticks).toEqual(expect.arrayContaining([
    { buildStage: 'checking', buildStep: 'link' },
    { buildStage: 'making', buildStep: null, buildFiles: [] },
    { buildFiles: ['package.json'] },
    { buildFiles: ['package.json', 'index.ts'] },
    { buildStage: 'checking', buildStep: 'compile' },
    { buildStep: 'load' },
  ]));
  ops.dispose();
});

it('bumps the version of a modification itself (package and modules together) instead of failing a repair round', async () => {
  const source = await mkdtemp(join(tmpdir(), 'workshop-version-'));
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', deepStudent: { id: 'workshop.plugin-x' } }));
  await writeFile(join(source, 'index.ts'), "export default { meta: { id: 'workshop.plugin-x', version: '1.0.0' } };");
  await writeFile(join(source, 'ui.tsx'), 'export default { meta: { id: "workshop.plugin-x", version: "1.0.0", host: true } };');
  expect(await normalizeWorkshopSource(source, { previousVersion: '1.0.0' })).toEqual({ version: '1.0.1', added: [] });
  expect(JSON.parse(await readFile(join(source, 'package.json'), 'utf8')).version).toBe('1.0.1');
  expect(await readFile(join(source, 'index.ts'), 'utf8')).toContain("version: '1.0.1'");
  expect(await readFile(join(source, 'ui.tsx'), 'utf8')).toContain('version: "1.0.1"');
  // A version the model already raised is kept.
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'x', version: '1.2.0' }));
  expect(await normalizeWorkshopSource(source, { previousVersion: '1.0.0' })).toEqual({ added: [] });
  expect([versionGreater('1.0.10', '1.0.9'), versionGreater('1.0.0', '1.0.0'), nextPatch('2.3.4')]).toEqual([true, false, '2.3.5']);
});

it('validates proposal settings and picks the recipe closest to the request', () => {
  expect(() => fillSettings(settings, { calendarUrl: 'https://user:pw@a.edu.cn/x.ics' })).toThrow('user name or password');
  expect(fillSettings([{ key: 'name', title: '名字', kind: 'text', value: '小明' }], {})).toEqual([{ key: 'name', title: '名字', kind: 'text', value: '小明' }]);
  const base = { template: 'learning-tool' as const, changes: [] };
  expect(recipeFor({ ...base, title: '公式速查', description: '按名称搜索常用公式' })).toBe('reference-app');
  expect(recipeFor({ ...base, title: '编成口诀', description: '选中一段话时多一个按钮' })).toBe('selection-model');
  expect(recipeFor({ ...base, template: 'host-tool', title: '查课表', description: '读日历' })).toBe('agent-tool');
  expect(streamedPaths('{"files":[{"path":"package.json","content":"{\\"a\\":1}"},{"path":"index.ts","con')).toEqual(['package.json', 'index.ts']);
});

it('refuses credential-like or malformed setting keys in a proposal', async () => {
  const { ops } = await setup();
  await expect(ops.propose({ ...brief, settings: [{ key: 'apiToken', title: 't', kind: 'text' }] })).rejects.toThrow('credentials only as kind "secret"');
  await expect(ops.propose({ ...brief, settings: [{ key: 'url', title: 'u', kind: 'ftp' as never }] })).rejects.toThrow('kind');
});
