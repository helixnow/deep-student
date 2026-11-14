#!/usr/bin/env node
/** Verify the compiler/resources actually shipped inside an app, not checkout dependencies.
 * Stock Electron supplies a utility process; every module under test comes from target app.asar.
 * node electron/scripts/__tests__/workshop-compiler.mjs '/path/Deep Student.app'
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = mkdtempSync(join(tmpdir(), 'dstu-packaged-compiler-'));
const archive = join(resolve(process.argv[2]), 'Contents/Resources/app.asar');
const checkout = fileURLToPath(new URL('../../../', import.meta.url));
const git = (...args) => {
  const output = spawnSync('git', args, { cwd: checkout, encoding: 'utf8' });
  if (output.status !== 0) throw new Error(output.stderr);
  return output.stdout;
};
const sourceSha = git('rev-parse', 'HEAD').trim();
const sourcePaths = [...git('ls-tree', '-r', '--name-only', sourceSha, 'host/plugins/plugin-workshop', 'resources/dstu-workshop',
  'host/kernel/runtime.ts', 'host/kernel/plugin-admin.ts', 'host/kernel/workshop-ui-authority.ts').trim().split('\n')]
  .filter(file => file && !file.includes('/tests/'));
const asar = require('@electron/asar');
for (const file of sourcePaths) {
  const expected = spawnSync('git', ['show', `${sourceSha}:${file}`], { cwd: checkout });
  if (expected.status !== 0 || !asar.extractFile(archive, file).equals(expected.stdout)) throw new Error(`Packaged source does not match ${sourceSha}: ${file}`);
}
const bundledVersion = JSON.parse(asar.extractFile(archive, 'electron/.build/version.json').toString());
if (bundledVersion.gitRevision !== sourceSha) throw new Error(`Packaged build SHA ${bundledVersion.gitRevision} differs from ${sourceSha}`);
const result = join(root, 'result.json');
const probe = join(root, 'probe.mjs');
writeFileSync(probe, `
import { createRequire } from 'node:module';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
try {
  const base = ${JSON.stringify(archive)};
  const { WorkshopStore } = await import(${JSON.stringify(pathToFileURL(join(archive, 'host/plugins/plugin-workshop/src/store.ts')).href)});
  const { seedTemplate, developmentSkill } = await import(${JSON.stringify(pathToFileURL(join(archive, 'host/plugins/plugin-workshop/src/resources.ts')).href)});
  const { compileWorkshop, checkWorkshopLifecycle } = await import(${JSON.stringify(pathToFileURL(join(archive, 'host/plugins/plugin-workshop/src/compiler.ts')).href)});
  const store = new WorkshopStore(${JSON.stringify(root)});
  const card = await store.propose({ sessionId: 'packaged-probe', title: 'Packaged recall', description: 'Recall a word', template: 'learning-tool', changes: [], capabilities: [] });
  const source = join(store.directory(card.id), 'source');
  await seedTemplate(source, card);
  const app = { name: 'dstu', version: '0.11.0', dataDir: ${JSON.stringify(root)}, debug: false };
  const built = await compileWorkshop(source, join(store.directory(card.id), 'build'), card.pluginId, app);
  const check = await checkWorkshopLifecycle(built, app);
  const { HostRuntime } = await import(${JSON.stringify(pathToFileURL(join(archive, 'host/kernel/runtime.ts')).href)});
  const { ContractSet } = await import(${JSON.stringify(pathToFileURL(join(archive, 'host/kernel/contract-set.ts')).href)});
  const { PluginAdmin } = await import(${JSON.stringify(pathToFileURL(join(archive, 'host/kernel/plugin-admin.ts')).href)});
  const { UserProfileStore } = await import(${JSON.stringify(pathToFileURL(join(archive, 'host/kernel/profile-store.ts')).href)});
  const { CommunityConsentLedger } = await import(${JSON.stringify(pathToFileURL(join(archive, 'host/kernel/community-consent.ts')).href)});
  const { PluginPackages } = await import(${JSON.stringify(pathToFileURL(join(archive, 'host/kernel/plugin-packages/index.ts')).href)});
  const { createNodeFiles } = await import(${JSON.stringify(pathToFileURL(join(archive, 'host/platform/files/index.ts')).href)});
  const { realpath } = await import('node:fs/promises');
  const dataDir = await realpath(${JSON.stringify(root)});
  const realApp = { ...app, dataDir, platform: process.platform };
  await mkdir(join(dataDir, 'plugins'), { recursive: true });
  const official = join(dataDir, 'official.json');
  await writeFile(official, '{"plugins":[]}');
  const runtime = new HostRuntime({ app: realApp, contracts: new ContractSet([]) });
  const files = createNodeFiles({ roots: [{ name: 'appData', path: dataDir }] });
  const packages = new PluginPackages(files.scope(join(dataDir, 'plugins')));
  const consent = new CommunityConsentLedger(dataDir);
  const profile = new UserProfileStore(join(dataDir, 'plugins/user.profile.json'), official);
  const admin = new PluginAdmin({ runtime, store: profile, official, consent, files, packages });
  admin.register();
  const { pluginExecution } = await import(${JSON.stringify(pathToFileURL(join(archive, 'host/kernel/plugin-execution.ts')).href)});
  let captured;
  await runtime.install({ name: 'compiler-probe', meta: { id: 'dstu.compiler-probe' }, inject: ['dstuPluginInstaller'], apply(ctx) { captured = ctx.dstuPluginInstaller; } });
  const fiber = runtime.get('dstu.compiler-probe').fiber;
  const inventory = await pluginExecution.run(fiber, () => captured.inventory());
  const install = await pluginExecution.run(fiber, () => captured.installManagedDirectory({ id: card.pluginId, directory: built.directory,
    revision: inventory.revision, version: built.manifest.version, permissions: built.manifest.permissions, confirmed: true }));
  const enabled = await runtime.dispatchInvoke({ id: 'packaged-enable', cmd: 'plugin:manager|set-enabled',
    args: { id: card.pluginId, revision: install.revision, enabled: true }, source: { window: 'main', webview: 'main' } });
  const running = runtime.get(card.pluginId) !== undefined;
  if (!running) throw new Error(JSON.stringify(enabled));
  await runtime.dispose();
  await writeFile(${JSON.stringify(result)}, JSON.stringify({ sourceSha: ${JSON.stringify(sourceSha)}, bundledSha: ${JSON.stringify(bundledVersion.gitRevision)}, sourceFilesVerified: ${sourcePaths.length}, check, directory: built.directory, skillBytes: Buffer.byteLength(await developmentSkill()),
    esbuild: require.resolve(join(base, 'node_modules/esbuild')), archive: base, install, running }, null, 2));
  process.exit(check.ok ? 0 : 1);
} catch (error) { await writeFile(${JSON.stringify(result)}, JSON.stringify({ error: error.stack })); process.exit(1); }
`);
writeFileSync(join(root, 'main.cjs'), `
const { app, utilityProcess } = require('electron');
app.whenReady().then(() => {
  const child = utilityProcess.fork(${JSON.stringify(probe)}, [], { stdio: 'pipe' });
  child.stdout.on('data', value => process.stdout.write(value));
  child.stderr.on('data', value => process.stderr.write(value));
  child.on('exit', code => app.exit(code));
});
`);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
const run = spawnSync(require('electron'), [join(root, 'main.cjs')], { env, stdio: 'inherit', timeout: 60_000 });
console.log(readFileSync(result, 'utf8'));
console.log(`Evidence retained: ${result}`);
process.exit(run.status ?? 1);
