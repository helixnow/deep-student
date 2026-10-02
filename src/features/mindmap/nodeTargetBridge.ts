/**
 * 导图节点定位桥：引用回链（聊天 `[思维导图:mm_xxx#节点:标题]`、知识库命中、
 * 选区引用 `node:<id>`）打开导图后，定位到具体节点。
 *
 * 打开动作（CHAT_OPEN_ATTACHMENT_PREVIEW / workbench launch）与导图实例加载是异步的：
 * 这里登记一次「等该资源的 store 加载完成」的请求（subscribeMindMapStoreReady），
 * 实例已就绪则立即执行。定位 = 展开祖先 + 选中聚焦 + 画布居中/大纲滚入 +
 * 复用 Agent 更新高亮（agent-updated 背景 flash，已含 reduced-motion / forced-colors 适配）。
 * 找不到节点时静默放弃——导图照常打开，只是不定位。
 *
 * 本模块只静态依赖纯函数；store 经动态 import 取得，避免把导图 store 拖进聊天首屏。
 */
import { resolveMindmapNodeTarget, type MindmapNodeTargetHint } from './utils/nodeTarget';

export interface MindmapNodeTargetRequest extends MindmapNodeTargetHint {
  /** 导图资源 ID（mm_xxx；版本引用需先换算成父导图 ID） */
  mindmapId: string;
}

/** 等待导图实例加载的上限；超时即放弃定位（导图仍会打开） */
export const MINDMAP_NODE_TARGET_TIMEOUT_MS = 10_000;
/** 定位高亮保留时长（CSS flash 900ms 播完后静态消失，留余量给居中动画） */
export const MINDMAP_NODE_TARGET_FLASH_MS = 1_800;

const cancelByMindmapId = new Map<string, () => void>();

function hasHint(request: MindmapNodeTargetRequest): boolean {
  return Boolean(request.nodeId?.trim() || request.text?.trim() || request.chunkText?.trim());
}

/**
 * 登记一次节点定位请求。同一导图的新请求会取消尚未执行的旧请求。
 * 返回取消函数。
 */
export function publishMindmapNodeTarget(request: MindmapNodeTargetRequest): () => void {
  const mindmapId = request.mindmapId?.trim();
  if (!mindmapId || !hasHint(request)) return () => undefined;

  cancelByMindmapId.get(mindmapId)?.();

  let cancelled = false;
  let cancelWait: () => void = () => undefined;
  const timeout = setTimeout(() => cancel(), MINDMAP_NODE_TARGET_TIMEOUT_MS);
  function cancel() {
    if (cancelled) return;
    cancelled = true;
    clearTimeout(timeout);
    cancelWait();
    if (cancelByMindmapId.get(mindmapId) === cancel) cancelByMindmapId.delete(mindmapId);
  }
  cancelByMindmapId.set(mindmapId, cancel);

  void import('./store/mindmapStore')
    .then(({ subscribeMindMapStoreReady }) => {
      if (cancelled) return;
      let done = false;
      const unsubscribe = subscribeMindMapStoreReady(mindmapId, (storeApi) => {
        if (cancelled || done) return;
        done = true;
        cancel();
        const state = storeApi.getState();
        const target = resolveMindmapNodeTarget(state.document.root, request);
        if (!target) return;
        if (!state.locateNode(target.nodeId)) return;
        storeApi.getState().markAgentUpdated([target.nodeId]);
        setTimeout(() => {
          storeApi.getState().clearAgentUpdated([target.nodeId]);
        }, MINDMAP_NODE_TARGET_FLASH_MS);
      });
      // 同步回调（实例已就绪）时 subscribe 返回空函数；异步等待时登记取消
      cancelWait = unsubscribe;
      if (done) unsubscribe();
    })
    .catch((error: unknown) => {
      console.warn('[mindmap] node target: failed to load store', error);
      cancel();
    });

  return cancel;
}

/** 仅供测试：清空挂起请求 */
export function __resetMindmapNodeTargetsForTests(): void {
  for (const cancel of [...cancelByMindmapId.values()]) cancel();
  cancelByMindmapId.clear();
}
