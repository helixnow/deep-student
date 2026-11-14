/**
 * `anki` 服务面向 L24 chatanki 的嵌套仓储适配。
 *
 * 卡片/文档 SQL 在 `repository/chatanki-surface.ts`；本文件只做服务形状映射。
 * L04 `chatSession`、F4 `settings`、L11 `vfsDatabase` + `vfsRepo` 都是按需查找：
 * 缺少对应服务时显式抛错，不做静默降级。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { isVirtualUri } from '../../../platform/storage/file-names.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import type { ChatSessionService } from '../../chat/api.ts';
import type { VfsDatabase } from '../../vfs/api.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import type { MessageBlock } from '../../../../contracts/ipc/generated/L04-chat-session.ts';
import type {
  AnkiApkgExporter,
  AnkiApkgImporter,
  AnkiApkgVfs,
  AnkiCardRepository,
  AnkiChatBlock,
  AnkiChatBlockStore,
  AnkiDocumentTaskRepository,
  AnkiPreferenceObservation,
  AnkiPreferenceMemory,
  AnkiSettingsStore,
} from '../api.ts';
import { exportMultiTemplateApkgReport } from './apkg-exporter.ts';
import { ApkgImporterService } from './apkg-importer.ts';
import { sanitizeFilenameWithExtension } from './files.ts';
import type { ApkgImportResult } from './apkg-types.ts';
import {
  consolidateObservation,
  createPreferenceStore,
  type ConsolidateOutcome,
  type PreferenceStore,
} from './preference-memory.ts';
import { decodeAnkiCardRow, decodeDocumentTaskRow } from './anki-cards.ts';
import {
  getCardsForDocumentForSession as getCardRowsForDocumentForSession,
  listCardsForDocument,
  listTasksForDocument,
  setDocumentSessionSource as setDocumentSessionSourceRow,
} from '../repository/anki-cards.ts';
import { insertDocumentTask as insertDocumentTaskRow } from '../repository/document-processing.ts';
import {
  deleteCardForSession as deleteCardRow,
  getDocumentSessionSource as getDocumentSessionSourceRow,
  getLibraryCardsByIds as getLibraryCardRowsByIds,
  getLiveCardForOwnedDocumentSession,
  getLiveCardForSession,
  getLiveCardWithDocument,
  insertCard as insertCardRow,
  insertCardsForDocument as insertCardsForDocumentRows,
  isDocumentOwnedBySession as isDocumentOwnedBySessionRow,
  retemplateCardsForSession as retemplateCardsRows,
  updateCardIfVersionForSession as updateCardRow,
} from '../repository/chatanki-surface.ts';
import { readVfsBlob, resolveApkgFile } from '../repository/chatanki-vfs.ts';
import { ankiLocalRuntime } from './local-runtime.ts';
import type { AnkiLogger } from './logger.ts';
import type { FsrsTransactionOwner } from './fsrs-owner.ts';
import type { NativeCompression } from '../../../platform/native/api.ts';

/** L16 service construction values shared by the nested adapters. */
export interface AnkiHostAdaptersOptions {
  db(): DatabaseHandle;
  logger: AnkiLogger;
  mediaDir: string | null;
  tempDir: string;
  openDatabase(filePath: string): DatabaseHandle;
  closeDatabase(handle: DatabaseHandle): void;
  /** L15 transaction owner; resolved lazily so the plugin can load before L15 provides it. */
  fsrsOwner(): FsrsTransactionOwner;
  /** F7 `nativeCompression`; null 时异步导入退回同步 zlib 路径。 */
  compression(): NativeCompression | null;
  now?: () => Date;
}

/** Live mistakes-DB card repository consumed by L24 chatanki. */
export function createAnkiCards(options: AnkiHostAdaptersOptions): AnkiCardRepository {
  const db = (): DatabaseHandle => options.db();
  return {
    isDocumentOwnedBySession: (documentId, sessionId) =>
      isDocumentOwnedBySessionRow(db(), documentId, sessionId),
    getCardsForDocumentForSession: (documentId, sessionId) => {
      const rows = getCardRowsForDocumentForSession(db(), documentId, sessionId);
      return rows === null ? null : rows.map(decodeAnkiCardRow);
    },
    getCardsForDocument: (documentId) =>
      listCardsForDocument(db(), documentId).map(decodeAnkiCardRow),
    getCardWithDocument: (cardId) => getLiveCardWithDocument(db(), cardId),
    getCardForSession: (cardId, sessionId) => getLiveCardForSession(db(), cardId, sessionId),
    getLibraryCardsByIds: (cardIds) => getLibraryCardRowsByIds(db(), cardIds),
    loadOwnedCard: (cardId, sessionId) =>
      getLiveCardForOwnedDocumentSession(db(), cardId, sessionId),
    insertCard: (card) => insertCardRow(db(), card),
    insertCardsForDocument: (documentId, sessionId, cards) =>
      insertCardsForDocumentRows(db(), documentId, sessionId, cards),
    updateCardIfVersionForSession: (card, expectedVersion, sessionId) =>
      updateCardRow(db(), card, expectedVersion, sessionId),
    retemplateCardsForSession: (
      selector, target, expectedVersions, sessionId, preflightedDocumentIds,
    ) => retemplateCardsRows(
      db(), selector, target, expectedVersions, sessionId, preflightedDocumentIds,
    ),
    deleteCardForSession: (
      cardId, expectedVersion, expectedReviewVersion, sessionId,
    ) => deleteCardRow(
      db(), options.fsrsOwner(), cardId, expectedVersion, expectedReviewVersion, sessionId,
    ),
  };
}

/** Live mistakes-DB document/task repository consumed by L24 chatanki. */
export function createAnkiDocuments(
  options: AnkiHostAdaptersOptions,
): AnkiDocumentTaskRepository {
  const db = (): DatabaseHandle => options.db();
  return {
    getTasksForDocument: (documentId) =>
      listTasksForDocument(db(), documentId).map(decodeDocumentTaskRow),
    insertDocumentTask: (task) => insertDocumentTaskRow(db(), task),
    getDocumentSessionSource: (documentId) => getDocumentSessionSourceRow(db(), documentId),
    setDocumentSessionSource: (documentId, sessionId) =>
      setDocumentSessionSourceRow(db(), documentId, sessionId),
  };
}

function requireSettings(ctx: Context): SettingsStore {
  const service = ctx.get('settings') as SettingsStore | undefined;
  if (service === undefined) throw new Error('settings service is not available');
  return service;
}

/** F4 settings adapter using the published `get`/`save` names. */
export function createAnkiSettings(ctx: Context): AnkiSettingsStore {
  return {
    getSetting: (key) => requireSettings(ctx).get(key),
    saveSetting: (key, value) => requireSettings(ctx).save(key, value),
  };
}

/** L16 preference-memory pure functions with the chatanki camelCase observation. */
export function createAnkiPreferenceMemory(): AnkiPreferenceMemory {
  return {
    emptyStore: () => createPreferenceStore(),
    consolidateObservation: (
      store: PreferenceStore,
      observation: AnkiPreferenceObservation,
      nowMs: number | bigint,
    ): ConsolidateOutcome => consolidateObservation(store, {
      extra_requirements: observation.extraRequirements,
      edits: observation.edits.map((edit) => ({ ...edit })),
      deletions: observation.deletions.map((deletion) => ({ ...deletion })),
      generated_count: observation.generatedCount,
      template_used: observation.templateUsed,
    }, nowMs),
  };
}

function requireChatSession(ctx: Context): ChatSessionService {
  const service = ctx.get('chatSession') as ChatSessionService | undefined;
  if (service === undefined) throw new Error('chatSession service is not available');
  return service;
}

function chatBlock(
  block: MessageBlock,
  sessionId: string,
): AnkiChatBlock {
  return {
    id: block.id,
    sessionId,
    type: block.type,
    status: block.status,
    toolOutput: block.toolOutput ?? null,
    error: block.error ?? null,
    messageId: block.messageId,
    toolName: block.toolName ?? null,
    startedAt: block.startedAt ?? null,
    firstChunkAt: block.firstChunkAt ?? null,
    endedAt: block.endedAt ?? null,
  };
}

function toMessageBlock(block: AnkiChatBlock, existing: MessageBlock | null): MessageBlock {
  const messageId = block.messageId ?? existing?.messageId;
  if (messageId === undefined || messageId === '') {
    throw new Error(`chat block ${block.id} is missing messageId`);
  }
  return {
    id: block.id,
    messageId,
    type: block.type !== '' ? block.type : existing?.type ?? 'anki_cards',
    status: block.status ?? existing?.status ?? 'running',
    content: existing?.content ?? null,
    toolName: block.toolName !== undefined ? block.toolName : existing?.toolName ?? null,
    toolInput: existing?.toolInput ?? null,
    toolOutput: block.toolOutput,
    citations: existing?.citations ?? null,
    error: block.error !== undefined ? block.error : existing?.error ?? null,
    startedAt: block.startedAt !== undefined ? block.startedAt : existing?.startedAt ?? null,
    endedAt: block.endedAt !== undefined ? block.endedAt : existing?.endedAt ?? null,
    firstChunkAt: block.firstChunkAt !== undefined ? block.firstChunkAt : existing?.firstChunkAt ?? null,
  };
}

/** L04 chatSession-backed block store used by chatanki mutation UI sync. */
export function createAnkiChatBlocks(ctx: Context): AnkiChatBlockStore {
  return {
    listSessionBlocks: (sessionId) => {
      const session = requireChatSession(ctx);
      return session.getSessionMessages(sessionId).flatMap((message) =>
        session.getMessageBlocks(message.id).map((block) => chatBlock(block, message.sessionId)));
    },
    getBlock: (blockId) => {
      const session = requireChatSession(ctx);
      const block = session.getBlock(blockId);
      if (block === null) return null;
      const message = session.getMessage(block.messageId);
      if (message === null) {
        throw new Error(`chat block ${blockId} has no parent message`);
      }
      return chatBlock(block, message.sessionId);
    },
    updateBlock: (block) => {
      const session = requireChatSession(ctx);
      const existing = session.getBlock(block.id);
      if (existing === null) throw new Error(`chat block not found: ${block.id}`);
      session.updateBlock(toMessageBlock(block, existing));
    },
    /** `chatanki_executor.rs:14592-14691` upsert_block_allow_orphan. */
    upsertBlock: (block) => {
      const session = requireChatSession(ctx);
      const existing = session.getBlock(block.id);
      // AnkiChatBlock has no content/toolInput/citations; every Rust caller passes None and the ON CONFLICT update writes excluded.* (14651-14664).
      const input: MessageBlock = { ...toMessageBlock(block, existing), content: null, toolInput: null, citations: null };
      if (session.getMessage(input.messageId) === null) {
        try {
          session.createMessage({
            id: input.messageId, sessionId: orphanSessionId(input.messageId), role: 'assistant', blockIds: [], timestamp: Date.now(),
          });
        } catch { // boundary-allow empty-catch: chatanki_executor.rs:14619 `let _ = conn.execute(INSERT OR IGNORE …)` drops the placeholder error; the block write below reports the FK failure
        }
      }
      if (existing === null) session.createBlock({ ...input, blockIndex: block.blockIndex ?? 0 } as MessageBlock);
      else session.updateBlock(input);
      try {
        session.appendBlockIdToMessageWithConn(session.database.getConn(), input.messageId, block.id);
      } catch { // boundary-allow empty-catch: chatanki_executor.rs:14689 `let _ = append_block_id_to_message(...)` is best-effort
      }
    },
  };
}

/** `chatanki_executor.rs:14611-14618`: `msg_<rest>` → `sess_<rest>`, else `orphan_sess_<id>`, first 40 chars. */
function orphanSessionId(messageId: string): string {
  const sessionId = messageId.startsWith('msg_') ? `sess_${messageId.slice('msg_'.length)}` : `orphan_sess_${messageId}`;
  return Array.from(sessionId).slice(0, 40).join('');
}

/** L16 `ApkgImporterService` bound to the real mistakes DB and `anki_media/`. */
export function createAnkiApkgImporter(options: AnkiHostAdaptersOptions): AnkiApkgImporter {
  const importer = (): ApkgImporterService => new ApkgImporterService({
    db: options.db(),
    logger: options.logger,
    mediaDir: options.mediaDir,
    tempDir: options.tempDir,
    fsrsOwner: options.fsrsOwner(),
    compression: options.compression(),
    openDatabase: (filePath) => options.openDatabase(filePath),
    closeDatabase: (handle) => options.closeDatabase(handle),
    now: () => (options.now?.() ?? new Date()).getTime(),
  });
  return {
    importBytes: (
      bytes: Uint8Array, sourceName: string | null, sessionId: string | null,
    ): ApkgImportResult => importer().importBytes(new Uint8Array(bytes), sourceName, sessionId),
    importPath: (sourcePath: string, sessionId: string | null): ApkgImportResult =>
      importer().importPath(sourcePath, sessionId),
    importBytesAsync: (
      bytes: Uint8Array, sourceName: string | null, sessionId: string | null,
    ): Promise<ApkgImportResult> =>
      importer().importBytesAsync(new Uint8Array(bytes), sourceName, sessionId),
    importPathAsync: (
      sourcePath: string, sessionId: string | null,
    ): Promise<ApkgImportResult> => importer().importPathAsync(sourcePath, sessionId),
  };
}

/** L16 `export_multi_template_apkg_report` bound to the host temp dir and storage handles. */
export function createAnkiApkgExporter(options: AnkiHostAdaptersOptions): AnkiApkgExporter {
  return {
    exportMultiTemplateReport: (cards, deckName, outputPath, templateMap) => exportMultiTemplateApkgReport({
      logger: options.logger,
      openDatabase: (filePath) => options.openDatabase(filePath),
      closeDatabase: (handle) => options.closeDatabase(handle),
      tempDir: options.tempDir,
      now: () => (options.now?.() ?? new Date()).getTime(),
    }, cards, deckName, outputPath, templateMap),
    sanitizeFilenameWithExtension,
  };
}

function requireVfsDatabase(ctx: Context): VfsDatabase {
  const service = ctx.get('vfsDatabase') as VfsDatabase | undefined;
  if (service === undefined) throw new Error('vfsDatabase service is not available');
  return service;
}

function requireVfsRepositories(ctx: Context): VfsReposService {
  const service = ctx.get('vfsRepo') as VfsReposService | undefined;
  if (service === undefined) throw new Error('vfsRepo service is not available');
  return service;
}

/** L11 `vfsDatabase` (connection/blob dir) + `vfsRepo` public read APIs. */
export function createAnkiApkgVfs(ctx: Context): AnkiApkgVfs {
  return {
    resolveApkgFile: (rawResourceId) => {
      const database = requireVfsDatabase(ctx);
      return resolveApkgFile(requireVfsRepositories(ctx), database.getConn(), rawResourceId);
    },
    readBlob: (hash) => {
      const database = requireVfsDatabase(ctx);
      return readVfsBlob(
        requireVfsRepositories(ctx), database.getConn(), database.blobsDir(), hash,
      );
    },
    statFile: (filePath) => {
      try {
        const stat = ankiLocalRuntime().stat(filePath);
        return stat.kind === 'file' ? { size: stat.size } : null;
      } catch {
        return null;
      }
    },
    isFile: (filePath) => {
      try {
        return ankiLocalRuntime().stat(filePath).kind === 'file';
      } catch {
        return false;
      }
    },
    isVirtualUri: (filePath) => isVirtualUri(filePath),
    readFile: (filePath) => ankiLocalRuntime().readBytes(filePath),
  };
}
