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
import { launchWorkbenchApp } from '@/shared/workbenchHost';
import {
  CHAT_SEARCH_MIN_CHARS,
  CONTENT_SEARCH_MIN_CHARS,
  GLOBAL_SEARCH_DEBOUNCE_MS,
  fetchChatSearchResults,
  fetchDstuSearchResults,
  fetchFlashcardSearchResults,
  formatDstuSearchSubtitle,
  formatFlashcardSearchSubtitle,
  openChatInWorkbench,
  openDstuInWorkbench,
  openFlashcardInWorkbench,
  stripSnippetMarkers,
  useAbortableDebouncedQuery,
  type FlashcardSearchItem,
  type SessionSearchItem,
} from '@/features/workbench/search/globalSearchProviders';
import type { DependencyResolver } from '../registry/types';

export type { FlashcardSearchItem, SessionSearchItem };
export { formatDstuSearchSubtitle, formatFlashcardSearchSubtitle, stripSnippetMarkers };

export interface ResourceSearchState {
  fileResults: DstuNode[];
  flashcardResults: FlashcardSearchItem[];
  sessionResults: SessionSearchItem[];
  loading: boolean;
}

const EMPTY_FILES: DstuNode[] = [];
const EMPTY_FLASHCARDS: FlashcardSearchItem[] = [];
const EMPTY_SESSIONS: SessionSearchItem[] = [];

/**
 * Legacy 命令面板资源搜索。签名保持 `{ fileResults, sessionResults, loading }` 并增补 `flashcardResults`。
 * dstu / flashcards / chat 各自独立 250ms 防抖与 AbortController 过期丢弃。
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

  const flashcards = useAbortableDebouncedQuery(
    query,
    enabled,
    fetchFlashcardSearchResults,
    {
      debounceMs: GLOBAL_SEARCH_DEBOUNCE_MS,
      minChars: CONTENT_SEARCH_MIN_CHARS,
      empty: EMPTY_FLASHCARDS,
    },
  );

  const sessions = useAbortableDebouncedQuery(
    query,
    enabled,
    fetchChatSearchResults,
    {
      debounceMs: GLOBAL_SEARCH_DEBOUNCE_MS,
      minChars: CHAT_SEARCH_MIN_CHARS,
      empty: EMPTY_SESSIONS,
    },
  );

  return {
    fileResults: files.data,
    flashcardResults: flashcards.data,
    sessionResults: sessions.data,
    loading: files.loading || flashcards.loading || sessions.loading,
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
 * 打开文件资源：跳转 Workbench 对应应用或 Learning Hub 并在标签页中打开聚焦。
 * Learning Hub 的 OpenResourceHandler 在页面挂载后才注册，因此需要等待。
 */
export async function openFileFromPalette(deps: DependencyResolver, node: DstuNode): Promise<void> {
  const targetId = (node.id || node.sourceId || '').trim();
  if (!targetId) return;

  if (deps.getCurrentView() === 'workbench') {
    // Notes and mind maps are routed through the shared Notes workspace by
    // workbenchBus when their resource type is used as the launch type. The
    // remaining resource types use the public app mapping.
    const typeId = node.type === 'note' || node.type === 'mindmap'
      ? node.type
      : (await import('@/features/workbench/apps/content/typeMap')).resourceTypeToAppTypeId(node.type);
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
    if (node.type === 'note') {
      openDstuInWorkbench({ ...node, id: targetId });
      return;
    }
    launchWorkbenchApp({ typeId, instanceKey: targetId, reason: 'command' });
    return;
  }

  deps.navigate('learning-hub');
  const ready = await waitFor(() => !!getOpenResourceHandler('learning-hub'), 4000, 80);
  if (!ready) {
    if (node.type === 'note') {
      window.dispatchEvent(new CustomEvent('DSTU_OPEN_NOTE', {
        detail: { noteId: targetId, source: 'command-palette' },
      }));
      return;
    }
    console.warn('[CommandPalette] learning-hub OpenResourceHandler 未就绪');
    return;
  }
  await openResource(node, { handlerNamespace: 'learning-hub' });
}

/**
 * 打开命中的闪卡：直接定位到卡片库中的该卡片、牌组与搜索词（非空白今日首页）。
 * 使用动态 import，不增加启动静态闭包。
 */
export async function openFlashcardFromPalette(
  deps: DependencyResolver,
  item: Pick<FlashcardSearchItem, 'cardId' | 'front' | 'deck'>,
  searchQuery?: string,
): Promise<void> {
  if (deps.getCurrentView() === 'workbench') {
    await openFlashcardInWorkbench(item, searchQuery);
    return;
  }
  const focusQuery = (searchQuery?.trim() || item.front.trim()).slice(0, 120);
  const targetDeck = item.deck?.trim() || null;
  try {
    const {
      useFsrsReviewStore,
      useFlashcardsLibraryStore,
      requestLibraryCardFocus,
    } = await import('@/features/flashcards');
    requestLibraryCardFocus({
      cardId: item.cardId,
      query: focusQuery,
      deckFilter: targetDeck,
    });
    useFlashcardsLibraryStore.setState({
      statusFilter: 'all',
      deckFilter: targetDeck,
      sortKey: 'default',
      sortDir: 'asc',
      searchInput: focusQuery,
      query: focusQuery,
      page: 1,
      actionError: null,
    });
    useFsrsReviewStore.getState().setScreen('library');
    void useFlashcardsLibraryStore.getState().load(focusQuery, 1);
  } catch {
    // fallback: still navigate to flashcards library with route params
  }
  deps.navigate('flashcards', {
    screen: 'library',
    cardId: item.cardId,
    query: focusQuery,
    ...(targetDeck ? { deck: targetDeck } : {}),
  });
}

/**
 * 打开聊天会话：跳转 Chat V2 并切换到目标会话。
 * 优先走 pendingChatNavigation 握手（动态引入，避免静态闭包膨胀），并兼容旧事件重发。
 */
export function openSessionFromPalette(deps: DependencyResolver, sessionId: string): void {
  if (deps.getCurrentView() === 'workbench') {
    openChatInWorkbench(sessionId);
    return;
  }
  deps.navigate('chat-v2');
  void import('@/features/chat/navigation/pendingChatNavigation')
    .then(({ requestChatSessionNavigation }) => {
      requestChatSessionNavigation(sessionId);
    })
    .catch(() => {
      const fire = () => {
        window.dispatchEvent(new CustomEvent('navigate-to-session', { detail: { sessionId } }));
      };
      fire();
      setTimeout(fire, 400);
      setTimeout(fire, 1200);
    });
}
