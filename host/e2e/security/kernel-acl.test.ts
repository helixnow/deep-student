/**
 * Host-side half of the renderer command surface: the kernel `CapabilityAcl` loaded from the real
 * `resources/app/capabilities` + `resources/app/permissions`, and the kernel-command origin and window rules in
 * `host/kernel/commands.ts`. These guard the parts that already match Tauri; the shell built-ins
 * that bypass this ACL are covered in `shell-builtin-acl.test.ts`.
 *
 * Issue ids refer to `reviews/ELECTRON-SHELL-SECURITY.md`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { definePlugin, HOST_CALL_COMMAND, HOST_STATUS_COMMAND, UI_MANIFEST_COMMAND } from '../../kernel/api.ts';
import { CapabilityAcl } from '../../kernel/acl.ts';
import { KERNEL_COMMAND_WINDOWS } from '../../kernel/commands.ts';
import { createTestHost, type TestHost } from '../../kernel/testing.ts';
import type { WindowRef } from '../../kernel/protocol.ts';

const TAURI_DIR = join(import.meta.dirname, '../../../resources/app');
const platform = process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux';
const acl = CapabilityAcl.fromDirectory(platform, TAURI_DIR);

const MAIN: WindowRef = { window: 'main', webview: 'main' };
const REMOTE_CONTENT: WindowRef = { window: 'main', webview: 'browser-content', origin: 'https://attacker.example' };
const QUICK: WindowRef = { window: 'quick-assistant', webview: 'quick-assistant' };

const hosts: TestHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
});

describe('SEC-E01 [W01] kernel ACL for Host commands', () => {
  it('SEC-E01 [W01] application commands are refused for a remote page in browser-content', () => {
    expect(acl.denial('save_setting', MAIN, false)).toBeNull();
    expect(acl.denial('save_setting', REMOTE_CONTENT, false)).toBe('Command save_setting not allowed by ACL');
    expect(acl.denial('textbooks_add', REMOTE_CONTENT, false)).toBe('Command textbooks_add not allowed by ACL');
  });

  it('SEC-E01 [W01] browser-content keeps only the trusted-input command, and only for http(s) origins', () => {
    expect(acl.denial('browser_content_user_input', REMOTE_CONTENT, false)).toBeNull();
    expect(acl.denial('browser_content_user_input', { ...REMOTE_CONTENT, origin: 'null' }, false)).not.toBeNull();
  });

  it('SEC-E03 [W01] the quick-assistant window reaches its own commands but not main-only ones', () => {
    expect(acl.denial('save_setting', QUICK, false)).toBeNull();
    expect(acl.denial('textbooks_add', QUICK, false)).toBe('Command textbooks_add not allowed by ACL');
  });

  it('SEC-E01 [W01] kernel commands (plugin:host|*, plugin:ui|*) are refused for remote origins', async () => {
    const host = await createTestHost({ acl });
    hosts.push(host);
    await expect(host.invoke('plugin:host|status', {}, MAIN)).resolves.toEqual([]);
    await expect(host.invoke('plugin:host|status', {}, REMOTE_CONTENT)).rejects.toBe('Command plugin:host|status not allowed by ACL');
    await expect(host.invoke('plugin:host|call', { service: 'x', method: 'y', args: [] }, REMOTE_CONTENT)).rejects.toBe('Command plugin:host|call not allowed by ACL');
  });
});

/** Every window and webview label the real Tauri capabilities grant anything to, on any platform. */
function capabilityLabels(): string[] {
  const labels = new Set<string>();
  const dir = join(TAURI_DIR, 'capabilities');
  for (const file of readdirSync(dir).filter(name => name.endsWith('.json'))) {
    const capability = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { windows?: string[]; webviews?: string[] };
    for (const label of [...(capability.windows ?? []), ...(capability.webviews ?? [])]) labels.add(label);
  }
  return [...labels].sort();
}

const KERNEL_COMMANDS = [
  [UI_MANIFEST_COMMAND, {}],
  [HOST_STATUS_COMMAND, {}],
  [HOST_CALL_COMMAND, { caller: 'example.remote', service: 'exampleRemote', method: 'ping', args: [] }],
] as const;
const denied = (cmd: string) => `Command ${cmd} not allowed by ACL`;

describe('SEC-E11 [W01] kernel commands are limited to the main window', () => {
  async function hostWithRemote(hostCallCaller?: 'warn' | 'require'): Promise<{ host: TestHost; pings: () => number }> {
    let pings = 0;
    const host = await createTestHost({ acl, ...(hostCallCaller ? { hostCallCaller } : {}) });
    hosts.push(host);
    // The SEC-E11 scenario: a community plugin exposes a method to UI through meta.remote.
    await host.runtime.install(definePlugin({
      meta: { id: 'example.remote', provides: ['exampleRemote'], remote: { exampleRemote: ['ping'] } },
      apply(ctx) {
        ctx.provide('exampleRemote', { ping: () => { pings++; return 'pong'; } });
      },
    }));
    return { host, pings: () => pings };
  }

  it('SEC-E11 [W01] the capability labels other than main are exactly the auxiliary windows and browser-content', () => {
    expect(KERNEL_COMMAND_WINDOWS).toEqual(['main']);
    expect(capabilityLabels().filter(label => !KERNEL_COMMAND_WINDOWS.includes(label))).toEqual(['browser-content', 'pomodoro-mini', 'quick-assistant']);
  });

  it('SEC-E11 [W01] the main window reaches all three kernel commands and the meta.remote method', async () => {
    const { host, pings } = await hostWithRemote();
    await expect(host.invoke(UI_MANIFEST_COMMAND, {}, MAIN)).resolves.toEqual([]);
    await expect(host.invoke(HOST_STATUS_COMMAND, {}, MAIN)).resolves.toEqual([]);
    await expect(host.invoke(HOST_CALL_COMMAND, KERNEL_COMMANDS[2][1], MAIN)).resolves.toBe('pong');
    expect(pings()).toBe(1);
  });

  it('SEC-E11 [W01] every other capability label is refused every kernel command, while the real ACL still grants it its own commands', async () => {
    const { host, pings } = await hostWithRemote();
    // Positive controls from the real capabilities: the refusal comes from the kernel window rule, not from an unknown window.
    expect(acl.denial('save_setting', QUICK, false)).toBeNull();
    expect(acl.denial('get_setting', { window: 'pomodoro-mini', webview: 'pomodoro-mini' }, false)).toBeNull();
    expect(acl.denial('browser_content_user_input', REMOTE_CONTENT, false)).toBeNull();
    for (const label of capabilityLabels().filter(label => !KERNEL_COMMAND_WINDOWS.includes(label))) {
      const sources: WindowRef[] = [
        { window: label, webview: label },
        // A webview of the main window, and the main webview label inside another window.
        { window: 'main', webview: label },
        { window: label, webview: 'main' },
      ];
      for (const source of sources) {
        for (const [cmd, args] of KERNEL_COMMANDS) {
          await expect(host.invoke(cmd, args, source), `${cmd} from ${JSON.stringify(source)}`).rejects.toBe(denied(cmd));
        }
      }
    }
    expect(pings()).toBe(0);
  });

  it('SEC-E11 [W01] the window rule runs before argument and caller checks, so refused windows learn nothing about services', async () => {
    const { host, pings } = await hostWithRemote('require');
    for (const args of [{ service: 'exampleRemote', method: 'ping', args: [] }, { service: 'ghost', method: 'x', args: [] }, 'not-an-object', { caller: 42 }]) {
      await expect(host.invoke(HOST_CALL_COMMAND, args, QUICK), JSON.stringify(args)).rejects.toBe(denied(HOST_CALL_COMMAND));
    }
    // Same text as an ACL denial of an application command the window lacks.
    expect(acl.denial('textbooks_add', QUICK, false)).toBe(denied('textbooks_add'));
    // The main window still gets the argument errors.
    await expect(host.invoke(HOST_CALL_COMMAND, { service: 'exampleRemote', method: 'ping', args: [] }, MAIN)).rejects.toMatchObject({ error_type: 'Validation' });
    expect(pings()).toBe(0);
  });
});
