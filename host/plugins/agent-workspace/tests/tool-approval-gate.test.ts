import fs from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createWorkspaceHost } from './host-support.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
import vfsReposPlugin from '../../vfs-repos/index.ts';
import { immutableCommandGuardForToolCall, shellCommandDecision, effectiveSensitivity,
  resolveLocalShellApprovalArguments, runtimeApprovalScope, vfsFileExists, type LocalShellApprovalDeps,
  type JsonValue } from '../api.ts';

it('local guard and user command policy retain source isolation and sensitivity floors', () => {
  expect(immutableCommandGuardForToolCall({ name: 'mcp_local_shell_execute', arguments: { command: 'rm -rf /' } })).toBeNull();
  expect(immutableCommandGuardForToolCall({ name: 'builtin-local_shell_execute', arguments: { command: 'rm -rf /' } })?.effect).toBe('deny');
  const call = { name: 'builtin-local_shell_execute', arguments: { command: 'pwd' } };
  const allow = { get: () => '{"version":1,"default_effect":"allow","rules":[]}' };
  expect(shellCommandDecision(call, true, allow)?.applyToSensitivity('high')).toBe('low');
  expect(shellCommandDecision(call, false, allow)?.applyToSensitivity('high')).toBe('high');
  expect(shellCommandDecision({ ...call, arguments: { command: 'git status --short' } }, true, allow)?.applyToSensitivity('high')).toBe('high');
  expect(shellCommandDecision(call, true, { get: () => { throw new Error('settings unavailable'); } })?.applyToSensitivity('low')).toBe('medium');
  expect(effectiveSensitivity('high', 'note_read', {}, null)).toBe('high');
  expect(effectiveSensitivity('high', 'note_read', {}, { get: () => { throw new Error('settings unavailable'); } })).toBe('high');
  expect(shellCommandDecision({ name: 'note_read', arguments: {} }, false, allow)).toBeNull();
});

it('vfs existence uses the real L11 owner and preserves missing/failed VFS checks', async () => {
  const { host, storage } = await createWorkspaceHost();
  try {
    expect((await storage.migrations.runAll()).success).toBe(true);
    await host.install(pathsPlugin);
    await host.install(vfsReposPlugin);
    const repos = host.ctx.vfsRepo;
    const db = storage.database('vfs');
    const file = repos.files.createFile(db, 'gate-file-hash', 'gate.txt', 4, 'document', 'text/plain', null);
    const vfs = { database: { getConnSafe: () => storage.database('vfs') } };
    expect(vfsFileExists(file.id, vfs, repos)).toBe(true);
    expect(vfsFileExists('missing-file', vfs, repos)).toBe(false);
    expect(vfsFileExists(file.id, null, repos)).toBeNull();
    const maintenance = await storage.enterMaintenance(['vfs']);
    try { expect(vfsFileExists(file.id, vfs, repos)).toBe(false); }
    finally { maintenance.release(); }
  } finally { await host.dispose(); storage.dispose(); }
});

it('approval binding uses owner authority/group callbacks, clones args and rejects windowless local shell', async () => {
  const { host, storage } = await createWorkspaceHost();
  try {
    const workspace = path.join(host.app.dataDir, 'selected'); fs.mkdirSync(workspace);
    await host.invoke('chat_v2_set_workspace_root', { path: workspace });
    const authorityState = vi.fn(() => ({ authorityMode: 'craft' as const, permissionPreset: 'relaxed' as const }));
    const preferredRuntimeRootId = vi.fn(() => 'temp');
    const warn = vi.fn();
    const deps: LocalShellApprovalDeps = { settings: host.ctx.settings, dataDir: host.app.dataDir,
      authorityState, preferredRuntimeRootId, warn, windowsFiles: host.ctx.get('nativeWindowsFiles') };
    const call = { name: 'builtin-local_shell_execute', arguments: { command: 'echo safe' } };
    expect(resolveLocalShellApprovalArguments(call, { tryWindow: () => null }, 's', null, deps)).toEqual({ ok: false,
      error: 'windowless runtime: local shell approval binding requires a Tauri window' });
    expect(authorityState).not.toHaveBeenCalled();
    expect(resolveLocalShellApprovalArguments({ ...call, name: 'mcp_local_shell_execute' }, { tryWindow: () => null }, 's', null, deps))
      .toEqual({ ok: true, value: null });
    const result = resolveLocalShellApprovalArguments(call, { tryWindow: () => ({}) }, 's', null, deps);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(result.error);
    expect(result.value).toMatchObject({ root_id: 'temp', _runtimeRootAccess: 'read_write', _runtimeRootSessionScoped: true });
    expect(result.value).toMatchObject({ _runtimeRootBinding: expect.stringMatching(/^[a-f0-9]{64}$/),
      _runtimeEnvPlanHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(call.arguments).toEqual({ command: 'echo safe' });
    expect(runtimeApprovalScope(call.name, result.value, 'medium')).toMatchObject({ rootId: 'temp' });
    preferredRuntimeRootId.mockReturnValue('authorized_missing');
    expect(resolveLocalShellApprovalArguments(call, { tryWindow: () => ({}) }, 's', null, deps).ok).toBe(true);
    expect(warn).toHaveBeenCalledWith("[runtime_roots] group preferred runtime root 'authorized_missing' for session 's' is not resolvable on this device; falling back to workspace");
    const denied = resolveLocalShellApprovalArguments(call, { tryWindow: () => ({}) }, 's', null,
      { ...deps, authorityState: () => { throw new Error('authority failed'); } });
    expect(denied).toEqual({ ok: false, error: 'Failed to resolve shell authority: authority failed' });
  } finally { storage.dispose(); await host.dispose(); }
});

it('full-access absolute cwd wins over explicit/group roots without mutating execution arguments', async () => {
  const { host, storage } = await createWorkspaceHost();
  try {
    const cwd = path.join(host.app.dataDir, 'host-cwd'); fs.mkdirSync(cwd);
    const preferred = vi.fn(() => { throw new Error('host cwd must not query group roots'); });
    const args: JsonValue = { command: 'echo safe', root_id: 'workspace', cwd };
    const result = resolveLocalShellApprovalArguments({ name: 'builtin-local_shell_execute', arguments: args },
      { tryWindow: () => ({}) }, 's', null, { settings: host.ctx.settings, dataDir: host.app.dataDir,
        authorityState: () => ({ authorityMode: 'craft', permissionPreset: 'full_access' }), preferredRuntimeRootId: preferred, warn: vi.fn(), windowsFiles: host.ctx.get('nativeWindowsFiles') });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(result.error);
    expect(result.value).toMatchObject({ root_id: 'host', _runtimeReadableRoots: [] });
    expect(args.root_id).toBe('workspace');
    expect(preferred).not.toHaveBeenCalled();
  } finally { storage.dispose(); await host.dispose(); }
});
