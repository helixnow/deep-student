/**
 * Chat V2 — 会话级产物 registry（P1 产物一等公民化）
 *
 * 产物 = generative_ui 块 / anki_cards 块 / 笔记写入 / 文件生成。
 * SSOT 已在 blocks 表（save_tool_block 落库、restore 原样恢复），本模块只做
 * **派生索引 + 薄元数据层**，不动 Rust：
 *
 * - 派生：扫 store.blocks 重建索引（hydrateSessionArtifacts），live 路径由
 *   generativeUI 事件插件 onEnd 调用 registerGenerativeUIArtifact 增量登记。
 * - 刷新快照：登记时沿 messageOrder 前溯到前一用户消息，取消息文本
 *   （refreshPrompt）与 _meta.contextSnapshot.userRefs（contextRefs）——
 *   live 路径 contextSnapshot 只建在用户消息上（messageActions.ts），
 *   助手消息的 _meta 要 restore 后才有，所以必须前溯。
 * - intent 提取：必须走 extractGenerativeUIIntent 三级回退——落库 intent 在
 *   tool_input 而非 tool_output（executor 的 tool_output 只有 status/blockCount），
 *   真实重载后只有 toolInput 通道有值。
 * - 用户态元数据（pin/隐藏/别名）：存 sessionMetadata['artifactMeta']，
 *   整体替换语义 → 必须 read-modify-write（buildArtifactMetaPatch）。
 * - 生命周期：模块级 Map<sessionId, ...>，订阅 session-evicted/session-destroyed
 *   双事件清理（先例 App.tsx 的 chat header 订阅）。
 *
 * 设计文档：docs/plans/2026-09-06-canvas-patterns-absorption.md P1
 */

import type { Block } from '../types/block';
import type { Message } from '../types/message';
import type { ContextRef } from '../../context/types';
import type { ChatStore } from '../types';
import { sessionManager } from '../session/sessionManager';
import { extractGenerativeUIIntent } from '@/features/generative-ui/bridge/chatBlockBridge';
import {
  NOTE_WRITE_TOOLS,
  isFileProducingTool,
  unwrapToolData,
  firstString,
} from '../../components/agent-task/extractors';
import { extractMessageContentFromBlocks } from '../../components/message/messageItemUtils';

// ============================================================================
// 类型
// ============================================================================

export type ArtifactKind = 'generative-ui' | 'anki-cards' | 'note' | 'file';

export interface ArtifactEntry {
  /** = blockId（全局唯一、已持久化） */
  artifactId: string;
  kind: ArtifactKind;
  /** intent.meta.title ?? 工具产物标题 ?? 工具名回退 */
  title: string;
  /** 块结束时间（无则 startedAt / 登记时刻） */
  createdAt: number;
  /** 产物所在助手消息 */
  sourceMessageId: string;
  /** 刷新用快照：触发该产物的用户消息文本（前溯取得） */
  refreshPrompt?: string;
  /** 刷新用快照：同消息 _meta.contextSnapshot.userRefs */
  contextRefs?: ContextRef[];
  /** 打开目标（note → noteId，file → fileId） */
  targetId?: string;
}

/** sessionMetadata['artifactMeta'] 的单条用户态元数据 */
export interface ArtifactUserMeta {
  pinned?: boolean;
  hidden?: boolean;
  alias?: string;
}

// ============================================================================
// 模块级索引 + 订阅
// ============================================================================

const registry = new Map<string, Map<string, ArtifactEntry>>();

type RegistryListener = (sessionId: string) => void;
const listeners = new Set<RegistryListener>();

function notify(sessionId: string): void {
  for (const fn of listeners) fn(sessionId);
}

/** UI 订阅（useSyncExternalStore 兼容）：产物索引变化时触发 */
export function subscribeArtifactRegistry(listener: RegistryListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getBucket(sessionId: string): Map<string, ArtifactEntry> {
  let bucket = registry.get(sessionId);
  if (!bucket) {
    bucket = new Map();
    registry.set(sessionId, bucket);
  }
  return bucket;
}

/** 读取会话产物列表（创建时间倒序；pin/隐藏由 UI 结合 userMeta 处理） */
export function getSessionArtifacts(sessionId: string): ArtifactEntry[] {
  const bucket = registry.get(sessionId);
  if (!bucket) return [];
  return [...bucket.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export function clearSessionArtifacts(sessionId: string): void {
  if (registry.delete(sessionId)) notify(sessionId);
}

// ============================================================================
// 生命周期：LRU 淘汰 / 销毁时清理（防内存泄漏）
// ============================================================================

let lifecycleSubscribed = false;

/** 幂等：挂 sessionManager 清理订阅（模块首次使用时调用） */
export function ensureArtifactRegistryLifecycle(): void {
  if (lifecycleSubscribed) return;
  lifecycleSubscribed = true;
  sessionManager.subscribe((event) => {
    if (event.type === 'session-evicted' || event.type === 'session-destroyed') {
      clearSessionArtifacts(event.sessionId);
    }
  });
}

// ============================================================================
// 派生：blocks → ArtifactEntry
// ============================================================================

interface DeriveStateLike {
  blocks: Map<string, Block>;
  /** 窄 store（如 AgentTaskPanel 的读取切片）可不带消息面；缺失时刷新快照为空 */
  messageMap?: Map<string, Message>;
  messageOrder?: string[];
}

/** 前溯到前一用户消息，取刷新快照（refreshPrompt + userRefs） */
function findRefreshSnapshot(
  state: DeriveStateLike,
  assistantMessageId: string,
): { refreshPrompt?: string; contextRefs?: ContextRef[] } {
  const order = state.messageOrder;
  const messageMap = state.messageMap;
  if (!order || !messageMap) return {};
  const idx = order.indexOf(assistantMessageId);
  if (idx <= 0) return {};

  for (let i = idx - 1; i >= 0; i -= 1) {
    const msg = messageMap.get(order[i]);
    if (!msg || msg.role !== 'user') continue;

    const userBlocks = msg.blockIds
      .map((id) => state.blocks.get(id))
      .filter((b): b is Block => !!b);
    const text = extractMessageContentFromBlocks(userBlocks).trim();
    const userRefs = msg._meta?.contextSnapshot?.userRefs;

    return {
      refreshPrompt: text || undefined,
      contextRefs: userRefs && userRefs.length > 0 ? userRefs : undefined,
    };
  }
  return {};
}

/** 从单个块派生产物条目（非产物块返回 null） */
export function deriveArtifactFromBlock(
  block: Block,
  state: DeriveStateLike,
): ArtifactEntry | null {
  if (block.status !== 'success') return null;
  const createdAt = block.endedAt ?? block.startedAt ?? Date.now();

  // generative_ui 块（终态）→ generative-ui
  if (block.type === 'generative_ui') {
    const extracted = extractGenerativeUIIntent(
      block.toolOutput, block.content, block.toolInput, block.id,
    );
    if (!extracted || extracted.isStreaming) return null;
    const intent = typeof extracted.intent === 'string' ? null : extracted.intent;
    const title = intent?.meta?.title?.trim() || '生成式 UI';
    return {
      artifactId: block.id,
      kind: 'generative-ui',
      title,
      createdAt,
      sourceMessageId: block.messageId,
      ...findRefreshSnapshot(state, block.messageId),
    };
  }

  // anki_cards 块 → anki-cards（cards 在 toolOutput 自包含，重开=重渲染块）
  if (block.type === 'anki_cards') {
    const out = unwrapToolData(block.toolOutput);
    const cards = Array.isArray(out.cards) ? out.cards : [];
    const title = firstString(out.title, out.deckName) ?? `Anki 卡片（${cards.length}）`;
    return {
      artifactId: block.id,
      kind: 'anki-cards',
      title,
      createdAt,
      sourceMessageId: block.messageId,
      ...findRefreshSnapshot(state, block.messageId),
    };
  }

  // 工具块：笔记写入 / 文件生成（与 AgentTaskPanel 共用判定，口径不漂移）
  if (!block.toolName) return null;

  if (NOTE_WRITE_TOOLS.has(block.toolName)) {
    const d = unwrapToolData(block.toolOutput);
    const noteId = firstString(
      d.note_id, d.noteId, d.id,
      block.toolInput?.noteId, block.toolInput?.note_id,
    );
    if (!noteId) return null;
    return {
      artifactId: block.id,
      kind: 'note',
      title: firstString(d.title, block.toolInput?.title, d.noteTitle) ?? noteId,
      createdAt,
      sourceMessageId: block.messageId,
      targetId: noteId,
      ...findRefreshSnapshot(state, block.messageId),
    };
  }

  if (isFileProducingTool(block.toolName)) {
    const d = unwrapToolData(block.toolOutput);
    const fileId = firstString(d.file_id, d.new_file_id);
    if (!fileId) return null;
    return {
      artifactId: block.id,
      kind: 'file',
      title: firstString(d.file_name, d.title) ?? fileId,
      createdAt,
      sourceMessageId: block.messageId,
      targetId: fileId,
      ...findRefreshSnapshot(state, block.messageId),
    };
  }

  return null;
}

/**
 * 全量/增量水合：扫 blocks 重建索引。
 * 已存在的 artifactId 跳过（保留 live 登记时的快照，不覆盖）。
 * restore 分页 prepend 后对新到 blocks 再调一次即可增量补齐。
 */
export function hydrateSessionArtifacts(
  sessionId: string,
  state: DeriveStateLike,
): number {
  ensureArtifactRegistryLifecycle();
  const bucket = getBucket(sessionId);
  let added = 0;

  for (const block of state.blocks.values()) {
    if (bucket.has(block.id)) continue;
    const entry = deriveArtifactFromBlock(block, state);
    if (!entry) continue;
    bucket.set(entry.artifactId, entry);
    added += 1;
  }

  if (added > 0) notify(sessionId);
  return added;
}

/**
 * live 登记点：generativeUI 事件插件 onEnd 调用。
 * 此时终态 intent 刚写入 toolOutput（同一 onEnd 内先 updateBlock 再调用本函数）。
 * 注意：eventBridge 传入的 store 是 ChatStore 状态+动作对象本身（非 StoreApi），
 * blocks/messageMap/messageOrder/sessionId 直接挂在上面。
 */
export function registerGenerativeUIArtifact(store: ChatStore, blockId: string): void {
  ensureArtifactRegistryLifecycle();
  const block = store.blocks.get(blockId);
  if (!block) return;

  const entry = deriveArtifactFromBlock(block, store);
  if (!entry) return;

  getBucket(store.sessionId).set(entry.artifactId, entry);
  notify(store.sessionId);
}

// ============================================================================
// 用户态元数据（pin / 隐藏 / 别名）——sessionMetadata read-modify-write
// ============================================================================

/** sessionMetadata 里产物元数据的挂载键 */
export const ARTIFACT_META_KEY = 'artifactMeta';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 读取某产物的用户态元数据 */
export function getArtifactUserMeta(
  sessionMetadata: Record<string, unknown> | null | undefined,
  artifactId: string,
): ArtifactUserMeta {
  const all = isRecord(sessionMetadata) ? sessionMetadata[ARTIFACT_META_KEY] : undefined;
  if (!isRecord(all)) return {};
  const meta = all[artifactId];
  return isRecord(meta) ? (meta as ArtifactUserMeta) : {};
}

/**
 * read-modify-write：产出新的 sessionMetadata 全量对象（整体替换语义）。
 * patch 置空（该产物无任何元数据）时清理条目；全空时返回 undefined（清空态）。
 */
export function buildArtifactMetaPatch(
  sessionMetadata: Record<string, unknown> | null | undefined,
  artifactId: string,
  patch: Partial<ArtifactUserMeta>,
): Record<string, unknown> | undefined {
  const base = isRecord(sessionMetadata) ? { ...sessionMetadata } : {};
  const allRaw = base[ARTIFACT_META_KEY];
  const all: Record<string, ArtifactUserMeta> = isRecord(allRaw) ? { ...(allRaw as Record<string, ArtifactUserMeta>) } : {};

  const current = all[artifactId] ?? {};
  const next: ArtifactUserMeta = { ...current, ...patch };
  // 清理 falsy 键，保持载荷最小
  if (!next.pinned) delete next.pinned;
  if (!next.hidden) delete next.hidden;
  if (!next.alias) delete next.alias;

  if (Object.keys(next).length > 0) {
    all[artifactId] = next;
  } else {
    delete all[artifactId];
  }

  if (Object.keys(all).length > 0) {
    base[ARTIFACT_META_KEY] = all;
  } else {
    delete base[ARTIFACT_META_KEY];
  }

  return Object.keys(base).length > 0 ? base : undefined;
}
