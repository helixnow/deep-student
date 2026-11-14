import { mkdtemp, readFile, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { AppInfo } from '../../../kernel/api.ts';
import { WorkshopOperations } from '../src/operations.ts';
import { WorkshopCatalog } from '../src/catalog.ts';
import { WorkshopToolExecutor } from '../src/tools.ts';
import { seedTemplate } from '../src/resources.ts';

const brief = { sessionId: 'owner', title: 'Recall', description: 'Practice', template: 'host-tool' as const, changes: [], capabilities: [] };
async function setup() {
  const ops = new WorkshopOperations({ dataDir: await mkdtemp(join(tmpdir(), 'autonomous-workshop-')), version: '0.20.0' } as AppInfo);
  const tools = new WorkshopToolExecutor(ops, new WorkshopCatalog(() => []));
  return { ops, tools };
}
async function terminal(ops: WorkshopOperations, id: string) {
  await vi.waitFor(async () => expect((await ops.status(id)).state).not.toBe('generating'), { timeout: 5000 });
  return ops.status(id);
}

it('autonomously repairs compiler then apply errors and stages one frozen confirmation', async () => {
  const { ops, tools } = await setup();
  const diagnostics: string[] = [];
  let original = '';
  ops.bindGeneration({ async generate(card, source) {
    diagnostics.push(card.error ?? '');
    if (diagnostics.length === 1) {
      await seedTemplate(source, card);
      original = await readFile(join(source, 'index.ts'), 'utf8');
      await writeFile(join(source, 'index.ts'), 'export default {');
    } else if (diagnostics.length === 2) {
      await writeFile(join(source, 'index.ts'), original.replace('ctx.provide(', "throw new Error('exact-apply-failure'); ctx.provide("));
    } else await writeFile(join(source, 'index.ts'), original);
  } });
  const card = await tools.invoke('dstu_plugin_propose_install', { ...brief, autoGenerate: true }, 'owner') as { id: string };
  const ready = await terminal(ops, card.id);
  expect(ready.state).toBe('pending-confirmation');
  expect(ready.buildAttempt).toBe(3);
  expect(diagnostics[1]).toContain('Expected');
  expect(diagnostics[2]).toContain('exact-apply-failure');
  await expect(tools.invoke('dstu_plugin_write_source', { id: card.id, revision: ready.revision, files: [{ path: 'index.ts', content: 'changed' }] }, 'owner')).rejects.toThrow('cannot act');
  ops.dispose();
});

it('bounds repair failures without touching the last working package pointer', async () => {
  const { ops } = await setup();
  let card = await ops.propose(brief);
  card = await ops.store.write({ ...card, previousVersion: '1.0.0', usableVersion: '1.0.0', lastGoodPackageDir: '/retained/package' });
  const generate = vi.fn(async () => { throw new Error('invalid JSON from model'); });
  ops.bindGeneration({ generate });
  await ops.create(card.id, card.revision);
  const failed = await terminal(ops, card.id);
  expect(generate).toHaveBeenCalledTimes(3);
  expect(failed).toMatchObject({ state: 'failed', usableVersion: '1.0.0', lastGoodPackageDir: '/retained/package', error: 'invalid JSON from model' });
});

it('scopes source edits and diagnostics to conversation and rejects links/traversal before writing', async () => {
  const { ops, tools } = await setup();
  let card = await ops.propose(brief);
  const args = { id: card.id, revision: card.revision, files: [{ path: 'index.ts', content: 'hello' }] };
  await expect(tools.invoke('dstu_plugin_write_source', args, 'other')).rejects.toThrow('another conversation');
  card = await tools.invoke('dstu_plugin_write_source', args, 'owner') as typeof card;
  await expect(tools.invoke('dstu_plugin_diagnose', { id: card.id }, 'other')).rejects.toThrow('another conversation');
  expect(await tools.invoke('dstu_plugin_diagnose', { id: card.id }, 'owner')).toMatchObject({ files: [{ path: 'index.ts', content: 'hello' }] });
  const source = join(ops.store.directory(card.id), 'source');
  await expect(ops.writeSource(card.id, card.revision, [{ path: '../user.profile.json', content: '{}' }])).rejects.toThrow('outside source');
  await symlink(join(source, 'index.ts'), join(source, 'linked.ts'));
  await expect(ops.writeSource(card.id, card.revision, [{ path: 'linked.ts', content: 'bad' }])).rejects.toThrow('links');
  expect(await readFile(join(source, 'index.ts'), 'utf8')).toBe('hello');
});

it('isolates a UI-faulty release and automatically restores an earlier approved source snapshot', async () => {
  const { ops } = await setup();
  let card = await ops.propose(brief);
  ops.bindGeneration({ generate: (card, source) => seedTemplate(source, card) });
  await ops.create(card.id, card.revision);
  card = await terminal(ops, card.id);
  const isolateManaged = vi.fn(async () => null), activateManaged = vi.fn(async () => null);
  const installManagedDirectory = vi.fn(async (request: { id: string; version: string }) => ({
    id: request.id, version: request.version, enabled: false as const, revision: 'next', rollback: 'not-needed' as const,
    consentRequired: { code: 'CONSENT_REQUIRED' as const, id: request.id, version: request.version, permissions: [] },
  }));
  ops.bindAdmin({ inventory: async () => ({ safeMode: false, revision: 'revision', plugins: [] }), installManagedDirectory, activateManaged, isolateManaged, uninstall: async () => null });
  card = await ops.install(card.id, card.revision);
  card = await ops.store.write({ ...card, version: '2.0.0', previousVersion: '1.0.0' });
  const recovered = await ops.reportFault(card.id, 'UI_ERROR_BUDGET: render failed');
  expect(isolateManaged).toHaveBeenCalledWith(card.pluginId);
  expect(recovered).toMatchObject({ state: 'installed', version: '1.0.0', rollback: 'restored' });
  expect(installManagedDirectory).toHaveBeenCalledTimes(2);
  expect(activateManaged).toHaveBeenCalledTimes(2);
});
