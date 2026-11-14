/**
 * Run seed against a 0.20 checkout, then verify against a 0.21 candidate
 * checkout, and optionally reopen the old version, with the same isolated root. All phases run the actual Electron
 * app, Host plugin manager and package store. See docs/plugins/UPGRADES.md.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type Browser, type Page } from '@playwright/test';
import { readFile, writeFile, readdir, mkdir, rename } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { isolatedEnv, launchApp } from './__tests__/support/app.ts';
import { waitForBridge } from './__tests__/support/onboarding.ts';
import { BaseDirectory } from '../../../electron/shell/paths.ts';
import { WorkshopStore } from '../../plugins/plugin-workshop/src/store.ts';
import { CommunityConsentLedger } from '../../kernel/community-consent.ts';
import { pluginServiceName } from '../../kernel/plugin-id.ts';
import type { PluginManagerInventory, PluginManagerInstallResult, PluginUpdateImpact } from '../../kernel/core.ts';

const [phase, root, executable] = process.argv.slice(2);
assert((phase === 'seed' || phase === 'verify' || phase === 'restore') && root && isAbsolute(root) && (!executable || isAbsolute(executable)),
  'usage: plugin-upgrade.mts seed|verify|restore <absolute-isolated-root> [absolute-app-executable]');
await mkdir(root, { recursive: true });
const data = join(root, 'data');
const plugins = join(data, 'plugins');
const profile = join(plugins, 'user.profile.json');
const statePath = join(root, 'upgrade-fixtures.json');
const failureMarker = join(root, 'candidate-start');
const marker = 'user edit survived 0.20 -> 0.21';
const expectedVersion = phase === 'verify' ? '0.21.0' : '0.20.0';
if (phase === 'restore') await rename(failureMarker, join(root, 'candidate-fault-completed'));
type Fixture = { id: string; module: string; stateFile: string; manifest: string; moduleBytes: string };
type State = { oldPid: number; savedNoteId: string; workId: string; boundedWorkId: string; compatible: Fixture; bounded: Fixture; boundedWorkshop: Fixture; broken: Fixture; api: Fixture; revision: string; profile: string; lock: string; consent: string; source: string };
interface Driver {
  pid: number | undefined;
  page: Page;
  call<T = unknown>(cmd: string, args?: unknown, timeoutMs?: number): Promise<T>;
  close(): Promise<void>;
}

async function packagedApp(executable: string, root: string): Promise<Driver> {
  const child = spawn(executable, ['--disable-gpu', '--remote-debugging-port=0'], {
    cwd: root, env: isolatedEnv(root), stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8000); });
  let spawnError: Error | undefined;
  child.on('error', error => { spawnError = error; });
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
  let browser: Browser | undefined;
  async function close() {
    try {
      await browser?.close();
    } finally {
      if (child.pid && child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    }
  }
  try {
    const deadline = Date.now() + 90_000;
    let page: Page | undefined;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) break;
      const endpoint = /DevTools listening on (ws:\/\/\S+)/.exec(stderr)?.[1];
      if (!browser && endpoint) browser = await chromium.connectOverCDP(endpoint, { timeout: 10_000 });
      page = browser?.contexts().flatMap(context => context.pages()).find(item => item.url().startsWith('tauri://localhost/'));
      if (page) break;
      await delay(100);
    }
    assert(page, 'packaged app window unavailable: ' + stderr);
    const appPage = page;
    return {
      pid: child.pid, page: appPage, close,
      async call<T>(cmd: string, args: unknown = {}, timeoutMs = 15_000): Promise<T> {
        return appPage.evaluate(({ cmd, args, timeoutMs }) => {
          const internals = (globalThis as unknown as { __TAURI_INTERNALS__: { invoke(c: string, a: unknown): Promise<unknown> } }).__TAURI_INTERNALS__;
          let timer: ReturnType<typeof setTimeout>;
          return Promise.race([
            internals.invoke(cmd, args),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('IPC timed out: ' + cmd)), timeoutMs); }),
          ]).finally(() => clearTimeout(timer));
        }, { cmd, args, timeoutMs }) as Promise<T>;
      },
    };
  } catch (error) {
    await close().catch(() => {}); // boundary-allow empty-catch: preserve the original launch failure while closing best-effort
    throw error;
  }
}

const app: Driver = executable ? await packagedApp(executable, root) : await (async () => {
  const source = await launchApp({ root, electronArgs: ['--disable-gpu'],
    env: process.env.DSTU_TEST_DEV_URL ? { DS_ELECTRON_DEV_URL: process.env.DSTU_TEST_DEV_URL } : {} });
  return { ...source, pid: source.app.process().pid };
})();
const inventory = () => app.call<PluginManagerInventory>('plugin:manager|list', {}, 30_000);
const config = (id: string) => app.call<{values: unknown}>('plugin:manager|config', { id });
const read = (path: string) => readFile(path, 'utf8');
try {
  await waitForBridge(app.page);
  await app.call('plugin:host|status', {}, 90_000);
  assert.ok(app.pid);
  assert.equal(await app.call('plugin:app|version'), expectedVersion);
  const store = new WorkshopStore(data);
  const consent = new CommunityConsentLedger(data);
  if (phase === 'seed') {
    const card = await store.propose({ sessionId: 'isolated', title: 'Upgrade fixture', description: 'Keeps local edits',
      template: 'host-tool', capabilities: [], changes: [] });
    const boundedCard = await store.propose({ sessionId: 'isolated', title: 'Version bounded Workshop fixture',
      description: 'Requires app 0.20', template: 'host-tool', capabilities: [], changes: [] });
    const source = join(store.directory(card.id), 'source', 'index.ts');
    await writeFile(source, '// ' + marker + '\n', { flag: 'wx' });
    const install = async (id: string, engine: string, options: { fail?: boolean; api?: string } = {}): Promise<Fixture> => {
      const pkg = JSON.stringify({ name: id, type: 'module', version: '1.0.0',
        engines: { deepStudent: engine, ...(options.api ? { deepStudentPluginApi: options.api } : {}) },
        deepStudent: { manifestVersion: 1, id, platforms: ['desktop'], host: './index.mjs' } });
      const service = pluginServiceName(id);
      const moduleBytes = `import Schema from '@deepseek-ai/schemastery';
import { existsSync } from 'node:fs';
${options.fail ? `if (existsSync(${JSON.stringify(failureMarker)})) throw new Error('upgrade fixture import failure');` : ''}
const id = ${JSON.stringify(id)};
export default { name: id, meta: { id, version: '1.0.0', provides: [${JSON.stringify(service)}] },
  Config: Schema.object({ message: Schema.string().default('original') }),
  apply(ctx, config) { ctx.provide(${JSON.stringify(service)}, { value: config.message }); } };`;
      // An installed package must be self-contained; resolve the fixture's Schema
      // dependency through the actual application dependency path on this machine.
      const fixtureModule = moduleBytes.replace('@deepseek-ai/schemastery', import.meta.resolve('@deepseek-ai/schemastery'));
      const zip = new JSZip();
      zip.file('package.json', pkg);
      zip.file('index.mjs', fixtureModule);
      const archive = join(data, id + '.dsplugin');
      await writeFile(archive, await zip.generateAsync({ type: 'nodebuffer' }));
      const rev = (await inventory()).revision;
      const installed = await app.call<PluginManagerInstallResult>('plugin:manager|install', { path: archive, revision: rev });
      if (id === card.pluginId || id === boundedCard.pluginId) await consent.grant({ id, version: installed.version, permissions: [] }, { source: 'workshop', trust: 'full' });
      else await app.call('plugin:manager|consent', { id, version: installed.version, permissions: [] });
      await app.call('plugin:manager|set-enabled', { id, enabled: true, revision: installed.revision });
      const document = JSON.parse(await read(profile));
      const module = fileURLToPath(document.plugins.find((entry: { id: string }) => entry.id === id).module);
      const stateFile = join(plugins, id, 'user-data.txt');
      await mkdir(join(plugins, id), { recursive: true });
      await writeFile(stateFile, marker, { flag: 'wx' });
      return { id, module, stateFile, manifest: pkg, moduleBytes: fixtureModule };
    };
    const compatible = await install(card.pluginId, '^0.20');
    const bounded = await install('alice.bounded', '>=0.20.0 <0.21.0');
    const boundedWorkshop = await install(boundedCard.pluginId, '>=0.20.0 <0.21.0');
    const broken = await install('alice.broken', '>=0.20.0', { fail: true });
    const api = await install('alice.future-api', '>=0.20.0', { api: '2' });
    await app.call('plugin:manager|config|save', { id: compatible.id, revision: (await inventory()).revision, values: { message: marker } });
    assert.deepEqual((await config(compatible.id)).values, { message: marker });
    await store.update(card.id, card.revision, { state: 'installed', version: '1.0.0', usableVersion: '1.0.0' });
    await store.update(boundedCard.id, boundedCard.revision, { state: 'installed', version: '1.0.0', usableVersion: '1.0.0' });
    const snapshot = await inventory();
    for (const item of [compatible, bounded, boundedWorkshop, broken, api]) assert.equal(snapshot.plugins.find(entry => entry.id === item.id)?.state, 'running');
    const savedNote = await app.call<{ id: string }>('notes_create', { note: { title: marker, content_md: marker, tags: [] } });
    assert.ok(savedNote.id);
    await writeFile(failureMarker, '', { flag: 'wx' });
    await writeFile(statePath, JSON.stringify({
      oldPid: app.pid, savedNoteId: savedNote.id, workId: card.id, boundedWorkId: boundedCard.id, compatible, bounded, boundedWorkshop, broken, api,
      revision: snapshot.revision, profile: await read(profile), lock: await read(join(plugins, 'plugins.lock.json')),
      consent: await read(consent.path), source: await read(source),
    }));
    console.log('0.20 installed and running with saved user configuration');
  } else if (phase === 'verify') {
    const state = JSON.parse(await read(statePath)) as State;
    assert.notEqual(app.pid, state.oldPid);
    const current = await inventory();
    const plugin = (id: string) => current.plugins.find(item => item.id === id);
    assert.equal(current.safeMode, false);
    assert.equal(plugin(state.compatible.id)?.state, 'running');
    assert.deepEqual((await config(state.compatible.id)).values, { message: marker });
    for (const [fixture, reason] of [[state.bounded, 'ENGINE_INCOMPATIBLE'], [state.boundedWorkshop, 'ENGINE_INCOMPATIBLE'], [state.api, 'ENGINE_INCOMPATIBLE'], [state.broken, 'IMPORT_FAILED']] as const) {
      assert.equal(plugin(fixture.id)?.state, 'degraded');
      assert.equal(plugin(fixture.id)?.enabled, true);
      assert.ok(plugin(fixture.id)?.reason?.startsWith(reason + ':'), JSON.stringify(plugin(fixture.id)));
    }
    const impact = await app.call<PluginUpdateImpact>('plugin:manager|update-impact', { version: '0.21.0' });
    assert.deepEqual(new Set(impact.incompatible), new Set([state.bounded.id, state.boundedWorkshop.id, state.api.id]));
    assert.deepEqual(impact.unchecked, []); // manifest preflight does not execute the throwing module
    assert.equal((await store.read(state.workId)).state, 'installed');
    assert.equal((await store.read(state.boundedWorkId)).state, 'installed');
    assert.equal(await read(join(store.directory(state.workId), 'source', 'index.ts')), state.source);
    assert.equal(await read(profile), state.profile);
    assert.equal(await read(join(plugins, 'plugins.lock.json')), state.lock);
    assert.equal(await read(consent.path), state.consent);
    for (const fixture of [state.compatible, state.bounded, state.boundedWorkshop, state.broken, state.api]) {
      assert.equal(await read(fixture.stateFile), marker);
      assert.equal(await read(fixture.module), fixture.moduleBytes);
      assert.equal(await read(join(dirname(fixture.module), 'package.json')), fixture.manifest);
    }
    const logs = join(await app.call<string>('plugin:path|resolve_directory', { directory: BaseDirectory.AppLog }), 'backend');
    const diagnostics = (await Promise.all((await readdir(logs)).filter(name => name.endsWith('_diagnostic.log')).map(name => read(join(logs, name))))).join('\n');
    for (const [fixture, reason] of [[state.bounded, 'ENGINE_INCOMPATIBLE'], [state.broken, 'IMPORT_FAILED']] as const) {
      assert.ok(diagnostics.split('\n').some(line => {
        const entry = JSON.parse(line || '{}').data;
        return entry?.pluginId === fixture.id && entry?.code === reason;
      }), 'missing diagnostics for ' + fixture.id);
    }
    const saved = await app.call<{ content_md: string }>('notes_get', { id: state.savedNoteId });
    assert.equal(saved.content_md.trim(), marker);
    const note = await app.call<{ id: string }>('notes_create', { note: { title: marker, content_md: marker, tags: [] } });
    assert.ok(note.id);
    console.log(JSON.stringify({ mode: executable ? 'packaged' : 'source', versions: ['0.20.0', '0.21.0'], impact, compatible: 'running with saved configuration and source',
      degraded: [state.bounded.id, state.boundedWorkshop.id, state.api.id, state.broken.id], profileLockAndConsentPreserved: true, diagnostics: true, priorNotePreserved: true, notesUsable: true }));
  } else {
    const state = JSON.parse(await read(statePath)) as State;
    const current = await inventory();
    assert.equal(current.safeMode, false);
    for (const fixture of [state.compatible, state.bounded, state.boundedWorkshop, state.broken, state.api]) {
      const entry = current.plugins.find(item => item.id === fixture.id);
      assert.equal(entry?.state, 'running', JSON.stringify(entry));
      assert.equal(await read(fixture.stateFile), marker);
    }
    assert.equal((await store.read(state.boundedWorkId)).state, 'installed');
    assert.deepEqual((await config(state.compatible.id)).values, { message: marker });
    console.log('0.20 reopened the same data and loaded the version-bounded Workshop plugin without reinstalling');
  }
} finally {
  await app.close();
}
