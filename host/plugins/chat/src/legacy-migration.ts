/**
 * Legacy chat migration orchestration.
 * Rust source: `chat_v2/migration/legacy_migration.rs` + `migration/types.rs`.
 *
 * The command always resolves with a `MigrationReport` for per-session
 * failures; only a failing `BEGIN IMMEDIATE` / `COMMIT` aborts the whole run
 * (which is still reported as `status: "failed"`, not thrown).
 */
import { rustTrim, utf8ByteLength } from '../../../platform/util/index.ts';
import { now, parseRfc3339 } from '../../../platform/time/index.ts';
import type {
  MigrationCheckResult, MigrationEvent, MigrationEventType, MigrationProgress,
  MigrationReport, MigrationStep,
} from '../api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { errorText, type ChatLogger } from './logger.ts';
import {
  beginMigrationTransaction, commitMigrationTransaction, deleteMigratedSession,
  insertLegacyContentBlock, insertLegacyMessage, insertLegacySession,
  insertLegacyToolBlock, legacyMistakeInfo, loadLegacyMessages, markMessageMigrated,
  migratedSessionIds, migrationStatus, resetMigrationMarkers, rollbackMigrationTransaction,
  updateLegacyMessageBlockIds, type LegacyBlockInsert, type LegacyMessageRow,
} from '../repository/legacy-migration.ts';

export const MIGRATION_EVENT_CHANNEL = 'chat_v2_migration';
export const TITLE_MAX_LENGTH = 50;
const BLOCK_STATUS_SUCCESS = 'success';
const BLOCK_THINKING = 'thinking';
const BLOCK_CONTENT = 'content';
const BLOCK_RAG = 'rag';
const BLOCK_MEMORY = 'memory';
const BLOCK_WEB_SEARCH = 'web_search';
const BLOCK_GRAPH = 'graph';
const BLOCK_MCP_TOOL = 'mcp_tool';

function defaultProgress(): MigrationProgress {
  return {
    status: 'not_started', currentStep: 'check_legacy_data', totalMessages: 0,
    migratedMessages: 0, totalSessions: 0, createdSessions: 0, percent: 0,
    currentMistakeId: null, error: null,
  };
}

function defaultReport(): MigrationReport {
  return {
    status: 'not_started', sessionsCreated: 0, messagesMigrated: 0, blocksCreated: 0,
    attachmentsCreated: 0, messagesSkipped: 0, errors: [], startedAt: 0, endedAt: 0, durationMs: 0,
  };
}

/** `MigrationProgress::update_percent` (types.rs:87-92), including the u8 truncation. */
function updatePercent(progress: MigrationProgress): void {
  if (progress.totalMessages > 0) {
    progress.percent = Math.trunc((progress.migratedMessages / progress.totalMessages) * 100);
  }
}

/** `truncate_title` (legacy_migration.rs:381-393). */
export function truncateTitle(text: string): string {
  const firstLine = rustTrim((text.split('\n', 1)[0] ?? '').replace(/\r$/, ''));
  const chars = [...firstLine];
  return chars.length <= TITLE_MAX_LENGTH
    ? firstLine
    : `${chars.slice(0, TITLE_MAX_LENGTH).join('')}...`;
}

/** `get_session_title` (legacy_migration.rs:318-378). */
export function sessionTitle(
  dataDb: SqlExecutor, mistakeId: string, messages: readonly LegacyMessageRow[], log?: ChatLogger,
): string {
  const info = legacyMistakeInfo(dataDb, mistakeId);
  if (info !== null) {
    if (info.chatMetadata !== null) {
      try {
        const meta: unknown = JSON.parse(info.chatMetadata);
        const title = meta !== null && typeof meta === 'object'
          ? (meta as Record<string, unknown>).title : undefined;
        if (typeof title === 'string' && title !== '' && title !== '新对话') {
          return truncateTitle(title);
        }
      } catch (error) {
        log?.debug('[LegacyMigration] chat_metadata is not valid JSON: ' + errorText(error));
      }
    }
    if (info.ocrText !== null) {
      const trimmed = rustTrim(info.ocrText);
      if (trimmed !== '') return truncateTitle(trimmed);
    }
    if (info.userQuestion !== null) {
      const trimmed = rustTrim(info.userQuestion);
      if (trimmed !== '') return truncateTitle(trimmed);
    }
  }
  const firstUser = messages.find(message => message.role === 'user');
  if (firstUser !== undefined) {
    const content = rustTrim(firstUser.content);
    if (content !== '') return truncateTitle(content);
  }
  return '对话（迁移）';
}

/** `parse_timestamp` (legacy_migration.rs:760-771): invalid input falls back to epoch. */
export function parseLegacyTimestamp(value: string): number {
  return parseRfc3339(value)?.millis ?? 0;
}

function jsonObjectGet(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key] : undefined;
}

function parseStringArray(raw: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string')) return null;
    return parsed as string[];
  } catch {
    return null;
  }
}

/** `build_attachments_json` (legacy_migration.rs:697-757). */
export function legacyAttachmentsJson(message: LegacyMessageRow, log?: ChatLogger): string | null {
  const attachments: Array<Record<string, unknown>> = [];
  if (message.image_paths !== null) {
    const paths = parseStringArray(message.image_paths);
    if (paths !== null) {
      paths.forEach((path, index) => {
        attachments.push({
          id: `att_${globalThis.crypto.randomUUID()}`, name: `image_${index + 1}.jpg`, type: 'image',
          mimeType: 'image/jpeg', size: 0, status: 'ready', previewUrl: path,
        });
      });
    }
  }
  if (message.image_base64 !== null) {
    const encoded = parseStringArray(message.image_base64);
    if (encoded !== null) {
      encoded.forEach((base64, index) => {
        attachments.push({
          id: `att_${globalThis.crypto.randomUUID()}`, name: `image_${index + 1}.jpg`, type: 'image',
          mimeType: 'image/jpeg', size: utf8ByteLength(base64), status: 'ready',
          previewUrl: `data:image/jpeg;base64,${base64}`,
        });
      });
    }
  }
  if (message.doc_attachments !== null) {
    let docs: unknown;
    try {
      docs = JSON.parse(message.doc_attachments);
    } catch (error) {
      log?.debug('[LegacyMigration] doc_attachments is not valid JSON: ' + errorText(error));
      docs = undefined;
    }
    if (Array.isArray(docs)) {
      for (const doc of docs) {
        const name = jsonObjectGet(doc, 'name');
        const mimeType = jsonObjectGet(doc, 'mimeType');
        const size = jsonObjectGet(doc, 'size');
        attachments.push({
          id: `att_${globalThis.crypto.randomUUID()}`,
          name: typeof name === 'string' ? name : 'document',
          type: 'document',
          mimeType: typeof mimeType === 'string' ? mimeType : 'application/octet-stream',
          size: typeof size === 'number' && Number.isInteger(size) && size >= 0 ? size : 0,
          status: 'ready',
        });
      }
    }
  }
  return attachments.length === 0 ? null : JSON.stringify(attachments);
}

/** `build_message_meta` (legacy_migration.rs:672-694); always non-null in practice. */
export function legacyMessageMeta(message: LegacyMessageRow, log?: ChatLogger): string {
  const meta: Record<string, unknown> = { migratedFrom: 'chat_messages', legacyId: message.id };
  if (message.metadata !== null) {
    try {
      meta.legacyMetadata = JSON.parse(message.metadata);
    } catch (error) {
      log?.debug('[LegacyMigration] message metadata is not valid JSON: ' + errorText(error));
    }
  }
  return JSON.stringify(meta);
}

interface MigratedSession {
  sessionId: string;
  messageIds: number[];
}

export interface MigrationSink {
  emit(event: string, payload: MigrationEvent): void;
}

/** `MigrationExecutor` (legacy_migration.rs:57-812). */
export class MigrationExecutor {
  readonly progress: MigrationProgress = defaultProgress();
  readonly report: MigrationReport = defaultReport();

  private readonly dataDb: SqlExecutor;
  private readonly chatDb: SqlExecutor;
  private readonly sink: MigrationSink | undefined;
  private readonly log?: ChatLogger;

  constructor(
    dataDb: SqlExecutor,
    chatDb: SqlExecutor,
    sink: MigrationSink | undefined,
    log?: ChatLogger,
  ) {
    this.dataDb = dataDb;
    this.chatDb = chatDb;
    this.sink = sink;
    this.log = log;
  }

  private emitEvent(eventType: MigrationEventType, message: string): void {
    if (this.sink === undefined) return;
    const event: MigrationEvent = { eventType, progress: { ...this.progress }, message };
    try {
      this.sink.emit(MIGRATION_EVENT_CHANNEL, event);
    } catch (error) {
      this.log?.warn('[Migration] 发送事件失败: ' + errorText(error));
    }
  }

  private updateProgress(step: MigrationStep, message: string): void {
    this.progress.currentStep = step;
    updatePercent(this.progress);
    this.emitEvent('progress', message);
  }

  /** `execute` (legacy_migration.rs:94-125). */
  execute(): MigrationReport {
    this.report.startedAt = Date.now();
    this.progress.status = 'in_progress';
    this.emitEvent('started', '开始迁移旧版对话数据');

    let failure: unknown = null;
    try {
      this.executeInternal();
    } catch (error) {
      failure = error;
    }

    this.report.endedAt = Date.now();
    this.report.durationMs = this.report.endedAt - this.report.startedAt;

    if (failure === null) {
      this.report.status = 'completed';
      this.progress.status = 'completed';
      this.progress.percent = 100;
      this.emitEvent('completed', '迁移完成');
    } else {
      const text = errorText(failure);
      this.report.status = 'failed';
      this.progress.status = 'failed';
      this.progress.error = text;
      this.report.errors.push(text);
      this.emitEvent('failed', `迁移失败: ${text}`);
    }
    return this.report;
  }

  /** `execute_internal` (legacy_migration.rs:127-238). */
  private executeInternal(): void {
    this.updateProgress('check_legacy_data', '正在检查旧版数据...');
    const messages = loadLegacyMessages(this.dataDb);
    if (messages.length === 0) {
      this.log?.info('[Migration] 没有需要迁移的消息');
      return;
    }

    this.progress.totalMessages = messages.length;
    this.updateProgress('group_by_mistake_id', '正在分组消息...');
    const grouped = new Map<string, LegacyMessageRow[]>();
    for (const message of messages) {
      const group = grouped.get(message.mistake_id);
      if (group === undefined) grouped.set(message.mistake_id, [message]);
      else group.push(message);
    }
    this.progress.totalSessions = grouped.size;

    for (const [mistakeId, group] of grouped) {
      this.progress.currentMistakeId = mistakeId;
      this.updateProgress('create_session', `正在创建会话: ${mistakeId}`);

      beginMigrationTransaction(this.chatDb);
      let migrated: MigratedSession;
      try {
        migrated = this.migrateSession(mistakeId, group);
      } catch (error) {
        try {
          rollbackMigrationTransaction(this.chatDb);
        } catch (rollbackError) {
          this.log?.error('[Migration] 回滚迁移事务失败: ' + errorText(rollbackError)
            + ' (原始错误: ' + errorText(error) + ')');
        }
        this.log?.error(`[Migration] 会话 ${mistakeId} 迁移失败并已回滚: ` + errorText(error));
        this.report.errors.push(`会话 ${mistakeId} 迁移失败: ${errorText(error)}`);
        continue;
      }

      commitMigrationTransaction(this.chatDb);
      for (const messageId of migrated.messageIds) {
        try {
          markMessageMigrated(this.dataDb, messageId, migrated.sessionId);
        } catch (error) {
          this.log?.warn(`[Migration] 标记消息 ${messageId} 已迁移失败: ` + errorText(error) + '（V2 数据已保存）');
        }
      }
    }

    this.updateProgress('finished', '迁移完成');
  }

  private migrateSession(mistakeId: string, messages: readonly LegacyMessageRow[]): MigratedSession {
    const title = sessionTitle(this.dataDb, mistakeId, messages, this.log);
    const sessionId = this.createSession(mistakeId, title);
    this.progress.createdSessions += 1;
    this.report.sessionsCreated += 1;

    const messageIds: number[] = [];
    for (const message of messages) {
      this.updateProgress('migrate_messages',
        `正在迁移消息 ${this.progress.migratedMessages + 1}/${this.progress.totalMessages}`);
      const blocks = this.migrateMessage(sessionId, message);
      this.report.blocksCreated += blocks;
      this.report.messagesMigrated += 1;
      this.progress.migratedMessages += 1;
      messageIds.push(message.id);
    }
    return { sessionId, messageIds };
  }

  /** `create_session` (legacy_migration.rs:396-430). */
  private createSession(mistakeId: string, title: string): string {
    const instant = now();
    const sessionId = `sess_${globalThis.crypto.randomUUID()}`;
    insertLegacySession(this.chatDb, {
      id: sessionId, title, createdAt: instant.rfc3339, updatedAt: instant.rfc3339,
      metadataJson: JSON.stringify({
        mistakeId, migratedFrom: 'chat_messages', migratedAt: instant.millis,
      }),
    });
    return sessionId;
  }

  /** `migrate_message` (legacy_migration.rs:433-594), returning the created block count. */
  private migrateMessage(sessionId: string, message: LegacyMessageRow): number {
    const messageId = `msg_${globalThis.crypto.randomUUID()}`;
    const timestamp = parseLegacyTimestamp(message.timestamp);
    const role = message.role === 'user' ? 'user' : 'assistant';
    insertLegacyMessage(this.chatDb, {
      id: messageId, sessionId, role, timestamp, stableId: message.stable_id,
      metaJson: legacyMessageMeta(message, this.log), attachmentsJson: legacyAttachmentsJson(message, this.log),
    });

    const blockIds: string[] = [];
    let blockIndex = 0;
    const pushBlock = (blockType: string, content: string | null, citationsJson: string | null): void => {
      blockIds.push(this.createBlock(messageId, blockType, blockIndex, content, citationsJson));
      blockIndex += 1;
    };

    if (message.thinking_content !== null && message.thinking_content !== '') {
      pushBlock(BLOCK_THINKING, message.thinking_content, null);
    }
    if (message.content !== '') pushBlock(BLOCK_CONTENT, message.content, null);
    const sources: Array<[string, string | null]> = [
      [BLOCK_RAG, message.rag_sources],
      [BLOCK_MEMORY, message.memory_sources],
      [BLOCK_WEB_SEARCH, message.web_search_sources],
      [BLOCK_GRAPH, message.graph_sources],
    ];
    for (const [blockType, value] of sources) {
      if (value !== null && value !== '[]' && value !== '') pushBlock(blockType, null, value);
    }
    if (message.tool_call !== null && message.tool_call !== '' && message.tool_call !== 'null') {
      blockIds.push(this.createToolBlock(messageId, blockIndex, message.tool_call,
        message.tool_result));
    }

    const blocksCount = blockIds.length;
    if (blockIds.length > 0) {
      updateLegacyMessageBlockIds(this.chatDb, messageId, JSON.stringify(blockIds));
    }
    return blocksCount;
  }

  /** `create_block` (legacy_migration.rs:597-627). */
  private createBlock(
    messageId: string, blockType: string, blockIndex: number,
    content: string | null, citationsJson: string | null,
  ): string {
    const blockId = `blk_${globalThis.crypto.randomUUID()}`;
    const block: LegacyBlockInsert = {
      id: blockId, messageId, blockType, status: BLOCK_STATUS_SUCCESS, blockIndex,
      content, citationsJson, toolName: null, toolInputJson: null, toolOutputJson: null,
      now: Date.now(),
    };
    insertLegacyContentBlock(this.chatDb, block);
    return blockId;
  }

  /** `create_tool_block` (legacy_migration.rs:630-669). */
  private createToolBlock(
    messageId: string, blockIndex: number, toolCallJson: string, toolOutputJson: string | null,
  ): string {
    const blockId = `blk_${globalThis.crypto.randomUUID()}`;
    let toolName: string | null = null;
    try {
      const parsed: unknown = JSON.parse(toolCallJson);
      const name = jsonObjectGet(parsed, 'name');
      if (typeof name === 'string') toolName = name;
    } catch (error) {
      this.log?.debug('[LegacyMigration] tool_call is not valid JSON: ' + errorText(error));
    }
    insertLegacyToolBlock(this.chatDb, {
      id: blockId, messageId, blockType: BLOCK_MCP_TOOL, status: BLOCK_STATUS_SUCCESS,
      blockIndex, content: null, citationsJson: null, toolName,
      toolInputJson: toolCallJson, toolOutputJson, now: Date.now(),
    });
    return blockId;
  }
}

/** `check_migration_status` command body (handlers/migration.rs:19-29). */
export function checkMigrationStatus(dataDb: SqlExecutor, chatDb: SqlExecutor): MigrationCheckResult {
  return migrationStatus(dataDb, chatDb);
}

/** `migrate_legacy_chat` (legacy_migration.rs:922-929). */
export function migrateLegacyChat(
  dataDb: SqlExecutor, chatDb: SqlExecutor, sink: MigrationSink | undefined, log?: ChatLogger,
): MigrationReport {
  return new MigrationExecutor(dataDb, chatDb, sink, log).execute();
}

/** `rollback_migration` (legacy_migration.rs:936-1022). */
export function rollbackMigration(
  dataDb: SqlExecutor, chatDb: SqlExecutor, sink: MigrationSink | undefined, log?: ChatLogger,
): MigrationReport {
  const report = defaultReport();
  report.startedAt = Date.now();

  const emit = (event: MigrationEvent): void => {
    if (sink === undefined) return;
    try {
      sink.emit(MIGRATION_EVENT_CHANNEL, event);
    } catch (error) {
      log?.warn('[Migration] 发送事件失败: ' + errorText(error));
    }
  };

  emit({ eventType: 'rollback_started', progress: defaultProgress(), message: '开始回滚迁移' });

  const migratedSessions = migratedSessionIds(chatDb);

  // Reset markers before deleting V2 data so a failed delete can be retried.
  const resetCount = resetMigrationMarkers(dataDb);
  report.messagesMigrated = resetCount;
  log?.info(`[Migration::Rollback] 已重置 ${resetCount} 条消息的迁移标记`);

  const deleteErrors: string[] = [];
  for (const sessionId of migratedSessions) {
    try {
      deleteMigratedSession(chatDb, sessionId);
      report.sessionsCreated += 1; // reuses the field for the deleted count
    } catch (error) {
      deleteErrors.push(`删除会话 ${sessionId} 失败: ${errorText(error)}`);
    }
  }
  if (deleteErrors.length > 0) {
    log?.warn('[Migration::Rollback] 部分会话删除失败: ' + deleteErrors.join('; '));
    report.errors.push(...deleteErrors);
  }

  report.endedAt = Date.now();
  report.durationMs = report.endedAt - report.startedAt;
  report.status = 'rolled_back';

  emit({
    eventType: 'rollback_completed',
    progress: { ...defaultProgress(), status: 'rolled_back' },
    message: `回滚完成，删除 ${migratedSessions.length} 个会话，重置 ${resetCount} 条消息`,
  });
  return report;
}
