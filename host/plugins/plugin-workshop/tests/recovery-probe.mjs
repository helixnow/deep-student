import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostRuntime } from '../../../kernel/runtime.ts';
import { ContractSet } from '../../../kernel/contract-set.ts';
import { PluginAdmin } from '../../../kernel/plugin-admin.ts';
import { UserProfileStore } from '../../../kernel/profile-store.ts';
import { CommunityConsentLedger } from '../../../kernel/community-consent.ts';
import { PluginPackages } from '../../../kernel/plugin-packages/index.ts';
import { createNodeFiles } from '../../../platform/files/index.ts';
import { WorkshopOperations } from '../src/operations.ts';
import { seedTemplate } from '../src/resources.ts';
import { injectedInstaller } from './installer-fixture.ts';

const dataDir = await realpath(await mkdtemp(join(tmpdir(), 'dstu-recovery-actual-')));
await mkdir(join(dataDir, 'plugins'));
const official = join(dataDir, 'official.json'); await writeFile(official, '{"plugins":[]}');
const app = { dataDir, version: '0.20.0', platform: process.platform, debug: true };
const files = createNodeFiles({ roots: [{ name: 'appData', path: dataDir }] });
const packages = new PluginPackages(files.scope(join(dataDir, 'plugins')));
const profile = new UserProfileStore(join(dataDir, 'plugins/user.profile.json'), official);
let runtime, ops, installer;
async function start() {
  runtime = new HostRuntime({ app, contracts: new ContractSet([]) });
  new PluginAdmin({ runtime, store: profile, official, consent: new CommunityConsentLedger(dataDir), files, packages }).register();
  installer = await injectedInstaller(runtime);
  ops = new WorkshopOperations(app); ops.bindAdmin(installer); await ops.ready();
}
async function enable(id) {
  const inventory = await installer.inventory();
  return runtime.dispatchInvoke({ id: 'enable', cmd: 'plugin:manager|set-enabled', args: { id, revision: inventory.revision, enabled: true }, source: { window: 'main', webview: 'main' } });
}
async function generate(card, version) {
  let done;
  const completed = new Promise(resolve => { done = resolve; });
  ops.bindGeneration({ generate: async (work, source) => {
    if (version === '1.0.0') await seedTemplate(source, work);
    else {
      const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')); pkg.version = version;
      await writeFile(join(source, 'package.json'), JSON.stringify(pkg));
      let code = await readFile(join(source, 'index.ts'), 'utf8');
      code = code.replace("version: '1.0.0'", `version: '${version}'`).replace('ctx.provide(', "if (globalThis.__workshopActivationFail) throw new Error('v2-activation-failed'); ctx.provide(");
      await writeFile(join(source, 'index.ts'), code);
    }
    done();
  } });
  await ops.create(card.id, card.revision); await completed;
  // Test-only wait for the Host-owned background compilation, bounded and without model/network.
  const deadline = Date.now() + 5000;
  while ((await ops.status(card.id)).state === 'generating') {
    assert(Date.now() < deadline, 'generation timed out'); await new Promise(resolve => setTimeout(resolve, 10));
  }
  const ready = await ops.status(card.id); assert.equal(ready.state, 'pending-confirmation', ready.error);
  ops.bindAdmin({ inventory: () => installer.inventory(), onActivation: listener => installer.onActivation(listener), uninstall: (id, revision) => installer.uninstall(id, revision),
    installManagedDirectory: async request => {
      await access(join(ops.store.directory(card.id), 'versions', version, 'source/index.ts'));
      return installer.installManagedDirectory(request);
    } });
  return ops.install(card.id, ready.revision);
}
await start();
try {
  const brief = { sessionId: 'test', title: 'Test', description: 'Test', template: 'host-tool', changes: [], capabilities: [] };
  let card = await ops.propose(brief);
  card = await generate(card, '1.0.0'); assert.equal((await enable(card.pluginId)).kind, 'ok');
  assert.equal((await ops.status(card.id)).usableVersion, '1.0.0');
  card = await ops.propose({ ...brief, pluginId: card.pluginId });
  card = await generate(card, '2.0.0');
  ops.dispose(); await runtime.dispose();
  await start();
  globalThis.__workshopActivationFail = true;
  const failed = await enable(card.pluginId); assert.equal(failed.kind, 'err');
  card = await ops.status(card.id); assert.equal(card.state, 'failed'); assert.equal(card.previousVersion, '1.0.0');
  card = await ops.restore(card.id, card.revision);
  assert.equal(card.version, '1.0.0'); assert.equal((await enable(card.pluginId)).kind, 'ok');
  assert.equal((await packages.verify(card.pluginId)).version, '1.0.0');
  assert(runtime.get(card.pluginId));
  console.log(JSON.stringify({ restored: '1.0.0', running: true, dataDir }));
} finally { ops.dispose(); await runtime.dispose(); delete globalThis.__workshopActivationFail; }
