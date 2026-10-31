/**
 * mindmapStore slice：保存（防竞态/冲突/自动重试）、冲突快照恢复、标脏与同步草稿。
 */

import i18next from 'i18next';
import * as api from '../../api/mindmapApi';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { DEFAULT_LAYOUT_CONFIG } from '../../constants';
import type { MindMapConflictSnapshot } from '../mindmapStoreTypes';
import { normalizeStyleId } from '../mindmapStoreHelpers';
import { removeDraftFromStorage } from '../mindmapDraftStorage';
import type { MindMapSliceCreator } from '../mindmapStoreRuntime';

export const createPersistenceSlice: MindMapSliceCreator<
  | 'save'
  | 'restoreConflictSnapshot'
  | 'dismissConflictSnapshot'
  | 'markDirty'
  | 'saveDraftSync'
> = (set, get, rt) => {
  const {
    MAX_SAVE_AUTO_RETRIES,
    SAVE_RETRY_BASE_DELAY_MS,
    lastDraftVersionByMindmap,
    persistDraftNow,
    scheduleDraftPersist,
    captureUiSnapshot,
    pushHistory,
    debounceSave,
  } = rt;

  return {
    // 保存（防竞态 + 冲突检测 + 自动重试）
    save: async (options) => {
      const saveSource = options?.source ?? 'manual';
      const { mindmapId, metadata, document, currentView, focusedNodeId, isDirty, isSaving, _documentVersion } = get();
      if (!mindmapId) return false;
      if (!isDirty) return true;
      if (isSaving) {
        // 保存进行中：登记补存请求，当前保存结束后自动再保存一次
        rt.pendingSaveRequested = true;
        return false;
      }

      // 捕获保存开始时的版本号，防止竞态（替代 JSON.stringify 全量比较，O(1) 性能）
      const savingMindmapId = mindmapId;
      const savingVersion = _documentVersion;
      const savingGeneration = rt.documentGeneration;
      const expectedUpdatedAt = metadata?.updatedAt;

      if (rt.saveDebounceTimer) {
        clearTimeout(rt.saveDebounceTimer);
        rt.saveDebounceTimer = null;
      }
      if (rt.retrySaveTimer) {
        clearTimeout(rt.retrySaveTimer);
        rt.retrySaveTimer = null;
      }
      // 超限后的再次保存（通常为手动）：开启新一轮自动重试额度
      if (rt.saveRetryCount > MAX_SAVE_AUTO_RETRIES) {
        rt.saveRetryCount = 0;
      }

      set((state) => {
        state.isSaving = true;
      });

      try {
        const { layoutId: savingLayoutId, layoutDirection: savingLayoutDirection, styleId: savingStyleId, edgeType: savingEdgeType } = get();
        const docWithViewState = {
          ...document,
          meta: {
            ...document.meta,
            lastFocusId: focusedNodeId || undefined,
            updatedAt: new Date().toISOString(),
            renderConfig: {
              layoutId: savingLayoutId,
              direction: savingLayoutDirection,
              styleId: savingStyleId,
              edgeType: savingEdgeType,
              layoutConfig: { ...DEFAULT_LAYOUT_CONFIG, direction: savingLayoutDirection },
            },
          },
        };

        const updated = await api.updateMindMap(savingMindmapId, {
          content: JSON.stringify(docWithViewState),
          defaultView: currentView,
          expectedUpdatedAt,
          versionSource: saveSource,
        });
        if (rt.documentGeneration !== savingGeneration || get().mindmapId !== savingMindmapId) return true;

        set((state) => {
          state.isSaving = false;
          state.lastSavedAt = Date.now();
          state.conflictSnapshot = null; // A6-24: 保存成功后清除暂存的冲突快照
          if (state.mindmapId === savingMindmapId) {
            state.metadata = updated;
          }
          // ★ 2026-02 优化：用版本号比较替代 JSON.stringify，O(1) 复杂度
          if (state.mindmapId === savingMindmapId &&
            state._documentVersion === savingVersion) {
            state.isDirty = false;
          }
        });

        // 保存成功：重置自动重试计数
        rt.saveRetryCount = 0;

        const nextState = get();
        if (nextState.mindmapId === savingMindmapId) {
          if (!nextState.isDirty) {
            rt.pendingSaveRequested = false;
            removeDraftFromStorage(savingMindmapId);
            lastDraftVersionByMindmap.delete(savingMindmapId);
          } else if (rt.pendingSaveRequested) {
            // 保存期间有显式 save() 请求（如可见性 flush）：立即补存而非等 debounce
            rt.pendingSaveRequested = false;
            persistDraftNow(true);
            void get().save();
          } else {
            persistDraftNow(true);
            // 保存期间若继续编辑，重排一次自动保存，避免漏存
            debounceSave();
          }
        }
        return true;
      } catch (error) {
        if (rt.documentGeneration !== savingGeneration || get().mindmapId !== savingMindmapId) return false;
        console.error('[MindMapStore] save failed:', error);
        // 失败路径交给重试/冲突流程处理，避免补存请求造成额外循环
        rt.pendingSaveRequested = false;
        set((state) => {
          state.isSaving = false;
        });

        const errorMessage =
          typeof error === 'string'
            ? error
            : error instanceof Error
              ? error.message
              : '';

        // M-074 / A6-24: 冲突时自动重载服务端版本，并暂存本地未保存编辑供"恢复我的修改"
        if (errorMessage.includes('MINDMAP_UPDATE_CONFLICT')) {
          rt.saveRetryCount = 0;
          // A6-24: 先捕获冲突前的本地文档快照（含视图/渲染配置），避免被服务端重载静默覆盖
          const localSnapshot: MindMapConflictSnapshot | null = savingMindmapId
            ? {
                mindmapId: savingMindmapId,
                document: get().document,
                currentView: get().currentView,
                focusedNodeId: get().focusedNodeId,
                layoutId: get().layoutId,
                layoutDirection: get().layoutDirection,
                styleId: get().styleId,
                edgeType: get().edgeType,
              }
            : null;
          // 清除过期本地草稿，避免 loadMindMap 恢复出冲突的旧版本
          if (savingMindmapId) {
            removeDraftFromStorage(savingMindmapId);
          }
          // 自动重新加载服务端最新版本
          if (get().mindmapId === savingMindmapId) {
            const reloadSeq = get()._loadSeq + 1;
            try {
              await get().loadMindMap(savingMindmapId);
              if (get()._loadSeq !== reloadSeq || get().mindmapId !== savingMindmapId) return false;
              // ★ A6-24: 重载完成后再写入快照（避免被 loadMindMap 的状态重置覆盖）
              if (localSnapshot && get().mindmapId === savingMindmapId) {
                set((state) => {
                  state.conflictSnapshot = localSnapshot;
                });
                showGlobalNotification('warning', i18next.t('store.conflictSnapshotKept', { ns: 'mindmap' }));
              } else {
                showGlobalNotification('success', i18next.t('store.conflictResolved', { ns: 'mindmap' }));
              }
            } catch (reloadError) {
              if (get()._loadSeq !== reloadSeq) return false;
              console.error('[MindMapStore] conflict auto-reload failed:', reloadError);
              showGlobalNotification('error', i18next.t('store.conflictReloadFailed', { ns: 'mindmap' }));
            }
          }
          return false;
        }

        const isStructuralError =
          errorMessage.includes('depth exceeds') ||
          errorMessage.includes('node count exceeds') ||
          errorMessage.includes('Invalid JSON') ||
          errorMessage.includes('VALIDATION') ||
          errorMessage.includes('too large') ||
          errorMessage.includes('size exceeds');

        let userMessage = i18next.t('store.saveFailed', { ns: 'mindmap' });
        if (errorMessage.includes('Mindmap depth exceeds limit')) {
          userMessage = i18next.t('store.depthExceeded', { ns: 'mindmap' });
        } else if (errorMessage.includes('Mindmap node count exceeds limit')) {
          userMessage = i18next.t('store.nodeCountExceeded', { ns: 'mindmap' });
        } else if (errorMessage.includes('Invalid JSON')) {
          userMessage = i18next.t('store.invalidContent', { ns: 'mindmap' });
        }

        const nextRetry = rt.saveRetryCount + 1;
        const canAutoRetry = !isStructuralError && nextRetry <= MAX_SAVE_AUTO_RETRIES;

        // 首次失败提示一次；自动重试过程中不再刷 toast；超限后改提示需手动保存
        if (isStructuralError) {
          showGlobalNotification('error', userMessage, i18next.t('store.saveFailedTitle', { ns: 'mindmap' }));
          rt.saveRetryCount = nextRetry;
        } else if (canAutoRetry) {
          if (rt.saveRetryCount === 0) {
            showGlobalNotification('error', userMessage, i18next.t('store.saveFailedTitle', { ns: 'mindmap' }));
          }
          rt.saveRetryCount = nextRetry;
          if (!rt.retrySaveTimer) {
            const delayMs = SAVE_RETRY_BASE_DELAY_MS * nextRetry; // 5s / 10s / 15s
            rt.retrySaveTimer = setTimeout(() => {
              rt.retrySaveTimer = null;
              void get().save();
            }, delayMs);
          }
        } else {
          rt.saveRetryCount = nextRetry;
          showGlobalNotification(
            'error',
            i18next.t('store.saveRetryExhausted', { ns: 'mindmap' }),
            i18next.t('store.saveFailedTitle', { ns: 'mindmap' })
          );
        }
        return false;
      }
    },

    // A6-24: 把暂存的本地冲突快照重新应用为当前文档
    restoreConflictSnapshot: () => {
      const snap = get().conflictSnapshot;
      if (!snap) return;
      // 仅当仍停留在同一导图时才恢复，避免把快照写到别的导图
      if (get().mindmapId !== snap.mindmapId) {
        set((state) => {
          state.conflictSnapshot = null;
        });
        return;
      }
      pushHistory(get().document, captureUiSnapshot(get()));
      rt.lastCoalesce = null;
      set((state) => {
        state.document = snap.document;
        state.currentView = snap.currentView;
        state.focusedNodeId = snap.focusedNodeId;
        state.layoutId = snap.layoutId;
        state.layoutDirection = snap.layoutDirection;
        state.styleId = normalizeStyleId(snap.styleId);
        state.edgeType = snap.edgeType;
        state.isDirty = true;
        state._documentVersion += 1;
        state.conflictSnapshot = null;
      });
      const nextState = get();
      if (nextState.mindmapId) {
        scheduleDraftPersist();
      }
      // 以重载后的最新基线保存，使"我的修改"覆盖服务端
      debounceSave();
    },

    // A6-24: 放弃暂存快照，采用已重载的服务端版本
    dismissConflictSnapshot: () => {
      set((state) => {
        state.conflictSnapshot = null;
      });
    },

    markDirty: () => {
      set((state) => {
        state.isDirty = true;
        state._documentVersion += 1;
      });
      scheduleDraftPersist();
      debounceSave();
    },

    // M-069: 同步写入 localStorage 草稿（组件卸载 / beforeunload / pagehide 时调用）
    saveDraftSync: () => {
      persistDraftNow();
    },
  };
};
