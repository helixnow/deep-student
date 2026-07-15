/**
 * 命令面板资源搜索 Hook
 *
 * 在命令搜索之外，提供文件（DSTU 资源）与聊天会话的直达搜索：
 * - 文件：dstu_search（全库按名称匹配）
 * - 会话：chat_v2_search_content（FTS5 标题+内容全文搜索，按会话去重）
 */

import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { search as dstuSearch } from '@/dstu/api';
import { openResource, getOpenResourceHandler } from '@/dstu/openResource';
import type { DstuNode } from '@/dstu/types';
import { workbenchBus } from '@/features/workbench/core/workbenchBus';
import { resourceTypeToAppTypeId } from '@/features/workbench/apps/content/typeMap';
import type { DependencyResolver } from '../registry/types';

const DEBOUNCE_MS = 250;
const FILE_LIMIT = 6;
const SESSION_LIMIT = 5;

interface ContentSearchResult {
  sessionId: string;
  sessionTitle: string | null;
  messageId: string;
  blockId: string;
  role: string;
  snippet: string;
  updatedAt: string;
}

export interface SessionSearchItem {
  sessionId: string;
  title: string;
  snippet: string;
}

export interface ResourceSearchState {
  fileResults: DstuNode[];
  sessionResults: SessionSearchItem[];
  loading: boolean;
}

const EMPTY_STATE: ResourceSearchState = {
  fileResults: [],
  sessionResults: [],
  loading: false,
};

export function useResourceSearch(query: string, enabled: boolean): ResourceSearchState {
  const [state, setState] = useState<ResourceSearchState>(EMPTY_STATE);
  const requestSeq = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();
    if (!enabled || trimmed.length < 2) {
      requestSeq.current += 1;
      setState(EMPTY_STATE);
      return;
    }

    const seq = ++requestSeq.current;
    setState((prev) => ({ ...prev, loading: true }));

    const timer = setTimeout(async () => {
      const [fileSettled, sessionSettled] = await Promise.allSettled([
        dstuSearch(trimmed, { limit: FILE_LIMIT + 4 }),
        invoke<ContentSearchResult[]>('chat_v2_search_content', {
          query: trimmed,
          limit: 30,
        }),
      ]);

      if (seq !== requestSeq.current) return;

      let fileResults: DstuNode[] = [];
      if (fileSettled.status === 'fulfilled' && fileSettled.value.ok) {
        fileResults = fileSettled.value.value
          .filter((node) => node.type !== 'folder')
          .slice(0, FILE_LIMIT);
      }

      const sessionResults: SessionSearchItem[] = [];
      if (sessionSettled.status === 'fulfilled' && Array.isArray(sessionSettled.value)) {
        const seen = new Set<string>();
        for (const item of sessionSettled.value) {
          if (seen.has(item.sessionId)) continue;
          seen.add(item.sessionId);
          sessionResults.push({
            sessionId: item.sessionId,
            title: item.sessionTitle || '',
            snippet: stripSnippetMarkers(item.snippet),
          });
          if (sessionResults.length >= SESSION_LIMIT) break;
        }
      }

      setState({ fileResults, sessionResults, loading: false });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query, enabled]);

  return state;
}

/** FTS snippet 可能包含高亮标记，纯文本展示时去掉 */
function stripSnippetMarkers(snippet: string): string {
  return snippet.replace(/<\/?b>/g, '').replace(/\s+/g, ' ').trim();
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
