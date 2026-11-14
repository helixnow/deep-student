import { rustTrim } from '../../../platform/util/portable.ts';
import { CommandError, type Context } from '../../../kernel/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import { ChatLanceStore } from './chat-embeddings.ts';
import { deleteChatEmbeddingRows, findChatMessageIdsByStableIds } from '../repository/chat-lance.ts';
import type { LanceEngineService } from '../api.ts';
import type { SettingsWithConn } from '../../../platform/settings/api.ts';
import type { FilesService } from '../../../platform/files/api.ts';

export interface ClearMessageEmbeddingsArgs { messageIds: string[] }
export interface OptimizeChatEmbeddingsArgs {
  olderThanDays?: number | null;
  deleteUnverified?: boolean | null;
  force?: boolean | null;
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Rust str::parse::<i64>(); callers perform Rust Unicode trim first. */
function parseI64(raw: string): bigint | undefined {
  if (!/^[+-]?\d+$/.test(raw)) return undefined;
  const value = BigInt(raw);
  return value >= -9223372036854775808n && value <= 9223372036854775807n ? value : undefined;
}

export function createChatCommands(ctx: Context, engine: LanceEngineService, lanceEnabled: () => boolean) {
  const logger = ctx.logger('vfs-index');
  const files = (): FilesService => {
    const service = ctx.reflect.get('files', false) as FilesService | undefined;
    if (service === undefined) throw new Error('待接线：files（ctx.files 文件服务）');
    return service;
  };
  const createStore = () => ChatLanceStore.create(ctx.storage.database('mistakes'), engine, files, logger,
    ctx.get('settings') as SettingsWithConn | undefined);
  return {
    /** commands.rs:2012-2084, called only after kernel argument decoding. */
    async clearMessageEmbeddings(args: ClearMessageEmbeddingsArgs): Promise<null> {
      if (args.messageIds.length === 0) return null;
      const resolvedIds: bigint[] = [];
      const stableTokens: string[] = [];
      for (const token of args.messageIds) {
        const trimmed = rustTrim(token);
        if (trimmed === '') continue;
        const parsed = parseI64(trimmed);
        if (parsed !== undefined) resolvedIds.push(parsed);
        else stableTokens.push(trimmed);
      }
      if (stableTokens.length > 0) {
        try {
          resolvedIds.push(...findChatMessageIdsByStableIds(ctx.storage.database('mistakes'), stableTokens));
        } catch (error) {
          throw new CommandError(AppError.database(messageOf(error)));
        }
      }
      if (resolvedIds.length === 0) {
        logger.warn('[ClearEmbeddings] 未找到可清理的消息向量');
        return null;
      }
      resolvedIds.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
      const uniqueIds = resolvedIds.filter((id, index) => index === 0 || id !== resolvedIds[index - 1]);
      let store: ChatLanceStore | null = null;
      if (lanceEnabled()) {
        try { store = createStore(); }
        catch { store = null; } // Rust `if let Ok(store)` intentionally ignores constructor failure.
      }
      if (store !== null) {
        try {
          await store.deleteChatEmbeddingsByIds(uniqueIds.map(String));
        } catch (error) {
          logger.error(`[ClearEmbeddings] 清空向量失败: ${messageOf(error)}`);
          throw new CommandError(AppError.database(`清空向量失败: ${messageOf(error)}`));
        }
        logger.info(`[ClearEmbeddings] 已清空 Lance 中 ${uniqueIds.length} 条消息的向量`);
      }
      try {
        deleteChatEmbeddingRows(ctx.storage.database('mistakes'), uniqueIds);
      } catch (error) {
        logger.error(`[ClearEmbeddings] 无法标记数据库 embedding_retry: ${messageOf(error)}`);
      }
      return null;
    },
    /** commands.rs:2088-2105; no cancellation point in the Rust command. */
    async optimizeChatEmbeddingsTable(args: OptimizeChatEmbeddingsArgs): Promise<null> {
      let optimized = 0;
      if (lanceEnabled()) {
        try {
          optimized = await createStore().optimizeChatTables(
            args.olderThanDays ?? null, args.deleteUnverified ?? null, args.force ?? true,
          );
        } catch (error) {
          throw new CommandError(AppError.database(messageOf(error)));
        }
      }
      if (optimized === 0) logger.debug('[Lance优化] 聊天向量表在节流窗口内，未执行优化。');
      return null;
    },
  };
}

/** commands.rs:6898-6910 deliberately performs no optimization. */
export function optimizeLanceDatabase() {
  return { success: true, optimized_tables: 0, duration_ms: 0, message: 'Lance 优化已跳过' };
}
