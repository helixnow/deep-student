// The installed version and the proposal in progress are separate: a modification starts from the version in use
// (F1), turning it down never touches what is installed (F3), export packs the approved installed version (F4), a new
// proposal replaces the conversation's un-started drafts and abandoned works can be deleted (F6), environment errors
// stop at once (F18), and settings the card asked for become an editable plugin Config (F10).
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import type { AppInfo, HostPlugin } from '../../../kernel/api.ts';
import { projectConfigSchema } from '../../../kernel/config-schema.ts';
import { withDeclaredSettings } from '../../../kernel/plugin-config.ts';
import { WorkshopOperations, type WorkshopAdmin } from '../src/operations.ts';
import { seedTemplate } from '../src/resources.ts';
import { normalizeWorkshopSource } from '../src/settings.ts';
import { expectedPlaces, installationOf } from '../src/store.ts';
import type { WorkshopCard } from '../api.ts';

const brief = { sessionId: 'chat', title: 'Recall', description: 'Practice', template: 'host-tool' as const, changes: [], capabilities: [] };

async function setup() {
  const ops = new WorkshopOperations({ version: '0.20.0', dataDir: await mkdtemp(join(tmpdir(), 'dstu-lifecycle-')), debug: true } as AppInfo);
  /** What the next generation appends to index.ts, and what index.ts looked like when each generation started. */
  const plan = { mark: '', fail: false };
  const seen: string[] = [];
  const generate = vi.fn(async (card: WorkshopCard, source: string) => {
    if ((await readdir(source)).length === 0) await seedTemplate(source, card);
    const index = join(source, 'index.ts');
    const before = await readFile(index, 'utf8');
    seen.push(before);
    if (plan.mark) await writeFile(index, `${before}\n// ${plan.mark}\n`);
    if (plan.fail) throw new Error('WORKSHOP_INVALID: model output broke');
  });
  ops.bindGeneration({ generate });
  let present = false;
  const uninstall = vi.fn(async () => { present = false; return null; });
  const admin: WorkshopAdmin = {
    inventory: async () => ({ revision: 'r', safeMode: false, plugins: present ? [{ id: `workshop.plugin-x`, enabled: true, state: 'running', version: '1.0.0' }] : [] }) as never,
    installManagedDirectory: async request => { present = true; return { id: request.id, version: request.version, enabled: true, revision: 'next', rollback: 'not-needed' } as never; },
    uninstall,
  };
  // Inventory entries are keyed by the real plugin id once a work exists.
  const bind = (card: WorkshopCard) => ops.bindAdmin({ ...admin, inventory: async () => ({ revision: 'r', safeMode: false,
    plugins: present ? [{ id: card.pluginId, enabled: true, state: 'running', version: '1.0.0' }] : [] }) as never });
  return { ops, plan, seen, generate, uninstall, bind };
}
async function terminal(ops: WorkshopOperations, id: string) {
  await vi.waitFor(async () => { expect((await ops.status(id)).state).not.toBe('generating'); }, { timeout: 10_000 });
  return ops.status(id);
}
async function installV1() {
  const context = await setup();
  const { ops, bind } = context;
  let card = await ops.propose(brief);
  bind(card);
  await ops.create(card.id, card.revision);
  card = await terminal(ops, card.id);
  expect(card.state, card.error ?? '').toBe('pending-confirmation');
  card = await ops.install(card.id, card.revision);
  expect(card.state).toBe('installed');
  expect(installationOf(card)).toMatchObject({ state: 'installed', version: '1.0.0' });
  return { ...context, card };
}

describe('workshop lifecycle state', () => {
  it('F1: a modification starts from the installed version; the old draft is kept; only a failed attempt is continued', async () => {
    const { ops, plan, seen, card: v1 } = await installV1();
    const installedSource = await readFile(join(ops.store.directory(v1.id), 'versions', '1.0.0', 'source', 'index.ts'), 'utf8');
    // A modification that the user turns down leaves its code in source/.
    plan.mark = 'leftover-of-turned-down-change';
    let card = await ops.propose({ ...brief, pluginId: v1.pluginId, changes: ['change A'] });
    await ops.create(card.id, card.revision);
    card = await terminal(ops, card.id);
    card = await ops.cancel(card.id, card.revision);
    // The next modification does not see it: it starts from what is installed.
    plan.mark = 'attempt-of-change-B';
    plan.fail = true;
    card = await ops.propose({ ...brief, pluginId: v1.pluginId, changes: ['change B'] });
    const draftRevision = card.revision;
    await ops.create(card.id, card.revision);
    card = await terminal(ops, card.id);
    expect(card.state).toBe('failed');
    expect(seen.at(-3)).toBe(installedSource);
    expect(seen.at(-3)).not.toContain('leftover-of-turned-down-change');
    const kept = await readFile(join(ops.store.directory(v1.id), 'drafts', String(draftRevision), 'index.ts'), 'utf8');
    expect(kept).toContain('leftover-of-turned-down-change');
    // 「让 AI 接着修」/「继续做」 on the failed attempt continues where it stopped.
    plan.fail = false;
    plan.mark = '';
    await ops.create(card.id, card.revision);
    await terminal(ops, card.id);
    expect(seen.at(-1)).toContain('attempt-of-change-B');
  });

  it('F3: turning down a modification keeps v1 installed; uninstall and restore act on the installed version only', async () => {
    const { ops, uninstall, card: v1 } = await installV1();
    let card = await ops.propose({ ...brief, pluginId: v1.pluginId, changes: ['v2'] });
    expect(card.proposalRevision).toBe(card.revision);
    expect(installationOf(card)).toMatchObject({ state: 'installed', version: '1.0.0' });
    card = await ops.cancel(card.id, card.revision);
    expect(card.state).toBe('cancelled');
    expect(card.installation).toMatchObject({ state: 'installed', version: '1.0.0' });
    // 卸载 no longer fails with "cannot act in cancelled".
    card = await ops.revoke(card.id, card.revision);
    expect(uninstall).toHaveBeenCalledTimes(1);
    expect(card.installation).toMatchObject({ state: 'revoked', version: '1.0.0' });
    card = await ops.restore(card.id, card.revision);
    expect(card.state).toBe('installed');
    expect(card.installation).toMatchObject({ state: 'installed', version: '1.0.0' });
    // Uninstalling while a new proposal waits keeps the proposal (its own state) and marks only the installation.
    card = await ops.propose({ ...brief, pluginId: v1.pluginId, changes: ['v3'] });
    card = await ops.revoke(card.id, card.revision);
    expect(card.state).toBe('draft');
    expect(card.installation?.state).toBe('revoked');
  });

  it('F3: records written before the split get their installed version derived once', async () => {
    const { ops, card: v1 } = await installV1();
    const file = join(ops.store.directory(v1.id), 'workshop.json');
    const legacy = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    delete legacy.installation; delete legacy.proposalRevision;
    await writeFile(file, JSON.stringify({ ...legacy, state: 'cancelled', version: null, previousVersion: '1.0.0' }));
    const migrated = await ops.status(v1.id);
    expect(migrated.installation).toMatchObject({ state: 'installed', version: '1.0.0' });
    expect((await ops.revoke(v1.id, migrated.revision)).installation?.state).toBe('revoked');
  });

  it('F4: export packs the approved installed version, not the edited source, under a readable name', async () => {
    const { ops, plan, card: v1 } = await installV1();
    plan.mark = 'unapproved-change';
    let card = await ops.propose({ ...brief, pluginId: v1.pluginId, changes: ['v2'] });
    await ops.create(card.id, card.revision);
    card = await terminal(ops, card.id);
    expect(await readFile(join(ops.store.directory(v1.id), 'source', 'index.ts'), 'utf8')).toContain('unapproved-change');
    const exported = await ops.export(card.id);
    expect(exported).toMatchObject({ version: '1.0.0', fileName: 'Recall-v1.0.0.dstuplugin' });
    const zip = await JSZip.loadAsync(await readFile(exported.path));
    const packaged = await readFile(join(ops.store.directory(v1.id), 'versions', '1.0.0', 'package', 'dist', 'host.js'), 'utf8');
    expect(await zip.file('dist/host.js')!.async('string')).toBe(packaged);
    expect(JSON.parse(await zip.file('package.json')!.async('string')).version).toBe('1.0.0');
  });

  it('F6: a new proposal supersedes the conversation\'s un-started drafts; never-installed works can be deleted', async () => {
    const { ops, card: installed } = await installV1();
    const first = await ops.propose({ ...brief, title: 'First idea' });
    const other = await ops.propose({ ...brief, title: 'Other chat', sessionId: 'another' });
    const second = await ops.propose({ ...brief, title: 'Second idea' });
    expect((await ops.status(first.id)).state).toBe('superseded');
    expect((await ops.status(other.id)).state).toBe('draft');
    expect((await ops.status(second.id)).state).toBe('draft');
    const directory = ops.store.directory(first.id);
    const superseded = await ops.status(first.id);
    await ops.discard(first.id, superseded.revision);
    await expect(stat(directory)).rejects.toThrow();
    await expect(ops.status(first.id)).rejects.toThrow('WORKSHOP_NOT_FOUND');
    const current = await ops.status(installed.id);
    await expect(ops.discard(installed.id, current.revision)).rejects.toThrow('WORKSHOP_STATE');
  });

  it('F18: an environment problem stops generation after the first round instead of three repair rounds', async () => {
    const { ops, generate } = await setup();
    generate.mockImplementation(async () => { throw new Error('SAFE_MODE_ACTIVE: workshop lifecycle is disabled'); });
    const card = await ops.propose(brief);
    await ops.create(card.id, card.revision);
    const failed = await terminal(ops, card.id);
    expect(failed.state).toBe('failed');
    expect(failed.error).toContain('SAFE_MODE_ACTIVE');
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('F10: settings the card asked for are declared in the manifest and become an editable Config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dstu-settings-'));
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', deepStudent: { id: 'workshop.plugin-x', permissions: [] } }));
    const settings = [{ key: 'calendarUrl', title: '课表日历地址（.ics）', kind: 'ics-url' as const, value: 'https://school.example.edu/a.ics' }];
    await normalizeWorkshopSource(dir, { previousVersion: null, settings });
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    expect(pkg.deepStudent.settings).toEqual([{ key: 'calendarUrl', title: '课表日历地址（.ics）', kind: 'ics-url' }]);
    const bare: HostPlugin<any> = { name: 'x', meta: { id: 'workshop.plugin-x' }, apply() {} };
    const plugin = withDeclaredSettings(bare, { settings: pkg.deepStudent.settings });
    const projection = projectConfigSchema(plugin.Config);
    expect(projection?.fields.map(field => field.path)).toEqual(['calendarUrl']);
    // A plugin with its own Config keeps it.
    const own: HostPlugin<any> = { name: 'y', meta: { id: 'y.y' }, Config: plugin.Config, apply() {} };
    expect(withDeclaredSettings(own, { settings: [] })).toBe(own);
  });

  it('F9: before anything is built, the place is the recipe expectation (no guess for a Host-only tool)', () => {
    expect(expectedPlaces({ template: 'learning-tool', title: '编成口诀', description: '选中一段话时多一个按钮', changes: [] })).toEqual([{ kind: 'selectionButton' }]);
    expect(expectedPlaces({ template: 'learning-tool', title: '公式速查', description: '搜索公式', changes: [] })).toEqual([{ kind: 'app', title: '公式速查' }]);
    expect(expectedPlaces({ template: 'learning-tool', title: '每日回忆', description: 'A daily recall helper', changes: [] })).toEqual([{ kind: 'app', title: '每日回忆' }]);
    expect(expectedPlaces({ template: 'host-tool', title: '查课表', description: '以后我说查课表', changes: [] })).toEqual([]);
  });
});
