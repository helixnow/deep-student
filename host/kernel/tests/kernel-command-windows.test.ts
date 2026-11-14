/**
 * SEC-E11（`reviews/ELECTRON-SHELL-SECURITY.md`）：kernel 命令（`plugin:ui|manifest`、`plugin:host|call`、`plugin:host|status`）
 * 不在 ACL 权限表中，此前只要求 origin 为本地，quick-assistant、pomodoro-mini 也能调用社区插件的 `meta.remote` 方法。
 * 现在只对 `main` 窗口的 `main` webview 开放。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { definePlugin, HOST_CALL_COMMAND, HOST_STATUS_COMMAND, UI_MANIFEST_COMMAND, type WindowRef } from '../api.ts';
import { KERNEL_COMMAND_WINDOWS } from '../commands.ts';
import { createTestHost, type TestHost } from '../testing.ts';

const hosts: TestHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
});

async function hostWithRemote(): Promise<TestHost> {
  const host = await createTestHost();
  hosts.push(host);
  await host.runtime.install(definePlugin({
    meta: { id: 'example.remote', provides: ['exampleRemote'], remote: { exampleRemote: ['ping'] } },
    apply(ctx) {
      ctx.provide('exampleRemote', { ping: () => 'pong' });
    },
  }));
  return host;
}

const CALL = { caller: 'example.remote', service: 'exampleRemote', method: 'ping', args: [] };

describe('SEC-E11 kernel commands are limited to the main window', () => {
  it('the allow-list is exactly the main window', () => {
    expect(KERNEL_COMMAND_WINDOWS).toEqual(['main']);
  });

  it('main/main reaches all three kernel commands', async () => {
    const host = await hostWithRemote();
    const main: WindowRef = { window: 'main', webview: 'main' };
    await expect(host.invoke(UI_MANIFEST_COMMAND, {}, main)).resolves.toEqual([]);
    await expect(host.invoke(HOST_STATUS_COMMAND, {}, main)).resolves.toEqual([]);
    await expect(host.invoke(HOST_CALL_COMMAND, CALL, main)).resolves.toBe('pong');
  });

  it('other local windows and non-main webviews are refused like an ACL denial', async () => {
    const host = await hostWithRemote();
    const sources: WindowRef[] = [
      { window: 'quick-assistant', webview: 'quick-assistant' },
      { window: 'pomodoro-mini', webview: 'pomodoro-mini' },
      // A local page in a secondary webview of the main window (browser-content is already remote-only in the shell).
      { window: 'main', webview: 'browser-content' },
      { window: 'quick-assistant', webview: 'main' },
    ];
    for (const source of sources) {
      for (const [cmd, args] of [[UI_MANIFEST_COMMAND, {}], [HOST_STATUS_COMMAND, {}], [HOST_CALL_COMMAND, CALL]] as const) {
        await expect(host.invoke(cmd, args, source), `${cmd} from ${JSON.stringify(source)}`).rejects.toBe(`Command ${cmd} not allowed by ACL`);
      }
    }
  });

  it('a remote origin is refused even in the main window', async () => {
    const host = await hostWithRemote();
    const remote: WindowRef = { window: 'main', webview: 'main', origin: 'https://attacker.example' };
    await expect(host.invoke(HOST_CALL_COMMAND, CALL, remote)).rejects.toBe(`Command ${HOST_CALL_COMMAND} not allowed by ACL`);
  });
});
