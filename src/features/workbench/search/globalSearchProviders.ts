/**
 * Workbench OS 全局搜索（Spotlight ⌘K）Provider 注册表。
 *
 * 统一契约 GlobalSearchItem；首批 providers：apps / commands / dstu / chat。
 * 异步内容检索（dstu、chat）各自 250ms 防抖 + AbortController 语义（过期结果丢弃）。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { search as dstuSearch } from '@/dstu/api';
import type { DstuNode } from '@/dstu/types';
import type { Command } from '@/command-palette/registry/types';
import type { AppDefinition } from '../core/types';
import { workbenchBus } from '../core/workbenchBus';
import { resourceTypeToAppTypeId } from '../apps/content/typeMap';
import { openChatSession } from '../apps/chat/newSession';

export const GLOBAL_SEARCH_DEBOUNCE_MS = 250;
export const CONTENT_SEARCH_MIN_CHARS = 2;
export const DSTU_RESULT_LIMIT = 6;
export const CHAT_RESULT_LIMIT = 5;

export type GlobalSearchKind = 'app' | 'command' | 'dstu' | 'chat';

/** 统一搜索结果契约 */
export interface GlobalSearchItem {
  id: string;
  kind: GlobalSearchKind;
  title: string;
  subtitle?: string;
  score: number;
  open: () => void | Promise<void>;
  /** 命令项可选快捷键（展示用，非 open 载荷） */
  shortcut?: string;
}

export interface GlobalSearchProvider {
  id: string;
  kind: GlobalSearchKind;
  /** 防抖毫秒；同步 provider 可为 0 */
  debounceMs: number;
  /** 触发检索的最小 trim 后字符数 */
  minChars: number;
  search: (query: string, signal: AbortSignal) => Promise<GlobalSearchItem[]>;
}

export interface ContentSearchHit {
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

/** FTS snippet 可能包含高亮标记，纯文本展示时去掉 */
export function stripSnippetMarkers(snippet: string): string {
  return snippet.replace(/<\/?b>/g, '').replace(/\s+/g, ' ').trim();
}

function scoreByRank(index: number): number {
  return Math.max(0, 1 - index * 0.05);
}

function matchScore(haystack: string, query: string): number {
  const h = haystack.toLowerCase();
  const q = query.toLowerCase();
  if (!q) return 0.5;
  if (h === q) return 1;
  if (h.startsWith(q)) return 0.9;
  if (h.includes(q)) return 0.75;
  return 0.4;
}

// ---------------------------------------------------------------------------
// 底层可取消 fetch（供 providers 与 legacy useResourceSearch 共用）
// ---------------------------------------------------------------------------

export async function fetchDstuSearchResults(
  query: string,
  signal: AbortSignal,
  limit = DSTU_RESULT_LIMIT,
): Promise<DstuNode[]> {
  if (signal.aborted) return [];
  const settled = await dstuSearch(query, { limit: limit + 4 });
  if (signal.aborted) return [];
  if (!settled.ok) return [];
  return settled.value.filter((node) => node.type !== 'folder').slice(0, limit);
}

export async function fetchChatSearchResults(
  query: string,
  signal: AbortSignal,
  limit = CHAT_RESULT_LIMIT,
): Promise<SessionSearchItem[]> {
  if (signal.aborted) return [];
  const hits = await invoke<ContentSearchHit[]>('chat_v2_search_content', {
    query,
    limit: 30,
  });
  if (signal.aborted) return [];
  if (!Array.isArray(hits)) return [];

  const sessionResults: SessionSearchItem[] = [];
  const seen = new Set<string>();
  for (const item of hits) {
    if (seen.has(item.sessionId)) continue;
    seen.add(item.sessionId);
    sessionResults.push({
      sessionId: item.sessionId,
      title: item.sessionTitle || '',
      snippet: stripSnippetMarkers(item.snippet),
    });
    if (sessionResults.length >= limit) break;
  }
  return sessionResults;
}

/** Workbench 下打开学习资源（与 command-palette openFileFromPalette 对齐） */
export function openDstuInWorkbench(node: DstuNode): void {
  const typeId =
    node.type === 'note' || node.type === 'mindmap'
      ? node.type
      : resourceTypeToAppTypeId(node.type);
  if (!typeId) return;
  workbenchBus.launch({ typeId, instanceKey: node.id, reason: 'command' });
}

/** Workbench 下打开聊天会话并定位 */
export function openChatInWorkbench(sessionId: string): void {
  openChatSession(sessionId, 'command');
}

// ---------------------------------------------------------------------------
// Host：AppsPanel / 测试注入本地数据与 open 副作用
// ---------------------------------------------------------------------------

export interface WorkbenchSearchHost {
  listLaunchableApps: () => AppDefinition[];
  appName: (app: AppDefinition) => string;
  searchCommands: (query: string) => Command[];
  openApp: (typeId: string) => void;
  openCommand: (id: string) => void | Promise<void>;
  openDstu: (node: DstuNode) => void | Promise<void>;
  openChat: (sessionId: string) => void | Promise<void>;
  untitledSessionTitle?: string;
}

export function createAppsProvider(host: WorkbenchSearchHost): GlobalSearchProvider {
  return {
    id: 'apps',
    kind: 'app',
    debounceMs: 0,
    minChars: 0,
    search: async (query, signal) => {
      if (signal.aborted) return [];
      const q = query.trim().toLowerCase();
      const apps = [...host.listLaunchableApps()].sort((a, b) =>
        host.appName(a).localeCompare(host.appName(b), undefined, { sensitivity: 'base' }),
      );
      const filtered = q
        ? apps.filter((app) => {
            const name = host.appName(app).toLowerCase();
            return name.includes(q) || app.typeId.toLowerCase().includes(q);
          })
        : apps;
      return filtered.map((app, index) => {
        const title = host.appName(app);
        return {
          id: `app:${app.typeId}`,
          kind: 'app' as const,
          title,
          subtitle: app.typeId,
          score: q ? matchScore(`${title} ${app.typeId}`, q) : scoreByRank(index),
          open: () => host.openApp(app.typeId),
        };
      });
    },
  };
}

export function createCommandsProvider(host: WorkbenchSearchHost): GlobalSearchProvider {
  return {
    id: 'commands',
    kind: 'command',
    debounceMs: 0,
    minChars: 1,
    search: async (query, signal) => {
      if (signal.aborted) return [];
      const q = query.trim();
      if (!q) return [];
      const commands = host
        .searchCommands(q)
        .filter((command) => command.id !== 'global.command-palette');
      return commands.map((command, index) => ({
        id: `command:${command.id}`,
        kind: 'command' as const,
        title: command.name,
        subtitle: command.description,
        score: matchScore(`${command.name} ${command.description ?? ''}`, q) * 0.95,
        shortcut: command.shortcut,
        open: () => {
          void host.openCommand(command.id);
        },
      }));
    },
  };
}

export function createDstuProvider(host: WorkbenchSearchHost): GlobalSearchProvider {
  return {
    id: 'dstu',
    kind: 'dstu',
    debounceMs: GLOBAL_SEARCH_DEBOUNCE_MS,
    minChars: CONTENT_SEARCH_MIN_CHARS,
    search: async (query, signal) => {
      const nodes = await fetchDstuSearchResults(query.trim(), signal);
      if (signal.aborted) return [];
      return nodes.map((node, index) => ({
        id: `dstu:${node.id}`,
        kind: 'dstu' as const,
        title: node.name,
        subtitle: node.path,
        score: scoreByRank(index) * 0.85,
        open: () => host.openDstu(node),
      }));
    },
  };
}

export function createChatProvider(host: WorkbenchSearchHost): GlobalSearchProvider {
  return {
    id: 'chat',
    kind: 'chat',
    debounceMs: GLOBAL_SEARCH_DEBOUNCE_MS,
    minChars: CONTENT_SEARCH_MIN_CHARS,
    search: async (query, signal) => {
      const sessions = await fetchChatSearchResults(query.trim(), signal);
      if (signal.aborted) return [];
      const untitled = host.untitledSessionTitle ?? '';
      return sessions.map((item, index) => ({
        id: `chat:${item.sessionId}`,
        kind: 'chat' as const,
        title: item.title || untitled,
        subtitle: item.snippet,
        score: scoreByRank(index) * 0.8,
        open: () => host.openChat(item.sessionId),
      }));
    },
  };
}

export function createWorkbenchGlobalSearchProviders(
  host: WorkbenchSearchHost,
): GlobalSearchProvider[] {
  return [
    createAppsProvider(host),
    createCommandsProvider(host),
    createDstuProvider(host),
    createChatProvider(host),
  ];
}

// ---------------------------------------------------------------------------
// A45-3（docs/dev/acr/ACR-4.5.md）：desktop 虚拟目标 globalSearch 的最小追加辅助
// ---------------------------------------------------------------------------

/**
 * A45-3：dstu provider 的 agent 变体——检索与条目映射逻辑与 createDstuProvider
 * 完全一致，只额外把命中的 DstuNode 原样回传给 onNodes。
 * desktop.openSearchResult 需要 node.type 才能决定开窗应用（普通 provider 把
 * 节点封在 open 闭包里拿不到），agent 侧用它缓存命中节点。
 */
export function createDstuProviderWithNodeCapture(
  host: WorkbenchSearchHost,
  onNodes: (nodes: DstuNode[]) => void,
): GlobalSearchProvider {
  const base = createDstuProvider(host);
  return {
    ...base,
    search: async (query, signal) => {
      const nodes = await fetchDstuSearchResults(query.trim(), signal);
      if (signal.aborted) return [];
      onNodes(nodes);
      return nodes.map((node, index) => ({
        id: `dstu:${node.id}`,
        kind: 'dstu' as const,
        title: node.name,
        subtitle: node.path,
        score: scoreByRank(index) * 0.85,
        open: () => host.openDstu(node),
      }));
    },
  };
}

/**
 * A45-3：openChatInWorkbench 的 agent 变体——同一条 openChatSession 打开路径，
 * 但把 launch 返回的 windowId 交还调用方，供 agent 回执做权威确认
 * （workbench 未启用时为 null）。
 */
export function openChatInWorkbenchForAgent(sessionId: string): string | null {
  return openChatSession(sessionId, 'api');
}

// ---------------------------------------------------------------------------
// 单 provider：独立防抖 + AbortController（过期丢弃）
// ---------------------------------------------------------------------------

export interface DebouncedProviderState<T> {
  data: T;
  loading: boolean;
}

/**
 * 对单个异步查询做防抖 + 取消。过期响应（先发后至 / abort）不会写入 state。
 * 导出供行为级测试与 useResourceSearch 复用。
 */
export function useAbortableDebouncedQuery<T>(
  query: string,
  enabled: boolean,
  fetcher: (query: string, signal: AbortSignal) => Promise<T>,
  options: { debounceMs: number; minChars: number; empty: T },
): DebouncedProviderState<T> {
  const { debounceMs, minChars, empty } = options;
  const [data, setData] = useState<T>(empty);
  const [loading, setLoading] = useState(false);
  const requestSeq = useRef(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const emptyRef = useRef(empty);
  emptyRef.current = empty;

  useEffect(() => {
    const trimmed = query.trim();
    if (!enabled || trimmed.length < minChars) {
      requestSeq.current += 1;
      setData(emptyRef.current);
      setLoading(false);
      return undefined;
    }

    const seq = ++requestSeq.current;
    const controller = new AbortController();
    setLoading(true);

    const timer = setTimeout(() => {
      void (async () => {
        try {
          const result = await fetcherRef.current(trimmed, controller.signal);
          if (controller.signal.aborted || seq !== requestSeq.current) return;
          setData(result);
          setLoading(false);
        } catch {
          if (controller.signal.aborted || seq !== requestSeq.current) return;
          setData(emptyRef.current);
          setLoading(false);
        }
      })();
    }, debounceMs);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, enabled, debounceMs, minChars]);

  return { data, loading };
}

export interface GlobalSearchState {
  itemsByKind: Record<GlobalSearchKind, GlobalSearchItem[]>;
  flatItems: GlobalSearchItem[];
  loading: boolean;
  loadingByKind: Record<GlobalSearchKind, boolean>;
}

const EMPTY_LOADING: Record<GlobalSearchKind, boolean> = {
  app: false,
  command: false,
  dstu: false,
  chat: false,
};

/**
 * 并行跑多个 GlobalSearchProvider；每个 provider 独立防抖与取消。
 */
export function useGlobalSearch(
  query: string,
  enabled: boolean,
  providers: GlobalSearchProvider[],
): GlobalSearchState {
  // 固定 4 槽，避免 hooks 数量随 providers 变化
  const p0 = providers[0];
  const p1 = providers[1];
  const p2 = providers[2];
  const p3 = providers[3];

  const r0 = useAbortableDebouncedQuery(
    query,
    enabled && !!p0,
    (q, signal) => (p0 ? p0.search(q, signal) : Promise.resolve([])),
    {
      debounceMs: p0?.debounceMs ?? 0,
      minChars: p0?.minChars ?? 0,
      empty: [] as GlobalSearchItem[],
    },
  );
  const r1 = useAbortableDebouncedQuery(
    query,
    enabled && !!p1,
    (q, signal) => (p1 ? p1.search(q, signal) : Promise.resolve([])),
    {
      debounceMs: p1?.debounceMs ?? 0,
      minChars: p1?.minChars ?? 0,
      empty: [] as GlobalSearchItem[],
    },
  );
  const r2 = useAbortableDebouncedQuery(
    query,
    enabled && !!p2,
    (q, signal) => (p2 ? p2.search(q, signal) : Promise.resolve([])),
    {
      debounceMs: p2?.debounceMs ?? GLOBAL_SEARCH_DEBOUNCE_MS,
      minChars: p2?.minChars ?? CONTENT_SEARCH_MIN_CHARS,
      empty: [] as GlobalSearchItem[],
    },
  );
  const r3 = useAbortableDebouncedQuery(
    query,
    enabled && !!p3,
    (q, signal) => (p3 ? p3.search(q, signal) : Promise.resolve([])),
    {
      debounceMs: p3?.debounceMs ?? GLOBAL_SEARCH_DEBOUNCE_MS,
      minChars: p3?.minChars ?? CONTENT_SEARCH_MIN_CHARS,
      empty: [] as GlobalSearchItem[],
    },
  );

  return useMemo(() => {
    const slots: Array<{ provider?: GlobalSearchProvider; state: DebouncedProviderState<GlobalSearchItem[]> }> = [
      { provider: p0, state: r0 },
      { provider: p1, state: r1 },
      { provider: p2, state: r2 },
      { provider: p3, state: r3 },
    ];

    const itemsByKind: Record<GlobalSearchKind, GlobalSearchItem[]> = {
      app: [],
      command: [],
      dstu: [],
      chat: [],
    };
    const loadingByKind: Record<GlobalSearchKind, boolean> = { ...EMPTY_LOADING };

    for (const slot of slots) {
      if (!slot.provider) continue;
      const kind = slot.provider.kind;
      itemsByKind[kind] = slot.state.data;
      loadingByKind[kind] = slot.state.loading;
    }

    const flatItems = [
      ...itemsByKind.app,
      ...itemsByKind.command,
      ...itemsByKind.dstu,
      ...itemsByKind.chat,
    ];

    return {
      itemsByKind,
      flatItems,
      loading: Object.values(loadingByKind).some(Boolean),
      loadingByKind,
    };
  }, [p0, p1, p2, p3, r0, r1, r2, r3]);
}
