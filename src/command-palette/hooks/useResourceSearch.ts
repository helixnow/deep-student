/**
 * 命令面板资源搜索 Hook
 *
 * 在命令搜索之外，提供文件（DSTU 资源）与聊天会话的直达搜索：
 * - 文件：dstu_search（全库按名称匹配）
 * - 会话：chat_v2_search_content（FTS5 标题+内容全文搜索，按会话去重）
 *
 * 底层 fetch / 防抖取消与 Workbench Spotlight providers 共用
 *（`globalSearchProviders`），本 Hook 保持 legacy 导出签名不变。
 */

import type { DstuNode } from '@/dstu/types';
import { openResource, getOpenResourceHandler } from '@/dstu/openResource';
import { workbenchBus } from '@/features/workbench/core/workbenchBus';
import { resourceTypeToAppTypeId } from '@/features/workbench/apps/content/typeMap';
import {
  CONTENT_SEARCH_MIN_CHARS,
  GLOBAL_SEARCH_DEBOUNCE_MS,
  fetchChatSearchResults,
  fetchDstuSearchResults,
  stripSnippetMarkers,
  useAbortableDebouncedQuery,
  type SessionSearchItem,
} from '@/features/workbench/search/globalSearchProviders';
import type { DependencyResolver } from '../registry/types';

export type { SessionSearchItem };
export { stripSnippetMarkers };

export interface ResourceSearchState {
  fileResults: DstuNode[];
  sessionResults: SessionSearchItem[];
  loading: boolean;
}

const EMPTY_FILES: DstuNode[] = [];
const EMPTY_SESSIONS: SessionSearchItem[] = [];

/**
 * Legacy 命令面板资源搜索。签名保持 `{ fileResults, sessionResults, loading }`。
 * dstu / chat 各自独立 250ms 防抖与 AbortController 过期丢弃。
 */
export function useResourceSearch(query: string, enabled: boolean): ResourceSearchState {
  const files = useAbortableDebouncedQuery(
    query,
    enabled,
    fetchDstuSearchResults,
    {
      debounceMs: GLOBAL_SEARCH_DEBOUNCE_MS,
      minChars: CONTENT_SEARCH_MIN_CHARS,
      empty: EMPTY_FILES,
    },
  );

  const sessions = useAbortableDebouncedQuery(
    query,
    enabled,
    fetchChatSearchResults,
    {
      debounceMs: GLOBAL_SEARCH_DEBOUNCE_MS,
      minChars: CONTENT_SEARCH_MIN_CHARS,
      empty: EMPTY_SESSIONS,
    },
  );

  return {
    fileResults: files.data,
    sessionResults: sessions.data,
    loading: files.loading || sessions.loading,
  };
}

// ============================================================================
// 资源打开动作
// ============================================================================

async function waitFor(check: () => boolean, timeoutMs: number, intervalMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return check();
}

/**
 * 打开文件资源：跳转 Learning Hub 并在标签页中打开。
 * Learning Hub 的 OpenResourceHandler 在页面挂载后才注册，因此需要等待。
 */
export async function openFileFromPalette(deps: DependencyResolver, node: DstuNode): Promise<void> {
  if (deps.getCurrentView() === 'workbench') {
    // Notes and mind maps are routed through the shared Notes workspace by
    // workbenchBus when their resource type is used as the launch type. The
    // remaining resource types use the public app mapping.
    const typeId = node.type === 'note' || node.type === 'mindmap'
      ? node.type
      : resourceTypeToAppTypeId(node.type);
    if (!typeId) {
      deps.showNotification(
        'warning',
        deps.t(
          'command_palette:resource_not_openable_in_workbench',
          'This resource cannot be opened in the desktop.',
        ),
      );
      return;
    }
    workbenchBus.launch({ typeId, instanceKey: node.id, reason: 'command' });
    return;
  }

  deps.navigate('learning-hub');
  const ready = await waitFor(() => !!getOpenResourceHandler('learning-hub'), 4000, 80);
  if (!ready) {
    console.warn('[CommandPalette] learning-hub OpenResourceHandler 未就绪');
    return;
  }
  await openResource(node, { handlerNamespace: 'learning-hub' });
}

/**
 * 打开聊天会话：跳转 Chat V2 并切换到目标会话。
 * chat-v2 页面通过 window `navigate-to-session` 事件接收；页面可能尚未挂载，
 * 因此延迟重发两次（setCurrentSessionId 幂等，重复无副作用）。
 */
export function openSessionFromPalette(deps: DependencyResolver, sessionId: string): void {
  deps.navigate('chat-v2');
  const fire = () => {
    window.dispatchEvent(new CustomEvent('navigate-to-session', { detail: { sessionId } }));
  };
  fire();
  setTimeout(fire, 400);
  setTimeout(fire, 1200);
}
