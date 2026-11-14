import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { loadStartupProfile, OFFICIAL_PROFILE_PATH } from '../../../kernel/profile.ts';
import { PluginAdmin } from '../../../kernel/plugin-admin.ts';
import { UserProfileStore } from '../../../kernel/profile-store.ts';
import { BackendEventsSink, ChatV2Emitter } from '../../chat/api.ts';
import type { ChatExecutionContext, ToolExecutor, ToolResultInfo } from '../../chat/api.ts';
import { ignoresBroadApprovalBypassForArgs, neverRememberApprovalForArgs } from '../api.ts';
import { LaneToolContribution } from '../src/tools/lane-tool-contributions.ts';
import { buildSandboxPolicy, defaultShellExecuteOptions, protectHostPluginDir, type ShellExecuteContext } from '../src/tools/shell-execute/context.ts';
import { buildEnvPlan } from '../src/tools/shell-env.ts';
import type { SandboxPolicy } from '../src/tools/shell-sandbox.ts';
import type { RuntimeRoot } from '../api.ts';
import { pathHolders } from '../src/tools/shell-execute/snapshots.ts';
import { runtimeRootIdentity, saveWorkspaceRecord } from '../src/runtime-roots.ts';
import { canonicalPath } from '../src/runtime-paths.ts';
import { POSIX_SANDBOX } from './posix-sandbox.ts';

const posixSandbox = POSIX_SANDBOX.available;
const PLUGIN_DIR_CWD_REFUSAL = 'Refusing to run with this writable cwd: it contains the Host app data directory or a '
  + 'directory on the way to its plugin directory (<app data>/plugins), or lies inside that plugin directory. The Host '
  + 'imports code from <app data>/plugins with full privileges at startup, so sandboxed commands cannot write there or '
  + 'rename or replace any directory on its path. Run the command with a cwd that is outside <app data>/plugins and does '
  + 'not contain <app data>.';
const READ_ONLY_WORKSPACE_REFUSAL = "Runtime root 'workspace' is read-only for the agent runtime, but this command looks "
  + 'write-capable. Run writes inside root_id=artifacts or root_id=temp, or ask the user to perform this change manually.';
const tempBase = (): string => (fs.existsSync('/tmp/opencode') ? '/tmp/opencode' : os.tmpdir());

describe('RF-S01-shell-host-plugin-dir-protected (sandbox policy)', () => {
  let root: string;
  beforeAll(() => { root = fs.mkdtempSync(path.join(tempBase(), 's01-plugin-policy-')); });
  afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });
  const refusal = (writable: string, data: string): string | null => {
    try { protectHostPluginDir([writable], data); return null; }
    catch (error) { return (error as Error).message; }
  };
  const canonical = (target: string): string => fs.realpathSync.native(target);

  it('RF-S01-shell-host-plugin-dir-protected: the sandbox policy refuses a writable root inside the Host plugin directory, also when the directory is a symlink, and leaves disjoint roots and temp roots inside the data directory alone', () => {
    const case_ = fs.mkdtempSync(path.join(root, 'inside-'));
    const data = path.join(case_, 'data');
    const real = path.join(case_, 'elsewhere', 'plugins');
    fs.mkdirSync(path.join(real, 'community.demo'), { recursive: true });
    fs.mkdirSync(path.join(data, 'temp', 'sess_x'), { recursive: true });
    fs.symlinkSync(real, path.join(data, 'plugins'), 'junction');
    const target = canonical(real);
    expect([refusal(target, data), refusal(path.join(target, 'community.demo'), data)])
      .toEqual([PLUGIN_DIR_CWD_REFUSAL, PLUGIN_DIR_CWD_REFUSAL]);

    fs.mkdirSync(path.join(case_, 'other'));
    expect([refusal(canonical(path.join(case_, 'other')), data), refusal(canonical(path.join(data, 'temp', 'sess_x')), data)])
      .toEqual([null, null]);
    expect(() => protectHostPluginDir([], path.join(case_, 'missing-data'))).not.toThrow();
  });

  it('RF-S01-shell-host-plugin-dir-protected: the sandbox policy refuses a writable root that contains the data directory, the real plugin directory or a directory the data directory path goes through, so nothing on the way to plugins can be renamed or replaced', () => {
    const case_ = fs.mkdtempSync(path.join(root, 'covering-'));
    const data = path.join(case_, 'data');
    fs.mkdirSync(path.join(data, 'plugins'), { recursive: true });
    expect([refusal(canonical(case_), data), refusal(canonical(data), data)])
      .toEqual([PLUGIN_DIR_CWD_REFUSAL, PLUGIN_DIR_CWD_REFUSAL]);

    const linked = path.join(case_, 'linked-data');
    const real = path.join(case_, 'elsewhere', 'plugins');
    fs.mkdirSync(real, { recursive: true });
    fs.mkdirSync(linked);
    fs.symlinkSync(real, path.join(linked, 'plugins'), 'junction');
    expect([refusal(canonical(linked), linked), refusal(canonical(path.dirname(real)), linked)])
      .toEqual([PLUGIN_DIR_CWD_REFUSAL, PLUGIN_DIR_CWD_REFUSAL]);

    const holder = path.join(case_, 'holder');
    const realData = path.join(case_, 'real-data');
    fs.mkdirSync(path.join(realData, 'plugins'), { recursive: true });
    fs.mkdirSync(holder);
    fs.symlinkSync(realData, path.join(holder, 'data-link'), 'junction');
    expect(refusal(canonical(holder), path.join(holder, 'data-link'))).toBe(PLUGIN_DIR_CWD_REFUSAL);
  });

  it('RF-S01-shell-host-plugin-dir-protected: the sandbox policy refuses a writable root that holds any link the data directory or plugin directory path resolves through, also behind another link, and leaves a sibling of that root alone', () => {
    const case_ = fs.mkdtempSync(path.join(root, 'hops-'));
    const outer = path.join(case_, 'outer');
    const mid = path.join(case_, 'mid');
    const real = path.join(case_, 'real');
    fs.mkdirSync(path.join(real, 'data', 'plugins'), { recursive: true });
    fs.mkdirSync(outer);
    fs.mkdirSync(path.join(mid, 'sibling'), { recursive: true });
    fs.symlinkSync(real, path.join(mid, 'link2'), 'junction');
    fs.symlinkSync(path.join(mid, 'link2'), path.join(outer, 'link1'), 'junction');
    const twoHops = path.join(outer, 'link1', 'data');
    expect([refusal(canonical(mid), twoHops), refusal(canonical(outer), twoHops), refusal(canonical(path.join(mid, 'sibling')), twoHops)])
      .toEqual([PLUGIN_DIR_CWD_REFUSAL, PLUGIN_DIR_CWD_REFUSAL, null]);

    const data = path.join(case_, 'data');
    const holder = path.join(case_, 'holder');
    const store = path.join(case_, 'store');
    fs.mkdirSync(path.join(store, 'plugins-real'), { recursive: true });
    fs.mkdirSync(data);
    fs.mkdirSync(path.join(holder, 'sibling'), { recursive: true });
    fs.symlinkSync(store, path.join(holder, 'hop'), 'junction');
    fs.symlinkSync(path.join(holder, 'hop', 'plugins-real'), path.join(data, 'plugins'), 'junction');
    expect([refusal(canonical(holder), data), refusal(canonical(path.join(holder, 'sibling')), data)])
      .toEqual([PLUGIN_DIR_CWD_REFUSAL, null]);

    const dangling = path.join(case_, 'dangling-data');
    const workspace = path.join(case_, 'workspace');
    fs.mkdirSync(dangling);
    fs.mkdirSync(workspace);
    fs.symlinkSync(path.join(workspace, 'later', 'plugins'), path.join(dangling, 'plugins'), 'junction');
    expect(refusal(canonical(workspace), dangling)).toBe(PLUGIN_DIR_CWD_REFUSAL);
  });

  // realpath keeps the /System/Volumes/Data firmlink spelling, so only (dev, ino) tells it is the same directory.
  it.skipIf(process.platform !== 'darwin' || !fs.existsSync('/System/Volumes/Data'))('RF-S01-shell-host-plugin-dir-protected: the sandbox policy also compares directories by (dev, ino), so a firmlink alias of a writable root that contains the data directory or lies inside plugins is refused', () => {
    const case_ = canonical(fs.mkdtempSync(path.join(root, 'alias-')));
    const data = path.join(case_, 'data');
    fs.mkdirSync(path.join(data, 'plugins', 'community.demo'), { recursive: true });
    fs.mkdirSync(path.join(case_, 'other'));
    const alias = (target: string): string => path.join('/System/Volumes/Data', target);
    expect(canonical(alias(case_))).toBe(alias(case_));
    expect([refusal(alias(case_), data), refusal(alias(path.join(data, 'plugins', 'community.demo')), data),
      refusal(alias(path.join(case_, 'other')), data)]).toEqual([PLUGIN_DIR_CWD_REFUSAL, PLUGIN_DIR_CWD_REFUSAL, null]);
  });

  it('RF-S01-shell-host-plugin-dir-protected: buildSandboxPolicy refuses a read-write cwd that contains the data directory whatever the Host did to the workspace record, and builds the policy for a subdirectory cwd or a read-only root', () => {
    const workspace = canonical(fs.mkdtempSync(path.join(root, 'wiring-')));
    const data = path.join(workspace, 'app-data');
    const sub = path.join(workspace, 'sub');
    fs.mkdirSync(path.join(data, 'plugins'), { recursive: true });
    fs.mkdirSync(sub);
    const values = new Map<string, string>();
    const ctx: ShellExecuteContext = { sessionId: 'sess_wiring', dataDir: data, settings: {
      get: key => values.get(key) ?? null, save: (key, value) => { values.set(key, value); }, delete: key => values.delete(key),
    } };
    const selected: RuntimeRoot = { id: 'workspace', kind: 'workspace', path: workspace, access: 'read_write', label: 'Workspace',
      description: 'User-selected workspace root with explicit agent write access.', session_scoped: false, configured: true };
    const build = (root_: RuntimeRoot, cwd: string): SandboxPolicy | string => {
      try { return buildSandboxPolicy(ctx, root_, cwd, null, buildEnvPlan({}), false, defaultShellExecuteOptions()); }
      catch (error) { return (error as Error).message; }
    };
    expect(build(selected, workspace)).toBe(PLUGIN_DIR_CWD_REFUSAL);
    expect(build(selected, sub)).toMatchObject({ writable_roots: [sub] });
    expect(build({ ...selected, access: 'read_only' }, workspace)).toMatchObject({ writable_roots: [] });
  });

  // Relative symbolic links need the symlink privilege on Windows; junctions are always absolute.
  it.skipIf(process.platform === 'win32')('pathHolders follows relative link targets with .. from the directory holding the link, keeps the holder of a missing entry and fails with ELOOP on a link cycle', () => {
    const case_ = canonical(fs.mkdtempSync(path.join(root, 'holders-')));
    fs.mkdirSync(path.join(case_, 'store', 'data'), { recursive: true });
    fs.mkdirSync(path.join(case_, 'holder', 'inner'), { recursive: true });
    fs.symlinkSync(path.join('..', 'inner', '..', '..', 'store'), path.join(case_, 'holder', 'inner', 'rel'));
    const ancestors = pathHolders(case_);
    expect(pathHolders(path.join(case_, 'holder', 'inner', 'rel', 'data', 'missing', 'plugins'))).toEqual([
      ...ancestors, case_, path.join(case_, 'holder'), path.join(case_, 'holder', 'inner'), path.join(case_, 'store'),
      path.join(case_, 'store', 'data'),
    ]);

    fs.symlinkSync(path.join(case_, 'loop-b'), path.join(case_, 'loop-a'));
    fs.symlinkSync(path.join(case_, 'loop-a'), path.join(case_, 'loop-b'));
    expect(() => pathHolders(path.join(case_, 'loop-a', 'data'))).toThrow(expect.objectContaining({ code: 'ELOOP' }));
    expect(() => pathHolders(path.join(case_, 'store'), 0)).not.toThrow();
    expect(() => pathHolders(path.join(case_, 'holder', 'inner', 'rel'), 0)).toThrow(expect.objectContaining({ code: 'ELOOP' }));
  });
});

type Host = Awaited<ReturnType<typeof createTestHost>>;
interface ShellHost {
  host: Host;
  run(command: string, cwd?: string): Promise<ToolResultInfo>;
}

async function startShellHost(base: string, dataDir: string): Promise<ShellHost> {
  vi.stubEnv('XDG_DATA_HOME', path.join(base, 'xdg-data'));
  vi.stubEnv('XDG_CONFIG_HOME', path.join(base, 'xdg-config'));
  vi.stubEnv('XDG_CACHE_HOME', path.join(base, 'xdg-cache'));
  vi.stubEnv('DEEP_STUDENT_KEY_SEED_FILE_ONLY', '1');
  const host = await createTestHost({ app: { dataDir, debug: true } });
  new PluginAdmin({ runtime: host.runtime, official: OFFICIAL_PROFILE_PATH,
    store: new UserProfileStore(path.join(host.app.dataDir, 'plugins/user.profile.json'), OFFICIAL_PROFILE_PATH) }).register();
  expect((await loadStartupProfile(host.runtime, { official: OFFICIAL_PROFILE_PATH })).degraded).toEqual([]);
  const shell = host.ctx.agentTools.toolExecutors().find(executor => executor.name() === 'LocalShellExecuteExecutor') as ToolExecutor;
  if (!(shell instanceof LaneToolContribution)) throw new Error('expected the production LocalShellExecuteExecutor contribution');
  const registry = host.ctx.chatSession.createExecutorRegistry([shell], { ignoresBroadApprovalBypassForArgs, neverRememberApprovalForArgs });
  const stamp = '2026-11-07T00:00:00Z';
  host.ctx.chatSession.createSession({ id: 'sess_plugins', mode: 'chat', titleLocked: false, persistStatus: 'active', createdAt: stamp, updatedAt: stamp });
  let sequence = 0;
  const context = (): ChatExecutionContext => {
    const id = ++sequence;
    const emitter = ChatV2Emitter.withSinkAndBatching(new BackendEventsSink(host.ctx.backendEvents), 'sess_plugins', false);
    const value = host.ctx.chatSession.createExecutionContext({ sessionId: 'sess_plugins', messageId: `msg_plugins_${id}`,
      blockId: `blk_plugins_${id}`, emitter, services: host.ctx, window: null, toolRegistry: host.ctx.mcp.registry });
    value.chat_v2_db = host.ctx.chatSession.database;
    value.shell_authority_admission = ['craft', 'relaxed'];
    return Object.assign(value, { shell_guard_approved: true });
  };
  const run = (command: string, cwd?: string): Promise<ToolResultInfo> =>
    registry.execute({ id: `call_${++sequence}`, name: 'local_shell_execute',
      arguments: { command, root_id: 'workspace', track_file_changes: true, ...(cwd === undefined ? {} : { cwd }) } }, context());
  return { host, run };
}

/**
 * Persists a read-write workspace record the way Rust and earlier Host builds did, then returns the exact refusal a
 * write-capable command gets for the access the Host actually grants it: the sandbox policy refusal while the record
 * stays read-write, the read-only root refusal if the Host downgrades it.
 */
async function persistLegacyReadWriteWorkspace(shell: ShellHost, workspace: string): Promise<string> {
  const recorded = canonicalPath(workspace);
  saveWorkspaceRecord(shell.host.ctx.settings, {
    path: recorded, label: 'Legacy', access: 'read_write', identity: runtimeRootIdentity(recorded, shell.host.ctx.get('nativeWindowsFiles')),
  });
  const listed = await shell.host.invoke('chat_v2_list_runtime_roots', { sessionId: 'sess_plugins' }) as { id: string; path: string; configured: boolean; access: string }[];
  const effective = listed.find(root => root.id === 'workspace');
  const refusals: Record<string, string> = { read_write: PLUGIN_DIR_CWD_REFUSAL, read_only: READ_ONLY_WORKSPACE_REFUSAL };
  expect(effective).toMatchObject({ path: recorded, configured: true });
  expect(Object.keys(refusals)).toContain(effective?.access);
  return refusals[effective!.access]!;
}

describe('local_shell_execute in a read-write workspace next to the Host data directory', () => {
  let base: string;
  let workspace: string;
  let shell: ShellHost;

  beforeAll(async () => {
    base = fs.mkdtempSync(path.join(tempBase(), 's01-plugin-dir-'));
    workspace = path.join(base, 'workspace');
    fs.mkdirSync(workspace);
    shell = await startShellHost(base, path.join(base, 'app-data'));
    await shell.host.invoke('chat_v2_set_workspace_root', { path: workspace, access: 'read_write' });
  }, 240_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    try { await shell?.host.dispose(); } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });

  describe.skipIf(!posixSandbox)('with the POSIX sandbox', () => {
    it('a sandboxed command whose cwd is inside the workspace .git directory cannot plant a hook', async () => {
      const hooks = path.join(workspace, '.git', 'hooks');
      fs.mkdirSync(hooks, { recursive: true });
      const result = await shell.run(`printf '#!/bin/sh' > pre-commit`, '.git/hooks');
      expect(fs.existsSync(path.join(hooks, 'pre-commit'))).toBe(false);
      expect(result.output, result.error ?? undefined).toMatchObject({ execution_mode: 'sandboxed', cwd: '.git/hooks',
        success: false, timed_out: false, sandbox: { enforced: true, writable_roots: 1 } });
    });

    it('RF-S01-shell-host-plugin-dir-protected: a sandboxed command whose cwd is a workspace subdirectory runs as usual when the workspace and the Host data directory do not overlap', async () => {
      fs.mkdirSync(path.join(workspace, 'sub'));
      const result = await shell.run('printf done > note.txt', 'sub');
      expect(fs.readFileSync(path.join(workspace, 'sub', 'note.txt'), 'utf8')).toBe('done');
      expect([result.success, result.error]).toEqual([true, undefined]);
      expect(result.output).toMatchObject({ execution_mode: 'sandboxed', cwd: 'sub', success: true, timed_out: false,
        sandbox: { enforced: true, writable_roots: 1 } });
    });
  });
});

/**
 * The data directory path resolves through `<workspace>/link`, whose target is outside the workspace: directly
 * (`<workspace>/link/data`) or behind another link elsewhere (`outer/link1 -> <workspace>/link`). The workspace does
 * not overlap the real data directory, yet whoever can write it can rename or replace `link` and redirect the path.
 */
describe.each([
  { topology: 'one link', dataDir: (base: string, workspace: string) => path.join(workspace, 'link', 'data') },
  { topology: 'two links', dataDir: (base: string, workspace: string) => {
    fs.mkdirSync(path.join(base, 'outer'));
    fs.symlinkSync(path.join(workspace, 'link'), path.join(base, 'outer', 'link1'), 'junction');
    return path.join(base, 'outer', 'link1', 'data');
  } },
])('local_shell_execute in a read-write workspace holding a link the Host data directory path goes through ($topology)', ({ dataDir: dataDirFor }) => {
  let base: string;
  let workspace: string;
  let real: string;
  let dataDir: string;
  let shell: ShellHost;
  let refusal: string;

  beforeAll(async () => {
    base = fs.mkdtempSync(path.join(tempBase(), 's01-plugin-dir-link-'));
    workspace = path.join(base, 'workspace');
    real = path.join(base, 'elsewhere');
    fs.mkdirSync(workspace);
    fs.mkdirSync(path.join(real, 'data'), { recursive: true });
    fs.symlinkSync(real, path.join(workspace, 'link'), 'junction');
    dataDir = dataDirFor(base, workspace);
    shell = await startShellHost(base, dataDir);
    refusal = await persistLegacyReadWriteWorkspace(shell, workspace);
  }, 240_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    try { await shell?.host.dispose(); } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });

  // The path operand check refuses `link` named on the command line (its target is outside the root) but does not
  // read a script the command writes first, so the attack goes through one to reach the sandbox policy.
  it.each([
    ['renames', `printf 'mv link link.old\\nmkdir -p link/data/plugins\\ntouch link/data/plugins/user.profile.json\\n' > attack.sh && sh attack.sh`],
    ['replaces', `printf 'rm link\\nmkdir -p link/data/plugins\\ntouch link/data/plugins/user.profile.json\\n' > attack.sh && sh attack.sh`],
  ])('RF-S01-shell-host-plugin-dir-protected: a sandboxed command that %s the link cannot plant the user profile at the data directory path', async (_, command) => {
    const link = path.join(workspace, 'link');
    const moved = path.join(workspace, 'link.old');
    const profile = path.join(dataDir, 'plugins', 'user.profile.json');
    let result: ToolResultInfo;
    let replaced: boolean;
    let planted: boolean;
    try {
      result = await shell.run(command);
      replaced = fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink() !== true
        || fs.realpathSync.native(link) !== fs.realpathSync.native(real) || fs.lstatSync(moved, { throwIfNoEntry: false }) !== undefined;
      planted = fs.existsSync(profile);
    } finally {
      if (fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink() !== true) {
        fs.rmSync(link, { recursive: true, force: true });
        if (fs.lstatSync(moved, { throwIfNoEntry: false }) !== undefined) fs.renameSync(moved, link);
        else fs.symlinkSync(real, link, 'junction');
      }
      fs.rmSync(path.join(workspace, 'attack.sh'), { force: true });
    }
    expect([replaced, planted]).toEqual([false, false]);
    expect([result.success, result.error]).toEqual([false, refusal]);
  });
});

/**
 * Rust and earlier Host builds persisted a read-write workspace that contains the data directory. Depending on whether
 * the Host downgrades such a record to read-only, the shell refuses it at the sandbox policy or as a read-only root;
 * either way the command must not run, and each refusal is matched by its exact text.
 */
describe('local_shell_execute with a persisted read-write workspace that contains the Host data directory', () => {
  let base: string;
  let workspace: string;
  let dataDir: string;
  let shell: ShellHost;
  let refusal: string;

  beforeAll(async () => {
    base = fs.mkdtempSync(path.join(tempBase(), 's01-plugin-dir-covering-'));
    workspace = path.join(base, 'workspace');
    dataDir = path.join(workspace, 'app-data');
    fs.mkdirSync(workspace);
    shell = await startShellHost(base, dataDir);
    refusal = await persistLegacyReadWriteWorkspace(shell, workspace);
  }, 240_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    try { await shell?.host.dispose(); } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });

  it('RF-S01-shell-host-plugin-dir-protected: a sandboxed command whose cwd is inside the Host plugin directory cannot rewrite an installed plugin module or plant the user profile', async () => {
    const plugins = path.join(dataDir, 'plugins');
    const profile = path.join(plugins, 'user.profile.json');
    const module = path.join(plugins, 'community.demo', 'index.mjs');
    fs.rmSync(plugins, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(module), { recursive: true });
    fs.writeFileSync(module, 'export default {}');

    const rewritten = await shell.run(`printf 'import("node:child_process")' > index.mjs`, 'app-data/plugins/community.demo');
    expect(fs.readFileSync(module, 'utf8')).toBe('export default {}');
    const planted = await shell.run(`printf '{"plugins":[]}' > user.profile.json`, 'app-data/plugins');
    expect(fs.existsSync(profile)).toBe(false);
    expect([rewritten.success, rewritten.error, planted.success, planted.error])
      .toEqual([false, refusal, false, refusal]);
  });

  it('RF-S01-shell-host-plugin-dir-protected: a sandboxed command in a workspace that contains the Host data directory cannot plant the user profile the Host imports at startup', async () => {
    const plugins = path.join(dataDir, 'plugins');
    fs.rmSync(plugins, { recursive: true, force: true });
    const profile = path.join(plugins, 'user.profile.json');
    const planted = await shell.run(`mkdir -p app-data/plugins; printf '{"plugins":[]}' > app-data/plugins/user.profile.json; echo done > note.txt`);
    expect(fs.existsSync(profile)).toBe(false);
    expect(fs.existsSync(path.join(workspace, 'note.txt'))).toBe(false);

    fs.mkdirSync(path.join(plugins, 'community.demo'), { recursive: true });
    fs.writeFileSync(path.join(plugins, 'community.demo', 'index.mjs'), 'export default {}');
    const rewritten = await shell.run(`printf 'import("node:child_process")' > app-data/plugins/community.demo/index.mjs; printf '{}' > app-data/plugins/user.profile.json`);
    expect(fs.readFileSync(path.join(plugins, 'community.demo', 'index.mjs'), 'utf8')).toBe('export default {}');
    expect(fs.existsSync(profile)).toBe(false);
    expect([planted.success, planted.error, rewritten.success, rewritten.error])
      .toEqual([false, refusal, false, refusal]);
  });

  describe.skipIf(!posixSandbox)('with the POSIX sandbox', () => {
    it('RF-S01-shell-host-plugin-dir-protected: a sandboxed command whose cwd contains the Host data directory cannot rename it and plant the user profile at its old path', async () => {
      const moved = path.join(workspace, 'app-data.old');
      const decoy = path.join(workspace, 'evil');
      const profile = path.join(dataDir, 'plugins', 'user.profile.json');
      const command = process.platform === 'darwin'
        ? `mv app-data app-data.old && mkdir -p evil/plugins && printf '{"plugins":[]}' > evil/plugins/user.profile.json && ln -s evil app-data`
        : `mv app-data app-data.old && mkdir -p app-data/plugins && printf '{"plugins":[]}' > app-data/plugins/user.profile.json`;
      let result: ToolResultInfo;
      let replaced: boolean;
      let planted: boolean;
      try {
        result = await shell.run(command);
        replaced = fs.lstatSync(dataDir).isSymbolicLink() || fs.existsSync(moved);
        planted = fs.existsSync(profile);
      } finally {
        if (fs.lstatSync(dataDir, { throwIfNoEntry: false })?.isSymbolicLink() === true) fs.unlinkSync(dataDir);
        if (fs.existsSync(moved)) {
          fs.rmSync(dataDir, { recursive: true, force: true });
          fs.renameSync(moved, dataDir);
        }
        fs.rmSync(decoy, { recursive: true, force: true });
      }
      expect([replaced, planted]).toEqual([false, false]);
      expect([result.success, result.error]).toEqual([false, refusal]);
    });
  });
});
