/**
 * 思维导图应用注册（P8 + ACR R1-11）
 *
 * 复用 MindMapContentView，weight=2，multi（instanceKey=resourceId）。
 * onActivation：focusNode / setView（DESIGN §5.1）。
 */
import React from 'react';
import { AppIconImage } from '../../icons/appIcons';
import {
  getMindMapStoreForInstance,
  subscribeMindMapStoreReady,
  type MindMapStoreApi,
} from '@/features/mindmap/store/mindmapStore';
import type { MindMapViewType } from '@/features/mindmap/types';
import { getMindMapViewController } from '@/features/mindmap/viewController';
import { findNodeById } from '@/features/mindmap/utils/node/find';
import type { ActivationContext, ActivationResult, AppDefinition } from '../../core/types';
import { MINDMAP_APP_TYPE_ID } from '../content/typeMap';
import { createMindmapAgentManifest } from './agentManifest';

function payloadRecord(payload: unknown): Record<string, unknown> | null {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  return null;
}

const ACTIVATION_READY_TIMEOUT_MS = 8000;

/** 同步 store 写入后的读回校验：命中即 authoritative ack，避免 ACTION_UNVERIFIED 假阴性。 */
const ackIf = (verified: boolean): ActivationResult =>
  verified ? { handled: true, acknowledged: true } : { handled: true };

function applyMindmapActivation(
  storeApi: MindMapStoreApi,
  ctx: ActivationContext,
): ActivationResult {
  const store = storeApi.getState();
  if (!ctx.instanceKey || store.mindmapId !== ctx.instanceKey) {
    return { handled: false, code: 'MINDMAP_NOT_READY' };
  }
  const payload = payloadRecord(ctx.payload);

  switch (ctx.action) {
    case 'focusNode': {
      const nodeId =
        (typeof payload?.nodeId === 'string' && payload.nodeId) ||
        (typeof payload?.node_id === 'string' && payload.node_id) ||
        null;
      if (!nodeId) {
        return { handled: false, code: 'INVALID_ARGS', message: 'focusNode 缺少 nodeId' };
      }
      if (!findNodeById(store.document.root, nodeId)) {
        return {
          handled: false,
          code: 'NODE_NOT_FOUND',
          message: `导图节点 ${nodeId} 不存在`,
        };
      }
      store.expandToNode(nodeId, { silent: true });
      store.setFocusedNodeId(nodeId);
      return ackIf(storeApi.getState().focusedNodeId === nodeId);
    }
    case 'setView': {
      const view = payload?.view;
      if (view !== 'outline' && view !== 'mindmap') {
        return { handled: false, code: 'INVALID_ARGS', message: 'setView 的 view 无效' };
      }
      // B-5：agent 路径复用 UI 的 switchView（blur 未提交编辑 + 落 viewport +
      // 恢复大纲 caret），避免绕过防护直接 setCurrentView 丢字符。
      // 组件未挂载（headless store，测试场景）时回退旧行为。
      const controller = getMindMapViewController(storeApi);
      if (controller) {
        controller.switchView(view as MindMapViewType);
      } else {
        store.setCurrentView(view as MindMapViewType);
      }
      return ackIf(storeApi.getState().currentView === view);
    }
    case 'search': {
      const query = typeof payload?.query === 'string' ? payload.query : '';
      store.search(query);
      return ackIf(storeApi.getState().searchQuery === query);
    }
    case 'nextSearchResult':
    case 'previousSearchResult': {
      const before = storeApi.getState();
      if (before.searchResults.length === 0) {
        // 无可导航结果：指令已接收但未产生状态变更，不 ACK。
        return { handled: true };
      }
      const expectedIndex = ctx.action === 'nextSearchResult'
        ? (before.currentSearchIndex + 1) % before.searchResults.length
        : before.currentSearchIndex <= 0
          ? before.searchResults.length - 1
          : before.currentSearchIndex - 1;
      const expectedNodeId = before.searchResults[expectedIndex];
      if (ctx.action === 'nextSearchResult') store.nextSearchResult();
      else store.prevSearchResult();
      const after = storeApi.getState();
      return ackIf(
        after.currentSearchIndex === expectedIndex && after.focusedNodeId === expectedNodeId,
      );
    }
    case 'clearSearch':
      store.clearSearch();
      return ackIf(
        storeApi.getState().searchQuery === '' &&
          storeApi.getState().searchResults.length === 0,
      );
    default:
      return {
        handled: false,
        code: 'UNKNOWN_ACTION',
        message: `未知 mindmap action: ${ctx.action}`,
      };
  }
}

function waitForMindmapStore(ctx: ActivationContext): Promise<MindMapStoreApi | null> {
  const resourceId = ctx.instanceKey!;
  const readyStore = getMindMapStoreForInstance(ctx.windowId, resourceId);
  if (readyStore?.getState().mindmapId === resourceId) return Promise.resolve(readyStore);

  return new Promise((resolve) => {
    let settled = false;
    let cancelWait = () => undefined;
    const finish = (store: MindMapStoreApi | null) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      cancelWait();
      resolve(store);
    };
    const timeout = globalThis.setTimeout(() => finish(null), ACTIVATION_READY_TIMEOUT_MS);
    cancelWait = subscribeMindMapStoreReady(
      resourceId,
      (storeApi) => finish(storeApi),
      ctx.windowId,
    );
  });
}

/** onActivation：focusNode {nodeId} / setView {view:'outline'|'mindmap'} */
export async function handleMindmapActivation(
  ctx: ActivationContext,
): Promise<ActivationResult> {
  const resourceId = ctx.instanceKey;
  if (!resourceId) {
    return { handled: false, code: 'INVALID_ARGS', message: '缺少导图资源 ID' };
  }

  // 先校验不依赖文档的参数，避免把无效命令排队到加载完成。
  const payload = payloadRecord(ctx.payload);
  if (
    (ctx.action === 'focusNode' &&
      typeof payload?.nodeId !== 'string' &&
      typeof payload?.node_id !== 'string') ||
    (ctx.action === 'setView' && payload?.view !== 'outline' && payload?.view !== 'mindmap')
  ) {
    return { handled: false, code: 'INVALID_ARGS' };
  }
  if (
    ctx.action !== 'focusNode' &&
    ctx.action !== 'setView' &&
    ctx.action !== 'search' &&
    ctx.action !== 'nextSearchResult' &&
    ctx.action !== 'previousSearchResult' &&
    ctx.action !== 'clearSearch'
  ) {
    return { handled: false, code: 'UNKNOWN_ACTION' };
  }

  const storeApi = await waitForMindmapStore(ctx);
  if (!storeApi) {
    return {
      handled: false,
      code: 'MINDMAP_NOT_READY',
      hint: '目标导图未能在超时前完成加载',
    };
  }
  return applyMindmapActivation(storeApi, ctx);
}

/** 导出供测试断言元数据 */
export const MINDMAP_APP_DEFINITION: AppDefinition = {
  typeId: MINDMAP_APP_TYPE_ID,
  nameKey: 'workbench:apps.mindmap',
  icon: React.createElement(AppIconImage, { typeId: 'mindmap', className: 'h-8 w-8' }),
  instanceMode: 'multi',
  memoryWeight: 2,
  defaultFrame: { w: 920, h: 660 },
  minSize: { w: 420, h: 320 },
  render: React.lazy(() => import('./MindmapAppWindow')),
  onActivation: handleMindmapActivation,
  agentManifest: createMindmapAgentManifest(handleMindmapActivation),
};
