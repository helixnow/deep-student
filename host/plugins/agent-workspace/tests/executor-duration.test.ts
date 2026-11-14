import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createWorkspaceHost } from './host-support.ts';
import type { ToolResultInfo } from '../src/tools/shared.ts';

afterEach(() => { vi.restoreAllMocks(); });

it.each([-3_600_000, 86_400_000])('factory executors report integer monotonic durations across a wall-clock jump of %s ms', async jump => {
  const { host, storage } = await createWorkspaceHost();
  try {
    let wall = 1_700_000_000_000;
    let monotonic = 100.125;
    const saved = vi.fn();
    const ended = vi.fn();
    const started = vi.fn(() => { wall += jump; monotonic = 137.99; });
    const context = { sessionId: 'clock', dataDir: host.app.dataDir, settings: host.ctx.settings,
      block_id: 'clock-block', emitToolCallStart: started, emitToolCallEnd: ended, saveToolBlock: saved };
    const tools = host.ctx.agentWorkspaceTools;
    const call = { id: 'clock-call', name: 'unknown_clock_tool', arguments: null };
    const runs: Array<[string, () => Promise<ToolResultInfo<unknown>>]> = [
      ['workspace', () => tools.createWorkspace(context).execute(call)],
      ['workspace-fs', () => tools.createWorkspaceFs().execute(call, context)],
      ['git', () => tools.createGit().execute(call, context)],
      ['file-manager', () => tools.createFileManager().execute(call, context)],
      ['code-navigation', () => tools.createCodeNavigation().execute(call, context)],
      ['lsp', () => tools.createLsp().execute(call, context)],
      ['root-request', () => tools.createRuntimeRootRequest().execute(call, context)],
      ['shell', () => tools.createShell().execute(call, context)],
      ['preflight', () => tools.createShellPreflight().execute(call, context)],
    ];
    vi.spyOn(Date, 'now').mockImplementation(() => wall);
    vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
    for (const [name, run] of runs) {
      wall = 1_700_000_000_000; monotonic = 100.125;
      started.mockClear(); saved.mockClear(); ended.mockClear();
      const result = await run();
      expect(started, name).toHaveBeenCalledOnce();
      expect(result.durationMs, name).toBe(37);
      expect(saved, name).toHaveBeenCalledWith(expect.objectContaining({ durationMs: 37 }));
      if (result.success) expect(ended, name).toHaveBeenCalledWith(expect.objectContaining({ durationMs: 37 }));
    }
  } finally { vi.restoreAllMocks(); storage.dispose(); await host.dispose(); }
});

it('successful artifact execution shares its monotonic duration with the event and persisted tool result', async () => {
  const { host, storage } = await createWorkspaceHost();
  try {
    let wall = 1_700_000_000_000;
    let monotonic = 200.75;
    const saved = vi.fn();
    const ended = vi.fn();
    vi.spyOn(Date, 'now').mockImplementation(() => wall);
    vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
    const result = await host.ctx.agentWorkspaceTools.createWorkspaceFs().execute({ id: 'write', name: 'workspace_artifact_write',
      arguments: { path: 'clock.txt', content: 'clock content' } }, {
      sessionId: 'clock', dataDir: host.app.dataDir, settings: host.ctx.settings,
      emitToolCallStart: () => { wall -= 3_600_000; monotonic = 242.875; },
      emitToolCallEnd: ended, saveToolBlock: saved,
    });
    expect(result.success, result.error).toBe(true);
    expect(result.durationMs).toBe(42);
    expect(ended).toHaveBeenCalledWith(expect.objectContaining({ durationMs: 42 }));
    expect(saved).toHaveBeenCalledWith(expect.objectContaining({ success: true, durationMs: 42 }));
  } finally { vi.restoreAllMocks(); storage.dispose(); await host.dispose(); }
});

it.skipIf(process.platform !== 'linux')('real shell process output uses monotonic integer milliseconds', async () => {
  const { host, storage } = await createWorkspaceHost();
  try {
    const cwd = path.join(host.app.dataDir, 'clock-shell');
    fs.mkdirSync(cwd);
    vi.spyOn(Date, 'now').mockReturnValueOnce(1_700_000_000_000).mockReturnValue(1_699_996_400_000);
    vi.spyOn(performance, 'now').mockReturnValueOnce(100.125).mockReturnValue(137.99);
    const output = await host.ctx.agentWorkspaceTools.createShell().executeShell({ command: 'printf clock', cwd,
      track_file_changes: false, inherit_env: false, timeout_ms: 5000 }, {
      sessionId: 'clock', dataDir: host.app.dataDir, settings: host.ctx.settings,
      authority: ['craft', 'full_access'],
    });
    expect(output).toMatchObject({ success: true, stdout: 'clock', duration_ms: 37 });
  } finally { vi.restoreAllMocks(); storage.dispose(); await host.dispose(); }
});
