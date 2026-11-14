import fs from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { definePlugin } from '../../../kernel/api.ts';
import nativePlugin from '../../../platform/native/index.ts';
import type { NativeRegex } from '../../../platform/native/regex/api.ts';
import { createWorkspaceHost } from './host-support.ts';

it('X4 W08 code navigation uses the current Context regex provider, including replacement', async () => {
  const { host, storage } = await createWorkspaceHost({ native: false });
  try {
    await host.install(nativePlugin);
    const real = host.ctx.nativeRegex;
    const windowsFiles = host.ctx.nativeWindowsFiles;
    const executor = host.ctx.agentWorkspaceTools.createCodeNavigation();
    const root = path.join(host.app.dataDir, 'code');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'unicode.rs'), '😀 中文１２\nAlpha\n');
    await host.invoke('chat_v2_set_workspace_root', { path: root });
    const context = { sessionId: 'search-session', settings: host.ctx.settings, dataDir: host.app.dataDir };
    const call = { id: 'call', name: 'workspace_text_search', arguments: { query: '(?P<word>\\w+)', regex: true } };
    const result = await executor.execute(call, context);
    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ matches: [
      { path: 'unicode.rs', line: 1, column: 3, text: '😀 中文１２' },
      { path: 'unicode.rs', line: 2, column: 1, text: 'Alpha' },
    ] });
    await host.unload('dstu.native');
    // This test replaces only regex; retain the real file-identity provider on Windows.
    if (process.platform === 'win32') host.ctx.provide('nativeWindowsFiles', windowsFiles);
    const unavailable = await executor.execute(call, context);
    expect(unavailable.success).toBe(false);
    expect(unavailable.error).toContain('nativeRegex');
    const compile = vi.fn((pattern: string) => real.compile(pattern));
    const captures = vi.fn<NativeRegex['captures']>((pattern, text) => real.captures(pattern, text));
    await host.install(definePlugin({
      meta: { id: 'test.regex-replacement', commands: [], provides: ['nativeRegex'] },
      apply(ctx) { ctx.provide('nativeRegex', { ...real, compile, captures }); },
    }));
    const insensitive = await executor.execute({ ...call, arguments: { query: 'alpha', case_sensitive: false } }, context);
    expect(insensitive.success).toBe(true);
    expect(insensitive.output).toMatchObject({ match_count: 1, matches: [{ line: 2, column: 1, text: 'Alpha' }] });
    expect(compile).toHaveBeenCalledWith('(?i)alpha');
    expect(captures).toHaveBeenCalled();
    const invalid = await executor.execute({ ...call, arguments: { query: '(?=x)', regex: true } }, context);
    expect(invalid.success).toBe(false);
    expect(invalid.error).toContain('Invalid search regex:');
    expect(invalid.error).toContain('look-around');
  } finally {
    storage.dispose();
    await host.dispose();
  }
});
