import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { loadStartupProfile, OFFICIAL_PROFILE_PATH } from '../../../kernel/profile.ts';
import { PluginAdmin } from '../../../kernel/plugin-admin.ts';
import { UserProfileStore } from '../../../kernel/profile-store.ts';
import { Disposer, MissingExecutorError } from '../../../kernel/api.ts';
import { StorageError } from '../../../platform/storage/api.ts';
import { BackendEventsSink, ChatV2Emitter, createGroupWithConn } from '../../chat/api.ts';
import type { BackendEvent, ChatExecutionContext } from '../../chat/api.ts';
import plugin from '../index.ts';
import { ignoresBroadApprovalBypassForArgs, neverRememberApprovalForArgs, tempRoot, artifactRoot } from '../api.ts';
import { WorkspaceFsContribution } from '../src/tools/workspace-fs-contribution.ts';

it('W02 official profile registers one scoped WorkspaceFs executor with real L04 context, policy and persistence', async () => {
  const base = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp/opencode', 'l05-workspace-contribution-'));
  vi.stubEnv('XDG_DATA_HOME', path.join(base, 'data'));
  vi.stubEnv('XDG_CONFIG_HOME', path.join(base, 'config'));
  vi.stubEnv('XDG_CACHE_HOME', path.join(base, 'cache'));
  vi.stubEnv('DEEP_STUDENT_KEY_SEED_FILE_ONLY', '1');
  const host = await createTestHost({ app: { dataDir: path.join(base, 'app'), debug: true } });
  try {
    new PluginAdmin({ runtime: host.runtime, official: OFFICIAL_PROFILE_PATH,
      store: new UserProfileStore(path.join(host.app.dataDir, 'plugins/user.profile.json'), OFFICIAL_PROFILE_PATH) }).register();
    const loaded = await loadStartupProfile(host.runtime, { official: OFFICIAL_PROFILE_PATH });
    expect(loaded.degraded).toEqual([]);
    expect(loaded.installed.map(entry => entry.id)).toContain('dstu.agent-workspace');
    const tooling = host.ctx.agentTools;
    const contributions = () => tooling.toolExecutors().filter(executor => executor.name() === 'WorkspaceFsExecutor');
    const current = (): WorkspaceFsContribution => {
      const entries = contributions();
      expect(entries).toHaveLength(1);
      const entry = entries[0];
      expect(typeof entry?.execute).toBe('function');
      if (!(entry instanceof WorkspaceFsContribution)) throw new Error('expected the production WorkspaceFs contribution');
      return entry;
    };
    const contribution = current();
    expect(contribution.canHandle('builtin-workspace_file_read')).toBe(true);
    expect(contribution.sensitivityLevel('workspace_file_read')).toBe('low');
    expect(contribution.sensitivityLevel('workspace_file_write')).toBe('medium');
    expect(contribution.sensitivityLevel('workspace_file_delete')).toBe('high');
    expect(contribution.resultCharBudget('workspace_file_read')).toBeNull();
    expect(contribution.resultCharBudget('workspace_file_write')).toBe(30_000);
    const policy = { ignoresBroadApprovalBypassForArgs, neverRememberApprovalForArgs };
    // Full-roster missing owners are not filled with test doubles. Only prove this contribution is consumed.
    try { host.ctx.chatSession.assembleExecutorRegistry([], policy, false); }
    catch (error) {
      if (!(error instanceof MissingExecutorError)) throw error;
      expect(error.names).not.toContain('WorkspaceFsExecutor');
    }
    const chat = host.ctx.chatSession;
    const registry = chat.createExecutorRegistry([contribution], policy);
    expect(registry.getExecutor('workspace_file_read')).toBe(contribution);
    expect(registry.getConcurrencyClass('workspace_file_read')).toBe('serial');
    expect(registry.managesCancellation('workspace_file_read')).toBe(false);
    const conn = chat.database.getConnSafe();
    const stamp = '2026-11-05T00:00:00Z';
    createGroupWithConn(conn, { id: 'group_w02', name: 'Workspace group', defaultSkillIds: [], pinnedResourceIds: [],
      defaultRuntimeRootId: ' temp ', sortOrder: 0, persistStatus: 'active', createdAt: stamp, updatedAt: stamp });
    chat.createSession({ id: 'sess_w02', mode: 'chat', titleLocked: false, persistStatus: 'active',
      groupId: 'group_w02', createdAt: stamp, updatedAt: stamp });
    const root = path.join(host.app.dataDir, 'workspace');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'read.txt'), 'workspace bytes');
    const temp = tempRoot(host.app.dataDir, 'sess_w02', true).path;
    fs.writeFileSync(path.join(temp, 'read.txt'), 'group-selected bytes');
    await host.invoke('chat_v2_set_workspace_root', { path: root, access: 'read_only' });
    host.window({ window: 'main', webview: 'main' }, 'created');
    const emitter = ChatV2Emitter.withSinkAndBatching(new BackendEventsSink(host.ctx.backendEvents), 'sess_w02', false);
    let sequence = 0;
    const context = (window = true): ChatExecutionContext => {
      const id = ++sequence;
      const value = chat.createExecutionContext({ sessionId: 'sess_w02', messageId: `msg_w02_${id}`, blockId: `blk_w02_${id}`,
        emitter, services: host.ctx, window: window ? { window: 'main', webview: 'main' } : null, toolRegistry: host.ctx.mcp.registry });
      value.chat_v2_db = chat.database;
      value.variant_id = 'variant_w02'; value.skill_state_version = 3; value.round_id = 'round_w02';
      return value;
    };
    const getRow = conn.get.bind(conn);
    const get = vi.spyOn(conn, 'get');
    const rootQueries = () => get.mock.calls.filter(([sql]) => sql.includes('FROM chat_v2_sessions') || sql.includes('FROM chat_v2_session_groups'));
    const selected = context();
    const read = await registry.execute({ id: 'read', name: 'builtin-workspace_file_read', arguments: { path: 'read.txt' } }, selected);
    expect(read).toMatchObject({ success: true, blockId: selected.block_id, output: { content: 'group-selected bytes', root_id: 'temp' } });
    expect(rootQueries().map(([, params]) => params)).toEqual([['sess_w02'], ['group_w02']]);
    expect(chat.getBlock(selected.block_id)).toMatchObject({ status: 'success', toolOutput: { content: 'group-selected bytes' } });
    const events = host.eventsNamed('chat_v2_event_sess_w02') as BackendEvent[];
    expect(events.filter(event => event.blockId === selected.block_id)).toMatchObject([
      { phase: 'start', variantId: 'variant_w02', skillStateVersion: 3, roundId: 'round_w02' },
      { phase: 'end', variantId: 'variant_w02', skillStateVersion: 3, roundId: 'round_w02' },
    ]);
    get.mockClear();
    expect(await registry.execute({ id: 'explicit', name: 'workspace_file_read', arguments: { root_id: 'workspace', path: 'read.txt' } }, context()))
      .toMatchObject({ success: true, output: { content: 'workspace bytes' } });
    expect(rootQueries()).toHaveLength(0);
    const warnings: string[] = [];
    host.ctx.logger.exporter({ levels: { default: 4 }, export(event) {
      if (event.type === 'warn') warnings.push(String(event.args[0]));
    } });
    get.mockImplementation((sql, params) => {
      if (sql.includes('FROM chat_v2_session_groups')) throw new StorageError('SQLITE', 'group read denied', { database: 'chat_v2' });
      return getRow(sql, params);
    });
    expect(await registry.execute({ id: 'group-failed', name: 'workspace_file_read', arguments: { path: 'read.txt' } }, context()))
      .toMatchObject({ success: true, output: { content: 'workspace bytes', root_id: 'workspace' } });
    expect(warnings, warnings.join('\n')).toContain("[runtime_roots] failed to load group 'group_w02' for preferred root: Database error: group read denied");
    get.mockImplementation(getRow);
    const denied = context();
    expect(await registry.execute({ id: 'write', name: 'workspace_file_write', arguments: { path: 'blocked.txt', content: 'blocked' } }, denied))
      .toMatchObject({ success: false, error: 'Workspace is read-only; the user must explicitly grant write access' });
    expect(fs.existsSync(path.join(root, 'blocked.txt'))).toBe(false);
    expect(chat.getBlock(denied.block_id)).toMatchObject({ status: 'error' });
    get.mockClear();
    const windowless = context(false);
    await expect(registry.execute({ id: 'windowless', name: 'workspace_artifact_write', arguments: { path: 'windowless.txt', content: 'blocked' } }, windowless))
      .rejects.toThrow('ExecutionContext.window_ref() called without a Tauri window');
    expect(rootQueries()).toHaveLength(0);
    expect(host.eventsNamed('chat_v2_event_sess_w02').filter(event => (event as BackendEvent).blockId === windowless.block_id))
      .toMatchObject([{ phase: 'start' }]);
    expect(chat.getBlock(windowless.block_id)).toBeNull();
    expect(fs.existsSync(path.join(artifactRoot(host.app.dataDir, 'sess_w02', false).path, 'windowless.txt'))).toBe(false);
    const cancelled = context();
    const abort = new AbortController(); abort.abort(); cancelled.cancellation_token = abort.signal;
    const before = host.events.length;
    await expect(registry.execute({ id: 'cancelled', name: 'workspace_artifact_write', arguments: { path: 'cancelled.txt', content: 'blocked' } }, cancelled))
      .rejects.toThrow('TOOL_CANCELLED');
    expect(host.events.length).toBe(before);
    expect(chat.getBlock(cancelled.block_id)).toBeNull();
    expect(fs.existsSync(path.join(artifactRoot(host.app.dataDir, 'sess_w02', false).path, 'cancelled.txt'))).toBe(false);
    get.mockRestore();

    const packageRoot = path.join(host.app.dataDir, '.skills', 'w02-skill');
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'SKILL.md'), '---\nname: w02-skill\n---\nSkill body');
    await host.invoke('chat_v2_set_skill_trust', { skillId: 'w02-skill', packageRoot, trusted: true });
    const skillContext = context();
    skillContext.skill_package_roots = { 'w02-skill': packageRoot };
    const skillCall = { id: 'skill-read', name: 'workspace_file_read', arguments: { root_id: 'skill:w02-skill', path: 'SKILL.md' } };
    expect(await registry.execute(skillCall, skillContext)).toMatchObject({ success: true,
      output: { content: '---\nname: w02-skill\n---\nSkill body', root: { access: 'read_only' } } });
    await host.invoke('chat_v2_set_skill_trust', { skillId: 'w02-skill', trusted: false });
    expect(await registry.execute(skillCall, skillContext)).toMatchObject({ success: false,
      error: "Skill 'w02-skill' is not trusted by the backend" });

    // Dispose profile dependents in dependency order before unloading their service owners.
    await host.unload('dstu.plugin-workshop');
    await host.unload('dstu.chat-pipeline');
    const registrations: Disposer[] = [];
    const register = tooling.registerToolExecutors.bind(tooling);
    vi.spyOn(tooling, 'registerToolExecutors').mockImplementation(executors => {
      const registration = register(executors);
      if (executors.some(executor => executor.name() === 'WorkspaceFsExecutor')) registrations.push(registration);
      return registration;
    });
    await host.unload('dstu.agent-workspace');
    expect(contributions()).toEqual([]);
    await host.install(plugin);
    current();
    expect(registrations).toHaveLength(1);
    expect(registrations[0]!.isActive()).toBe(true);
    await host.unload('dstu.agent-workspace');
    expect(contributions()).toEqual([]);
    expect(registrations[0]!.isActive()).toBe(false);
    await host.install(plugin);
    const replacement = current();
    expect(registrations).toHaveLength(2);
    registrations[0]!.dispose();
    expect(contributions()).toEqual([replacement]);
    expect(registrations[1]!.isActive()).toBe(true);
    const replacementRegistry = chat.createExecutorRegistry([replacement], policy);
    expect(await replacementRegistry.execute({ id: 'reloaded', name: 'workspace_file_read', arguments: { root_id: 'workspace', path: 'read.txt' } }, context()))
      .toMatchObject({ success: true, output: { content: 'workspace bytes' } });
  } finally {
    vi.restoreAllMocks();
    try { await host.dispose(); }
    finally { vi.unstubAllEnvs(); fs.rmSync(base, { recursive: true, force: true }); }
  }
}, 240_000);
