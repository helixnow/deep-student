import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import type { NativeWindowsFiles } from '../../../platform/native/windows/api.ts';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createWorkspaceHost } from './host-support.ts';
import nativePlugin from '../../../platform/native/index.ts';
import { memorySettings } from './support.ts';
import { assessAuthorizedRootRiskCanonical, authorizedRootId, canonicalizeExistingDir } from '../src/runtime-paths.ts';
import {
  AUTHORIZED_ROOTS_KEY, WORKSPACE_ROOT_KEY, authorizedRootById, authorizedRoots,
  artifactRoot, authorizedRuntimeRoot, authorizeRuntimeRootPath, configuredWorkspaceRuntimeRoot,
  hostCwdRuntimeRoot, loadAuthorizedRecords, loadWorkspaceRecord, revalidateRuntimeRoot,
  runtimeRootBindingToken, runtimeRootById, runtimeRootIdentity, runtimeRootsForSession,
  setSkillTrust, shellApprovalBindingDigest, shellHostCwdApprovalBinding, skillPackageRuntimeRoot,
  skillTrustKey, tempRoot, validatePersistedRootBinding, validateSkillTrust, validateWorkspaceAccess,
  workspaceRoot, workspaceRuntimeRoot, type RuntimeRootDeps,
} from '../src/runtime-roots.ts';
import {
  WRITE_BACKUP_DIR, createWriteBackup, createWriteBackupFromFile, removeArtifactFile,
  removeSessionFileIrreversible, restoreArtifactFromBackup, safeBackupFileName,
} from '../src/write-backups.ts';
import { canonicalizeSkillPackageRoot } from '../src/skill-packages.ts';
import { encodeRuntimeRootRecord } from '../src/runtime-root-records.ts';

const dirs: string[] = [];
let nativeHost: Awaited<ReturnType<typeof createTestHost>> | undefined;
let windowsFiles: NativeWindowsFiles | undefined;
beforeAll(async () => {
  if (process.platform === 'win32') {
    nativeHost = await createTestHost({ plugins: [nativePlugin] });
    windowsFiles = nativeHost.ctx.nativeWindowsFiles;
  }
});
afterAll(async () => { await nativeHost?.dispose(); });
const tmp = () => { const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'l05-roots-'))); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const deps = (dataDir: string, settings = memorySettings()): RuntimeRootDeps => ({
  settings, dataDir, windowsFiles, skillPaths: { appDataDir: dataDir, home: os.homedir(), dataDir: null, currentDir: process.cwd() },
});
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

const windowsIt = it.skipIf(process.platform !== 'win32');
windowsIt('windows_runtime_root_and_file_identities_use_handle_information', () => {
  const base = tmp();
  const root = path.join(base, 'root');
  fs.mkdirSync(root);
  const canonical = fs.realpathSync.native(root);
  const first = runtimeRootIdentity(canonical, windowsFiles);
  const second = runtimeRootIdentity(canonical, windowsFiles);
  expect(first).toEqual(second);
  expect(first.kind).toBe('windows');
  if (first.kind !== 'windows') return;
  const filePath = path.join(canonical, 'sample.txt');
  fs.writeFileSync(filePath, 'sample');
  const file = windowsFiles!.openRegularFileNoFollow(filePath, 'sample file');
  try {
    const information = file.refreshInformation();
    expect(information.volume_serial_number).toBe(first.volume_serial_number);
    expect(information.file_index).not.toBe(BigInt(first.file_index));
    expect(information.attributes & 0x400).toBe(0);
  } finally {
    file.close();
  }
});

it('authorized_runtime_roots_are_read_only_and_global', () => {
  const base = tmp();
  const canonical = fs.realpathSync.native(base);
  const id = authorizedRootId(canonical);
  const root = authorizedRuntimeRoot({
    id, path: canonical, label: 'Materials', identity: runtimeRootIdentity(canonical, windowsFiles),
  }, true);
  expect(root.id).toBe(id);
  expect(root.kind).toBe('authorized');
  expect(root.access).toBe('read_only');
  expect(root.path).toBe(canonical);
  expect(root.label).toBe('Materials');
  expect(root.session_scoped).toBe(false);
});

it('configured_workspace_roots_are_read_only_and_marked_configured', () => {
  const canonical = fs.realpathSync.native(tmp());
  const root = configuredWorkspaceRuntimeRoot({
    path: canonical, label: 'Study Workspace', access: 'read_only', identity: runtimeRootIdentity(canonical, windowsFiles),
  });
  expect(root.id).toBe('workspace');
  expect(root.kind).toBe('workspace');
  expect(root.access).toBe('read_only');
  expect(root.path).toBe(canonical);
  expect(root.label).toBe('Study Workspace');
  expect(root.session_scoped).toBe(false);
  expect(root.configured).toBe(true);
});

it('configured_workspace_root_is_writable_only_when_explicitly_requested', () => {
  const canonical = fs.realpathSync.native(tmp());
  const root = configuredWorkspaceRuntimeRoot({
    path: canonical, label: 'Writable Workspace', access: 'read_write', identity: runtimeRootIdentity(canonical, windowsFiles),
  });
  expect(root.access).toBe('read_write');
  expect(root.description).toContain('explicit agent write access');
});

it('critical_workspace_locations_cannot_receive_write_access', () => {
  const home = fs.realpathSync.native(os.homedir());
  expect(assessAuthorizedRootRiskCanonical(home)).toBe('critical');
  expect(() => validateWorkspaceAccess(home, 'read_write')).toThrow();
  expect(() => validateWorkspaceAccess(home, 'read_only')).not.toThrow();
});

it('tampered_persisted_critical_workspace_is_downgraded_to_read_only', () => {
  const home = fs.realpathSync.native(os.homedir());
  const settings = memorySettings({
    [WORKSPACE_ROOT_KEY]: encodeRuntimeRootRecord({
      path: home, label: 'Tampered Workspace', access: 'read_write', identity: runtimeRootIdentity(home, windowsFiles),
    }),
  });
  const root = workspaceRoot(settings, undefined, windowsFiles);
  expect(root.configured).toBe(true);
  expect(root.access).toBe('read_only');
});

it('legacy_workspace_record_deserializes_as_read_only', () => {
  const settings = memorySettings({
    [WORKSPACE_ROOT_KEY]: JSON.stringify({ path: '/tmp/project', label: 'Legacy Workspace' }),
  });
  const record = loadWorkspaceRecord(settings);
  expect(record?.access).toBe('read_only');
});

it('skill_package_runtime_roots_are_read_only_and_scoped_by_skill_id', () => {
  const packageDir = path.join(process.cwd(), '.skills', `runtime-root-test-${process.pid}`);
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'SKILL.md'), 'name: Runtime Root Test\n');
  try {
    const root = skillPackageRuntimeRoot('runtime-root-test', packageDir, { appDataDir: tmp() });
    expect(root.id).toBe('skill:runtime-root-test');
    expect(root.kind).toBe('skill_package');
    expect(root.access).toBe('read_only');
    expect(root.path).toBe(fs.realpathSync.native(packageDir));
    expect(root.session_scoped).toBe(false);
  } finally {
    fs.rmSync(packageDir, { recursive: true, force: true });
  }
});

it('persisted_root_binding_rejects_directory_replacement', () => {
  const base = tmp();
  const selected = path.join(base, 'selected');
  const old = path.join(base, 'selected-old');
  fs.mkdirSync(selected);
  const canonical = fs.realpathSync.native(selected);
  const identity = runtimeRootIdentity(canonical, windowsFiles);
  expect(validatePersistedRootBinding(canonical, identity, 'test runtime root', windowsFiles)).toBe(canonical);
  fs.renameSync(selected, old);
  fs.mkdirSync(selected);
  expect(() => validatePersistedRootBinding(canonical, identity, 'test runtime root', windowsFiles)).toThrow();
});

it('stale_workspace_binding_is_listed_but_not_configured', () => {
  const base = tmp();
  const settings = memorySettings();
  const selected = path.join(base, 'workspace');
  const old = path.join(base, 'workspace-old');
  fs.mkdirSync(selected);
  const canonical = fs.realpathSync.native(selected);
  settings.save(WORKSPACE_ROOT_KEY, encodeRuntimeRootRecord({
    path: canonical, label: 'Workspace', access: 'read_only', identity: runtimeRootIdentity(canonical, windowsFiles),
  }));
  fs.renameSync(selected, old);
  fs.mkdirSync(selected);
  const root = workspaceRoot(settings, undefined, windowsFiles);
  expect(root.configured).toBe(false);
  expect(root.path).toBe(canonical);
});

it('concurrent_authorized_root_updates_do_not_lose_records', async () => {
  const base = tmp();
  const settings = memorySettings();
  const roots = Array.from({ length: 8 }, (_, index) => {
    const root = path.join(base, `root-${index}`);
    fs.mkdirSync(root);
    return root;
  });
  await Promise.all(roots.map(async root => authorizeRuntimeRootPath(settings, root, null, windowsFiles)));
  const records = loadAuthorizedRecords(settings);
  expect(records.length).toBe(roots.length);
  expect(records.every(record => record.identity != null)).toBe(true);
});

it('approval_binding_token_changes_with_workspace_and_directory_identity', () => {
  const base = tmp();
  const settings = memorySettings();
  const first = path.join(base, 'first');
  const second = path.join(base, 'second');
  fs.mkdirSync(first); fs.mkdirSync(second);
  const saveWorkspace = (target: string) => {
    const canonical = fs.realpathSync.native(target);
    settings.save(WORKSPACE_ROOT_KEY, encodeRuntimeRootRecord({
      path: canonical, label: 'Workspace', access: 'read_only', identity: runtimeRootIdentity(canonical, windowsFiles),
    }));
  };
  saveWorkspace(first);
  const firstToken = runtimeRootBindingToken(settings, workspaceRoot(settings, undefined, windowsFiles), 'sess-a', windowsFiles);
  saveWorkspace(second);
  const secondRoot = workspaceRoot(settings, undefined, windowsFiles);
  const secondToken = runtimeRootBindingToken(settings, secondRoot, 'sess-a', windowsFiles);
  expect(firstToken).not.toBe(secondToken);

  const writeEnabled = { ...secondRoot, access: 'read_write' as const };
  expect(runtimeRootBindingToken(settings, writeEnabled, 'sess-a', windowsFiles)).not.toBe(secondToken);

  const sessionRoot = {
    id: 'temp', kind: 'temp' as const, path: fs.realpathSync.native(second), access: 'read_write' as const,
    label: 'Temp', description: '', session_scoped: true, configured: false,
  };
  expect(runtimeRootBindingToken(settings, sessionRoot, 'sess-a', windowsFiles)).not.toBe(runtimeRootBindingToken(settings, sessionRoot, 'sess-b', windowsFiles));

  const authorizedPath = path.join(base, 'authorized');
  const oldAuthorized = path.join(base, 'authorized-old');
  fs.mkdirSync(authorizedPath);
  const firstOutcome = authorizeRuntimeRootPath(settings, authorizedPath, null, windowsFiles);
  const firstAuthorized = authorizedRootById(settings, firstOutcome.rootId, windowsFiles);
  expect(firstAuthorized).not.toBeNull();
  const firstAuthorizedToken = runtimeRootBindingToken(settings, firstAuthorized!, 'sess-a', windowsFiles);

  fs.renameSync(authorizedPath, oldAuthorized);
  fs.mkdirSync(authorizedPath);
  const secondOutcome = authorizeRuntimeRootPath(settings, authorizedPath, null, windowsFiles);
  const secondAuthorized = authorizedRootById(settings, secondOutcome.rootId, windowsFiles);
  expect(runtimeRootBindingToken(settings, secondAuthorized!, 'sess-a', windowsFiles)).not.toBe(firstAuthorizedToken);
});

it('shell_binding_changes_when_support_readable_roots_change', () => {
  const cwd = fs.realpathSync.native(tmp());
  const identity = runtimeRootIdentity(cwd, windowsFiles);
  const first: [string, string][] = [['/toolchain/a', 'identity-a']];
  const second: [string, string][] = [['/toolchain/b', 'identity-b']];
  expect(shellApprovalBindingDigest('selected', cwd, identity, first))
    .not.toBe(shellApprovalBindingDigest('selected', cwd, identity, second));
});

it('write_backup_roundtrip_restores_original_content', () => {
  const base = tmp();
  const artifacts = path.join(base, 'artifacts');
  const tempRootPath = path.join(base, 'temp');
  fs.mkdirSync(artifacts); fs.mkdirSync(tempRootPath);
  const relative = path.join('reports', 'summary.md');
  const target = path.join(artifacts, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'v2 content');
  const backupRef = createWriteBackup(tempRootPath, 'summary.md', Buffer.from('v1 content'));
  expect(backupRef.startsWith('.write_backups/')).toBe(true);
  expect(backupRef.endsWith('summary.md')).toBe(true);
  const restored = restoreArtifactFromBackup(artifacts, tempRootPath, relative, backupRef, sha('v2 content'), windowsFiles);
  expect(restored).toBe(Buffer.byteLength('v1 content'));
  expect(fs.readFileSync(target, 'utf8')).toBe('v1 content');
});

it('write_backup_refs_are_unique_for_same_file_name', () => {
  const base = tmp();
  const first = createWriteBackup(base, 'notes.md', Buffer.from('a'));
  const second = createWriteBackup(base, 'notes.md', Buffer.from('b'));
  expect(first).not.toBe(second);
  expect(fs.readFileSync(path.join(base, first), 'utf8')).toBe('a');
  expect(fs.readFileSync(path.join(base, second), 'utf8')).toBe('b');
});

it('write_backup_rejects_oversized_sources_before_streaming', () => {
  const base = tmp();
  const tempRootPath = path.join(base, 'temp');
  fs.mkdirSync(tempRootPath);
  const source = path.join(base, 'oversized.bin');
  fs.writeFileSync(source, '');
  fs.truncateSync(source, 64 * 1024 * 1024 + 1);
  expect(() => createWriteBackupFromFile(tempRootPath, 'oversized.bin', source, windowsFiles)).toThrow();
  expect(fs.existsSync(path.join(tempRootPath, WRITE_BACKUP_DIR))).toBe(false);
});

it('restore_rejects_backup_refs_outside_backup_area', () => {
  const base = tmp();
  const artifacts = path.join(base, 'artifacts');
  const tempRootPath = path.join(base, 'temp');
  fs.mkdirSync(artifacts);
  fs.mkdirSync(path.join(tempRootPath, WRITE_BACKUP_DIR), { recursive: true });
  fs.writeFileSync(path.join(tempRootPath, 'loose.txt'), 'loose');
  fs.writeFileSync(path.join(base, 'outside.txt'), 'outside');
  const relative = 'summary.md';
  for (const ref of [
    path.join(base, 'outside.txt'), '../outside.txt', '.write_backups/../loose.txt',
    'loose.txt', '.write_backups', '.write_backups/missing.txt',
  ]) {
    expect(() => restoreArtifactFromBackup(artifacts, tempRootPath, relative, ref, null, windowsFiles)).toThrow();
  }
});

it('persisted_root_identity_deserializes_across_operating_systems', () => {
  const identities = [
    { kind: 'unix', device: 1, inode: 2 },
    { kind: 'windows', volume_serial_number: 3, file_index: 4 },
    { kind: 'canonical_path', path: '/portable/workspace' },
  ];
  for (const identity of identities) {
    const settings = memorySettings({
      [WORKSPACE_ROOT_KEY]: JSON.stringify({ path: '/tmp/portable', label: 'Portable', access: 'read_only', identity }),
    });
    expect(loadWorkspaceRecord(settings)?.identity).toEqual(identity);
  }
});

it('remove_artifact_file_only_deletes_regular_files_inside_root', () => {
  const base = tmp();
  const artifacts = path.join(base, 'artifacts');
  fs.mkdirSync(path.join(artifacts, 'reports'), { recursive: true });
  const target = path.join(artifacts, 'reports', 'summary.md');
  fs.writeFileSync(target, 'content');
  expect(() => removeArtifactFile(artifacts, 'reports')).toThrow();
  expect(() => removeArtifactFile(artifacts, 'missing.md')).toThrow();
  expect(() => removeArtifactFile(artifacts, '')).toThrow();
  removeArtifactFile(artifacts, path.join('reports', 'summary.md'), sha('content'), windowsFiles);
  expect(fs.existsSync(target)).toBe(false);
});

it('irreversible_session_delete_leaves_no_backup_copy', () => {
  const base = tmp();
  const root = path.join(base, 'session-root');
  fs.mkdirSync(path.join(root, 'stage'), { recursive: true });
  const target = path.join(root, 'stage', 'input.txt');
  fs.writeFileSync(target, 'forget-me');
  removeSessionFileIrreversible(root, 'stage/input.txt', sha('forget-me'), windowsFiles);
  expect(fs.existsSync(target)).toBe(false);
  expect(fs.existsSync(path.join(root, '.workspace_changes'))).toBe(false);
  expect(fs.existsSync(path.join(root, WRITE_BACKUP_DIR))).toBe(false);
});

it('stale_undo_rejects_restore_and_delete', () => {
  const base = tmp();
  const artifacts = path.join(base, 'artifacts');
  const tempRootPath = path.join(base, 'temp');
  fs.mkdirSync(artifacts); fs.mkdirSync(tempRootPath);
  const relative = 'report.md';
  const target = path.join(artifacts, relative);
  fs.writeFileSync(target, 'after-write');
  const expectedAfterHash = sha('after-write');
  const backupRef = createWriteBackup(tempRootPath, 'report.md', Buffer.from('before-write'));
  fs.writeFileSync(target, 'newer-user-edit');
  expect(() => restoreArtifactFromBackup(artifacts, tempRootPath, relative, backupRef, expectedAfterHash, windowsFiles)).toThrow();
  expect(fs.readFileSync(target, 'utf8')).toBe('newer-user-edit');
  expect(() => removeArtifactFile(artifacts, relative, expectedAfterHash, windowsFiles)).toThrow();
  expect(fs.readFileSync(target, 'utf8')).toBe('newer-user-edit');
});

it('backup_file_names_are_sanitized', () => {
  expect(safeBackupFileName('summary.md')).toBe('summary.md');
  expect(safeBackupFileName('a b/c.md')).toBe('a_b_c.md');
  expect(safeBackupFileName('...')).toBe('artifact');
  expect(safeBackupFileName('..secret')).toBe('secret');
});

it('authorize_runtime_root_path_is_idempotent', () => {
  const base = tmp();
  const settings = memorySettings();
  const materials = path.join(base, 'materials');
  fs.mkdirSync(materials);
  const first = authorizeRuntimeRootPath(settings, materials, 'Materials', windowsFiles);
  expect(first.newlyGranted).toBe(true);
  const second = authorizeRuntimeRootPath(settings, materials, 'Materials', windowsFiles);
  expect(second.newlyGranted).toBe(false);
  expect(second.rootId).toBe(first.rootId);
  expect(second.path).toBe(first.path);
});

it('runtime_root_kinds_serialize_for_frontend_contract', () => {
  const base = tmp();
  const settings = memorySettings();
  const workspace = path.join(base, 'workspace');
  fs.mkdirSync(workspace);
  const canonical = fs.realpathSync.native(workspace);
  settings.save(WORKSPACE_ROOT_KEY, encodeRuntimeRootRecord({
    path: canonical, label: 'WS', access: 'read_only', identity: runtimeRootIdentity(canonical, windowsFiles),
  }));
  const packageDir = path.join(base, '.skills', `kind-test-${process.pid}`);
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'SKILL.md'), '---\nname: kind\n---\n');
  try {
    const kinds = [
      workspaceRoot(settings, undefined, windowsFiles).kind,
      authorizedRuntimeRoot({ id: 'authorized_x', path: base, label: 'B', identity: runtimeRootIdentity(base, windowsFiles) }, true).kind,
      skillPackageRuntimeRoot('kind', packageDir, { appDataDir: base }).kind,
      artifactRoot(base, 's', false).kind,
      tempRoot(base, 's', false).kind,
      hostCwdRuntimeRoot(base).kind,
    ];
    expect(kinds).toEqual(['workspace', 'authorized', 'skill_package', 'artifact', 'temp', 'host']);
  } finally {
    fs.rmSync(packageDir, { recursive: true, force: true });
  }
});

it('full_access_absolute_cwd_binding_does_not_require_workspace_root', () => {
  const settings = memorySettings();
  const hostCwd = tmp();
  const binding = shellHostCwdApprovalBinding(settings, 'sess_full_access', hostCwd, windowsFiles);
  expect(binding.rootId).toBe('host');
  expect(binding.rootPath).toBe(fs.realpathSync.native(hostCwd));
  expect(binding.readableRoots).toEqual([]);
});

it('backend_skill_trust_rejects_same_size_script_replacement', () => {
  const base = tmp();
  const packageDir = path.join(base, '.skills', `trust-test-${process.pid}`);
  fs.mkdirSync(path.join(packageDir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'SKILL.md'), '---\nname: external-tools\n---\nBody');
  fs.writeFileSync(path.join(packageDir, 'scripts', 'run.sh'), 'echo safe\n');
  try {
    const options = { appDataDir: base };
    const depsValue: RuntimeRootDeps = { settings: memorySettings(), dataDir: base, skillPaths: options };
    const state = setSkillTrust(depsValue, 'external-tools', packageDir, true);
    expect(state.trusted).toBe(true);
    expect(state.package_sha256).toHaveLength(64);
    const root = skillPackageRuntimeRoot('external-tools', packageDir, options);
    expect(() => validateSkillTrust(depsValue, 'external-tools', root)).not.toThrow();
    fs.writeFileSync(path.join(packageDir, 'scripts', 'run.sh'), 'echo evil\n');
    expect(fs.statSync(path.join(packageDir, 'scripts', 'run.sh')).size).toBe(10);
    expect(() => validateSkillTrust(depsValue, 'external-tools', root)).toThrow();
  } finally {
    fs.rmSync(packageDir, { recursive: true, force: true });
  }
});

it('runtime root helpers feed command-level lookups', () => {
  const base = tmp();
  const settings = memorySettings();
  const workspace = path.join(base, 'workspace');
  fs.mkdirSync(workspace);
  const canonical = fs.realpathSync.native(workspace);
  settings.save(WORKSPACE_ROOT_KEY, encodeRuntimeRootRecord({
    path: canonical, label: 'WS', access: 'read_write', identity: runtimeRootIdentity(canonical, windowsFiles),
  }));
  const value = deps(base, settings);
  const roots = runtimeRootsForSession(value, 'sess', false);
  expect(roots[0]?.path).toBe(canonical);
  expect(runtimeRootById(value, 'sess', null, 'workspace', false).path).toBe(canonical);
  expect(revalidateRuntimeRoot(settings, roots[0]!, windowsFiles)).toBe(canonical);
  expect(canonicalizeExistingDir(` ${workspace} `, 'workspace runtime root')).toBe(canonical);
  expect(authorizedRoots(settings, windowsFiles)).toEqual([]);
  expect(loadWorkspaceRecord(settings)?.label).toBe('WS');
  expect(workspaceRuntimeRoot(loadWorkspaceRecord(settings)!, true).configured).toBe(true);
  expect(hostCwdRuntimeRoot(canonical).id).toBe('host');
  expect(skillTrustKey('x')).toBe('chat_v2.skill_trust.x');
  expect(AUTHORIZED_ROOTS_KEY).toBe('chat_v2.runtime.authorized_roots');
});

it('chat_v2_list_runtime_roots defaults the session and exposes configured roots', async () => {
  const { host, storage } = await createWorkspaceHost();
  try {
    const roots = await host.invoke('chat_v2_list_runtime_roots', {}) as any[];
    expect(roots.map((root: { id: string }) => root.id)).toEqual(['workspace', 'artifacts', 'temp']);
    expect(roots[0].configured).toBe(false);
  } finally { storage.dispose(); await host.dispose(); }
});

it('chat_v2_set_workspace_root rejects critical write access and persists read-only', async () => {
  const { host, storage } = await createWorkspaceHost();
  const base = tmp();
  try {
    await expect(host.invoke('chat_v2_set_workspace_root', { path: base, access: 'read_write' }))
      .resolves.toBeInstanceOf(Array);
    const configured = await host.invoke('chat_v2_set_workspace_root', { path: base, access: 'read_only' }) as any[];
    expect(configured[0]).toMatchObject({ id: 'workspace', path: fs.realpathSync.native(base), configured: true, access: 'read_only' });
    const denied = await host.invoke('chat_v2_set_workspace_root', { path: os.homedir(), access: 'read_write' })
      .then(() => null, (error: unknown) => error);
    expect(String(denied)).toContain('Critical filesystem locations');
    await host.invoke('chat_v2_reset_workspace_root', {});
    const roots = await host.invoke('chat_v2_list_runtime_roots', {}) as any[];
    expect(roots[0].configured).toBe(false);
  } finally { storage.dispose(); await host.dispose(); }
});

it('chat_v2_authorize_revoke_resolve_list_and_read_round trip', async () => {
  const { host, storage } = await createWorkspaceHost();
  const base = tmp();
  try {
    if (process.platform === 'win32' && !host.ctx.get('nativeWindowsFiles')) await host.install(nativePlugin);
    const authorized = await host.invoke('chat_v2_authorize_runtime_root', { path: base, label: 'Materials' }) as any[];
    const entry = authorized.find((root: any) => root.kind === 'authorized');
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({ path: fs.realpathSync.native(base), access: 'read_only', configured: true });
    fs.mkdirSync(path.join(base, 'sub'));
    fs.writeFileSync(path.join(base, 'sub', 'note.txt'), 'hello');
    const page = await host.invoke('chat_v2_list_runtime_directory', { sessionId: 's', rootId: entry.id, relativePath: 'sub' }) as { entries: Array<{ name: string }> };
    expect(page.entries.map((item: { name: string }) => item.name)).toEqual(['note.txt']);
    const resolved = await host.invoke('chat_v2_resolve_runtime_path', { sessionId: 's', rootId: entry.id, relativePath: 'sub/note.txt' });
    expect(resolved).toBe(path.join(fs.realpathSync.native(base), 'sub', 'note.txt'));
    const preview = await host.invoke('chat_v2_read_runtime_file', { sessionId: 's', rootId: entry.id, relativePath: 'sub/note.txt', maxBytes: 2 });
    expect(preview).toEqual({ content: 'he', truncated: true });
    const revoked = await host.invoke('chat_v2_revoke_runtime_root', { rootId: entry.id }) as any[];
    expect(revoked.some((root: any) => root.id === entry!.id)).toBe(false);
  } finally { storage.dispose(); await host.dispose(); }
});

it('chat_v2_revert_artifact_write restores and deletes with hash binding', async () => {
  const { host, storage } = await createWorkspaceHost();
  try {
    if (process.platform === 'win32' && !host.ctx.get('nativeWindowsFiles')) await host.install(nativePlugin);
    const artifacts = path.join(host.app.dataDir, 'chat_v2_artifacts');
    const temp = path.join(host.app.dataDir, 'chat_v2_temp');
    fs.mkdirSync(artifacts, { recursive: true });
    fs.mkdirSync(temp, { recursive: true });
    const { resolveSessionRuntimeRoot } = await import('../src/runtime-paths.ts');
    const artifactRoot = resolveSessionRuntimeRoot(host.app.dataDir, 'chat_v2_artifacts', 's', false);
    const tempRoot = resolveSessionRuntimeRoot(host.app.dataDir, 'chat_v2_temp', 's', false);
    fs.mkdirSync(artifactRoot, { recursive: true });
    fs.mkdirSync(tempRoot, { recursive: true });
    const target = path.join(artifactRoot, 'note.txt');
    fs.writeFileSync(target, 'new');
    const backupRef = createWriteBackup(tempRoot, 'note.txt', Buffer.from('old'));
    const restored = await host.invoke('chat_v2_revert_artifact_write', {
      sessionId: 's', relativePath: 'note.txt', backupRef, expectedAfterHash: sha('new'),
    });
    expect(restored).toMatchObject({ reverted: true, mode: 'restored', root_id: 'artifacts', relative_path: 'note.txt', bytes_restored: 3 });
    expect(fs.readFileSync(target, 'utf8')).toBe('old');
    const deleted = await host.invoke('chat_v2_revert_artifact_write', {
      sessionId: 's', relativePath: 'note.txt', expectedAfterHash: sha('old'),
    });
    expect(deleted).toMatchObject({ reverted: true, mode: 'deleted' });
    expect(fs.existsSync(target)).toBe(false);
  } finally { storage.dispose(); await host.dispose(); }
});

it('chat_v2_revert_workspace_change rolls back a hash-bound write', async () => {
  const { host, storage } = await createWorkspaceHost();
  const base = tmp();
  try {
    await host.invoke('chat_v2_set_workspace_root', { path: base, access: 'read_write' });
    const target = path.join(base, 'note.txt');
    fs.writeFileSync(target, 'agent');
    const receipt = {
      change_id: 'change-1', root_id: 'workspace', op: 'created', relative_path: 'note.txt',
      after_hash: sha('agent'), bytes: 5,
    };
    const result = await host.invoke('chat_v2_revert_workspace_change', { sessionId: 's', receipt });
    expect(result).toMatchObject({ reverted: true, root_id: 'workspace', change_id: 'change-1' });
    expect(fs.existsSync(target)).toBe(false);
    await expect(host.invoke('chat_v2_revert_workspace_change', {
      sessionId: 's', receipt: { ...receipt, root_id: 'temp' },
    })).rejects.toBe('Mutation receipt does not belong to the workspace root');
  } finally { storage.dispose(); await host.dispose(); }
});

it('chat_v2_set_skill_trust trusts and revokes a package', async () => {
  const { host, storage } = await createWorkspaceHost();
  const packageDir = path.join(process.cwd(), '.skills', `cmd-trust-${process.pid}`);
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'SKILL.md'), '---\nname: cmd-trust\n---\nBody');
  try {
    const trusted = await host.invoke('chat_v2_set_skill_trust', {
      skillId: 'cmd-trust', packageRoot: packageDir, trusted: true,
    }) as any;
    expect(trusted).toMatchObject({ skill_id: 'cmd-trust', trusted: true });
    expect(trusted.package_sha256).toHaveLength(64);
    const revoked = await host.invoke('chat_v2_set_skill_trust', {
      skillId: 'cmd-trust', trusted: false,
    });
    expect(revoked).toEqual({ skill_id: 'cmd-trust', trusted: false, package_sha256: null });
  } finally {
    fs.rmSync(packageDir, { recursive: true, force: true });
    await host.dispose();
  }
});

it('canonicalize_skill_package_root requires SKILL.md', () => {
  const base = tmp();
  const packageDir = path.join(process.cwd(), '.skills', `validation-${process.pid}`);
  fs.mkdirSync(packageDir, { recursive: true });
  try {
    expect(() => canonicalizeSkillPackageRoot(packageDir, { appDataDir: base })).toThrow(/missing SKILL.md/);
    fs.writeFileSync(path.join(packageDir, 'SKILL.md'), '---\nname: x\n---\n');
    expect(canonicalizeSkillPackageRoot(packageDir, { appDataDir: base })).toBe(fs.realpathSync.native(packageDir));
  } finally {
    fs.rmSync(packageDir, { recursive: true, force: true });
  }
});
