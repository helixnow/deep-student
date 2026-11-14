/**
 * 卡片、文档任务、会话、库列表与模型适配器命令。
 */
import { CommandError, type CommandHandler } from '../../../kernel/api.ts';
import type {} from '../../../platform/paths/api.ts';
import type {} from '../../../platform/crypto/api.ts';
import type { CustomAnkiTemplate, ListAnkiCardsRequest } from '../../../../contracts/ipc/generated/L16-anki.ts';
import { decodeTemplateRow, type TemplateRow } from './templates.ts';
import { nowRfc3339 } from './time.ts';
import type { AnkiCard } from '../../../../contracts/ipc/generated/_shared.ts';
import {
  decodeAnkiCardInput,
  decodeAnkiCardRow,
  decodeDocumentTaskRow,
  insertUserContentProvenance,
  type AnkiCardRow,
  type DocumentTaskRow,
} from './anki-cards.ts';
import { validateAnkiCardUpdate } from './enhanced-anki.ts';
import {
  buildAnkiLibraryListResponse,
  LibraryQueryError,
  type AgentReviewStateSnapshot,
  type AnkiLibraryDeckCount,
} from './library.ts';
import * as ankiConnect from './anki-connect.ts';
import {
  addNotesToAnkiDetailed,
  cardHasClozeMarkup,
  syncReportToJson,
  templateModelName,
} from './anki-sync.ts';
import { computeAnkiCardContentHash } from './card-utils.ts';
import { getTemplateById } from '../repository/templates.ts';
import {
  deleteCard,
  deleteDocumentTask,
  listCardsForDocument,
  listCardsForTask,
  listRecentCards,
  listTasksForDocument,
  countDocumentTasks,
  listAnkiLibraryCardsFiltered,
  listAnkiLibraryDeckCounts,
  writeAnkiExportContentHashes,
  writeAnkiExportReceipts,
  updateCardRows,
  zeroDocumentTaskCounts,
} from '../repository/anki-cards.ts';

import { readAnkiConnectSyncOptions } from './settings-owner.ts';
import type { AnkiPluginRuntime } from './plugin-runtime.ts';
import {
  dbFailure,
  isAppErrorValue,
  messages,
  decodeCardArg,
  throwApp,
  validationFailure,
} from './plugin-runtime.ts';
import {
  cancelDocumentProcessing,
  deleteDocumentSessionLifecycle,
  documentRunRegistry,
  getDocumentState,
  pauseDocumentProcessing,
  type EnhancedServiceDeps,
} from './enhanced-service.ts';
import { cancelStreaming, clearCancelSender, isStreaming } from './streaming-anki.ts';
import { requireFsrsTransactionOwner } from './fsrs-owner.ts';

export function createCardHandlers(rt: AnkiPluginRuntime): Record<string, CommandHandler> {
  const { ctx, db } = rt;

  /** Tauri `Window::emit` 端口：事件名固定为 `anki_generation_event`。 */
  const windowPort = {
    emit(event: string, payload: unknown): void {
      ctx.backendEvents.emit(event, payload);
    },
  };

  const enhancedDeps = (): EnhancedServiceDeps => ({
    db: db(),
    registry: documentRunRegistry,
    logger: ctx.logger,
    streaming: { cancelStreaming, clearCancelSender, isStreaming },
    fsrsOwner: requireFsrsTransactionOwner(ctx),
  });

  return {
      // ---------------------------------------------------------------- 卡片与任务
      update_anki_card: async (args) => {
        const { card: rawCard } = args as { card: Record<string, unknown> };
        const card = decodeCardArg('update_anki_card', 'card', () => decodeAnkiCardInput(rawCard, nowRfc3339));
        const invalid = validateAnkiCardUpdate(card);
        if (invalid !== null) validationFailure(invalid);
        insertUserContentProvenance(card.extra_fields, 'update_anki_card', nowRfc3339());
        let affected: number;
        try {
          affected = updateCardRows(db(), card, nowRfc3339());
        } catch (error) {
          dbFailure('更新卡片失败', error);
        }
        if (affected === 1) return null;
        if (affected === 0) throwApp('NotFound', `卡片不存在或已删除: ${card.id}`);
        throwApp('Database', `更新卡片影响了异常数量的记录: card=${card.id}, affected=${affected}`);
      },

      delete_anki_card: async (args) => {
        const { cardId } = args as { cardId: string };
        if (cardId === '') validationFailure('卡片ID不能为空');
        try {
          deleteCard(db(), cardId, requireFsrsTransactionOwner(ctx));
        } catch (error) {
          dbFailure('删除卡片失败', error);
        }
        return true;
      },

      delete_document_task: async (args) => {
        const { taskId } = args as { taskId: string };
        if (taskId === '') validationFailure('任务ID不能为空');
        try {
          deleteDocumentTask(db(), taskId, requireFsrsTransactionOwner(ctx));
        } catch (error) {
          dbFailure('删除任务失败', error);
        }
        return true;
      },

      delete_document_session: async (args) => {
        const { documentId } = args as { documentId: string };
        if (documentId === '') validationFailure('文档ID不能为空');
        try {
          await deleteDocumentSessionLifecycle(enhancedDeps(), documentId);
        } catch (error) {
          dbFailure('删除文档会话失败', error);
        }
        return true;
      },

      get_document_cards: async (args) => {
        const { documentId } = args as { documentId: string };
        let rows: AnkiCardRow[];
        try {
          rows = listCardsForDocument(db(), documentId);
        } catch (error) {
          dbFailure('获取文档卡片失败', error);
        }
        return rows.map(decodeAnkiCardRow);
      },

      get_document_tasks: async (args) => {
        const { documentId } = args as { documentId: string };
        let rows: DocumentTaskRow[];
        try {
          rows = listTasksForDocument(db(), documentId);
        } catch (error) {
          dbFailure('获取文档任务失败', error);
        }
        return rows.map(decodeDocumentTaskRow);
      },

      get_document_task_counts: async (args) => {
        const { documentId } = args as { documentId: string };
        // `enhanced_anki_service.rs:1063`：读取失败时静默返回全零计数。
        try {
          return countDocumentTasks(db(), documentId);
        } catch {
          return zeroDocumentTaskCounts();
        }
      },

      get_task_cards: async (args) => {
        const { taskId } = args as { taskId: string };
        let rows: AnkiCardRow[];
        try {
          rows = listCardsForTask(db(), taskId);
        } catch (error) {
          dbFailure('获取任务卡片失败', error);
        }
        return rows.map(decodeAnkiCardRow);
      },

      get_all_recent_cards: async (args) => {
        const { limit } = args as { limit: number | null };
        let rows: AnkiCardRow[];
        try {
          rows = listRecentCards(db(), limit ?? 100);
        } catch (error) {
          dbFailure('获取最近卡片失败', error);
        }
        return rows.map(decodeAnkiCardRow);
      },

      add_cards_to_anki_connect: async (args) => {
        const { selectedCards, deckName, noteType: requestedNoteType } =
          args as { selectedCards: AnkiCard[]; deckName: string; noteType: string };
        if (selectedCards.length === 0) validationFailure('没有选择任何卡片');
        if (deckName.trim() === '') validationFailure('牌组名称不能为空');
        if (requestedNoteType.trim() === '') validationFailure('笔记类型不能为空');

        const clozeCount = selectedCards.filter((card) => cardHasClozeMarkup(card)).length;
        const noteType = clozeCount === selectedCards.length ? 'Cloze' : requestedNoteType;

        try {
          await ankiConnect.createDeckIfNotExists(deckName);
        } catch (error) {
          ctx.logger.warn(`创建牌组失败（可能已存在）: ${messages(error)}`);
        }

        const cardModels = new Map<string, string>();
        const templatesByModel = new Map<string, CustomAnkiTemplate>();
        for (const card of selectedCards) {
          if (cardHasClozeMarkup(card)) cardModels.set(card.id, 'Cloze');
          const templateId = card.template_id?.trim();
          if (templateId === undefined || templateId === '') continue;
          if (card.id.trim() === '') continue;
          let row: TemplateRow | undefined;
          try {
            row = getTemplateById(db(), templateId);
          } catch (error) {
            validationFailure(`读取模板失败: ${messages(error)}`);
          }
          if (row === undefined) {
            validationFailure(`模板 ${templateId} 不存在，请先选择可用模板`);
          }
          const template = decodeTemplateRow(row, () => new Date());
          const modelName = templateModelName(template);
          cardModels.set(card.id, modelName);
          if (!templatesByModel.has(modelName)) templatesByModel.set(modelName, template);
        }

        const cardIds = selectedCards.map((card) => card.id);
        const crypto = ctx.get('crypto');
        if (!crypto) throw new Error('crypto service is not available');
        const contentHashes = selectedCards.map((card) => computeAnkiCardContentHash(card, crypto));
        const syncOptions = readAnkiConnectSyncOptions(ctx, db());

        let report: Awaited<ReturnType<typeof addNotesToAnkiDetailed>>;
        try {
          report = await addNotesToAnkiDetailed({
            cards: selectedCards,
            deckName,
            noteType,
            cardModels,
            templatesByModel,
            options: syncOptions,
          }, ctx.logger);
        } catch (error) {
          validationFailure(messages(error));
        }

        if (report.added === 0 && report.failed > 0) {
          let reason = '所有卡片同步失败';
          if (report.duplicates > 0) reason += `（其中 ${report.duplicates} 张为重复卡片）`;
          reason += '。请检查 Anki 中是否存在对应笔记类型、卡片字段是否为空';
          validationFailure(reason);
        }

        if (report.added > 0) {
          try {
            writeAnkiExportReceipts(db(), cardIds, report.noteIds, nowRfc3339());
            try {
              writeAnkiExportContentHashes(db(), cardIds, contentHashes, report.noteIds);
            } catch (error) {
              ctx.logger.warn(`[add_cards_to_anki_connect] content_hash 回写失败: ${messages(error)}`);
            }
          } catch (error) {
            ctx.logger.warn(`[add_cards_to_anki_connect] receipt 回写失败: ${messages(error)}`);
          }
        }

        return syncReportToJson(report);
      },

      list_anki_library_cards: async (args) => {
        const { request } = args as { request: ListAnkiCardsRequest };
        const page = Math.max(1, request.page ?? 1);
        const pageSize = Math.min(200, Math.max(1, request.pageSize ?? 12));
        const filter = {
          status: request.status ?? null,
          sort: request.sort ?? null,
          sortDesc: request.sortDesc ?? null,
          deck: request.deck ?? null,
        };
        let listing: ReturnType<typeof listAnkiLibraryCardsFiltered>;
        try {
          listing = listAnkiLibraryCardsFiltered(
            db(),
            request.templateId ?? null,
            request.search ?? null,
            filter,
            page,
            pageSize,
            Date.now(),
          );
        } catch (error) {
          throwApp('Database', `获取卡片库失败: ${messages(error)}`);
        }

        const cardIds = listing.items.map((item) => item.id);
        const reviewStates: AgentReviewStateSnapshot[] = [];
        // L15 现在是 FSRS 表的唯一所有者：库列表快照走已发布的
        // `getReviewStatesForLibrary(scope, cardIds)`，本 lane 不再自写查询。
        // D3：reviewVersion 的 i64 bigint 原样传入响应；仅 kernel IPC 出站转 number。
        const review = ctx.get('review') as
          | { getReviewStatesForLibrary?: (scope: string, ids: readonly string[]) => AgentReviewStateSnapshot[] }
          | undefined;
        if (review === undefined || typeof review.getReviewStatesForLibrary !== 'function') {
          throwApp('Configuration', 'review 服务不可用：无法读取 Library 复习状态');
        }
        try {
          for (let index = 0; index < cardIds.length; index += 100) {
            reviewStates.push(...review.getReviewStatesForLibrary('agent', cardIds.slice(index, index + 100)));
          }
        } catch (error) {
          if (error instanceof LibraryQueryError) {
            if (error.kind === 'not_found') throwApp('NotFound', error.message);
            if (error.kind === 'validation') throwApp('Validation', error.message);
          }
          throwApp('Database', `查询 Library 复习状态失败: ${messages(error)}`);
        }

        let deckCounts: AnkiLibraryDeckCount[] | null = null;
        if (request.includeDecks ?? false) {
          try {
            deckCounts = listAnkiLibraryDeckCounts(db(), Date.now());
          } catch (error) {
            throwApp('Database', `获取牌组计数失败: ${messages(error)}`);
          }
        }

        const response = buildAnkiLibraryListResponse(
          listing.items,
          page,
          pageSize,
          listing.total,
          reviewStates,
        ) as Record<string, unknown>;
        response.statusCounts = listing.statusCounts;
        if (deckCounts !== null) response.decks = deckCounts;
        return response;
      },

      // ---------------------------------------------------- 文档处理运行控制
      /** `cmd/enhanced_anki.rs:123 pause_document_processing`。 */
      pause_document_processing: async (args) => {
        const { documentId } = args as { documentId: string };
        try {
          await pauseDocumentProcessing(enhancedDeps(), documentId, windowPort);
        } catch (error) {
          if (isAppErrorValue(error)) throw new CommandError(error);
          throwApp('Database', `暂停文档处理失败: ${messages(error)}`);
        }
        return true;
      },

      /** `cmd/enhanced_anki.rs:142 cancel_document_processing`。 */
      cancel_document_processing: async (args) => {
        const { documentId } = args as { documentId: string };
        if (documentId === '') validationFailure('文档ID不能为空');
        try {
          await cancelDocumentProcessing(enhancedDeps(), documentId, windowPort);
        } catch (error) {
          if (isAppErrorValue(error)) throw new CommandError(error);
          throwApp('Database', `取消文档处理失败: ${messages(error)}`);
        }
        return true;
      },

      /** `cmd/enhanced_anki.rs:183 get_document_processing_state`。 */
      get_document_processing_state: async (args) => {
        const { documentId } = args as { documentId: string };
        return getDocumentState(documentRunRegistry, documentId);
      },

  };
}
