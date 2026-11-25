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
import type { AnkiLibraryCard, AnkiLibraryListResponse } from '@/types';
import type { Command } from '@/command-palette/registry/types';
import type { AppDefinition } from '../core/types';
import { workbenchBus } from '../core/workbenchBus';
import { resourceTypeToAppTypeId } from '../apps/content/typeMap';
import { openChatSession } from '../apps/chat/newSession';

export const GLOBAL_SEARCH_DEBOUNCE_MS = 250;
export const CONTENT_SEARCH_MIN_CHARS = 2;
export const CHAT_SEARCH_MIN_CHARS = 1;
export const DSTU_RESULT_LIMIT = 6;
export const FLASHCARD_RESULT_LIMIT = 5;
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
  messageId?: string;
}

export interface FlashcardSearchItem {
  cardId: string;
  front: string;
  back: string;
  deck?: string;
  tags: string[];
  snippet: string;
}

/** FTS snippet 可能包含 <b> / <mark> 高亮标记与 HTML 实体，纯文本展示时还原并剥离 */
export function stripSnippetMarkers(snippet: string): string {
  return snippet
    .replace(/<\/?(?:b|mark)>/gi, '')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 将卡片字段里的 Cloze 标记与 HTML 标签清理为可读摘要文本 */
function stripCardMarkup(raw: string): string {
  return raw
    .replace(/\{\{c\d+::([^:}]+)(?:::[^}]*)?\}\}/gi, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function readCardDeck(card: AnkiLibraryCard & { deck?: unknown; deckName?: unknown }): string | undefined {
  const candidates = [
    card.deckName,
    card.deck,
    card.extra_fields?._deck,
    card.fields?._deck,
  ];
  for (const raw of candidates) {
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
  }
  return undefined;
}

/** 格式化 DSTU 搜索结果副标题：正文 snippet 存在时优先展示命中片段并附带路径 */
export function formatDstuSearchSubtitle(node: DstuNode): string {
  const rawSnippet = typeof node.metadata?.snippet === 'string'
    ? stripSnippetMarkers(node.metadata.snippet)
    : '';
  if (!rawSnippet) return node.path;
  return node.path ? `${rawSnippet} · ${node.path}` : rawSnippet;
}

/** 格式化闪卡搜索结果副标题：牌组 + 背面摘要 / 标签 */
export function formatFlashcardSearchSubtitle(item: FlashcardSearchItem): string {
  const parts: string[] = [];
  if (item.deck) parts.push(item.deck);
  if (item.snippet) parts.push(item.snippet);
  else if (item.tags.length > 0) parts.push(item.tags.slice(0, 3).map((tag) => `#${tag}`).join(' '));
  return parts.join(' · ');
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

/**
 * 全库闪卡深层内容检索（正面 / 背面 / 挖空正文 / 标签）。
 * 直接经 Tauri `list_anki_library_cards` 查询，不静态引入 flashcards 模块。
 */
export async function fetchFlashcardSearchResults(
  query: string,
  signal: AbortSignal,
  limit = FLASHCARD_RESULT_LIMIT,
): Promise<FlashcardSearchItem[]> {
  if (signal.aborted) return [];
  const trimmed = query.trim();
  if (!trimmed) return [];
  try {
    const response = await invoke<AnkiLibraryListResponse | null>('list_anki_library_cards', {
      request: {
        search: trimmed,
        page: 1,
        pageSize: limit,
        includeDecks: false,
      },
    });
    if (signal.aborted || !response || typeof response !== 'object' || !Array.isArray(response.items)) {
      return [];
    }
    const items: FlashcardSearchItem[] = [];
    const seen = new Set<string>();
    for (const raw of response.items) {
      if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id || seen.has(raw.id)) {
        continue;
      }
      seen.add(raw.id);
      const card = raw as AnkiLibraryCard & { deck?: unknown; deckName?: unknown };
      const rawFront = card.front || card.fields?.Front || card.text || '';
      const rawBack = card.back || card.fields?.Back || '';
      const front = stripCardMarkup(rawFront) || card.id;
      const back = stripCardMarkup(rawBack);
      const deck = readCardDeck(card);
      const tags = Array.isArray(card.tags)
        ? card.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
        : [];
      const snippet = back ? back.slice(0, 140) : tags.slice(0, 3).map((tag) => `#${tag}`).join(' ');
      items.push({
        cardId: card.id,
        front: front.slice(0, 140),
        back,
        ...(deck ? { deck } : {}),
        tags,
        snippet,
      });
      if (items.length >= limit) break;
    }
    return items;
  } catch {
    return [];
  }
}

interface ListedChatSessionRow {
  id: string;
  title?: string | null;
  description?: string | null;
  mode?: string | null;
  updatedAt?: string | null;
}

const UNTITLED_SESSION_ALIASES = [
  '未命名会话',
  '未命名',
  '新对话',
  '新建对话',
  'untitled session',
  'untitled',
  'new chat',
] as const;

const GENERIC_CHAT_SESSION_ALIASES = [
  '会话',
  '对话',
  '聊天',
  'chat',
  'session',
  'conversation',
] as const;

function matchesAliasList(queryLower: string, aliases: readonly string[]): boolean {
  if (!queryLower) return false;
  return aliases.some((alias) => alias.includes(queryLower) || queryLower.includes(alias));
}

function queryMatchesChatSessionFallback(queryLower: string): boolean {
  return (
    matchesAliasList(queryLower, UNTITLED_SESSION_ALIASES) ||
    matchesAliasList(queryLower, GENERIC_CHAT_SESSION_ALIASES)
  );
}

export async function fetchChatSearchResults(
  query: string,
  signal: AbortSignal,
  limit = CHAT_RESULT_LIMIT,
): Promise<SessionSearchItem[]> {
  if (signal.aborted) return [];
  const trimmedQuery = query.trim();
  const queryLower = trimmedQuery.toLowerCase();
  const [contentResult, sessionResult] = await Promise.allSettled([
    invoke<ContentSearchHit[]>('chat_v2_search_content', {
      query: trimmedQuery,
      limit: 30,
    }),
    invoke<Array<{ id: string; title?: string | null; description?: string | null }>>('chat_v2_search_sessions', {
      query: trimmedQuery,
      limit,
      includeArchived: false,
    }),
  ]);
  if (signal.aborted) return [];

  const hits = contentResult.status === 'fulfilled' && Array.isArray(contentResult.value)
    ? contentResult.value
    : [];
  const titleSessions = sessionResult.status === 'fulfilled' && Array.isArray(sessionResult.value)
    ? sessionResult.value
    : [];

  const sessionResults: SessionSearchItem[] = [];
  const seen = new Set<string>();
  for (const item of hits) {
    if (!item?.sessionId || seen.has(item.sessionId)) continue;
    seen.add(item.sessionId);
    sessionResults.push({
      sessionId: item.sessionId,
      title: item.sessionTitle || '',
      snippet: stripSnippetMarkers(item.snippet),
      ...(item.messageId ? { messageId: item.messageId } : {}),
    });
    if (sessionResults.length >= limit) break;
  }
  for (const session of titleSessions) {
    if (sessionResults.length >= limit) break;
    if (!session?.id || seen.has(session.id)) continue;
    seen.add(session.id);
    sessionResults.push({
      sessionId: session.id,
      title: session.title || '',
      snippet: session.description ? stripSnippetMarkers(session.description) : '',
    });
  }

  // 补充已有活跃会话（覆盖 title 为空/NULL 的「未命名会话」、单字查询如「会」及分组/未分组会话列表）
  if (
    sessionResults.length < limit &&
    (sessionResults.length === 0 || queryMatchesChatSessionFallback(queryLower))
  ) {
    const listLimit = Math.max(limit * 6, 30);
    const [ungroupedSettled, groupedSettled] = await Promise.allSettled([
      invoke<ListedChatSessionRow[]>('chat_v2_list_sessions', {
        status: 'active',
        groupId: '',
        limit: listLimit,
        offset: 0,
      }),
      invoke<ListedChatSessionRow[]>('chat_v2_list_sessions', {
        status: 'active',
        groupId: '*',
        limit: listLimit,
        offset: 0,
      }),
    ]);
    if (signal.aborted) return [];

    const listedRows: ListedChatSessionRow[] = [];
    const seenListed = new Set<string>();
    const pushRows = (rows: unknown) => {
      if (!Array.isArray(rows)) return;
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const candidate = row as ListedChatSessionRow;
        if (!candidate.id || candidate.mode === 'agent' || seenListed.has(candidate.id)) continue;
        seenListed.add(candidate.id);
        listedRows.push(candidate);
      }
    };
    if (ungroupedSettled.status === 'fulfilled') pushRows(ungroupedSettled.value);
    if (groupedSettled.status === 'fulfilled') pushRows(groupedSettled.value);

    const matchesUntitled = matchesAliasList(queryLower, UNTITLED_SESSION_ALIASES);
    const matchesGeneric = matchesAliasList(queryLower, GENERIC_CHAT_SESSION_ALIASES);

    // 内存态兜底：仅当列表查询为空且查询命中未命名/通用会话别名时，按需读取 sessionManager 活动会话（不进入首屏静态闭包）
    if (listedRows.length === 0 && (matchesUntitled || matchesGeneric)) {
      try {
        const { sessionManager } = await import('@/features/chat/core/session');
        if (signal.aborted) return [];
        const currentId = sessionManager?.getCurrentSessionId?.();
        if (currentId && !seenListed.has(currentId)) {
          seenListed.add(currentId);
          listedRows.push({ id: currentId, title: null, description: null });
        }
      } catch {
        // ignore sessionManager read errors in isolated environments
      }
    }

    listedRows.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));

    const matchedCandidates: Array<{ rank: number; item: SessionSearchItem }> = [];

    for (const row of listedRows) {
      if (seen.has(row.id)) continue;
      const trimmedTitle = (row.title ?? '').trim();
      const trimmedDesc = (row.description ?? '').trim();
      const customMatch =
        (trimmedTitle.length > 0 && trimmedTitle.toLowerCase().includes(queryLower)) ||
        (trimmedDesc.length > 0 && trimmedDesc.toLowerCase().includes(queryLower));
      const untitledMatch = trimmedTitle.length === 0 && matchesUntitled;
      if (!customMatch && !untitledMatch && !matchesGeneric) continue;

      const rank = customMatch ? 0 : untitledMatch ? 1 : 2;
      matchedCandidates.push({
        rank,
        item: {
          sessionId: row.id,
          title: trimmedTitle,
          snippet: trimmedDesc ? stripSnippetMarkers(trimmedDesc) : '',
        },
      });
    }

    matchedCandidates.sort((a, b) => a.rank - b.rank);
    for (const entry of matchedCandidates) {
      if (sessionResults.length >= limit) break;
      if (seen.has(entry.item.sessionId)) continue;
      seen.add(entry.item.sessionId);
      sessionResults.push(entry.item);
    }
  }

  return sessionResults;
}

/** Workbench 下打开学习资源并聚焦目标内容（与 command-palette openFileFromPalette 对齐） */
export function openDstuInWorkbench(node: DstuNode): void {
  const targetId = (node.id || node.sourceId || '').trim();
  if (!targetId) return;
  const typeId =
    node.type === 'note' || node.type === 'mindmap'
      ? node.type
      : resourceTypeToAppTypeId(node.type);
  if (!typeId) return;
  const windowId = workbenchBus.launch({ typeId, instanceKey: targetId, reason: 'command' });

  if (node.type === 'note') {
    const heading = typeof node.metadata?.heading === 'string'
      ? node.metadata.heading.trim()
      : '';
    if (heading) {
      void workbenchBus.openNoteAnchor({
        noteId: targetId,
        heading,
        fallbackLaunch: false,
      });
    }
    // 懒加载 noteDriver 让目标笔记编辑器获焦（不引入静态闭包依赖）
    void import('../agent/drivers/noteDriver')
      .then(({ getNoteEditor, subscribeNoteEditorReady }) => {
        const focusEditor = (api: { focus?: () => void } | undefined) => {
          api?.focus?.();
        };
        const existing = getNoteEditor(targetId, windowId ?? undefined);
        if (existing) {
          focusEditor(existing as { focus?: () => void });
          return;
        }
        const cancel = subscribeNoteEditorReady(
          targetId,
          (api) => {
            cancel();
            focusEditor(api as { focus?: () => void });
          },
          windowId ?? undefined,
        );
        setTimeout(cancel, 4000);
      })
      .catch(() => undefined);
  }
}

/**
 * Workbench 下打开命中的闪卡：直接定位到卡片库的对应卡片、牌组与搜索词，
 * 而不是落在空白的「今日复习」首页。所有 flashcards store 均走动态 import，
 * 保持首屏静态闭包零新增。
 */
export async function openFlashcardInWorkbench(
  item: Pick<FlashcardSearchItem, 'cardId' | 'front' | 'deck'>,
  searchQuery?: string,
): Promise<string | null> {
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

    const windowId = workbenchBus.launch({
      typeId: 'flashcards',
      payload: {
        screen: 'library',
        cardId: item.cardId,
        query: focusQuery,
        ...(targetDeck ? { deck: targetDeck } : {}),
      },
      reason: 'command',
    });

    void useFlashcardsLibraryStore.getState().load(focusQuery, 1);
    return windowId;
  } catch {
    return workbenchBus.launch({
      typeId: 'flashcards',
      payload: {
        screen: 'library',
        cardId: item.cardId,
        query: focusQuery,
        ...(targetDeck ? { deck: targetDeck } : {}),
      },
      reason: 'command',
    });
  }
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
  openFlashcard?: (card: FlashcardSearchItem, query: string) => void | Promise<void>;
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
      const trimmed = query.trim();
      const [dstuSettled, flashcardSettled] = await Promise.allSettled([
        fetchDstuSearchResults(trimmed, signal),
        fetchFlashcardSearchResults(trimmed, signal),
      ]);
      if (signal.aborted) return [];
      const nodes = dstuSettled.status === 'fulfilled' ? dstuSettled.value : [];
      const cards = flashcardSettled.status === 'fulfilled' ? flashcardSettled.value : [];

      const dstuItems: GlobalSearchItem[] = nodes.map((node, index) => ({
        id: `dstu:${node.id}`,
        kind: 'dstu' as const,
        title: node.name,
        subtitle: formatDstuSearchSubtitle(node),
        score: scoreByRank(index) * 0.85,
        open: () => host.openDstu(node),
      }));

      const flashcardItems: GlobalSearchItem[] = cards.map((card, index) => ({
        id: `dstu:flashcard:${card.cardId}`,
        kind: 'dstu' as const,
        title: card.front,
        subtitle: formatFlashcardSearchSubtitle(card),
        score: Math.max(
          scoreByRank(index) * 0.82,
          matchScore(`${card.front} ${card.back}`, trimmed) * 0.84,
        ),
        open: async () => {
          if (host.openFlashcard) {
            await host.openFlashcard(card, trimmed);
            return;
          }
          try {
            const { closeAppsPanel } = await import('../components/appsPanelStore');
            closeAppsPanel();
          } catch {
            // ignore outside workbench UI
          }
          await openFlashcardInWorkbench(card, trimmed);
        },
      }));

      return [...dstuItems, ...flashcardItems];
    },
  };
}

export function createChatProvider(host: WorkbenchSearchHost): GlobalSearchProvider {
  return {
    id: 'chat',
    kind: 'chat',
    debounceMs: GLOBAL_SEARCH_DEBOUNCE_MS,
    minChars: CHAT_SEARCH_MIN_CHARS,
    search: async (query, signal) => {
      const q = query.trim();
      const sessions = await fetchChatSearchResults(q, signal);
      if (signal.aborted) return [];
      const untitled = host.untitledSessionTitle ?? '未命名会话';
      return sessions.map((item, index) => {
        const displayTitle = item.title || untitled;
        return {
          id: `chat:${item.sessionId}`,
          kind: 'chat' as const,
          title: displayTitle,
          subtitle: item.snippet,
          score: Math.max(scoreByRank(index) * 0.8, matchScore(displayTitle, q) * 0.82),
          open: () => host.openChat(item.sessionId),
        };
      });
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
        subtitle: formatDstuSearchSubtitle(node),
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
