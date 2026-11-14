import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StorageServiceImpl } from '../../../platform/storage/service.ts';
import { MigrationCoordinator } from '../../../platform/storage/migration/coordinator.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { createSessionWithConn, createMessageWithConn, createBlocksBatchWithConn, getSessionWithConn,
  type ToolResultInfo } from '../../chat/api.ts';
import { tempRoot } from '../../agent-workspace/api.ts';
import { SessionToolExecutor } from '../src/session-tool-executor.ts';
import { setAgentOrchestrationWorkspaceRuntime } from '../src/workspace-runtime.ts';
import { nodeAgentOrchestrationWorkspaceRuntime } from '../src/workspace-runtime.node.ts';

const CURRENT = 'sess_current';
const disposers: (() => void)[] = [];
beforeEach(() => setAgentOrchestrationWorkspaceRuntime(nodeAgentOrchestrationWorkspaceRuntime));
afterEach(() => {
  setAgentOrchestrationWorkspaceRuntime(null);
  for (const dispose of disposers.splice(0)) dispose();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'w02-session-tool-'));
  const storage = new StorageServiceImpl({ baseDir: root, dataLocalDir: root });
  const report = new MigrationCoordinator({ appDataDir: storage.locations.activeDir, auditDbPath: null }).migrateSingle('chat_v2');
  if (!report.success) throw new Error(JSON.stringify(report));
  const db: DatabaseHandle = storage.database('chat_v2');
  disposers.push(() => { storage.dispose(); rmSync(root, { recursive: true, force: true }); });
  const events: [string, unknown][] = [];
  const saved: ToolResultInfo[] = [];
  const ctx = {
    session_id: CURRENT, message_id: 'msg_x', block_id: 'blk_x', tool_call_id: null,
    chat_v2_db: { getConnSafe: () => db },
    services: { app: { dataDir: root }, get: () => undefined,
      backendEvents: { emit: (name: string, payload: unknown) => { events.push([name, payload]); }, emitTo() {} } },
    tryWindow: () => null,
    emitToolCallStart() {}, emitToolCallEnd() {}, emitToolCallError() {},
    saveToolBlock: (result: ToolResultInfo) => { saved.push(result); },
  };
  return { db, root, events, saved, ctx: ctx as never };
}

function seed(db: DatabaseHandle, id: string, title: string, persistStatus: 'active' | 'archived' = 'active') {
  createSessionWithConn(db, { id, mode: 'chat', title, titleLocked: false, persistStatus,
    createdAt: '2026-11-01T00:00:00+00:00', updatedAt: '2026-11-01T00:00:00+00:00' });
  createMessageWithConn(db, { id: `msg_${id}`, sessionId: id, role: 'user', blockIds: [`blk_${id}`], timestamp: 1_790_000_000_000 });
  createBlocksBatchWithConn(db, [{ id: `blk_${id}`, messageId: `msg_${id}`, type: 'content', status: 'success',
    blockIndex: 0, content: `question about ${title}` }] as never);
}

const executor = new SessionToolExecutor({ info() {}, warn() {} });
const run = async (ctx: never, name: string, args: unknown = {}) =>
  executor.execute({ id: `call_${name}`, name, arguments: args }, ctx);

describe('session_executor.rs SessionToolExecutor', () => {
  it('rejects blank optional strings like Rust optional_non_empty_string', async () => {
    const { db, ctx } = fixture();
    seed(db, 'sess_a', 'Alpha');
    const result = await run(ctx, 'builtin-session_get_messages', { session_id: 'sess_a', role_filter: '  ' });
    expect(result.error).toBe('SESSION_INVALID_ARGUMENT: role_filter must not be empty');
    expect((await run(ctx, 'session_search', { query: 'x', date_from: '' })).error)
      .toBe('SESSION_INVALID_ARGUMENT: date_from must not be empty');
  });

  it('manages groups, tags, rename, archive and restore with Rust messages and refresh events', async () => {
    const { db, ctx, events } = fixture();
    seed(db, CURRENT, 'Current');
    seed(db, 'sess_a', 'Alpha');
    const created = await run(ctx, 'builtin-group_create', { name: 'Physics', color: '#f00' });
    const groupId = (created.output as { groupId: string }).groupId;
    expect(groupId).toMatch(/^group_[0-9a-f-]{36}$/);
    expect(created.output).toEqual({ success: true, groupId, name: 'Physics', message: `已创建分组「Physics」(${groupId})` });
    expect((await run(ctx, 'group_list')).output).toEqual({ count: 1, groups: [{ id: groupId, name: 'Physics',
      description: null, icon: null, color: '#f00', sortOrder: 1, defaultSkillIds: [], defaultRuntimeRootId: null,
      preferredProjectRootPath: null, systemPromptPreview: null }] });

    expect((await run(ctx, 'session_move', { session_id: CURRENT, group_id: groupId })).error)
      .toBe('不能对当前正在使用的会话执行分组移动');
    expect((await run(ctx, 'session_move', { session_id: 'sess_a', group_id: 'group_missing' })).error)
      .toBe('分组不存在: group_missing');
    expect((await run(ctx, 'session_move', { session_id: 'sess_a', group_id: groupId })).output)
      .toEqual({ success: true, sessionId: 'sess_a', groupId, message: '已将会话移入分组「Physics」' });
    expect((await run(ctx, 'session_tag_add', { session_id: 'sess_a', tag: 'exam' })).output)
      .toEqual({ success: true, sessionId: 'sess_a', tag: 'exam', message: '已为会话添加标签「exam」' });
    expect((await run(ctx, 'session_tag_add', { session_id: 'sess_none', tag: 'exam' })).error).toBe('会话不存在: sess_none');

    const detail = (await run(ctx, 'session_get', { session_id: 'sess_a' })).output as Record<string, unknown>;
    expect(Object.keys(detail)).toEqual(['id', 'mode', 'title', 'description', 'persistStatus', 'createdAt', 'updatedAt',
      'groupId', 'groupName', 'tags', 'metadata']);
    expect(detail).toMatchObject({ groupId, groupName: 'Physics', tags: ['exam'], metadata: null, persistStatus: 'active' });
    expect((await run(ctx, 'tag_list_all')).output).toEqual({ tags: [{ tag: 'exam', count: 1 }], totalTags: 1 });
    expect((await run(ctx, 'session_stats')).output).toEqual({ total: 2, active: 2, archived: 0, deleted: 0,
      groups: { count: 1, distribution: [{ groupId, groupName: 'Physics', sessionCount: 1 }], ungroupedCount: 1 },
      tags: { uniqueCount: 1, top10: [{ tag: 'exam', count: 1 }] } });

    expect((await run(ctx, 'session_rename', { session_id: 'sess_a', title: 'Renamed' })).output)
      .toMatchObject({ title: 'Renamed', message: '已将会话重命名为「Renamed」' });
    expect((await run(ctx, 'session_archive', { session_id: 'sess_a' })).output)
      .toEqual({ success: true, sessionId: 'sess_a', message: '已归档会话「Renamed」' });
    const archived = getSessionWithConn(db, 'sess_a')!;
    expect(archived.persistStatus).toBe('archived');
    expect(archived.metadata).toEqual({ manuallyArchivedBy: { archivedAt: expect.stringMatching(/\+00:00$/) } });
    expect((await run(ctx, 'session_archive', { session_id: 'sess_a' })).error).toBe('只能归档活跃会话，当前状态: Archived');
    expect((await run(ctx, 'session_restore', { session_id: 'sess_a' })).output)
      .toEqual({ success: true, sessionId: 'sess_a', message: '已恢复会话「Renamed」' });
    expect((await run(ctx, 'session_restore', { session_id: 'sess_a' })).error).toBe('会话已是活跃状态，无需恢复');

    expect(events.map(([name, payload]) => [name, (payload as { tool: string }).tool])).toEqual([
      ['session_management_change', 'group_create'], ['session_management_change', 'session_move'],
      ['session_management_change', 'session_tag_add'], ['session_management_change', 'session_rename'],
      ['session_management_change', 'session_archive'], ['session_management_change', 'session_restore']]);
  });

  it('archives, restores and soft-deletes groups with their sessions', async () => {
    const { db, ctx } = fixture();
    seed(db, CURRENT, 'Current');
    seed(db, 'sess_a', 'Alpha');
    const created = await run(ctx, 'group_create', { name: 'Biology' });
    const groupId = (created.output as { groupId: string }).groupId;
    await run(ctx, 'session_move', { session_id: 'sess_a', group_id: groupId });

    expect((await run(ctx, 'group_archive', { group_id: groupId })).output)
      .toEqual({ success: true, groupId, name: 'Biology', status: 'archived',
        message: '已归档分组「Biology」及其活跃会话' });
    expect((await run(ctx, 'group_list')).output).toEqual({ count: 0, groups: [] });
    expect(getSessionWithConn(db, 'sess_a')!.persistStatus).toBe('archived');

    expect((await run(ctx, 'group_restore', { group_id: groupId })).output)
      .toEqual({ success: true, groupId, name: 'Biology', status: 'active',
        message: '已恢复分组「Biology」及其归档会话' });
    expect(getSessionWithConn(db, 'sess_a')!).toMatchObject({ persistStatus: 'active', groupId });

    expect((await run(ctx, 'group_delete', { group_id: groupId })).error)
      .toBe('只能删除已归档的分组，请先调用 group_archive 归档');
    await run(ctx, 'group_archive', { group_id: groupId });
    expect((await run(ctx, 'group_delete', { group_id: groupId })).output)
      .toEqual({ success: true, groupId, name: 'Biology', status: 'deleted',
        message: '已删除分组「Biology」；组内会话保留但不再归属该分组' });
    expect(getSessionWithConn(db, 'sess_a')!.groupId ?? null).toBeNull();
    expect((await run(ctx, 'group_restore', { group_id: groupId })).error)
      .toBe('分组已删除，无法恢复: ' + groupId);
  });

  it('runs unified batch ops with full pre-validation, confirmation and per-op failures', async () => {
    const { db, ctx } = fixture();
    seed(db, CURRENT, 'Current');
    seed(db, 'sess_a', 'Alpha');
    seed(db, 'sess_b', 'Beta', 'archived');
    const ops = [{ session_id: 'sess_a', action: 'tag_add', tag: 'math' },
      { session_id: 'sess_a', action: 'restore' }, { session_id: 'sess_b', action: 'restore' },
      { session_id: 'sess_a', action: 'archive' }];
    expect((await run(ctx, 'session_batch_ops', { operations: ops })).error)
      .toBe('批量操作需要显式确认：请先征得用户同意，然后以 confirmed=true 重新调用');
    expect((await run(ctx, 'session_batch_ops', { confirmed: true, operations: [...ops, { session_id: 'sess_b', action: 'delete' }] })).error)
      .toBe('operations[4] 不支持的 action: delete');
    expect((await run(ctx, 'session_batch_ops', { confirmed: true, operations: [{ session_id: CURRENT, action: 'rename', title: 'x' }] })).error)
      .toBe('operations[0]: 不能对当前正在使用的会话执行重命名');
    const result = await run(ctx, 'session_batch_ops', { confirmed: true, operations: JSON.stringify(ops) });
    expect(executor.sensitivityLevelForCall('session_batch_ops', { operations: ops })).toBe('high');
    expect(result.output).toEqual({ success: false, totalOperations: 4, totalSessions: 2, applied: 3, failed: 1,
      actionStats: { attempted: { tag_add: 1, restore: 2, archive: 1 }, applied: { tag_add: 1, restore: 1, archive: 1 },
        failed: { restore: 1 } },
      results: [
        { index: 0, sessionId: 'sess_a', action: 'tag_add', success: true, message: '已添加标签 math' },
        { index: 1, sessionId: 'sess_a', action: 'restore', success: false, error: '会话已是活跃状态，无需恢复' },
        { index: 2, sessionId: 'sess_b', action: 'restore', success: true, message: '已恢复为活跃状态' },
        { index: 3, sessionId: 'sess_a', action: 'archive', success: true, message: '已归档' }],
      message: '统一批量操作完成：成功 3，失败 1' });

    expect((await run(ctx, 'session_batch_tag', { session_ids: ['a', 'b', 'c', 'd', 'e', 'f'], tag: 't' })).error)
      .toBe('批量打标超过 5 个会话时，需要用户确认并传入 confirmed=true');
    expect((await run(ctx, 'session_batch_move', { session_ids: ['sess_b', CURRENT] })).error)
      .toBe('批量移动不能包含当前正在使用的会话');
    expect((await run(ctx, 'session_batch_move', { session_ids: ['sess_b'] })).output)
      .toEqual({ success: true, moved: 1, total: 1, errors: [], groupId: null, message: '已移动 1/1 个会话' });
  });

  it('exports markdown, requires the notes service for note export and imports staged JSON', async () => {
    const { db, ctx, root } = fixture();
    seed(db, 'sess_a', 'Alpha');
    const markdown = await run(ctx, 'session_export', { session_id: 'sess_a', format: 'markdown' });
    expect(markdown.output).toMatchObject({ format: 'markdown', sessionId: 'sess_a', messageCount: 1 });
    expect((await run(ctx, 'session_export', { session_id: 'sess_a', format: 'note' })).error).toBe('SESSION_EXPORT_VFS_UNAVAILABLE');
    expect((await run(ctx, 'session_export', { session_id: 'sess_a', format: 'pdf' })).error)
      .toBe('SESSION_EXPORT_INVALID_FORMAT: expected markdown or note');

    const payload = { session: getSessionWithConn(db, 'sess_a'),
      messages: [{ id: 'msg_sess_a', sessionId: 'sess_a', role: 'user', blockIds: ['blk_sess_a'], timestamp: 1_790_000_000_000 }],
      blocks: [{ id: 'blk_sess_a', messageId: 'msg_sess_a', type: 'content', status: 'success', content: 'hi' }] };
    const temp = tempRoot(root, CURRENT, true).path;
    mkdirSync(join(temp, 'in'), { recursive: true });
    writeFileSync(join(temp, 'in', 'export.json'), JSON.stringify(payload));
    expect((await run(ctx, 'session_import', { root_id: 'workspace', relative_path: 'in/export.json' })).error)
      .toBe("SESSION_IMPORT_INVALID_ROOT: only root_id=temp is accepted, got 'workspace'");
    expect((await run(ctx, 'session_import', { relative_path: 'in/missing.json' })).error).toBe('Staged file not found: in/missing.json');
    const imported = await run(ctx, 'session_import', { relative_path: 'in/export.json', title: 'Copy' });
    expect(imported.output).toMatchObject({ success: true, title: 'Copy', importedFromSessionId: 'sess_a', messageCount: 1, blockCount: 1 });
    expect((imported.output as { sessionId: string }).sessionId).not.toBe('sess_a');
    writeFileSync(join(temp, '..export.json'), JSON.stringify(payload));
    expect((await run(ctx, 'session_import', { relative_path: '..export.json' })).output)
      .toMatchObject({ success: true, importedFromSessionId: 'sess_a' });
  });

  it('reports a missing chat database and exposes Rust sensitivity/concurrency classes', async () => {
    const { ctx } = fixture();
    const noDb = { ...(ctx as object), chat_v2_db: null } as never;
    expect((await run(noDb, 'session_list')).error).toBe('[SessionExecutor] chat_v2_db not available in ExecutionContext');
    expect(executor.canHandle('builtin-session_restore')).toBe(true);
    expect(['session_archive', 'session_export', 'session_list'].map(name => executor.sensitivityLevel(name)))
      .toEqual(['high', 'medium', 'low']);
    expect(['session_stats', 'session_rename'].map(name => executor.concurrencyClass(name))).toEqual(['read_only', 'serial']);
  });
});
