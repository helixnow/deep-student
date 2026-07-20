/** Files 应用 ACR 语义导航。文件数据写入仍归 DSTU 领域工具。 */

import { pathApi } from '@/dstu/api/pathApi';
import { resolveQuickAccessType } from '@/features/learning-hub/learningHubContracts';
import type { SortBy, SortOrder, ViewMode } from '@/features/learning-hub/stores/finderStore';
import type { ActivationContext, ActivationResult } from '../../core/types';
import { agentFlash } from '../../agent/visuals/agentFlash';

function payloadRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function payloadString(payload: unknown, key: string): string | null {
  const value = payloadRecord(payload)[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function invalid(hint: string): ActivationResult {
  return { handled: false, code: 'INVALID_ARGS', hint };
}

function unavailable(hint: string): ActivationResult {
  return { handled: false, code: 'ACTION_UNAVAILABLE', hint };
}

const SORT_FIELDS = new Set<SortBy>(['name', 'updatedAt', 'createdAt', 'type']);
const SORT_ORDERS = new Set<SortOrder>(['asc', 'desc']);

/** ACR 4.0（A6）：等一帧渲染后再查/闪 DOM 锚点（列表/计数由 React 异步落 DOM）。 */
function afterNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== 'function') {
      resolve();
      return;
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

function findAgentEntityElement(entityId: string): Element | null {
  if (typeof document === 'undefined') return null;
  const key = `files:${entityId}`;
  const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(key)
    : key.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return document.querySelector(`[data-agent-entity="${escaped}"]`);
}

/**
 * 导航类反馈：面包屑/路径栏（files:path）或结果计数（files:results）一次轻微
 * flash。保持克制：不滚动、缺锚点安全 no-op（列表重渲染本身已是主反馈）。
 */
async function flashNavigationAnchor(anchor: 'path' | 'results'): Promise<void> {
  await afterNextPaint();
  agentFlash('files', anchor, { scroll: false });
}

/** 导出供单测与 AppDefinition.onActivation。 */
export async function handleFilesActivation(ctx: ActivationContext): Promise<ActivationResult> {
  const { useFinderStore } = await import('@/features/learning-hub/stores/finderStore');
  const store = useFinderStore.getState();
  const finderError = (): ActivationResult | null => {
    const error = useFinderStore.getState().error;
    return error
      ? { handled: false, code: 'FILES_LOAD_FAILED', hint: error }
      : null;
  };

  switch (ctx.action) {
    case 'openFolder': {
      const folderId = payloadString(ctx.payload, 'folderId');
      if (!folderId) return invalid('openFolder 需要 payload.folderId');
      await store.enterFolder(folderId);
      const failed = finderError();
      if (failed) return failed;
      await flashNavigationAnchor('path');
      return { handled: true };
    }
    case 'reveal': {
      const resourceId = payloadString(ctx.payload, 'resourceId');
      if (!resourceId) return invalid('reveal 需要 payload.resourceId');
      const location = await pathApi.getResourceLocation(resourceId);
      if (store.currentPath.folderId !== location.folderId) {
        if (location.folderId) await store.enterFolder(location.folderId);
        else await store.setCurrentPathWithoutHistory(null);
        const failed = finderError();
        if (failed) return failed;
      }
      useFinderStore.getState().setSelectedIds(new Set([resourceId]));
      // ACR 4.0（A6）：flash 目标行可能不在虚拟化可视区/当前页——agentFlash 对缺失
      // 元素静默 no-op，这里显式查 DOM 兜底，回执不假装完成了定位。
      await afterNextPaint();
      if (findAgentEntityElement(resourceId)) {
        agentFlash('files', resourceId);
        return { handled: true };
      }
      return {
        handled: true,
        message: '已进入所在目录并选中该资源，但目标行当前不在可视区/当前页，未执行定位高亮',
      };
    }
    case 'openQuickAccess': {
      // 桌面快捷方式（全部笔记/收藏/最近等智能入口）→ 定位到对应视图
      const type = resolveQuickAccessType(payloadString(ctx.payload, 'type'));
      if (!type) return invalid('openQuickAccess 需要合法的 payload.type');
      store.quickAccessNavigate(type);
      await flashNavigationAnchor('path');
      return { handled: true };
    }
    case 'goBack':
      if (store.historyIndex <= 0) return unavailable('当前没有可返回的浏览位置');
      store.goBack();
      await flashNavigationAnchor('path');
      return { handled: true };
    case 'goForward':
      if (store.historyIndex >= store.history.length - 1) {
        return unavailable('当前没有可前进的浏览位置');
      }
      store.goForward();
      await flashNavigationAnchor('path');
      return { handled: true };
    case 'goUp':
      if (store.currentPath.breadcrumbs.length === 0) {
        return unavailable('当前已在文件根位置');
      }
      store.goUp();
      await flashNavigationAnchor('path');
      return { handled: true };
    case 'search': {
      const query = payloadString(ctx.payload, 'query') ?? '';
      store.setSearchQuery(query);
      if (query) await useFinderStore.getState().executeSearch();
      else await useFinderStore.getState().loadItems({ silent: true });
      const failed = finderError();
      if (failed) return failed;
      await flashNavigationAnchor('results');
      return { handled: true };
    }
    case 'setViewMode': {
      const mode = payloadString(ctx.payload, 'mode') as ViewMode | null;
      if (mode !== 'grid' && mode !== 'list') return invalid('mode 必须为 grid 或 list');
      store.setViewMode(mode);
      return { handled: true };
    }
    case 'setSorting': {
      const payload = payloadRecord(ctx.payload);
      const sortBy = payload.sortBy as SortBy;
      const sortOrder = payload.sortOrder as SortOrder | undefined;
      if (!SORT_FIELDS.has(sortBy)) return invalid('sortBy 值无效');
      if (sortOrder && !SORT_ORDERS.has(sortOrder)) return invalid('sortOrder 值无效');
      store.setSorting(sortBy, sortOrder);
      return { handled: true };
    }
    case 'select': {
      const resourceId = payloadString(ctx.payload, 'resourceId');
      if (!resourceId) return invalid('select 需要 payload.resourceId');
      store.select(resourceId, 'single');
      agentFlash('files', resourceId);
      return { handled: true };
    }
    case 'selectAll':
      if (store.items.length === 0 || store.selectedIds.size === store.items.length) {
        return unavailable(store.items.length === 0 ? '当前没有可选择的资源' : '当前资源已全部选中');
      }
      store.selectAll();
      return { handled: true };
    case 'clearSelection':
      if (store.selectedIds.size === 0) return unavailable('当前没有资源选择');
      store.clearSelection();
      return { handled: true };
    case 'refresh': {
      await store.refresh({ silent: true });
      const failed = finderError();
      if (failed) return failed;
      return { handled: true };
    }
    default:
      return {
        handled: false,
        code: 'UNKNOWN_ACTION',
        hint: `Files 不支持指令 ${ctx.action}`,
      };
  }
}
