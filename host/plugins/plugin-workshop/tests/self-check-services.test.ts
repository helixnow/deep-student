import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { WorkshopOperations } from '../src/operations.ts';
import { seedTemplate } from '../src/resources.ts';
import { HostRuntime } from '../../../kernel/runtime.ts';
import { ContractSet } from '../../../kernel/contract-set.ts';
import { PluginAdmin } from '../../../kernel/plugin-admin.ts';
import { UserProfileStore } from '../../../kernel/profile-store.ts';
import { CommunityConsentLedger } from '../../../kernel/community-consent.ts';
import { injectedInstaller } from './installer-fixture.ts';

it('B7 self-checks a full work using actual app services and still rejects kernel-only dependencies', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dstu-selfcheck-services-'));
  const ops = new WorkshopOperations({ dataDir, version: '0.20.0', platform: 'darwin', debug: true });
  const card = await ops.propose({ sessionId: 'test', title: 'Test', description: 'Test', template: 'host-tool', changes: [], capabilities: [] });
  const source = join(ops.store.directory(card.id), 'source'); await seedTemplate(source, card);
  const host = await readFile(join(source, 'index.ts'), 'utf8');
  await writeFile(join(source, 'index.ts'), host.replace("  name:", "  inject: ['paths'],\n  name:").replace('ctx.provide(', `if (ctx.paths.appDataDir !== ${JSON.stringify(dataDir)}) throw new Error('wrong-app-service'); ctx.provide(`));
  const actualPaths = { appDataDir: dataDir };
  const runtime = new HostRuntime({ app: ops.app, contracts: new ContractSet([]) });
  runtime.ctx.provide('paths', actualPaths);
  const official = join(dataDir, 'official.json'); await writeFile(official, '{"plugins":[]}');
  const consent = new CommunityConsentLedger(dataDir);
  new PluginAdmin({ runtime, store: new UserProfileStore(join(dataDir, 'user.profile.json'), official), official,
    consent }).register();
  ops.bindAdmin(await injectedInstaller(runtime));
  try {
    const checked = await ops.validate(card.id);
    expect(checked.ok, checked.errors.join('\n')).toBe(true);
    await consent.grant({ id: card.pluginId, version: '1.0.0', permissions: [] }, { trust: 'restricted', source: 'workshop' });
    expect((await ops.validate(card.id)).errors.join('\n')).toContain('PERMISSION_UNDECLARED');
    const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    pkg.deepStudent.permissions = ['service:paths']; await writeFile(join(source, 'package.json'), JSON.stringify(pkg));
    expect((await ops.validate(card.id)).ok).toBe(true);
    await writeFile(join(source, 'index.ts'), host.replace("  name:", "  inject: ['commands'],\n  name:"));
    const forbidden = await ops.validate(card.id);
    expect(forbidden.ok).toBe(false);
    expect(forbidden.errors.join('\n')).toContain('KERNEL_API_FORBIDDEN');
  } finally { ops.dispose(); await runtime.dispose(); }
});

it('B7 unsupported app service is reported not-run rather than a generated-code failure', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dstu-selfcheck-unavailable-'));
  const ops = new WorkshopOperations({ dataDir, version: '0.20.0', platform: 'darwin', debug: true });
  const card = await ops.propose({ sessionId: 'test', title: 'Test', description: 'Test', template: 'host-tool', changes: [], capabilities: [] });
  const source = join(ops.store.directory(card.id), 'source'); await seedTemplate(source, card);
  const host = await readFile(join(source, 'index.ts'), 'utf8');
  await writeFile(join(source, 'index.ts'), host.replace("  name:", "  inject: ['missingApplicationService'],\n  name:"));
  ops.bindAdmin({ inventory: async () => ({ revision: 'r', plugins: [], safeMode: false }), uninstall: async () => null,
    installManagedDirectory: async () => { throw new Error('not invoked'); },
    selfCheckContext: async () => ({ trust: 'full', safeMode: false, services: {} }),
  } as Parameters<typeof ops.bindAdmin>[0]);
  const checked = await ops.validate(card.id);
  expect(checked.lifecycle).toBe('not-run'); expect(checked.ok).toBe(false);
  expect(checked.errors.join('\n')).toContain('WORKSHOP_SELF_CHECK_UNAVAILABLE');
});
