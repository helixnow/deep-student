import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createWorkspaceHost } from './host-support.ts';
import { loadWorkspaceRecord, runtimeRootIdentity, saveWorkspaceRecord, workspaceOverlapsDataDir } from '../src/runtime-roots.ts';
import { canonicalPath } from '../src/runtime-paths.ts';

const ID = 'RF-W02-workspace-contains-data-dir';
const REFUSED = 'A read-write agent workspace cannot contain or be inside the application data directory';
const caseInsensitiveFs = fs.existsSync(os.tmpdir().toUpperCase()) && fs.existsSync(os.tmpdir().toLowerCase());

const refusal = (promise: Promise<unknown>) => promise.then(() => 'resolved without an error', (error: unknown) => String(error));

it(`${ID}: chat_v2_set_workspace_root refuses read-write on the data directory, an ancestor or a directory inside it; read-only and a sibling are unchanged`, async () => {
  const { host, storage } = await createWorkspaceHost();
  const sibling = fs.mkdtempSync(path.join(os.tmpdir(), 'w02-ws-sibling-'));
  try {
    const dataDir = host.app.dataDir;
    const plugins = path.join(dataDir, 'plugins');
    fs.mkdirSync(plugins);
    for (const target of [dataDir, path.dirname(dataDir), plugins]) {
      expect(await refusal(host.invoke('chat_v2_set_workspace_root', { path: target, access: 'read_write' }))).toContain(REFUSED);
      expect(loadWorkspaceRecord(host.ctx.settings)).toBeNull();
    }

    const parent = canonicalPath(path.dirname(dataDir));
    const readOnly = await host.invoke('chat_v2_set_workspace_root', { path: parent, access: 'read_only' }) as any[];
    expect(readOnly[0]).toMatchObject({ id: 'workspace', path: parent, configured: true, access: 'read_only' });

    const writable = await host.invoke('chat_v2_set_workspace_root', { path: sibling, access: 'read_write' }) as any[];
    expect(writable[0]).toMatchObject({ id: 'workspace', path: canonicalPath(sibling), configured: true, access: 'read_write' });
  } finally { storage.dispose(); await host.dispose(); fs.rmSync(sibling, { recursive: true, force: true }); }
});

it.skipIf(!caseInsensitiveFs)(`${ID}: on a case-insensitive volume a differently cased ancestor is refused too`, async () => {
  const { host, storage } = await createWorkspaceHost();
  try {
    const upper = path.dirname(host.app.dataDir).toUpperCase();
    expect(await refusal(host.invoke('chat_v2_set_workspace_root', { path: upper, access: 'read_write' }))).toContain(REFUSED);
    expect(loadWorkspaceRecord(host.ctx.settings)).toBeNull();
  } finally { storage.dispose(); await host.dispose(); }
});

it(`${ID}: the overlap check folds case on darwin and win32 only (paths that do not exist, so neither side is realpath'd)`, () => {
  const base = path.join(path.parse(process.cwd()).root, `w02-missing-${process.pid}`);
  const foldsCase = process.platform === 'darwin' || process.platform === 'win32';
  expect(workspaceOverlapsDataDir(path.join(base, 'Work'), path.join(base, 'work', 'Data'))).toBe(foldsCase);
  expect(workspaceOverlapsDataDir(path.join(base, 'WORK', 'data', 'inner'), path.join(base, 'work', 'DATA'))).toBe(foldsCase);
  expect(workspaceOverlapsDataDir(path.join(base, 'work'), path.join(base, 'work', 'data'))).toBe(true);
  expect(workspaceOverlapsDataDir(path.join(base, 'Workspace'), path.join(base, 'work', 'data'))).toBe(false);
});

it(`${ID}: a persisted read-write workspace containing the data directory is downgraded to read-only for listing, tools and revert`, async () => {
  const { host, storage } = await createWorkspaceHost();
  const errors: string[] = [];
  host.ctx.logger.exporter({ levels: { default: 4 }, export(message) { if (message.type === 'error') errors.push(String(message.args[0])); } });
  try {
    const parent = canonicalPath(path.dirname(host.app.dataDir));
    saveWorkspaceRecord(host.ctx.settings, {
      path: parent, label: 'Legacy', access: 'read_write', identity: runtimeRootIdentity(parent, host.ctx.get('nativeWindowsFiles')),
    });

    const listed = await host.invoke('chat_v2_list_runtime_roots', {}) as any[];
    expect(listed[0]).toMatchObject({ id: 'workspace', path: parent, configured: true, access: 'read_only' });
    expect(host.ctx.runtimeRoots.rootById('workspace', { session_id: 'sess' })).toMatchObject({ path: parent, access: 'read_only' });
    const receipt = { change_id: 'c1', root_id: 'workspace', op: 'created', relative_path: 'planted.txt', bytes: 0 };
    expect(await refusal(host.invoke('chat_v2_revert_workspace_change', { sessionId: 'sess', receipt }))).toContain('Workspace root is read-only');
    expect(errors.some(line => line.includes('to read-only'))).toBe(true);
    expect(loadWorkspaceRecord(host.ctx.settings)?.access).toBe('read_write');
  } finally { storage.dispose(); await host.dispose(); }
});

/**
 * The Host reads `<dataDir>/plugins/user.profile.json` through the dataDir path it was handed, not its realpath.
 * A link on that path that lives inside a writable workspace can be replaced by a real directory from the workspace.
 */
function linkedDataDirs() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'w02-ws-link-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'w02-ws-real-'));
  fs.mkdirSync(path.join(outside, 'data'));
  const kind = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(path.join(outside, 'data'), path.join(workspace, 'appdata'), kind);
  fs.symlinkSync(outside, path.join(workspace, 'ancestor'), kind);
  return {
    workspace,
    dataDirs: [path.join(workspace, 'appdata'), path.join(workspace, 'ancestor', 'data')],
    cleanup: () => { for (const dir of [workspace, outside]) fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

it(`${ID}: a data directory reached through a link inside the workspace (the link itself or an ancestor) is refused; an unrelated directory is not`, async () => {
  const { workspace, dataDirs, cleanup } = linkedDataDirs();
  const sibling = fs.mkdtempSync(path.join(os.tmpdir(), 'w02-ws-sibling-'));
  try {
    for (const dataDir of dataDirs) {
      const { host, storage } = await createWorkspaceHost({ dataDir });
      try {
        expect(await refusal(host.invoke('chat_v2_set_workspace_root', { path: workspace, access: 'read_write' }))).toContain(REFUSED);
        expect(loadWorkspaceRecord(host.ctx.settings)).toBeNull();
        const writable = await host.invoke('chat_v2_set_workspace_root', { path: sibling, access: 'read_write' }) as any[];
        expect(writable[0]).toMatchObject({ id: 'workspace', path: canonicalPath(sibling), configured: true, access: 'read_write' });
      } finally { storage.dispose(); await host.dispose(); }
    }
  } finally { cleanup(); fs.rmSync(sibling, { recursive: true, force: true }); }
});

it(`${ID}: a persisted read-write workspace holding a link on the data directory path is downgraded to read-only`, async () => {
  const { workspace, dataDirs, cleanup } = linkedDataDirs();
  try {
    for (const dataDir of dataDirs) {
      const { host, storage } = await createWorkspaceHost({ dataDir });
      try {
        const canonical = canonicalPath(workspace);
        saveWorkspaceRecord(host.ctx.settings, {
          path: canonical, label: 'Linked', access: 'read_write', identity: runtimeRootIdentity(canonical, host.ctx.get('nativeWindowsFiles')),
        });
        const listed = await host.invoke('chat_v2_list_runtime_roots', {}) as any[];
        expect(listed[0]).toMatchObject({ id: 'workspace', path: canonical, configured: true, access: 'read_only' });
        expect(host.ctx.runtimeRoots.rootById('workspace', { session_id: 'sess' })).toMatchObject({ path: canonical, access: 'read_only' });
      } finally { storage.dispose(); await host.dispose(); }
    }
  } finally { cleanup(); }
});
