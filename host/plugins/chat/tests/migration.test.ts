import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { MigrationCoordinator } from '../../../platform/storage/migration/coordinator.ts';
import { ChatV2Error } from '../api.ts';
import type { MigrationCheckResult, MigrationReport } from '../api.ts';
import {
  MIGRATION_EVENT_CHANNEL, legacyAttachmentsJson, legacyMessageMeta, parseLegacyTimestamp,
  rollbackMigration, sessionTitle, truncateTitle,
} from '../src/legacy-migration.ts';
import type { LegacyMessageRow } from '../repository/legacy-migration.ts';

function mistake(
  dataDb: DatabaseHandle, id: string,
  extra: { ocrText?: string; userQuestion?: string; chatMetadata?: string } = {},
): void {
  dataDb.run(`INSERT INTO mistakes
    (id, created_at, question_images, analysis_images, user_question, ocr_text, tags,
     mistake_type, status, updated_at, last_accessed_at, chat_metadata)
    VALUES (?1, '2026-01-01T00:00:00Z', '[]', '[]', ?2, ?3, '[]', 'other', 'active',
            '2026-01-01T00:00:00Z', '1970-01-01T00:00:00Z', ?4)`, [
    id, extra.userQuestion ?? '', extra.ocrText ?? '', extra.chatMetadata ?? null,
  ]);
}

interface LegacyInput {
  mistakeId: string;
  role: string;
  content: string;
  timestamp?: string;
  thinking?: string | null;
  ragSources?: string | null;
  memorySources?: string | null;
  graphSources?: string | null;
  webSearchSources?: string | null;
  imagePaths?: string | null;
  imageBase64?: string | null;
  docAttachments?: string | null;
  toolCall?: string | null;
  toolResult?: string | null;
  stableId?: string | null;
  metadata?: string | null;
}

function legacyMessage(dataDb: DatabaseHandle, input: LegacyInput): number {
  const result = dataDb.run(`INSERT INTO chat_messages
    (mistake_id, role, content, timestamp, thinking_content, rag_sources, memory_sources,
     graph_sources, web_search_sources, image_paths, image_base64, doc_attachments,
     tool_call, tool_result, stable_id, metadata)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`, [
    input.mistakeId, input.role, input.content, input.timestamp ?? '2026-02-03T04:05:06.789Z',
    input.thinking ?? null, input.ragSources ?? null, input.memorySources ?? null,
    input.graphSources ?? null, input.webSearchSources ?? null, input.imagePaths ?? null,
    input.imageBase64 ?? null, input.docAttachments ?? null, input.toolCall ?? null,
    input.toolResult ?? null, input.stableId ?? null, input.metadata ?? null,
  ]);
  return Number(result.lastInsertRowid);
}

function row(overrides: Partial<LegacyMessageRow> = {}): LegacyMessageRow {
  return {
    id: 1, mistake_id: 'm1', role: 'user', content: 'hello',
    timestamp: '2026-02-03T04:05:06.789Z', thinking_content: null,
    rag_sources: null, memory_sources: null, graph_sources: null, web_search_sources: null,
    image_paths: null, image_base64: null, doc_attachments: null, tool_call: null,
    tool_result: null, stable_id: null, metadata: null, ...overrides,
  };
}

function databaseError(message: string): string {
  return new ChatV2Error('Database', message).toCommandError();
}

describe('chat_v2 legacy chat migration', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  let dataDb: DatabaseHandle;

  beforeEach(async () => {
    f = databaseFixture();
    const report = f.coordinator.migrateSingle('mistakes');
    if (!report.success) throw new Error(JSON.stringify(report));
    dataDb = f.storage.database('mistakes');
    host = await createTestHost({ plugins: [plugin], provide: { storage: f.storage, vfs: vfsStub } });
  }, 60_000); // full mistakes+chat_v2 migration per test; 10s default times out under shared CI load
  afterEach(async () => { await host.dispose(); f.dispose(); });

  it('check_migration_status counts all rows as pending before the marker column exists', async () => {
    mistake(dataDb, 'm1');
    mistake(dataDb, 'm2');
    legacyMessage(dataDb, { mistakeId: 'm1', role: 'user', content: 'a' });
    legacyMessage(dataDb, { mistakeId: 'm1', role: 'assistant', content: 'b' });
    legacyMessage(dataDb, { mistakeId: 'm2', role: 'user', content: 'c' });

    const status = await host.invoke<MigrationCheckResult>('chat_v2_check_migration_status');
    expect(status).toEqual({
      needsMigration: true, pendingMessages: 3, pendingSessions: 2,
      migratedMessages: 0, canRollback: false, lastMigrationAt: null,
    });
  });

  it('check_migration_status returns defaults when the legacy table is absent', async () => {
    dataDb.run('DROP TABLE chat_messages');
    const status = await host.invoke<MigrationCheckResult>('chat_v2_check_migration_status');
    expect(status).toEqual({
      needsMigration: false, pendingMessages: 0, pendingSessions: 0,
      migratedMessages: 0, canRollback: false, lastMigrationAt: null,
    });
  });

  it('migrates messages, blocks, attachments and marks the legacy rows', async () => {
    mistake(dataDb, 'm1', { chatMetadata: JSON.stringify({ title: '代数 / 第一课' }) });
    mistake(dataDb, 'm2');
    const firstId = legacyMessage(dataDb, {
      mistakeId: 'm1', role: 'user', content: 'hello', thinking: 'plan',
      ragSources: '[{"id":"r1"}]', toolCall: '{"name":"search","arguments":{"q":"x"}}',
      toolResult: '{"ok":true}', stableId: 'stable-1', metadata: '{"foo":1}',
      imagePaths: '["/tmp/a.png"]', imageBase64: '["aGVsbG8="]',
      docAttachments: '[{"name":"a.pdf","mimeType":"application/pdf","size":12},{}]',
    });
    const secondId = legacyMessage(dataDb, {
      mistakeId: 'm1', role: 'assistant', content: '', ragSources: '[]',
      webSearchSources: '[]', toolCall: '',
    });
    const thirdId = legacyMessage(dataDb, {
      mistakeId: 'm2', role: 'user', content: '  line1\nline2  ',
      timestamp: 'not-a-timestamp',
    });

    const report = await host.invoke<MigrationReport>('chat_v2_migrate_legacy_chat');
    expect(report).toMatchObject({
      status: 'completed', sessionsCreated: 2, messagesMigrated: 3, blocksCreated: 5,
      attachmentsCreated: 0, messagesSkipped: 0, errors: [],
    });
    expect(report.durationMs).toBe(report.endedAt - report.startedAt);

    const sessions = f.db.all<{ id: string; mode: string; title: string; metadata_json: string }>(
      'SELECT id, mode, title, metadata_json FROM chat_v2_sessions ORDER BY title');
    expect(sessions.map(session => session.title)).toEqual(['line1', '代数 / 第一课']);
    expect(sessions.every(session => session.mode === 'analysis')).toBe(true);
    const migratorMetadata = JSON.parse(sessions[1]!.metadata_json) as Record<string, unknown>;
    expect(migratorMetadata).toEqual({
      mistakeId: 'm1', migratedFrom: 'chat_messages', migratedAt: expect.any(Number),
    });

    const messages = f.db.all<{
      id: string; role: string; block_ids_json: string; timestamp: number;
      persistent_stable_id: string | null; meta_json: string; attachments_json: string | null;
    }>('SELECT id, role, block_ids_json, timestamp, persistent_stable_id, meta_json, attachments_json'
      + ' FROM chat_v2_messages ORDER BY rowid');
    expect(messages).toHaveLength(3);
    // The malformed timestamp falls back to the Unix epoch, matching Rust.
    expect(messages[2]!.timestamp).toBe(0);
    const first = messages.find(message => message.persistent_stable_id === 'stable-1')!;
    expect(first.role).toBe('user');
    expect(first.timestamp).toBe(Date.parse('2026-02-03T04:05:06.789Z'));
    const firstMeta = JSON.parse(first.meta_json) as Record<string, unknown>;
    expect(firstMeta).toEqual({ migratedFrom: 'chat_messages', legacyId: firstId, legacyMetadata: { foo: 1 } });
    expect(JSON.parse(first.attachments_json!)).toEqual([
      { id: expect.stringMatching(/^att_/), name: 'image_1.jpg', type: 'image', mimeType: 'image/jpeg', size: 0, status: 'ready', previewUrl: '/tmp/a.png' },
      { id: expect.stringMatching(/^att_/), name: 'image_1.jpg', type: 'image', mimeType: 'image/jpeg', size: 8, status: 'ready', previewUrl: 'data:image/jpeg;base64,aGVsbG8=' },
      { id: expect.stringMatching(/^att_/), name: 'a.pdf', type: 'document', mimeType: 'application/pdf', size: 12, status: 'ready' },
      { id: expect.stringMatching(/^att_/), name: 'document', type: 'document', mimeType: 'application/octet-stream', size: 0, status: 'ready' },
    ]);
    const second = messages[1]!;
    expect(second.attachments_json).toBeNull();
    expect(JSON.parse(second.meta_json).legacyId).toBe(secondId);
    const blocks = f.db.all<{
      block_type: string; status: string; block_index: number; content: string | null;
      citations_json: string | null; tool_name: string | null; tool_input_json: string | null;
      tool_output_json: string | null;
    }>('SELECT block_type, status, block_index, content, citations_json, tool_name,'
      + ' tool_input_json, tool_output_json FROM chat_v2_blocks WHERE message_id = ?1 ORDER BY block_index',
    [first.id]);
    expect(blocks.map(block => block.block_type)).toEqual(['thinking', 'content', 'rag', 'mcp_tool']);
    expect(blocks.map(block => block.block_index)).toEqual([0, 1, 2, 3]);
    expect(blocks.every(block => block.status === 'success')).toBe(true);
    expect(blocks[0]!.content).toBe('plan');
    expect(blocks[1]!.content).toBe('hello');
    expect(blocks[2]!.citations_json).toBe('[{"id":"r1"}]');
    expect(blocks[2]!.content).toBeNull();
    expect(blocks[3]).toMatchObject({
      tool_name: 'search', tool_input_json: '{"name":"search","arguments":{"q":"x"}}',
      tool_output_json: '{"ok":true}', content: null,
    });
    expect(JSON.parse(first.block_ids_json)).toHaveLength(4);

    const legacyAssignments = dataDb.all<{ id: number; migrated_session_id: string | null }>(
      `SELECT m.id, map.session_id AS migrated_session_id FROM chat_messages m
       LEFT JOIN legacy_chat_migration_map map ON map.legacy_id = m.id ORDER BY m.id`);
    expect(legacyAssignments.map(item => item.migrated_session_id)).toEqual([
      sessions[1]!.id, sessions[1]!.id, sessions[0]!.id,
    ]);
    expect(legacyAssignments.map(item => item.id)).toEqual([firstId, secondId, thirdId]);

    const status = await host.invoke<MigrationCheckResult>('chat_v2_check_migration_status');
    expect(status).toMatchObject({
      needsMigration: false, pendingMessages: 0, pendingSessions: 0,
      migratedMessages: 3, canRollback: true,
    });
    const latest = f.db.get<{ metadata_json: string }>(
      'SELECT metadata_json FROM chat_v2_sessions ORDER BY created_at DESC LIMIT 1')!;
    expect(status.lastMigrationAt).toBe(
      (JSON.parse(latest.metadata_json) as { migratedAt: number }).migratedAt);
  });

  it('emits started, progress and completed events on chat_v2_migration', async () => {
    mistake(dataDb, 'm1');
    legacyMessage(dataDb, { mistakeId: 'm1', role: 'user', content: 'one' });
    legacyMessage(dataDb, { mistakeId: 'm1', role: 'assistant', content: 'two' });

    await host.invoke<MigrationReport>('chat_v2_migrate_legacy_chat');
    const events = host.eventsNamed(MIGRATION_EVENT_CHANNEL) as Array<{
      eventType: string; progress: Record<string, unknown>; message: string;
    }>;
    expect(events[0]).toMatchObject({
      eventType: 'started', message: '开始迁移旧版对话数据',
      progress: { status: 'in_progress', percent: 0, currentStep: 'check_legacy_data' },
    });
    expect(events[1]).toMatchObject({
      eventType: 'progress', message: '正在检查旧版数据...',
    });
    expect(events[2]).toMatchObject({
      eventType: 'progress', message: '正在分组消息...',
      // Rust emits this event before assigning total_sessions / current_mistake_id.
      progress: { totalMessages: 2, totalSessions: 0, currentMistakeId: null },
    });
    expect(events[3]).toMatchObject({
      eventType: 'progress', message: '正在创建会话: m1',
      progress: { currentStep: 'create_session', totalSessions: 1, currentMistakeId: 'm1' },
    });
    expect(events[4]).toMatchObject({
      eventType: 'progress', message: '正在迁移消息 1/2',
      progress: { currentStep: 'migrate_messages', migratedMessages: 0, percent: 0 },
    });
    expect(events[5]).toMatchObject({
      eventType: 'progress', message: '正在迁移消息 2/2',
      progress: { migratedMessages: 1, percent: 50, createdSessions: 1 },
    });
    expect(events[6]).toMatchObject({
      eventType: 'progress', message: '迁移完成',
      progress: { currentStep: 'finished', migratedMessages: 2, percent: 100 },
    });
    expect(events[7]).toMatchObject({
      eventType: 'completed', message: '迁移完成', progress: { status: 'completed', percent: 100 },
    });
    expect(events).toHaveLength(8);
  });

  it('reports completed with zero work when there are no legacy messages', async () => {
    const report = await host.invoke<MigrationReport>('chat_v2_migrate_legacy_chat');
    expect(report).toMatchObject({
      status: 'completed', sessionsCreated: 0, messagesMigrated: 0, blocksCreated: 0, errors: [],
    });
    const events = host.eventsNamed(MIGRATION_EVENT_CHANNEL) as Array<{ eventType: string }>;
    expect(events.map(event => event.eventType)).toEqual(['started', 'progress', 'completed']);
  });

  it('rolls back a failed session without aborting the remaining groups', async () => {
    mistake(dataDb, 'boom');
    mistake(dataDb, 'ok');
    legacyMessage(dataDb, { mistakeId: 'boom', role: 'user', content: 'explode', timestamp: '2026-02-03T00:00:00Z' });
    legacyMessage(dataDb, { mistakeId: 'ok', role: 'user', content: 'safe', timestamp: '2026-02-03T00:00:01Z' });
    f.db.exec(`CREATE TRIGGER fail_block BEFORE INSERT ON chat_v2_blocks
      WHEN NEW.block_type = 'content' AND NEW.content = 'explode'
      BEGIN SELECT RAISE(ABORT, 'boom'); END`);

    const report = await host.invoke<MigrationReport>('chat_v2_migrate_legacy_chat');
    expect(report.status).toBe('completed');
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain('会话 boom 迁移失败: Database error: 创建块失败:');
    // Rust increments the counters inside the transaction and never subtracts
    // them on rollback, so the report over-counts the failed session.
    expect(report.sessionsCreated).toBe(2);
    expect(report.messagesMigrated).toBe(1);
    expect(report.blocksCreated).toBe(1);

    const sessions = f.db.all<{ title: string }>('SELECT title FROM chat_v2_sessions');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.title).toBe('safe');
    const boom = dataDb.get<{ migrated_session_id: string | null }>(
      `SELECT map.session_id AS migrated_session_id FROM chat_messages m
       LEFT JOIN legacy_chat_migration_map map ON map.legacy_id = m.id WHERE m.mistake_id = 'boom'`)!;
    expect(boom).toEqual({ migrated_session_id: null });
  });

  it('rollback deletes migrated sessions and resets the legacy markers first', async () => {
    mistake(dataDb, 'm1');
    legacyMessage(dataDb, { mistakeId: 'm1', role: 'user', content: 'one' });
    legacyMessage(dataDb, { mistakeId: 'm1', role: 'assistant', content: 'two' });
    await host.invoke<MigrationReport>('chat_v2_migrate_legacy_chat');
    expect(f.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM chat_v2_sessions')!.count).toBe(1);

    const report = await host.invoke<MigrationReport>('chat_v2_rollback_migration');
    expect(report).toMatchObject({
      status: 'rolled_back', sessionsCreated: 1, messagesMigrated: 2, errors: [],
    });
    expect(f.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM chat_v2_sessions')!.count).toBe(0);
    expect(f.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM chat_v2_messages')!.count).toBe(0);
    expect(f.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM chat_v2_blocks')!.count).toBe(0);
    const markers = dataDb.all<{ migrated_session_id: string | null }>(
      `SELECT map.session_id AS migrated_session_id FROM chat_messages m
       LEFT JOIN legacy_chat_migration_map map ON map.legacy_id = m.id`);
    expect(markers).toEqual([{ migrated_session_id: null }, { migrated_session_id: null }]);

    const events = host.eventsNamed(MIGRATION_EVENT_CHANNEL) as Array<{
      eventType: string; message: string; progress: Record<string, unknown>;
    }>;
    expect(events.at(-2)).toMatchObject({
      eventType: 'rollback_started', message: '开始回滚迁移',
      progress: { status: 'not_started', percent: 0 },
    });
    expect(events.at(-1)).toMatchObject({
      eventType: 'rollback_completed',
      message: '回滚完成，删除 1 个会话，重置 2 条消息',
      progress: { status: 'rolled_back' },
    });

    const status = await host.invoke<MigrationCheckResult>('chat_v2_check_migration_status');
    expect(status).toMatchObject({
      needsMigration: true, pendingMessages: 2, migratedMessages: 0, canRollback: false,
    });
  });

  it('rollback rejects with DATABASE_ERROR when the legacy marker column is missing', async () => {
    mistake(dataDb, 'm1');
    legacyMessage(dataDb, { mistakeId: 'm1', role: 'user', content: 'one' });
    await expect(host.invoke('chat_v2_rollback_migration')).rejects.toBe(
      databaseError('重置迁移标记失败: no such column: migrated_to_v2'));
  });

  it('migrate reports a failed status when the legacy table is missing', async () => {
    dataDb.run('DROP TABLE chat_messages');
    const report = await host.invoke<MigrationReport>('chat_v2_migrate_legacy_chat');
    expect(report.status).toBe('failed');
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain('准备查询失败: no such table: chat_messages');
  });

  it('migration ignores malformed legacy metadata instead of failing', async () => {
    mistake(dataDb, 'm1', { chatMetadata: 'not-json' });
    legacyMessage(dataDb, {
      mistakeId: 'm1', role: 'assistant', content: 'body', metadata: '{bad',
      imagePaths: 'not-json', imageBase64: '{"a":1}', docAttachments: '[42]',
      toolCall: 'not-json',
    });
    const report = await host.invoke<MigrationReport>('chat_v2_migrate_legacy_chat');
    expect(report).toMatchObject({ status: 'completed', sessionsCreated: 1, blocksCreated: 2, errors: [] });
    const session = f.db.get<{ title: string }>('SELECT title FROM chat_v2_sessions')!;
    expect(session.title).toBe('对话（迁移）');
    const message = f.db.get<{ meta_json: string; attachments_json: string | null }>(
      'SELECT meta_json, attachments_json FROM chat_v2_messages')!;
    expect(JSON.parse(message.meta_json)).toEqual({ migratedFrom: 'chat_messages', legacyId: 1 });
    expect(JSON.parse(message.attachments_json!)).toEqual([
      { id: expect.stringMatching(/^att_/), name: 'document', type: 'document',
        mimeType: 'application/octet-stream', size: 0, status: 'ready' },
    ]);
    const tool = f.db.get<{ tool_name: string | null; tool_input_json: string; tool_output_json: string | null }>(
      "SELECT tool_name, tool_input_json, tool_output_json FROM chat_v2_blocks WHERE block_type = 'mcp_tool'")!;
    expect(tool).toEqual({ tool_name: null, tool_input_json: 'not-json', tool_output_json: null });
  });

  it('derives titles from chat metadata, OCR text, user question and the first user message', () => {
    mistake(dataDb, 'meta', { chatMetadata: '{"title":"Metadata title"}', ocrText: 'ocr' });
    mistake(dataDb, 'new-chat', { chatMetadata: '{"title":"新对话"}', ocrText: '  OCR 行1\n行2  ' });
    mistake(dataDb, 'question', { userQuestion: '  User question  ' });
    mistake(dataDb, 'none');
    const empty: LegacyMessageRow[] = [];
    expect(sessionTitle(dataDb, 'meta', empty)).toBe('Metadata title');
    expect(sessionTitle(dataDb, 'new-chat', empty)).toBe('OCR 行1');
    expect(sessionTitle(dataDb, 'question', empty)).toBe('User question');
    expect(sessionTitle(dataDb, 'none', empty)).toBe('对话（迁移）');
    expect(sessionTitle(dataDb, 'none', [row({ content: '  first\r\nsecond  ' })])).toBe('first');
    expect(sessionTitle(dataDb, 'missing', empty)).toBe('对话（迁移）');
  });

  it('truncates titles to 50 code points and appends an ellipsis', () => {
    const long = '中'.repeat(60);
    expect(truncateTitle(long)).toBe(`${'中'.repeat(50)}...`);
    expect(truncateTitle('短标题')).toBe('短标题');
    expect(truncateTitle('line1\nline2')).toBe('line1');
    expect(truncateTitle('line1\r\nline2')).toBe('line1');
    expect(truncateTitle('')).toBe('');
  });

  it('parses RFC3339 timestamps with offsets and falls back to epoch', () => {
    expect(parseLegacyTimestamp('2026-02-03T04:05:06.789Z')).toBe(Date.parse('2026-02-03T04:05:06.789Z'));
    expect(parseLegacyTimestamp('2026-02-03T12:05:06+08:00')).toBe(Date.parse('2026-02-03T04:05:06Z'));
    expect(parseLegacyTimestamp('2026-02-03T04:05:06')).toBe(0);
    expect(parseLegacyTimestamp('not-a-timestamp')).toBe(0);
    expect(parseLegacyTimestamp('')).toBe(0);
  });

  it('builds attachments from images, base64 payloads and documents', () => {
    const json = legacyAttachmentsJson(row({
      image_paths: '["/a.png","/b.png"]',
      image_base64: '["é"]',
      doc_attachments: JSON.stringify([
        { name: 'x', mimeType: 'text/plain', size: 3 },
        { name: 7, mimeType: null, size: -1 },
        'ignored',
      ]),
    }));
    const attachments = JSON.parse(json!) as Array<Record<string, unknown>>;
    expect(attachments).toHaveLength(6);
    expect(attachments.map(item => item.name))
      .toEqual(['image_1.jpg', 'image_2.jpg', 'image_1.jpg', 'x', 'document', 'document']);
    expect(attachments[1]!.previewUrl).toBe('/b.png');
    expect(attachments[2]).toMatchObject({ size: 2, previewUrl: 'data:image/jpeg;base64,é' });
    expect(attachments[3]).toMatchObject({ name: 'x', mimeType: 'text/plain', size: 3 });
    expect(attachments[4]).toMatchObject({ name: 'document', mimeType: 'application/octet-stream', size: 0 });

    expect(legacyAttachmentsJson(row())).toBeNull();
    expect(legacyAttachmentsJson(row({ image_paths: '[]', doc_attachments: '{}' }))).toBeNull();
  });

  it('legacy message metadata always records the origin row id', () => {
    expect(JSON.parse(legacyMessageMeta(row({ id: 42 })))).toEqual({
      migratedFrom: 'chat_messages', legacyId: 42,
    });
    expect(JSON.parse(legacyMessageMeta(row({ id: 7, metadata: '{"a":null}' })))).toEqual({
      migratedFrom: 'chat_messages', legacyId: 7, legacyMetadata: { a: null },
    });
  });

  it('RF-W10-legacy-chat-migration-marker-table: migrating keeps the managed chat_messages schema, so the next mistakes startup verifies', async () => {
    mistake(dataDb, 'm1');
    legacyMessage(dataDb, { mistakeId: 'm1', role: 'user', content: 'one' });
    const columnsBefore = dataDb.all<{ name: string }>("SELECT name FROM pragma_table_info('chat_messages')");

    const report = await host.invoke<MigrationReport>('chat_v2_migrate_legacy_chat');
    expect(report).toMatchObject({ status: 'completed', messagesMigrated: 1, errors: [] });

    const nextStartup = new MigrationCoordinator({ appDataDir: f.storage.locations.activeDir, auditDbPath: null })
      .migrateSingle('mistakes');
    expect(nextStartup.success, JSON.stringify(nextStartup)).toBe(true);
    expect(dataDb.all<{ name: string }>("SELECT name FROM pragma_table_info('chat_messages')")).toEqual(columnsBefore);
    expect(await host.invoke<MigrationCheckResult>('chat_v2_check_migration_status')).toMatchObject({
      needsMigration: false, pendingMessages: 0, migratedMessages: 1,
    });
  });

  it('RF-W10-legacy-chat-migration-marker-table: rows marked through the Rust-era columns stay migrated and are not loaded again', async () => {
    mistake(dataDb, 'm1');
    const rustMarked = legacyMessage(dataDb, { mistakeId: 'm1', role: 'user', content: 'old' });
    legacyMessage(dataDb, { mistakeId: 'm1', role: 'assistant', content: 'new' });
    dataDb.run('ALTER TABLE chat_messages ADD COLUMN migrated_to_v2 INTEGER DEFAULT 0');
    dataDb.run('ALTER TABLE chat_messages ADD COLUMN migrated_session_id TEXT');
    dataDb.run("UPDATE chat_messages SET migrated_to_v2 = 1, migrated_session_id = 'rust-session' WHERE id = ?1", [rustMarked]);

    expect(await host.invoke<MigrationCheckResult>('chat_v2_check_migration_status')).toMatchObject({
      needsMigration: true, pendingMessages: 1, pendingSessions: 1, migratedMessages: 1,
    });
    const report = await host.invoke<MigrationReport>('chat_v2_migrate_legacy_chat');
    expect(report).toMatchObject({ status: 'completed', messagesMigrated: 1 });
    expect(await host.invoke<MigrationCheckResult>('chat_v2_check_migration_status')).toMatchObject({
      needsMigration: false, pendingMessages: 0, migratedMessages: 2,
    });

    const rollback = await host.invoke<MigrationReport>('chat_v2_rollback_migration');
    expect(rollback).toMatchObject({ status: 'rolled_back', messagesMigrated: 2 });
    expect(await host.invoke<MigrationCheckResult>('chat_v2_check_migration_status')).toMatchObject({
      needsMigration: true, pendingMessages: 2, migratedMessages: 0,
    });
  });

  it('rollbackMigration resets markers even when no chat_v2 sessions exist', () => {
    mistake(dataDb, 'm1');
    legacyMessage(dataDb, { mistakeId: 'm1', role: 'user', content: 'one' });
    dataDb.run('ALTER TABLE chat_messages ADD COLUMN migrated_to_v2 INTEGER DEFAULT 0');
    dataDb.run('ALTER TABLE chat_messages ADD COLUMN migrated_session_id TEXT');
    dataDb.run('UPDATE chat_messages SET migrated_to_v2 = 1');
    const report = rollbackMigration(dataDb, f.db, undefined);
    expect(report).toMatchObject({ status: 'rolled_back', sessionsCreated: 0, messagesMigrated: 1 });
    expect(f.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM chat_v2_sessions')!.count).toBe(0);
  });
});
