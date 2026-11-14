import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { loadStartupProfile, OFFICIAL_PROFILE_PATH } from '../../../kernel/profile.ts';
import { PluginAdmin } from '../../../kernel/plugin-admin.ts';
import { UserProfileStore } from '../../../kernel/profile-store.ts';
import { orderExecutorsByRoster } from '../../../kernel/agent-roster.ts';
import { GeneralToolExecutor } from '../../agent-skills/api.ts';
import { BackendEventsSink, ChatV2Emitter } from '../../chat/api.ts';
import type { ChatExecutionContext, ToolExecutor, ToolResultInfo } from '../../chat/api.ts';
import { ignoresBroadApprovalBypassForArgs, neverRememberApprovalForArgs } from '../api.ts';
import { LaneToolContribution } from '../src/tools/lane-tool-contributions.ts';
import type { SandboxLaunch } from '../../../platform/native/sandbox/api.ts';
import { NPROC_PROBE } from './rlimit-probe.ts';
import { POSIX_SANDBOX } from './posix-sandbox.ts';

const posix = process.platform !== 'win32';
const posixSandbox = POSIX_SANDBOX.available;
const hasGit = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

type Host = Awaited<ReturnType<typeof createTestHost>>;
let base: string;
let host: Host;
let shell: ToolExecutor;
let git: ToolExecutor;
let registry: ReturnType<Host['ctx']['chatSession']['createExecutorRegistry']>;
let root: string;
let sequence = 0;

function context(overrides: Partial<ChatExecutionContext> = {}): ChatExecutionContext {
  const id = ++sequence;
  const emitter = ChatV2Emitter.withSinkAndBatching(new BackendEventsSink(host.ctx.backendEvents), 'sess_s01', false);
  const value = host.ctx.chatSession.createExecutionContext({ sessionId: 'sess_s01', messageId: `msg_s01_${id}`,
    blockId: `blk_s01_${id}`, emitter, services: host.ctx, window: null, toolRegistry: host.ctx.mcp.registry });
  value.chat_v2_db = host.ctx.chatSession.database;
  value.shell_authority_admission = ['craft', 'relaxed'];
  return Object.assign(value, overrides);
}

const run = (name: string, args: Record<string, unknown>, ctx = context()): Promise<ToolResultInfo> =>
  registry.execute({ id: `call_${++sequence}`, name, arguments: args }, ctx);
const output = (result: ToolResultInfo) => result.output as Record<string, unknown>;
const setAccess = (access: 'read_only' | 'read_write') => host.invoke('chat_v2_set_workspace_root', { path: root, access });

beforeAll(async () => {
  base = fs.mkdtempSync(path.join(posix && fs.existsSync('/tmp/opencode') ? '/tmp/opencode' : os.tmpdir(), 's01-shell-git-'));
  vi.stubEnv('XDG_DATA_HOME', path.join(base, 'data'));
  vi.stubEnv('XDG_CONFIG_HOME', path.join(base, 'config'));
  vi.stubEnv('XDG_CACHE_HOME', path.join(base, 'cache'));
  vi.stubEnv('DEEP_STUDENT_KEY_SEED_FILE_ONLY', '1');
  vi.stubEnv('S01_PROBE_ACCESS_TOKEN', 'leaked-token');
  vi.stubEnv('S01_PROBE_PLAIN', 'plain-value');
  host = await createTestHost({ app: { dataDir: path.join(base, 'app'), debug: true } });
  new PluginAdmin({ runtime: host.runtime, official: OFFICIAL_PROFILE_PATH,
    store: new UserProfileStore(path.join(host.app.dataDir, 'plugins/user.profile.json'), OFFICIAL_PROFILE_PATH) }).register();
  const loaded = await loadStartupProfile(host.runtime, { official: OFFICIAL_PROFILE_PATH });
  expect(loaded.degraded).toEqual([]);
  const named = (name: string) => {
    const found = host.ctx.agentTools.toolExecutors().filter(executor => executor.name() === name);
    expect(found).toHaveLength(1);
    const entry = found[0];
    if (!(entry instanceof LaneToolContribution)) throw new Error(`expected the production ${name} contribution`);
    return entry;
  };
  shell = named('LocalShellExecuteExecutor');
  git = named('GitToolExecutor');
  registry = host.ctx.chatSession.createExecutorRegistry([shell, git], { ignoresBroadApprovalBypassForArgs, neverRememberApprovalForArgs });
  const stamp = '2026-11-07T00:00:00Z';
  host.ctx.chatSession.createSession({ id: 'sess_s01', mode: 'chat', titleLocked: false, persistStatus: 'active',
    createdAt: stamp, updatedAt: stamp });
  root = path.join(base, 'workspace');
  fs.mkdirSync(root);
  await setAccess('read_write');
}, 240_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  try { await host?.dispose(); } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

describe('local_shell_execute and git_* registration (task 7)', () => {
  it('registers under the Rust roster names, accepts builtin- names and keeps Rust approval levels', () => {
    expect(registry.getExecutor('builtin-local_shell_execute')).toBe(shell);
    for (const name of ['git_status', 'git_diff', 'git_log', 'git_branch', 'git_commit']) {
      expect(registry.getExecutor(`builtin-${name}`)).toBe(git);
    }
    expect(registry.getSensitivityForCall('local_shell_execute', {})).toBe('high');
    expect(registry.getSensitivityForCall('local_shell_execute', { command: 'rm -rf build' })).toBe('high');
    expect(registry.getSensitivityForCall('local_shell_execute', { command: 'ls -la' })).toBe('medium');
    expect(registry.describeRiskForCall('local_shell_execute', { command: 'ls' })?.dynamic).toBe(true);
    expect(registry.managesCancellation('local_shell_execute')).toBe(true);
    expect(registry.getConcurrencyClass('local_shell_execute')).toBe('serial');
    for (const name of ['git_status', 'git_diff', 'git_log']) {
      expect(registry.getSensitivityForCall(name, {})).toBe('medium');
      expect(registry.getConcurrencyClass(name)).toBe('read_only');
    }
    expect(registry.getSensitivityForCall('git_branch', { action: 'list' })).toBe('medium');
    for (const action of ['create', 'switch', 'delete', undefined]) {
      expect(registry.getSensitivityForCall('git_branch', { action, name: 'x' })).toBe('high');
    }
    expect(registry.describeRiskForCall('git_branch', { action: 'list' })?.dynamic).toBe(true);
    expect(registry.getSensitivityForCall('git_commit', { message: 'm', paths: ['a'] })).toBe('high');
    expect(registry.getConcurrencyClass('git_commit')).toBe('serial');
  });

  it('test_local_shell_execute_registered_before_general_executor: the full roster resolves it before the General fallback', () => {
    const executable = host.ctx.agentTools.toolExecutors().filter(entry => typeof entry.execute === 'function') as ToolExecutor[];
    const general = executable.find(entry => entry.name() === 'GeneralToolExecutor') ?? new GeneralToolExecutor() as ToolExecutor;
    expect(general.canHandle('builtin-local_shell_execute')).toBe(true);
    const { executors } = orderExecutorsByRoster([...executable.filter(entry => entry !== general), general],
      { workspace: host.ctx.get('agentWorkspace') !== undefined });
    const full = host.ctx.chatSession.createExecutorRegistry(executors, { ignoresBroadApprovalBypassForArgs, neverRememberApprovalForArgs });
    expect(full.getExecutor('builtin-local_shell_execute')?.name()).toBe('LocalShellExecuteExecutor');
    for (const name of ['git_status', 'git_diff', 'git_log', 'git_branch', 'git_commit']) {
      expect(full.getExecutor(`builtin-${name}`)?.name()).toBe('GitToolExecutor');
    }
  });
});

describe.skipIf(!posixSandbox)('local_shell_execute security through the registered contribution', () => {
  it('runs in the sandbox with the session-row authority and the Rust RLIMITs', async () => {
    const result = await run('builtin-local_shell_execute', { command: `ulimit -t; ${NPROC_PROBE}`, root_id: 'workspace', track_file_changes: false },
      context({ shell_guard_approved: true }));
    expect(result, result.error ?? undefined).toMatchObject({ success: true, output: { execution_mode: 'sandboxed', authority_mode: 'craft', permission_preset: 'relaxed' } });
    expect(String(output(result)['stdout']).trim().split('\n')).toEqual(['130', '2048']);
  });

  it('a command the immutable guard asks about runs only with the gate approval on the context', async () => {
    const command = 'echo one; echo two';
    const refused = await run('local_shell_execute', { command, root_id: 'workspace', track_file_changes: false });
    expect(refused.success).toBe(false);
    expect(refused.error).toContain('Command requires a fresh immutable-guard approval before spawn');
    const approved = await run('local_shell_execute', { command, root_id: 'workspace', track_file_changes: false },
      context({ shell_guard_approved: true }));
    expect(approved).toMatchObject({ success: true });
    expect(output(approved)['stdout']).toBe('one\ntwo\n');
  });

  it('without admission evidence or the Chat V2 DB the command never runs', async () => {
    const marker = path.join(root, 'never.txt');
    const args = { command: `touch ${JSON.stringify(marker)}`, root_id: 'workspace' };
    expect((await run('local_shell_execute', args, context({ shell_authority_admission: null }))).error)
      .toBe('Local shell is missing backend authority admission evidence');
    expect((await run('local_shell_execute', args, context({ chat_v2_db: null }))).error)
      .toBe('Chat V2 database is unavailable for shell authority lookup');
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('authority is read from the session row, so a preset change after admission refuses the call', async () => {
    await host.invoke('chat_v2_set_permission_preset', { sessionId: 'sess_s01', preset: 'cautious' });
    try {
      const result = await run('local_shell_execute', { command: 'echo hi', root_id: 'workspace', track_file_changes: false });
      expect(result.error).toBe('Session authority or permission preset changed before local shell execution');
    } finally {
      await host.invoke('chat_v2_set_permission_preset', { sessionId: 'sess_s01', preset: 'relaxed' });
    }
  });

  it('authority is read again at the spawn boundary instead of being cached', async () => {
    const chat = host.ctx.chatSession;
    const original = chat.getSessionAuthorityState.bind(chat);
    const read = vi.spyOn(chat, 'getSessionAuthorityState');
    read.mockImplementationOnce(original);
    read.mockImplementationOnce(id => ({ ...original(id), permissionPreset: 'cautious' }));
    try {
      const marker = path.join(root, 'spawned.txt');
      const result = await run('local_shell_execute', { command: `touch ${JSON.stringify(marker)}`, root_id: 'workspace' });
      expect(result.error).toBe('Session authority or permission preset changed before shell spawn; retry required');
      expect(read).toHaveBeenCalledTimes(2);
      expect(read).toHaveBeenNthCalledWith(2, 'sess_s01');
      expect(fs.existsSync(marker)).toBe(false);
    } finally { read.mockRestore(); }
  });

  it('keeps cwd inside the runtime root and the sandbox blocks writes outside it', async () => {
    const escaped = await run('local_shell_execute', { command: 'pwd', root_id: 'workspace', cwd: '..', track_file_changes: false });
    expect(escaped.success).toBe(false);
    const outside = path.join(base, 'outside.txt');
    const blocked = await run('local_shell_execute', { command: `printf x > ${JSON.stringify(outside)}`, root_id: 'workspace' },
      context({ shell_guard_approved: true }));
    expect(blocked.success).toBe(false);
    expect(fs.existsSync(outside)).toBe(false);
    await setAccess('read_only');
    try {
      const readOnly = await run('local_shell_execute', { command: 'printf x > inside.txt', root_id: 'workspace' });
      expect(readOnly.success).toBe(false);
      expect(fs.existsSync(path.join(root, 'inside.txt'))).toBe(false);
    } finally { await setAccess('read_write'); }
  });

  it('filters the parent environment and refuses sensitive explicit variables', async () => {
    const probe = 'printf "%s|%s" "${S01_PROBE_ACCESS_TOKEN-unset}" "${S01_PROBE_PLAIN-unset}"';
    const approved = () => context({ shell_guard_approved: true });
    const minimal = await run('local_shell_execute', { command: probe, root_id: 'workspace', track_file_changes: false }, approved());
    expect(output(minimal), minimal.error ?? undefined).toMatchObject({ stdout: 'unset|unset', environment_mode: 'filtered' });
    const inherited = await run('local_shell_execute', { command: probe, root_id: 'workspace', track_file_changes: false, inherit_env: true },
      approved());
    expect(output(inherited)['stdout']).toBe('unset|plain-value');
    const explicit = await run('local_shell_execute', { command: 'true', root_id: 'workspace', env: { S01_PROBE_ACCESS_TOKEN: 'x' } });
    expect(explicit.error).toBe("environment variable 'S01_PROBE_ACCESS_TOKEN' is blocked by the shell env policy");
  });

  it('enforces the timeout and the run cancellation token on the process tree', async () => {
    const started = Date.now();
    const timedOut = await run('local_shell_execute', { command: 'sleep 30', root_id: 'workspace', track_file_changes: false, timeout_ms: 1_000 });
    expect(output(timedOut)).toMatchObject({ success: false, timed_out: true, cancelled: false });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const cancelled = await run('local_shell_execute', { command: 'sleep 30', root_id: 'workspace', track_file_changes: false, timeout_ms: 20_000 },
      context({ cancellation_token: controller.signal }));
    expect(output(cancelled)).toMatchObject({ success: false, timed_out: false, cancelled: true });
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('truncates output at max_output_bytes while counting the full stream', async () => {
    const result = await run('local_shell_execute', { command: "head -c 100000 /dev/zero | tr '\\0' a", root_id: 'workspace',
      track_file_changes: false, max_output_bytes: 1_024 }, context({ shell_guard_approved: true }));
    expect(output(result)).toMatchObject({ stdout_bytes: 100_000, stdout_truncated: true });
    expect(Buffer.byteLength(String(output(result)['stdout']))).toBeLessThanOrEqual(1_024);
  });
});

describe.skipIf(!posixSandbox || !hasGit)('git_* through the local shell channel', () => {
  beforeAll(() => {
    const gitIn = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    // `git init -b` needs git 2.28; Ubuntu 20.04 and Debian 10 ship older ones.
    gitIn('init', '-q');
    gitIn('symbolic-ref', 'HEAD', 'refs/heads/main');
    gitIn('config', 'user.name', 'S01');
    gitIn('config', 'user.email', 's01@example.invalid');
    gitIn('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'v1\n');
  });

  it('read and write Git tools run through the sandboxed shell channel on a read-write workspace', async () => {
    const status = await run('builtin-git_status', {});
    expect(status, status.error ?? undefined).toMatchObject({ success: true });
    expect(JSON.stringify(status.output)).toContain('tracked.txt');
    const commit = await run('git_commit', { message: 'S01 first', paths: ['tracked.txt'] });
    expect(commit, commit.error ?? undefined).toMatchObject({ success: true, output: { action: 'commit', paths: ['tracked.txt'] } });
    expect(execFileSync('git', ['log', '--format=%s'], { cwd: root, encoding: 'utf8' }).trim()).toBe('S01 first');
    const created = await run('git_branch', { action: 'create', name: 's01-topic' });
    expect(created, created.error ?? undefined).toMatchObject({ success: true });
    const list = await run('git_branch', { action: 'list' });
    expect(String(output(list)['branches'])).toContain('s01-topic');
    expect(output(await run('git_log', { limit: 1 }))['log']).toContain('S01 first');
  });

  it('a read-only workspace refuses Git writes and leaves the repository unchanged', async () => {
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'v2\n');
    const head = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const before = head();
    await setAccess('read_only');
    try {
      expect((await run('git_status', {})).success).toBe(true);
      const commit = await run('git_commit', { message: 'S01 blocked', paths: ['tracked.txt'] });
      expect(commit.success).toBe(false);
      const branch = await run('git_branch', { action: 'create', name: 's01-blocked' });
      expect(branch.success).toBe(false);
      expect(head()).toBe(before);
      expect(execFileSync('git', ['branch', '--list', 's01-blocked'], { cwd: root, encoding: 'utf8' }).trim()).toBe('');
    } finally { await setAccess('read_write'); }
  });
});

describe.skipIf(!posixSandbox)('RF-S01-shell-environment-failure through the registered contributions', () => {
  const launcher = process.platform === 'linux' ? '/usr/bin/prlimit' : '/bin/sh';
  const errno = os.constants.errno.EAGAIN;

  /** The RLIMIT launcher's next spawn fails the way Node reports a fork refused for lack of processes. */
  function refuseNextSandboxSpawn() {
    const launched: Array<{ request: SandboxLaunch; profileExisted: boolean }> = [];
    const sandbox = host.ctx.get('nativeSandbox')!;
    const spy = vi.spyOn(sandbox, 'spawn').mockImplementationOnce(async request => {
      const profile = request.args[request.args.indexOf('-f') + 1];
      launched.push({ request, profileExisted: request.args[0] === '-f' && profile !== undefined && fs.existsSync(profile) });
      throw Object.assign(new Error(`spawn ${launcher} EAGAIN`), { code: 'EAGAIN', errno: -errno, syscall: `spawn ${launcher}` });
    });
    return { launched, restore: () => { spy.mockRestore(); } };
  }

  it('RF-S01-shell-environment-failure: a refused sandbox spawn reaches the tool result, the tool_call error event and chat_v2_blocks.error as an environment failure', async () => {
    const events: Array<Record<string, unknown>> = [];
    host.ctx.backendEvents.listen('chat_v2_event_sess_s01', payload => { events.push(payload as Record<string, unknown>); });
    const marker = path.join(root, 'environment-failure.txt');
    const refused = refuseNextSandboxSpawn();
    try {
      const ctx = context({ shell_guard_approved: true });
      const result = await run('builtin-local_shell_execute', { command: `touch ${JSON.stringify(marker)}`, root_id: 'workspace' }, ctx);
      expect(refused.launched).toHaveLength(1);
      expect(result).toMatchObject({ success: false, output: null, blockId: ctx.block_id });
      // Rust: Err("Failed to execute local shell command: Resource temporarily unavailable (os error N)"), shaped like any other tool error.
      expect(result.error).toBe('LOCAL_SHELL_ENVIRONMENT_FAILURE (stage=spawn, code=EAGAIN): Failed to execute local shell command: '
        + `Resource temporarily unavailable (os error ${errno})\n`
        + 'This is a failure of the local shell execution environment, not of the command. '
        + 'The command did not run, so there is no exit code or output and nothing was changed. '
        + 'EAGAIN means the system is temporarily out of processes, file descriptors or memory. Do not retry the same command right away: '
        + 'wait, retry at most once, and tell the user if it fails again.');
      expect(events.filter(event => event['blockId'] === ctx.block_id && event['phase'] === 'error').map(event => event['error']))
        .toEqual([result.error]);
      expect(host.ctx.chatSession.database.getConnSafe().get<{ status: string; error: string }>(
        'SELECT status, error FROM chat_v2_blocks WHERE id = ?1', [ctx.block_id])).toEqual({ status: 'error', error: result.error });
      expect(fs.existsSync(marker)).toBe(false);
      const { request, profileExisted } = refused.launched[0]!;
      if (request.backend === 'macos_seatbelt') {
        expect(profileExisted).toBe(true);
        expect(fs.existsSync(request.args[1]!)).toBe(false);
      }
    } finally { refused.restore(); }
  });

  it('RF-S01-shell-environment-failure: git_* tools on the same shell channel report the same environment failure', async () => {
    const refused = refuseNextSandboxSpawn();
    try {
      const status = await run('builtin-git_status', {});
      expect(refused.launched).toHaveLength(1);
      expect(status).toMatchObject({ success: false, output: null });
      expect(status.error).toMatch(new RegExp('^LOCAL_SHELL_ENVIRONMENT_FAILURE \\(stage=spawn, code=EAGAIN\\): '
        + `Failed to execute local shell command: Resource temporarily unavailable \\(os error ${errno}\\)\\n`));
      expect(status.error).toContain('Do not retry the same command right away');
    } finally { refused.restore(); }
    const after = await run('builtin-git_status', {});
    expect(after, after.error ?? undefined).toMatchObject({ success: hasGit });
  });
});
