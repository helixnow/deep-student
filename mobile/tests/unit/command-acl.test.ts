/**
 * 移动端应用命令 ACL：清单与 Rust 移动端 capability 的应用命令部分口径一致，只列移动端实际装配的插件和它们声明的命令；
 * 判定走 kernel 的 `CapabilityAcl`，经外壳 → MessagePort → Worker 会话（`serveImportedHost`）的真实路径生效。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCapabilityFile } from '../../../host/kernel/capability-decode.ts';
import { definePlugin } from '../../../host/kernel/core.ts';
import type { HostPlugin } from '../../../host/kernel/api.ts';
import { serveImportedHost } from '../../../host/kernel/serve.ts';
import { createTestHost } from '../../../host/kernel/testing.ts';
import { webMessagePortTransport } from '../../../host/kernel/transports.ts';
import { MobileShell } from '../../src/shell/mobile-shell.ts';
import { APP_COMMANDS_PERMISSION, MOBILE_APP_COMMANDS, MOBILE_CAPABILITY, mobileCommandAcl, profileAppCommands } from '../../src/worker/command-acl.ts';
import { bundledContracts } from '../../src/worker/contracts.ts';
import { rendererInvoker } from './support/renderer.ts';
import { REPO } from './support/sqlite-node.ts';

const PROFILES = join(REPO, 'host/profiles');
const SHELL_PLUGIN_ID = 'dstu.mobile.shell';

/** 与 kernel `CapabilityAcl.fromDirectory` 相同的读法（build.rs::extract_allowed_commands 的已提交格式）。 */
function rustPermissionAllows(identifier: string): Set<string> {
  const dir = join(REPO, 'resources/app/permissions');
  for (const file of readdirSync(dir).filter(name => name.endsWith('.toml')).sort()) {
    for (const block of readFileSync(join(dir, file), 'utf8').split('[[permission]]').slice(1)) {
      if (block.match(/^identifier\s*=\s*"([^"]+)"/m)?.[1] !== identifier) continue;
      const body = block.match(/commands\.allow\s*=\s*\[([^\]]*)\]/s)?.[1] ?? '';
      return new Set([...body.matchAll(/"([^"\n]+)"/g)].map(m => m[1]!));
    }
  }
  throw new Error(`no permission ${identifier} under resources/app/permissions`);
}

function mobileProfile(): { id: string; module: string }[] {
  return (JSON.parse(readFileSync(join(PROFILES, 'mobile.json'), 'utf8')) as { plugins: { id: string; module: string }[] }).plugins;
}

function settingsPlugin(): HostPlugin {
  const values = new Map<string, string>();
  return definePlugin({
    meta: { id: 'fixture.settings', commands: ['get_setting', 'save_setting'], platforms: ['desktop', 'mobile'] },
    apply(ctx) {
      ctx.commands.register<{ key: string }>('get_setting', ({ key }) => values.get(key) ?? null);
      ctx.commands.register<{ key: string; value: string }>('save_setting', ({ key, value }) => {
        values.set(key, value);
        return true;
      });
    },
  });
}

const ONLY_GET_SETTING = { 'fixture.settings': ['get_setting'] };

describe('mobile command ACL manifest', () => {
  it('is the application-command part of the Rust mobile capability', () => {
    const file = join(REPO, 'resources/app/capabilities/mobile.json');
    const rust = parseCapabilityFile(readFileSync(file, 'utf8'), file).find(cap => cap.identifier === 'mobile')!;
    const appPermissions = (cap: { permissions: readonly (string | { identifier: string })[] }) =>
      cap.permissions.map(p => (typeof p === 'string' ? p : p.identifier)).filter(id => !id.includes(':'));
    expect({ ...MOBILE_CAPABILITY, description: '', permissions: appPermissions(MOBILE_CAPABILITY), platforms: null })
      .toEqual({ ...rust, description: '', permissions: appPermissions(rust), platforms: null });
    expect(appPermissions(rust)).toEqual([APP_COMMANDS_PERMISSION]);
    expect(rust.platforms).toEqual(['android', 'iOS']);
    expect(MOBILE_CAPABILITY.platforms).toBeNull();
  });

  it('lists exactly the plugins the mobile Worker installs', () => {
    expect(Object.keys(MOBILE_APP_COMMANDS)).toEqual([SHELL_PLUGIN_ID, ...mobileProfile().map(entry => entry.id)]);
  });

  it('each plugin lists the commands it declares that Rust allows, and every listed command has an IPC contract', async () => {
    const rustAllowed = rustPermissionAllows(APP_COMMANDS_PERMISSION);
    expect(rustAllowed.size).toBeGreaterThan(500);
    const contracts = bundledContracts();
    expect(MOBILE_APP_COMMANDS[SHELL_PLUGIN_ID]).toEqual([]);
    for (const entry of mobileProfile()) {
      const plugin = (await import(pathToFileURL(resolve(PROFILES, entry.module)).href) as { default: HostPlugin }).default;
      expect(plugin.meta.id).toBe(entry.id);
      const expected = (plugin.meta.commands ?? []).filter(name => rustAllowed.has(name)).sort();
      expect(MOBILE_APP_COMMANDS[entry.id], entry.id).toEqual(expected);
    }
    for (const name of Object.values(MOBILE_APP_COMMANDS).flat()) expect(contracts.get(name), name).toBeDefined();
  });

  it('a business plugin added to the profile gets its Rust-allowed commands without editing the manifest', () => {
    const rustAllowed = rustPermissionAllows(APP_COMMANDS_PERMISSION);
    const business = { id: 'fixture.business', plugin: { meta: { id: 'fixture.business', commands: ['get_setting', 'save_setting', 'not_a_rust_command'] } } };
    const table = profileAppCommands([business], rustAllowed);
    expect(Object.keys(table)).toEqual([SHELL_PLUGIN_ID, 'fixture.business']);
    expect(table['fixture.business']).toEqual(['get_setting', 'save_setting'].filter(name => rustAllowed.has(name)).sort());
    expect(table['fixture.business']).not.toContain('not_a_rust_command');
  });
});

describe('mobile command ACL decisions', () => {
  it('allows listed commands for the bundled frontend in the main window only', async () => {
    const host = await createTestHost({
      contracts: bundledContracts(),
      plugins: [settingsPlugin()],
      acl: mobileCommandAcl('linux', ONLY_GET_SETTING),
      app: { debug: false },
    });
    try {
      await expect(host.invoke('get_setting', { key: 'theme' })).resolves.toBeNull();
      await expect(host.invoke('save_setting', { key: 'theme', value: 'dark' })).rejects.toBe('Command save_setting not allowed by ACL');
      await expect(host.invoke('get_setting', { key: 'theme' }, { window: 'quick-assistant', webview: 'quick-assistant' }))
        .rejects.toBe('Command get_setting not allowed by ACL');
      await expect(host.invoke('get_setting', { key: 'theme' }, { window: 'main', webview: 'main', origin: 'https://example.com' }))
        .rejects.toBe('Command get_setting not allowed by ACL');
    } finally {
      await host.dispose();
    }
  });

  it('the shipped manifest refuses a command no mobile plugin declares, even when something registers it', async () => {
    // `test_rmcp_streamable_http` 在契约里有，但 Rust 的 `allow-application-commands` 不含它
    // （`x-rust-registered: false`，前端未调用）：插件即便声明并注册，移动端清单也不会放行。
    // 不能用 `browser_get_surface_host_mode`：`dstu.mobile.compat` 已为它注册降级处理函数。
    const undeclared = definePlugin({
      meta: { id: 'fixture.undeclared', commands: ['test_rmcp_streamable_http'], platforms: ['desktop', 'mobile'] },
      apply(ctx) {
        ctx.commands.register('test_rmcp_streamable_http', () => 'native');
      },
    });
    const host = await createTestHost({ contracts: bundledContracts(), plugins: [undeclared], acl: mobileCommandAcl('linux'), app: { debug: false } });
    try {
      await expect(host.invoke('test_rmcp_streamable_http', { url: 'https://example.com/mcp' })).rejects.toBe('Command test_rmcp_streamable_http not allowed by ACL');
    } finally {
      await host.dispose();
    }
    const open = await createTestHost({ contracts: bundledContracts(), plugins: [undeclared], app: { debug: false } });
    try {
      await expect(open.invoke('test_rmcp_streamable_http', { url: 'https://example.com/mcp' })).resolves.toBe('native');
    } finally {
      await open.dispose();
    }
  });

  it('applies through the mobile shell, the MessagePort and the Worker session', async () => {
    const { port1, port2 } = new MessageChannel();
    const exits: number[] = [];
    const session = serveImportedHost(webMessagePortTransport(port2), {
      contracts: () => bundledContracts(),
      platform: 'mobile',
      acl: app => mobileCommandAcl(app.platform, ONLY_GET_SETTING),
      installs: async () => [{ plugin: settingsPlugin() }],
      exit: code => exits.push(code),
    });
    const shell = new MobileShell({ handshake: { appDataDir: '/deep-student', appVersion: '0.0.0-test', platform: 'linux', debug: false } });
    const invoke = rendererInvoker(shell);
    shell.attach(port1, { onReady: () => undefined, onFatal: () => undefined, onExit: () => undefined });
    try {
      await shell.ready;
      await expect(invoke('get_setting', { key: 'theme' })).resolves.toEqual({ ok: true, body: null });
      await expect(invoke('save_setting', { key: 'theme', value: 'dark' })).resolves.toEqual({ ok: false, body: 'Command save_setting not allowed by ACL' });
    } finally {
      await session.shutdown();
      port1.close();
    }
    expect(exits).toEqual([0]);
  });
});
