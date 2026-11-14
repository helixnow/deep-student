/**
 * 精读讲义反向同步的导图侧宿主（MindMapContentView 挂载）。
 *
 * 笔记侧只派发平台事件；这里校验「原导图是否就是当前文档」，按出处节点原地合并，
 * 走 `setDocument`（可撤销、标脏、防抖保存）后立即手动保存一次，最后回传统计。
 */
import { useEffect } from 'react';
import { addHandoutSyncRequestListener, type HandoutSyncRequestDetail } from '@/ui-kernel/services/handoutSyncBridge';
import { parseHandoutMarkdownToMindMapDraft } from '@/ui-kernel/services/mindmapHandoutBridge';
import { mergeHandoutDraftIntoMindMap } from '../interop/handoutSync';
import { useMindMapStoreApi } from '../store';

export interface UseMindMapHandoutSyncOptions {
  /** 当前导图 resourceId；为空时不订阅 */
  mindmapId?: string | null;
  /** 文档仍在异步加载：拒绝写入，避免把同步结果写进旧文档 */
  isLoading?: boolean;
}

export function useMindMapHandoutSync({ mindmapId, isLoading = false }: UseMindMapHandoutSyncOptions): void {
  const storeApi = useMindMapStoreApi();

  useEffect(() => {
    if (!mindmapId) return undefined;

    return addHandoutSyncRequestListener((request: HandoutSyncRequestDetail) => {
      const state = storeApi.getState();
      if (
        isLoading
        || request.mindmapId !== mindmapId
        || state.mindmapId !== mindmapId
      ) {
        request.respond({ ok: false, updated: 0, added: 0, reason: 'mindmap-not-open' });
        return;
      }

      const draft = parseHandoutMarkdownToMindMapDraft(request.markdown, {
        noteId: request.noteId,
        noteTitle: request.noteTitle,
        idPrefix: `mm_note_${request.noteId.slice(-8)}`,
      });
      if (!draft) {
        request.respond({ ok: false, updated: 0, added: 0, reason: 'empty-handout' });
        return;
      }

      try {
        const current = storeApi.getState();
        const { document, updated, added } = mergeHandoutDraftIntoMindMap(current.document, draft, {
          mindmapId: request.mindmapId,
        });
        if (updated > 0 || added > 0) {
          current.setDocument(document);
          void storeApi.getState().save({ source: 'manual' }).catch(() => undefined);
        }
        request.respond({ ok: true, updated, added });
      } catch (error) {
        request.respond({
          ok: false,
          updated: 0,
          added: 0,
          reason: 'empty-handout',
        });
        void error;
      }
    });
  }, [isLoading, mindmapId, storeApi]);
}
