import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import { HostRuntime } from '../runtime.ts';
import { ContractSet } from '../contracts.ts';
import { PluginAdmin } from '../plugin-admin.ts';
import {
  HOST_CALL_COMMAND,
  PLUGIN_MANAGER_CONSENT_COMMAND,
  PLUGIN_MANAGER_INSTALL_COMMAND,
  PLUGIN_MANAGER_LIST_COMMAND,
  PLUGIN_MANAGER_SET_ENABLED_COMMAND,
  PLUGIN_MANAGER_UNINSTALL_COMMAND,
} from '../api.ts';
import { UserProfileStore } from '../profile-store.ts';
import { PluginPackages } from '../plugin-packages/index.ts';
import { CommunityConsentLedger } from '../community-consent.ts';
import { createNodeFiles } from '../../platform/files/index.ts';

let workDir = '';
let runtime: HostRuntime | undefined;

afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = '';
});

let seq = 0;
async function callManager<T>(rt: HostRuntime, cmd: string, args: Record<string, unknown>): Promise<T> {
  const outcome = await rt.dispatchInvoke(
    {
      id: `ui_only_${++seq}`,
      cmd,
      args,
      source: { window: 'main', webview: 'main' },
    },
    new AbortController().signal,
  );
  if (outcome.kind !== 'ok') {
    throw new Error(`command ${cmd} failed: ${JSON.stringify(outcome)}`);
  }
  return outcome.value as T;
}

describe('RFC-002 P1: UI-only community plugin lifecycle', () => {
  it('installs, consents, enables, disables, and uninstalls a UI-only .dsplugin without requiring a Host entry', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'dstu-ui-only-'));
    const dataDir = join(workDir, 'app');
    await mkdir(join(dataDir, 'plugins'), { recursive: true });
    const officialProfile = join(workDir, 'official.profile.json');
    await writeFile(officialProfile, JSON.stringify({ plugins: [] }), 'utf8');

    runtime = new HostRuntime({
      app: { dataDir, platform: 'linux', version: '0.20.9', debug: true },
      contracts: ContractSet.empty(),
    });
    runtime.ctx.provide('paths', {});
    runtime.ctx.provide('storage', {});
    runtime.ctx.provide('log', {});
    // Install an official provider of `studyData` so we can verify permission-gated brokered domain calls
    await runtime.install({
      name: 'dstu.plugin-services',
      meta: { id: 'dstu.plugin-services', provides: ['studyData'] },
      apply(ctx) {
        ctx.provide('studyData', {
          notes: {
            list: () => [{ id: 'note_1', title: 'Brokered Note' }],
          },
        });
      },
    });

    const store = new UserProfileStore(join(dataDir, 'plugins/user.profile.json'), officialProfile);
    const files = createNodeFiles({ roots: [{ name: 'appData', path: dataDir }, { name: 'work', path: workDir }] });
    const packages = new PluginPackages(files.scope(join(dataDir, 'plugins')));
    const consent = new CommunityConsentLedger(dataDir);

    const admin = new PluginAdmin({
      runtime,
      official: officialProfile,
      store,
      packages,
      consent,
      files,
    });
    admin.register();

    // Build a minimal valid UI-only .dsplugin archive (NO host field!)
    const zip = new JSZip();
    zip.file('package.json', JSON.stringify({
      name: 'deepstudent-plugin-demo-widget',
      version: '1.0.0',
      engines: { deepStudent: '^0.20.0' },
      deepStudent: {
        manifestVersion: 1,
        id: 'acme.demo-widget',
        displayName: 'Demo UI Widget',
        platforms: ['desktop'],
        ui: './dist/ui.js',
        permissions: ['service:studyData'],
      },
    }));
    zip.file('dist/ui.js', 'export default { meta: { id: "acme.demo-widget", version: "1.0.0" }, apply() {} };\n');
    const archivePath = join(workDir, 'demo-widget.dsplugin');
    await writeFile(archivePath, await zip.generateAsync({ type: 'nodebuffer' }));

    const initial = await callManager<{ revision: string }>(runtime, PLUGIN_MANAGER_LIST_COMMAND, {});

    // 1. Install UI-only package (previously failed with PLUGIN_HOST_REQUIRED!)
    const installed = await callManager<{ id: string; version: string; enabled: boolean; revision: string }>(
      runtime,
      PLUGIN_MANAGER_INSTALL_COMMAND,
      { path: archivePath, revision: initial.revision },
    );
    expect(installed.id).toBe('acme.demo-widget');
    expect(installed.enabled).toBe(false);

    // 2. Grant consent & enable
    const consented = await callManager<{ revision?: string }>(
      runtime,
      PLUGIN_MANAGER_CONSENT_COMMAND,
      { id: 'acme.demo-widget', version: '1.0.0', permissions: ['service:studyData'], revision: installed.revision },
    );
    const revAfterConsent = consented.revision ?? installed.revision;

    const enabled = await callManager<{ enabled: boolean; revision: string }>(
      runtime,
      PLUGIN_MANAGER_SET_ENABLED_COMMAND,
      { id: 'acme.demo-widget', enabled: true, revision: revAfterConsent },
    );
    expect(enabled.enabled).toBe(true);
    expect(runtime.get('acme.demo-widget')).toBeDefined();

    // 2b. Consented UI-only plugin can call brokered `studyData.notes.list` WITHOUT any Host half!
    const notes = await callManager<Array<{ id: string; title: string }>>(runtime, HOST_CALL_COMMAND, {
      caller: 'acme.demo-widget',
      service: 'studyData',
      method: 'notes.list',
      args: [],
    });
    expect(notes).toEqual([{ id: 'note_1', title: 'Brokered Note' }]);

    // Unconsented service (`pluginModel`) is still denied!
    const denied = await runtime.dispatchInvoke({
      id: 'ui_only_denied',
      cmd: HOST_CALL_COMMAND,
      args: { caller: 'acme.demo-widget', service: 'studyData', method: 'notes.__proto__', args: [] },
      source: { window: 'main', webview: 'main' },
    });
    expect(denied.kind).toBe('err');

    // 3. Disable & uninstall cleanly
    const disabled = await callManager<{ enabled: boolean; revision: string }>(
      runtime,
      PLUGIN_MANAGER_SET_ENABLED_COMMAND,
      { id: 'acme.demo-widget', enabled: false, revision: enabled.revision },
    );
    expect(disabled.enabled).toBe(false);

    const uninstalled = await callManager<{ id: string }>(
      runtime,
      PLUGIN_MANAGER_UNINSTALL_COMMAND,
      { id: 'acme.demo-widget', revision: disabled.revision },
    );
    expect(uninstalled.id).toBe('acme.demo-widget');
  });
});
