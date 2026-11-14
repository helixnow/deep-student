import { mkdtemp, mkdir, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { HostRuntime } from '../../../kernel/runtime.ts';
import { ContractSet } from '../../../kernel/contract-set.ts';
import { PluginAdmin } from '../../../kernel/plugin-admin.ts';
import { UserProfileStore } from '../../../kernel/profile-store.ts';
import { CommunityConsentLedger } from '../../../kernel/community-consent.ts';
import { PluginPackages } from '../../../kernel/plugin-packages/index.ts';
import { createNodeFiles } from '../../../platform/files/index.ts';
import type { PluginManagerInventory } from '../../../kernel/api.ts';
import { WorkshopOperations } from '../src/operations.ts';
import { seedTemplate } from '../src/resources.ts';
import { injectedInstaller } from './installer-fixture.ts';

it('RF-P3-workshop-tools: installs through P1 real ZIP/consent/profile transaction; revoke and cross-Host restore retain source without model', async () => {
  await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
  const dataDir = await realpath(await mkdtemp(join(process.cwd(), '.tmp', 'dstu-managed-e2e-')));
  await mkdir(join(dataDir, 'plugins'), { recursive: true });
  const official = join(dataDir, 'official.json');
  await writeFile(official, '{"plugins":[]}');
  const app = { dataDir, version: '0.20.0', platform: 'darwin' as const, debug: true };
  const files = createNodeFiles({ roots: [{ name: 'appData', path: dataDir }] });
  const packages = new PluginPackages(files.scope(join(dataDir, 'plugins')));
  const consent = new CommunityConsentLedger(dataDir);
  const profile = new UserProfileStore(join(dataDir, 'plugins/user.profile.json'), official);
  let runtime = new HostRuntime({ app, contracts: new ContractSet([]) });
  const bind = async () => {
    const admin = new PluginAdmin({ runtime, store: profile, official, consent, files, packages }); admin.register();
    const invoke = async <T>(cmd: string, args = {}): Promise<T> => {
      const result = await runtime.dispatchInvoke({ id: `test-${Math.random()}`, cmd, args, source: { window: 'main', webview: 'main' } });
      if (result.kind !== 'ok') throw new Error(JSON.stringify(result));
      return result.value as T;
    };
    const ops = new WorkshopOperations(app);
    ops.bindAdmin(await injectedInstaller(runtime));
    return { ops, invoke };
  };
  let { ops, invoke } = await bind();
  const generation = vi.fn(async (card, source) => seedTemplate(source, card));
  ops.bindGeneration({ generate: generation });
  const card = await ops.propose({ sessionId: 'test', title: 'Recall', description: 'Practice', template: 'host-tool', changes: [], capabilities: [] });
  try {
    await ops.create(card.id, card.revision);
    await vi.waitFor(async () => expect((await ops.status(card.id)).state).toBe('pending-confirmation'), { timeout: 5000 });
    const pending = await ops.status(card.id);
    const installed = await ops.install(card.id, pending.revision);
    expect((await packages.list())[0]?.id).toBe(card.pluginId);
    expect((await consent.read())[0]).toMatchObject({ id: card.pluginId, trust: 'full', source: 'workshop' });
    const inv = await invoke<PluginManagerInventory>('plugin:manager|list');
    expect(inv.plugins.find(item => item.id === card.pluginId)).toMatchObject({ enabled: true, trust: 'full', source: 'workshop' });
    const revoked = await ops.revoke(card.id, installed.revision);
    expect((await packages.list())).toEqual([]);
    await runtime.dispose();
    runtime = new HostRuntime({ app, contracts: new ContractSet([]) });
    ({ ops, invoke } = await bind());
    await ops.ready();
    const restored = await ops.restore(card.id, revoked.revision);
    expect(restored.state).toBe('installed');
    expect((await packages.verify(card.pluginId)).version).toBe('1.0.0');
    expect(generation).toHaveBeenCalledTimes(1);
  } finally { await runtime.dispose(); }
}, 20_000);
