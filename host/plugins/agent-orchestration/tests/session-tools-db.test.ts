import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StorageServiceImpl } from '../../../platform/storage/service.ts';
import { MigrationCoordinator } from '../../../platform/storage/migration/coordinator.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { ChatMessage, ChatSession, MessageBlock } from '../../chat/api.ts';
import {
  executeSessionGetMessagesWithDb, executeSessionListWithDb, importSessionPayload,
  prepareSessionExportWithDb,
} from '../src/session-tools.ts';
import {
  getBlocks, getMessages, getSessionById,
  type ChatBlockRecord, type ChatMessageRecord, type ChatSessionRecord, type SessionImportRepository,
} from '../repository/session-tools.ts';

const SEED_SESSION_ID = 'sess_executor_repo';
const SEED_USER_MESSAGE_ID = 'msg_executor_user';
const SEED_ASSISTANT_MESSAGE_ID = 'msg_executor_assistant';

interface ChatDatabaseFixture {
  db: DatabaseHandle;
  dispose(): void;
}

function chatDatabaseFixture(): ChatDatabaseFixture {
  const root = mkdtempSync(join(tmpdir(), 'l06-session-tools-'));
  const storage = new StorageServiceImpl({ baseDir: root, dataLocalDir: root });
  const coordinator = new MigrationCoordinator({
    appDataDir: storage.locations.activeDir,
    auditDbPath: null,
  });
  const report = coordinator.migrateSingle('chat_v2');
  if (!report.success) throw new Error(JSON.stringify(report));
  return {
    db: storage.database('chat_v2'),
    dispose() {
      storage.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Stand-in for L04's published D1 repository (branch `ds-mig/L04-chat-session`,
 * `createSessionWithConn` / `createMessageWithConn` / `createBlocksBatchWithConn`;
 * not on main yet). The caller owns the transaction; this adapter only executes
 * the owner's SQL on the supplied executor. It is not counted as L04 coverage.
 */
function createImportRepository(): SessionImportRepository {
  return {
    createSessionWithConn(tx, session) {
      tx.run(`INSERT INTO chat_v2_sessions (
          id, mode, title, description, summary_hash, title_locked, persist_status,
          created_at, updated_at, metadata_json, group_id)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      [session.id, session.mode, session.title ?? null, session.description ?? null,
        session.summaryHash ?? null, session.titleLocked ? 1 : 0, session.persistStatus,
        session.createdAt, session.updatedAt,
        session.metadata === undefined || session.metadata === null ? null : JSON.stringify(session.metadata),
        session.groupId ?? null]);
    },
    createMessageWithConn(tx, message) {
      tx.run(`INSERT INTO chat_v2_messages (
          id, session_id, role, block_ids_json, timestamp, persistent_stable_id, parent_id,
          supersedes, meta_json, attachments_json, active_variant_id, variants_json, shared_context_json)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
      [message.id, message.sessionId, message.role, JSON.stringify(message.blockIds), message.timestamp,
        message.persistentStableId ?? null, message.parentId ?? null, message.supersedes ?? null,
        message._meta === undefined || message._meta === null ? null : JSON.stringify(message._meta),
        message.attachments === undefined || message.attachments === null ? null : JSON.stringify(message.attachments),
        message.activeVariantId ?? null,
        message.variants === undefined || message.variants === null ? null : JSON.stringify(message.variants),
        message.sharedContext === undefined || message.sharedContext === null ? null : JSON.stringify(message.sharedContext)]);
    },
    createBlocksBatchWithConn(tx, blocks) {
      for (const block of blocks) {
        tx.run(`INSERT INTO chat_v2_blocks (
            id, message_id, block_type, status, block_index, content, tool_name,
            tool_input_json, tool_output_json, citations_json, error, started_at, ended_at, first_chunk_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
        [block.id, block.messageId, block.type, block.status, block.blockIndex ?? 0,
          block.content ?? null, block.toolName ?? null,
          block.toolInput === undefined ? null : JSON.stringify(block.toolInput),
          block.toolOutput === undefined ? null : JSON.stringify(block.toolOutput),
          block.citations === undefined || block.citations === null ? null : JSON.stringify(block.citations),
          block.error ?? null, block.startedAt ?? null, block.endedAt ?? null, block.firstChunkAt ?? null]);
      }
    },
  };
}

function insertSessionRow(db: DatabaseHandle, session: ChatSession): void {
  db.run(`INSERT INTO chat_v2_sessions (
      id, mode, title, description, summary_hash, title_locked, persist_status,
      created_at, updated_at, metadata_json, group_id)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
  [session.id, session.mode, session.title ?? null, session.description ?? null,
    session.summaryHash ?? null, session.titleLocked ? 1 : 0, session.persistStatus,
    session.createdAt, session.updatedAt,
    session.metadata === undefined || session.metadata === null ? null : JSON.stringify(session.metadata),
    session.groupId ?? null]);
}

function insertMessageRow(db: DatabaseHandle, message: ChatMessage): void {
  db.run(`INSERT INTO chat_v2_messages (
      id, session_id, role, block_ids_json, timestamp, persistent_stable_id, parent_id,
      supersedes, meta_json, attachments_json, active_variant_id, variants_json, shared_context_json)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
  [message.id, message.sessionId, message.role, JSON.stringify(message.blockIds), message.timestamp,
    message.persistentStableId ?? null, message.parentId ?? null, message.supersedes ?? null,
    message._meta === undefined || message._meta === null ? null : JSON.stringify(message._meta),
    message.attachments === undefined || message.attachments === null ? null : JSON.stringify(message.attachments),
    message.activeVariantId ?? null,
    message.variants === undefined || message.variants === null ? null : JSON.stringify(message.variants),
    message.sharedContext === undefined || message.sharedContext === null ? null : JSON.stringify(message.sharedContext)]);
}

function insertBlockRows(db: DatabaseHandle, blocks: ReadonlyArray<MessageBlock & { blockIndex?: number }>): void {
  for (const block of blocks) {
    db.run(`INSERT INTO chat_v2_blocks (
        id, message_id, block_type, status, block_index, content, tool_name,
        tool_input_json, tool_output_json, citations_json, error, started_at, ended_at, first_chunk_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
    [block.id, block.messageId, block.type, block.status, block.blockIndex ?? 0,
      block.content ?? null, block.toolName ?? null,
      block.toolInput === undefined ? null : JSON.stringify(block.toolInput),
      block.toolOutput === undefined ? null : JSON.stringify(block.toolOutput),
      block.citations === undefined || block.citations === null ? null : JSON.stringify(block.citations),
      block.error ?? null, block.startedAt ?? null, block.endedAt ?? null, block.firstChunkAt ?? null]);
  }
}

function seedPersistedSession(db: DatabaseHandle): void {
  const session: ChatSession = {
    id: SEED_SESSION_ID,
    mode: 'chat',
    title: 'Persisted export',
    titleLocked: false,
    persistStatus: 'active',
    createdAt: '2023-11-14T22:13:20+00:00',
    updatedAt: '2023-11-14T22:13:21+00:00',
  };
  insertSessionRow(db, session);

  const user: ChatMessage = {
    id: SEED_USER_MESSAGE_ID,
    sessionId: SEED_SESSION_ID,
    role: 'user',
    blockIds: ['blk_executor_user'],
    timestamp: 1_700_000_000_000,
  };
  insertMessageRow(db, user);
  insertBlockRows(db, [{
    id: 'blk_executor_user',
    messageId: user.id,
    type: 'content',
    status: 'success',
    blockIndex: 0,
    content: 'Persisted user question',
  }]);

  const assistant: ChatMessage = {
    id: SEED_ASSISTANT_MESSAGE_ID,
    sessionId: SEED_SESSION_ID,
    role: 'assistant',
    blockIds: ['blk_executor_thinking', 'blk_executor_answer'],
    timestamp: 1_700_000_001_000,
  };
  insertMessageRow(db, assistant);
  insertBlockRows(db, [{
    id: 'blk_executor_thinking',
    messageId: assistant.id,
    type: 'thinking',
    status: 'success',
    blockIndex: 0,
    content: 'private reasoning',
  }, {
    id: 'blk_executor_answer',
    messageId: assistant.id,
    type: 'content',
    status: 'success',
    blockIndex: 1,
    content: 'Persisted assistant answer',
  }]);
}

function toChatSession(record: ChatSessionRecord): ChatSession {
  return {
    id: record.id,
    mode: record.mode,
    title: record.title,
    description: record.description,
    summaryHash: record.summaryHash,
    titleLocked: record.titleLocked,
    persistStatus: record.persistStatus as ChatSession['persistStatus'],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    metadata: record.metadata,
    groupId: record.groupId,
    tagsHash: record.tagsHash,
  };
}

function toChatMessage(record: ChatMessageRecord): ChatMessage {
  return {
    id: record.id,
    sessionId: record.sessionId,
    role: record.role,
    blockIds: record.blockIds,
    timestamp: record.timestamp,
    persistentStableId: record.persistentStableId,
    parentId: record.parentId,
    supersedes: record.supersedes,
    _meta: record.meta as ChatMessage['_meta'],
    attachments: record.attachments as ChatMessage['attachments'],
    activeVariantId: record.activeVariantId,
    variants: record.variants as ChatMessage['variants'],
    sharedContext: record.sharedContext as ChatMessage['sharedContext'],
  };
}

function toMessageBlock(record: ChatBlockRecord): MessageBlock {
  return {
    id: record.id,
    messageId: record.messageId,
    type: record.blockType,
    status: record.status,
    content: record.content,
    toolName: record.toolName,
    toolInput: record.toolInput,
    toolOutput: record.toolOutput,
    citations: record.citations as MessageBlock['citations'],
    error: record.error,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    firstChunkAt: record.firstChunkAt,
  };
}

let fixture: ChatDatabaseFixture | null = null;

afterEach(() => {
  fixture?.dispose();
  fixture = null;
});

describe('session_executor.rs real chat_v2 repository', () => {
  it('get_messages_and_markdown_export_read_real_migrated_chat_repository', () => {
    fixture = chatDatabaseFixture();
    const db = fixture.db;
    seedPersistedSession(db);

    const page = executeSessionGetMessagesWithDb(db, {
      session_id: SEED_SESSION_ID,
      page: 1,
      page_size: 20,
    });
    expect(page.total).toBe(2);
    const messages = page.messages as Array<Record<string, unknown>>;
    expect(messages[0]!.content).toBe('Persisted user question');
    expect(messages[1]!.content).toBe('Persisted assistant answer');
    expect(JSON.stringify(page)).not.toContain('private reasoning');

    const exported = prepareSessionExportWithDb(db, {
      session_id: SEED_SESSION_ID,
      format: 'markdown',
      range: {
        start_message_id: SEED_USER_MESSAGE_ID,
        end_message_id: SEED_ASSISTANT_MESSAGE_ID,
      },
    });
    expect(exported.messageCount).toBe(2);
    expect(exported.markdown).toContain('# Persisted export');
    expect(exported.markdown).toContain('Persisted user question');
    expect(exported.markdown).toContain('Persisted assistant answer');
    expect(exported.markdown).not.toContain('private reasoning');
  });

  it('session_list_defaults_to_twenty_and_clamps_requested_limit', () => {
    fixture = chatDatabaseFixture();
    const db = fixture.db;
    for (let index = 0; index < 25; index += 1) {
      insertSessionRow(db, {
        id: `sess_list_${String(index).padStart(2, '0')}`,
        mode: 'chat',
        titleLocked: false,
        persistStatus: 'active',
        createdAt: `2026-01-01T00:00:${String(index).padStart(2, '0')}Z`,
        updatedAt: `2026-01-01T00:00:${String(index).padStart(2, '0')}Z`,
      });
    }

    const defaultPage = executeSessionListWithDb(db, {});
    expect(defaultPage.limit).toBe(20);
    expect((defaultPage.sessions as unknown[]).length).toBe(20);
    expect(defaultPage.total).toBe(25);
    expect(defaultPage.hasMore).toBe(true);

    const oversizedPage = executeSessionListWithDb(db, { limit: 500 });
    expect(oversizedPage.limit).toBe(20);
    expect((oversizedPage.sessions as unknown[]).length).toBe(20);

    const zeroPage = executeSessionListWithDb(db, { limit: 0 });
    expect(zeroPage.limit).toBe(1);
    expect((zeroPage.sessions as unknown[]).length).toBe(1);
  });

  it('session_import_creates_new_session_with_remapped_ids', () => {
    fixture = chatDatabaseFixture();
    const db = fixture.db;
    seedPersistedSession(db);

    const session = getSessionById(db, SEED_SESSION_ID);
    expect(session).not.toBeNull();
    const payload = JSON.stringify({
      session: toChatSession(session!),
      messages: getMessages(db, SEED_SESSION_ID).map(toChatMessage),
      blocks: getBlocks(db, SEED_SESSION_ID).map(toMessageBlock),
      exportedAt: '2026-01-01T00:00:00+00:00',
    });

    const result = importSessionPayload(db, createImportRepository(), payload, '导入验证');
    expect(result.success).toBe(true);
    const newSessionId = result.sessionId as string;
    expect(newSessionId).not.toBe(SEED_SESSION_ID);
    expect(newSessionId.startsWith('sess_')).toBe(true);
    expect(result.messageCount).toBe(2);
    expect(result.blockCount).toBe(3);
    expect(result.importedFromSessionId).toBe(SEED_SESSION_ID);
    expect(result.droppedOrphanBlocks).toBe(0);
    expect(result.droppedMissingBlockRefs).toBe(0);

    const imported = getSessionById(db, newSessionId);
    expect(imported).not.toBeNull();
    expect(imported!.title).toBe('导入验证');
    expect(imported!.titleLocked).toBe(true);
    expect(imported!.groupId).toBeNull();
    expect(imported!.persistStatus).toBe('active');
    expect(imported!.metadata).toMatchObject({ importedFromSessionId: SEED_SESSION_ID });

    const importedMessages = getMessages(db, newSessionId);
    expect(importedMessages.length).toBe(2);
    expect(importedMessages.every((message) => message.id !== SEED_USER_MESSAGE_ID)).toBe(true);
    expect(importedMessages.every((message) => message.sessionId === newSessionId)).toBe(true);
    expect(getBlocks(db, newSessionId).length).toBe(3);

    // 原会话保持不变
    expect(getMessages(db, SEED_SESSION_ID).length).toBe(2);
  });

  it('session_import_rejects_invalid_payloads', () => {
    fixture = chatDatabaseFixture();
    const db = fixture.db;

    expect(() => importSessionPayload(db, createImportRepository(), 'not-json', null))
      .toThrow(/SESSION_IMPORT_INVALID_JSON/);
    expect(() => importSessionPayload(db, createImportRepository(), '{"messages":[]}', null))
      .toThrow(/SESSION_IMPORT_INVALID_FORMAT/);
  });

  it('session_import_rolls_back_the_caller_owned_transaction_on_write_failure', () => {
    fixture = chatDatabaseFixture();
    const db = fixture.db;
    seedPersistedSession(db);

    const session = getSessionById(db, SEED_SESSION_ID);
    const payload = JSON.stringify({
      session: toChatSession(session!),
      messages: getMessages(db, SEED_SESSION_ID).map(toChatMessage),
      blocks: getBlocks(db, SEED_SESSION_ID).map(toMessageBlock),
    });
    const repository = createImportRepository();
    const failing: SessionImportRepository = {
      ...repository,
      createBlocksBatchWithConn() {
        throw new Error('block insert failed');
      },
    };

    expect(() => importSessionPayload(db, failing, payload, null))
      .toThrow(/SESSION_IMPORT_DB_FAILED: block insert failed/);
    expect(db.pluck<number>('SELECT COUNT(*) FROM chat_v2_sessions')).toBe(1);
    expect(db.pluck<number>('SELECT COUNT(*) FROM chat_v2_messages')).toBe(2);
    expect(db.pluck<number>('SELECT COUNT(*) FROM chat_v2_blocks')).toBe(3);
  });
});
