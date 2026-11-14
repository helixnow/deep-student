/**
 * 导图与插件内核 anchors / dnd 的桥接（宿主 MindMapContentView 挂载）：
 * 1. 划选即入图：开关开启且导图为活跃标签、非背诵时订阅 `kernel.dnd.subscribeAutoExcerpt`，
 *    按确定性落点写入一个 undo 步；400ms 内重复到达的同一摘录去重。
 * 2. 反向定位：注册 `mindmap` 锚点处理器，阅读器侧回链 `ds-anchor://v1/mindmap/<id>?node=`
 *    直达节点（展开祖先 + 选中 + 居中 + 高亮）。
 * 3. 出处边同步：把内核 anchors 注入 excerptIngest 的边同步通道。
 */

import { useEffect, useRef } from 'react';
import type { ExcerptDragPayload, MindmapSemanticAnchor } from '@/ui-kernel/contracts/interop';
import type { UiAnchorsHandle } from '@/ui-kernel/services/anchors';
import type { UiExcerptDndHandle } from '@/ui-kernel/services/excerpt-dnd';
import type { MindMapStoreApi } from '../store/mindmapStore';
import { findNodeById } from '../utils/node/find';
import {
  createAutoExcerptDeduper,
  registerMindMapAnchorEdgeSink,
} from '../utils/excerptIngest';
import { MINDMAP_NODE_TARGET_FLASH_MS } from '../nodeTargetBridge';

export interface MindMapExcerptKernel {
  anchors?: Pick<
    UiAnchorsHandle,
    'registerAnchorRevealHandler' | 'upsertAnchorEdges' | 'pruneAnchorEdgesBySource'
  > | null;
  dnd?: Pick<UiExcerptDndHandle, 'subscribeAutoExcerpt'> | null;
}

export interface MindMapExcerptBridgeOptions {
  storeApi: MindMapStoreApi;
  kernel: MindMapExcerptKernel | null;
  resourceId?: string;
  isActive: boolean;
  autoExcerptEnabled: boolean;
  reciteMode: boolean;
  isLoading?: boolean;
}

/** 反向定位一个导图节点；节点缺失时回退到根。返回定位到的节点 id */
export function revealMindMapAnchorInStore(
  storeApi: MindMapStoreApi,
  anchor: Pick<MindmapSemanticAnchor, 'nodeId'>,
  pulse: boolean,
): string {
  const state = storeApi.getState();
  const root = state.document.root;
  const nodeId = anchor.nodeId && findNodeById(root, anchor.nodeId) ? anchor.nodeId : root.id;
  state.locateNode(nodeId);
  if (pulse) {
    storeApi.getState().markAgentUpdated([nodeId]);
    setTimeout(() => {
      if (storeApi.getState().agentUpdatedIds.has(nodeId)) {
        storeApi.getState().clearAgentUpdated([nodeId]);
      }
    }, MINDMAP_NODE_TARGET_FLASH_MS);
  }
  return nodeId;
}

/** 划选即入图的单条处理：去重后入图，返回新节点 id（重复 / 背诵 / 失败返回 null） */
export function handleAutoExcerptPayload(
  storeApi: MindMapStoreApi,
  payload: ExcerptDragPayload,
  isDuplicate: (payload: ExcerptDragPayload) => boolean,
): string | null {
  if (isDuplicate(payload)) return null;
  return storeApi.getState().ingestAutoExcerpt(payload);
}

export function useMindMapExcerptBridge({
  storeApi,
  kernel,
  resourceId,
  isActive,
  autoExcerptEnabled,
  reciteMode,
  isLoading = false,
}: MindMapExcerptBridgeOptions): void {
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  const isLoadingRef = useRef(isLoading);
  isLoadingRef.current = isLoading;

  const anchors = kernel?.anchors ?? null;
  const dnd = kernel?.dnd ?? null;

  // 划选即入图订阅
  useEffect(() => {
    if (!autoExcerptEnabled || !isActive || reciteMode || !dnd) return;
    const isDuplicate = createAutoExcerptDeduper();
    return dnd.subscribeAutoExcerpt((payload) => {
      if (isLoadingRef.current || !isActiveRef.current) return;
      handleAutoExcerptPayload(storeApi, payload, (p) => isDuplicate(p));
    });
  }, [autoExcerptEnabled, dnd, isActive, reciteMode, storeApi]);

  // 导图作为反向定位目标
  useEffect(() => {
    if (!resourceId || !anchors) return;
    let disposed = false;
    const pendingWaitCleanups = new Set<() => void>();
    const unregister = anchors.registerAnchorRevealHandler('mindmap', {
      canHandle: (anchor) => {
        if (anchor.resourceId !== resourceId && anchor.aliasResourceId !== resourceId) return false;
        return isActiveRef.current ? 'exact-focused' : 'exact-mounted';
      },
      reveal: (anchor, ctx) => {
        if (disposed || ctx.signal?.aborted) return false;
        const current = storeApi.getState();
        if (current.mindmapId === resourceId || (!current.mindmapId && !isLoadingRef.current)) {
          revealMindMapAnchorInStore(storeApi, anchor, ctx.pulse !== false);
          return true;
        }
        if (current.mindmapId && current.mindmapId !== resourceId) {
          return false;
        }
        // 新分屏打开但异步 loadMindMap 尚未完成：等待同一实例加载就绪后立即定位
        return new Promise<boolean>((resolve) => {
          let settled = false;
          const finish = (ok: boolean) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(ok);
          };
          const unsub = storeApi.subscribe((next) => {
            if (settled) return;
            if (disposed || ctx.signal?.aborted) {
              finish(false);
              return;
            }
            if (next.mindmapId === resourceId) {
              settled = true;
              cleanup();
              revealMindMapAnchorInStore(storeApi, anchor, ctx.pulse !== false);
              resolve(true);
            } else if (next.mindmapId !== null && next.mindmapId !== resourceId) {
              finish(false);
            }
          });
          const timer = setTimeout(() => finish(false), 5000);
          const onAbort = () => finish(false);
          ctx.signal?.addEventListener('abort', onAbort, { once: true });
          const cleanup = () => {
            clearTimeout(timer);
            unsub();
            ctx.signal?.removeEventListener('abort', onAbort);
            pendingWaitCleanups.delete(cancelWaiting);
          };
          const cancelWaiting = () => finish(false);
          pendingWaitCleanups.add(cancelWaiting);
        });
      },
    });
    return () => {
      disposed = true;
      for (const fn of [...pendingWaitCleanups]) fn();
      pendingWaitCleanups.clear();
      unregister();
    };
  }, [anchors, resourceId, storeApi]);

  // 出处边同步通道
  useEffect(() => {
    if (!anchors) return;
    return registerMindMapAnchorEdgeSink({
      upsertAnchorEdges: (edges) => anchors.upsertAnchorEdges(edges),
      pruneAnchorEdgesBySource: (params) => anchors.pruneAnchorEdgesBySource(params),
    });
  }, [anchors]);
}
