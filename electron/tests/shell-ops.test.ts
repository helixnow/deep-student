import { describe, expect, it, vi } from 'vitest';
import { PathResolver } from '../shell/paths.ts';
import { processPlugin } from '../shell/plugins/system.ts';
import { ShellRuntime, type CommandContext } from '../shell/runtime.ts';
import { FsScope } from '../shell/scope.ts';
import { resolveShellOp } from '../shell/shell-ops.ts';

describe('shell op mapping', () => {
  it('maps the L21 purge restart alias to the builtin process command', () => {
    expect(resolveShellOp('process:restart')).toBe('plugin:process|restart');
    expect(resolveShellOp('plugin:process|restart')).toBe('plugin:process|restart');
    expect(resolveShellOp('app.pdfStreamAllowedDirs')).toBe('app.pdfStreamAllowedDirs');
    expect(resolveShellOp('browser.nope')).toBe('browser.nope');
  });

  it('process plugin implements the restart command used by restart_app and purge_all_data', async () => {
    const restart = vi.fn();
    const exit = vi.fn();
    const plugin = processPlugin({ restart, exit });
    expect(Object.hasOwn(plugin, 'restart')).toBe(true);
    const input = { command: 'plugin:process|restart', json: null, raw: null, headers: {} };
    await expect(Promise.resolve(plugin.restart!(input, {} as CommandContext))).resolves.toBeNull();
    expect(restart).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
  });

  it('dispatches the L21 process:restart alias through the real shell runtime', async () => {
    const restart = vi.fn();
    const exit = vi.fn();
    const runtime = new ShellRuntime({
      platform: 'linux',
      debug: false,
      config: {
        productName: 'F2 shell test',
        version: '0.0.0',
        identifier: 'test',
        devUrl: '',
        frontendDist: '',
        windows: [],
        assetScope: { allow: [], deny: [] },
        assetProtocolEnabled: false,
        csp: null,
        macOSPrivateApi: false,
      },
      paths: new PathResolver({
        platform: 'linux',
        env: {},
        fallbackHome: '/tmp',
        identifier: 'test',
        tempDir: '/tmp',
        resourceDir: null,
      }),
      assetScope: new FsScope({ platform: 'linux' }),
      fsScope: new FsScope({ platform: 'linux' }),
      appVersion: '0.0.0',
      localOrigin: 'tauri://localhost',
      log: () => {},
    });
    runtime.registerPlugin('process', processPlugin({ restart, exit }));

    const result = runtime.runBuiltin(
      resolveShellOp('process:restart'),
      { json: null, raw: null, headers: {} },
      { runtime, windowLabel: 'main', webviewLabel: 'main' },
    );
    if (result === undefined) throw new Error('process:restart was not routed to the builtin process plugin');
    await expect(result).resolves.toBeNull();
    expect(restart).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
  });
});
