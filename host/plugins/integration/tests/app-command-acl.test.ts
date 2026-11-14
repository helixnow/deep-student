import { expect, it } from 'vitest';
import { CapabilityAcl } from '../../../kernel/acl.ts';
import { definePlugin } from '../../../kernel/api.ts';
import type { LaneContract } from '../../../kernel/contract.ts';
import type { WindowRef } from '../../../kernel/protocol.ts';
import { createTestHost } from '../../../kernel/testing.ts';

/** The Rust test registers `test_mcp_connection` only to observe ACL gating. */
const ACL_CONTRACT: LaneContract = {
  lane: 'L22-app-commands',
  generator: 'hand-written app_command_acl fixture',
  commands: [{
    name: 'test_mcp_connection',
    lane: 'L22-app-commands',
    rust: { file: 'tests/app_command_acl.rs', line: 10, fn: 'test_mcp_connection' },
    async: false,
    args: [],
    injected: [],
    result: { type: 'string' },
    frontend: 'none',
  }],
  events: [],
  $defs: {},
};

function platform(): 'darwin' | 'win32' | 'linux' {
  return process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin';
}

async function captured(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

it('app_acl_blocks_remote_browser_content_and_allows_local_main', async () => {
  let executed = false;
  const fixture = definePlugin({
    meta: {
      id: 'integration.app-command-acl-fixture',
      lane: 'L22-app-commands',
      commands: ['test_mcp_connection'],
    },
    apply(ctx) {
      ctx.commands.register('test_mcp_connection', () => {
        executed = true;
        return 'executed';
      });
    },
  });
  const host = await createTestHost({
    acl: CapabilityAcl.fromDirectory(platform()),
    plugins: [fixture],
    contracts: [ACL_CONTRACT],
  });
  try {
    const browserContent: WindowRef = { window: 'browser-content', webview: 'browser-content' };
    const remoteBrowser = await captured(host.invoke(
      'test_mcp_connection',
      {},
      { ...browserContent, origin: 'https://attacker.invalid/' },
    ));
    expect(remoteBrowser, 'remote app command invocation was allowed').toBeDefined();
    expect(executed, 'ACL rejection happened after the application command executed').toBe(false);

    const localOriginInBrowser = await captured(host.invoke('test_mcp_connection', {}, browserContent));
    expect(localOriginInBrowser, 'browser-content window received application command access').toBeDefined();
    expect(executed).toBe(false);

    const main: WindowRef = { window: 'main', webview: 'main' };
    const remoteOriginInMain = await captured(host.invoke(
      'test_mcp_connection',
      {},
      { ...main, origin: 'https://attacker.invalid/' },
    ));
    expect(remoteOriginInMain, 'remote origin received application command access in main').toBeDefined();
    expect(executed).toBe(false);

    await expect(host.invoke('test_mcp_connection', {}, main)).resolves.toBe('executed');
    expect(executed).toBe(true);
  } finally {
    await host.dispose();
  }
});
