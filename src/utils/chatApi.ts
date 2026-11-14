import { invoke } from '@tauri-apps/api/core';
import { getErrorMessage } from './errorUtils';
import { invokeWithDebug } from './shared';
import type {
  AnkiLibraryCard,
  AnkiLibraryCardPatch,
  AnkiLibraryListResponse,
  ExportAnkiCardsResult,
  FsrsCardMutationResult,
  FsrsStats,
  ListAnkiCardsParams,
} from '../types';
import {
  applyReviewCardEdit,
  getReviewCardEditValues,
  type EditableReviewCard,
  type ReviewEditTemplate,
} from '@/features/flashcards/reviewCardEditFields';
import { getAppDataDir } from './systemApi';
// 通用转发：允许组件通过 TauriAPI.invoke 调用任意后端命令（带调试埋点）
export async function tauriInvoke<T = any>(cmd: string, args?: any): Promise<T> {
  return await invokeWithDebug<T>(cmd, args);
}
/**
 * 读取文本文件内容
 */
export async function readFileAsText(path: string): Promise<string> {
  try {
    return await invoke<string>('read_file_text', { path });
  } catch (error) {
    console.error('Failed to read file:', error);
    throw new Error(`Failed to read file: ${getErrorMessage(error)}`);
  }
}

/**
 * 复制文件到指定位置
 */
export async function copyFile(sourcePath: string, destPath: string): Promise<void> {
  try {
    await invoke<void>('copy_file', { sourcePath, destPath });
  } catch (error) {
    console.error('Failed to copy file:', error);
    throw new Error(`Failed to copy file: ${getErrorMessage(error)}`);
  }
}

/**
 * 读取二进制文件为 Uint8Array（跨平台，兼容移动端 content:// 等 URI）
 */
export async function readFileAsBytes(path: string): Promise<Uint8Array> {
  try {
    // ★ 2026-06-12（审阅问题 R4）：后端改为返回原始二进制（ArrayBuffer），
    // 不再是 JSON number[]（旧格式传输体积膨胀 3-4 倍）
    const buffer = await invoke<ArrayBuffer>('read_file_bytes', { path });
    return new Uint8Array(buffer);
  } catch (error) {
    console.error('Failed to read binary file:', error);
    throw new Error(`Failed to read binary file: ${getErrorMessage(error)}`);
  }
}

/** 获取文件大小（字节） */
export async function getFileSize(path: string): Promise<number> {
  try {
    const size = await invoke<number>('get_file_size', { path });
    return size ?? 0;
  } catch (error) {
    console.error('Failed to get file size:', error);
    return 0;
  }
}

/**
 * 将文件复制到应用私有目录下的 textbooks 目录，并返回目标路径。
 * - 桌面端：可直接返回源路径（可配置），但为一致性这里统一复制
 * - 移动端：必须复制或持久化；复制更稳定
 */
export async function copyIntoTextbooksDir(sourcePath: string): Promise<string> {
  const root = await getAppDataDir();
  const { extractFileName } = await import('@/utils/fileManager');
  const fileName = extractFileName(sourcePath) || `textbook_${Date.now()}.pdf`;
  // 使用与 root 一致的路径分隔符，避免 Windows 上产生混合分隔符
  const sep = root.includes('\\') ? '\\' : '/';
  const destPath = [root, 'textbooks', fileName].join(sep);
  try {
    // copy_file 的写入端会自动创建父目录（后端 open_writer 中实现）
    await copyFile(sourcePath, destPath);
    return destPath;
  } catch (error) {
    console.error('Failed to copy to textbook directory:', error);
    throw new Error(`Failed to copy to textbook directory: ${getErrorMessage(error)}`);
  }
}

// ==================== Anki Library ====================
export async function listAnkiLibraryCards(
  params: ListAnkiCardsParams
): Promise<AnkiLibraryListResponse> {
  const request = {
    templateId: params?.template_id,
    search: params?.search,
    page: params?.page,
    pageSize: params?.page_size,
    status: params?.status,
    sort: params?.sort,
    sortDesc: params?.sort_desc,
    deck: params?.deck,
    includeDecks: params?.include_decks,
  };
  return invoke<AnkiLibraryListResponse>('list_anki_library_cards', { request });
}

export async function enqueueAnkiLibraryCard(cardId: string): Promise<unknown> {
  return invoke('fsrs_enqueue_cards', { ankiCardIds: [cardId] });
}

export async function suspendFsrsCard(cardStateId: string): Promise<FsrsCardMutationResult> {
  return invoke<FsrsCardMutationResult>('fsrs_suspend_card', { cardStateId });
}

export async function unsuspendFsrsCard(cardStateId: string): Promise<FsrsCardMutationResult> {
  return invoke<FsrsCardMutationResult>('fsrs_unsuspend_card', { cardStateId });
}

export async function undoFsrsLastReview(
  cardStateId: string,
  expectedLogId: string,
): Promise<unknown> {
  return invoke('fsrs_undo_last_review', { cardStateId, expectedLogId });
}

/**
 * 库内编辑保存：复用复习会话的字段别名映射（reviewCardEditFields），
 * 把 front/back 编辑写回模板真正渲染的字段（如 Question/explanation），
 * 而不是硬写 fields.Front/Back 导致模板卡编辑不生效。
 */
export async function updateAnkiLibraryCard(
  card: AnkiLibraryCard,
  patch: AnkiLibraryCardPatch,
  template?: ReviewEditTemplate | null,
): Promise<void> {
  const editable: EditableReviewCard = {
    ankiCardId: card.id,
    front: card.front,
    back: card.back,
    text: card.text,
    tags: card.tags,
    images: card.images,
    templateId: card.template_id ?? null,
    extraFields: { ...(card.fields ?? {}), ...(card.extra_fields ?? {}) },
  };
  const current = getReviewCardEditValues(editable, template);
  const edit = applyReviewCardEdit(
    editable,
    {
      front: patch.front ?? current.front,
      back: patch.back ?? current.back,
    },
    template,
  );
  await invoke<void>('update_anki_card', {
    card: {
      id: card.id,
      task_id: card.task_id,
      front: edit.front,
      back: edit.back,
      text: patch.text ?? edit.text,
      tags: patch.tags ?? card.tags,
      images: card.images,
      fields: { ...edit.extraFields },
      extra_fields: { ...edit.extraFields },
      template_id: card.template_id ?? null,
      is_error_card: card.is_error_card ?? false,
      error_content: card.error_content ?? null,
    },
  });
}

export async function getFsrsStats(): Promise<FsrsStats> {
  return invoke<FsrsStats>('fsrs_get_stats');
}

/** 危险操作：清除该卡全部复习日志并重建全新调度状态（返回新 stateId）。 */
export async function resetFsrsCardProgress(cardStateId: string): Promise<unknown> {
  return invoke('fsrs_reset_card_progress', { cardStateId });
}

export async function updateAnkiCard(request: {
  id: string;
  payload: {
    front?: string;
    back?: string;
    tags?: string[];
    fields?: Record<string, string>;
    messageStableId: string | null;
  };
}): Promise<void> {
  const { id, payload } = request;
  const fields = { ...(payload.fields ?? {}) };
  const resolvedFront = payload.front ?? fields.Front ?? '';
  const resolvedBack = payload.back ?? fields.Back ?? '';
  const tags = Array.isArray(payload.tags) ? [...payload.tags] : [];
  const cardPayload = {
    id,
    front: resolvedFront,
    back: resolvedBack,
    tags,
    fields: {
      ...fields,
      Front: resolvedFront,
      Back: resolvedBack,
    },
    extra_fields: {
      ...fields,
      messageStableId: payload.messageStableId ?? null,
    },
  };
  await invoke<void>('update_anki_card', { card: cardPayload });
}

export async function deleteAnkiCard(cardId: string): Promise<boolean> {
  return invoke<boolean>('delete_anki_card', { cardId });
}

export async function exportAnkiCards(options: {
  ids: string[];
  format?: 'apkg' | 'json';
  deckName?: string;
  noteType?: string;
  templateId?: string | null;
}): Promise<ExportAnkiCardsResult> {
  const request = {
    ids: options.ids,
    format: options.format ?? 'apkg',
    deck_name: options.deckName,
    note_type: options.noteType,
    template_id: options.templateId ?? undefined,
  };
  return invoke<ExportAnkiCardsResult>('export_anki_cards', { request });
}

// ==================== 教材库（兼容壳，建议迁移到 textbookDstuAdapter） ====================

/** 教材多模态自动索引的最大并发数，避免批量导入时索引风暴。 */
const TEXTBOOK_AUTO_INDEX_CONCURRENCY = 2;

/** 单本教材的自动索引结果（供调用方/日志观测，不抛错以免影响导入主流程）。 */
export interface TextbookAutoIndexFailure {
  id: string;
  name: string;
  error: string;
}

/**
 * 后台批量索引教材（并发上限 {@link TEXTBOOK_AUTO_INDEX_CONCURRENCY}）。
 *
 * 失败不会中断队列：逐本收集失败项，结束后统一弹出一条 warning 通知并打日志。
 */
async function autoIndexTextbooksInBackground(
  textbooks: Array<{ id: string; name: string }>
): Promise<TextbookAutoIndexFailure[]> {
  if (textbooks.length === 0) return [];

  const failures: TextbookAutoIndexFailure[] = [];
  try {
    const { multimodalRagService } = await import('@/services/multimodalRagService');
    const capability = await multimodalRagService.getCapabilityStatus();
    if (!capability.available) return [];

    const queue = [...textbooks];
    const worker = async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
        try {
          await multimodalRagService.indexTextbook(item.id);
        } catch (indexError) {
          failures.push({
            id: item.id,
            name: item.name,
            error: getErrorMessage(indexError),
          });
        }
      }
    };
    const workerCount = Math.min(TEXTBOOK_AUTO_INDEX_CONCURRENCY, queue.length);
    await Promise.all(Array.from({ length: workerCount }, worker));

    if (failures.length > 0) {
      console.warn('[chatApi] Textbook auto-indexing failed:', failures);
      const { showGlobalNotification } = await import('@/components/UnifiedNotification');
      showGlobalNotification(
        'warning',
        `${failures.length}/${textbooks.length} textbook(s) failed multimodal indexing: ${failures.map((f) => f.name).join(', ')}`
      );
    }
  } catch (error) {
    // 能力探测/动态导入失败：跳过自动索引，不影响导入主流程。
    console.warn('[chatApi] Textbook auto-indexing skipped:', error);
  }
  return failures;
}

/**
 * @deprecated 请改用 `textbookDstuAdapter.addTextbooks()`。
 * 该兼容壳不支持传入 `folderId`，仅为历史调用保留。
 */
export async function textbooksAdd(filePaths: string[]): Promise<Array<{ id: string; name: string; path: string; size: number; addedAt: string }>> {
console.warn('[chatApi] textbooksAdd() is deprecated; use textbookDstuAdapter.addTextbooks() instead.');
const raw = await invoke<any>('textbooks_add', { sources: filePaths });
const list = Array.isArray(raw) ? raw : [];
const results = list.map((r: any) => ({
  id: r.id,
  name: r.file_name,
  path: r.file_path,
  size: typeof r.size === 'number' ? r.size : (typeof r.size === 'string' ? Number(r.size) : 0),
  addedAt: r.created_at || r.updated_at || new Date().toISOString(),
}));

// 教材导入后按运行时能力异步补充多模态索引（并发受限），不阻塞导入主流程。
void autoIndexTextbooksInBackground(results.map((r) => ({ id: r.id, name: r.name })));

return results;
}

// ========== Enhanced Chat Search APIs ==========
export async function rebuildChatFts(): Promise<number> {
  try {
    console.info('[TauriAPI] rebuildChatFts start');
    const res = await invoke<number>('rebuild_chat_fts');
    console.info('[TauriAPI] rebuildChatFts done', { inserted: res });
    return res || 0;
  } catch (e) {
    console.error('[TauriAPI] rebuildChatFts error', e);
    throw e;
  }
}

/**
 * 回填用户消息嵌入向量
 *
 * @deprecated 后端 `backfill_user_message_embeddings` 命令尚未实现。
 * 此前该函数恒返回 0 造成"假成功"（UI 显示维护完成但什么都没发生）；
 * 现在改为显式抛出 not-implemented 错误，调用方可通过 `code === 'NOT_IMPLEMENTED'` 识别。
 * 后端实现后请恢复为真实 invoke 调用。
 */
export async function backfillUserMessageEmbeddings(_params: Record<string, unknown>): Promise<number> {
  console.warn('[TauriAPI] backfillUserMessageEmbeddings rejected: backend command not implemented');
  const error = new Error(
    'backfillUserMessageEmbeddings is not implemented: backend command "backfill_user_message_embeddings" does not exist yet'
  ) as Error & { code: string };
  error.code = 'NOT_IMPLEMENTED';
  throw error;
}

// ★ 2026-06-13（round 2）：research_* 报告类死包装已删除（后端命令未注册、前端无调用方）
