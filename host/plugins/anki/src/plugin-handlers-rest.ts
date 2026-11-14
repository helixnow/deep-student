/**
 * 卡片内容、保存、统计、会话来源与待处理记忆候选命令。
 */
import { type CommandHandler } from '../../../kernel/api.ts';
import type {} from '../../../platform/paths/api.ts';
import type { SaveAnkiCardsRequest, SaveAnkiCardsResponse } from '../../../../contracts/ipc/generated/L16-anki.ts';
import { decodeAnkiLibraryCardRow, type AnkiLibraryCardRow } from './library.ts';
import { buildSaveAnkiCardsChangedPayload, saveAnkiCardsInDatabase, SaveCardsError } from './save-cards.ts';
import {
  dismissPendingMemoryCandidates,
  expirePendingMemoryCandidates,
  getAnkiStats,
  listDocumentSessions,
  listPendingMemoryCandidates,
  markPendingMemoryCandidatesSaved,
  getLibraryCardRecord,
  recoverStuckDocumentTasks,
  setDocumentSessionSource,
  type PendingMemoryCandidateRow,
} from '../repository/anki-cards.ts';

import type { AnkiPluginRuntime } from './plugin-runtime.ts';
import {
  dbFailure,
  messages,
  normalizeConversationId,
  pendingMemoryDbFailure,
  throwApp,
  validationFailure,
} from './plugin-runtime.ts';

export function createRestHandlers(rt: AnkiPluginRuntime): Record<string, CommandHandler> {
  const { ctx, db } = rt;
  return {
      get_anki_library_card_content: async (args) => {
        const { cardId } = args as { cardId: string };
        const trimmed = cardId.trim();
        let row: AnkiLibraryCardRow | undefined;
        try {
          if (trimmed === '') throw new Error('cardId is required');
          row = getLibraryCardRecord(db(), trimmed, Date.now());
        } catch (error) {
          throwApp('Database', `读取库卡片失败: ${messages(error)}`);
        }
        return row === undefined ? null : decodeAnkiLibraryCardRow(row);
      },

      save_anki_cards: async (args) => {
        const { request } = args as { request: SaveAnkiCardsRequest };
        let response: SaveAnkiCardsResponse;
        try {
          response = saveAnkiCardsInDatabase(db(), request);
        } catch (error) {
          if (error instanceof SaveCardsError) throwApp(error.errorType, error.message);
          throw error;
        }
        const payload = buildSaveAnkiCardsChangedPayload(response);
        if (payload !== null) {
          try {
            ctx.backendEvents.emit('fsrs://changed', payload);
          } catch (error) {
            ctx.logger.warn(`[save_anki_cards] Failed to emit fsrs://changed: ${messages(error)}`);
          }
        }
        return response;
      },

      recover_stuck_document_tasks: async () => {
        try {
          return recoverStuckDocumentTasks(db(), 10);
        } catch (error) {
          dbFailure('恢复卡住任务失败', error);
        }
      },

      list_document_sessions: async (args) => {
        const { limit } = args as { limit: number | null };
        try {
          return listDocumentSessions(db(), limit ?? 50);
        } catch (error) {
          dbFailure('获取任务列表失败', error);
        }
      },

      get_anki_stats: async () => {
        try {
          return getAnkiStats(db(), ctx.logger);
        } catch (error) {
          dbFailure('获取统计失败', error);
        }
      },

      set_document_session_source: async (args) => {
        const documentId = (args as { documentId: string }).documentId.trim();
        const sessionId = (args as { sessionId: string }).sessionId.trim();
        if (documentId === '') validationFailure('documentId 不能为空');
        if (sessionId === '') validationFailure('sessionId 不能为空');
        try {
          setDocumentSessionSource(db(), documentId, sessionId);
        } catch (error) {
          dbFailure('设置文档来源会话失败', error);
        }
        return null;
      },

      // ---------------------------------------------------------------- 待处理记忆候选
      get_pending_memory_candidates: async (args) => {
        const { conversationId } = args as { conversationId: string };
        const normalized = normalizeConversationId(conversationId);
        let rows: PendingMemoryCandidateRow[];
        try {
          expirePendingMemoryCandidates(db());
          rows = listPendingMemoryCandidates(db(), normalized);
        } catch (error) {
          pendingMemoryDbFailure(error);
        }
        if (rows.length === 0) return null;
        const first = rows[0]!;
        return {
          conversation_id: normalized,
          subject: first.subject,
          candidates: rows.map((row) => ({ content: row.content, category: row.category })),
          created_at: first.created_at,
        };
      },

      dismiss_pending_memory_candidates: async (args) => {
        const { conversationId } = args as { conversationId: string };
        const normalized = normalizeConversationId(conversationId);
        try {
          return dismissPendingMemoryCandidates(db(), normalized);
        } catch (error) {
          pendingMemoryDbFailure(error);
        }
      },

      mark_pending_memory_candidates_saved: async (args) => {
        const { conversationId } = args as { conversationId: string };
        const normalized = normalizeConversationId(conversationId);
        try {
          return markPendingMemoryCandidatesSaved(db(), normalized);
        } catch (error) {
          pendingMemoryDbFailure(error);
        }
      },
  };
}

