/**
 * 选区即上下文（P0）——把用户划选的内容片段作为结构化 contextRef 注入聊天。
 *
 * 对标 Cursor Design Mode 的「元素身份 + 截图」双信号：我们的内容全部自己渲染，
 * 引用 id + locator 即精确坐标，选区文本快照即视觉状态，无需 fiber 树逆向。
 *
 * 存储策略（零 Rust 改动）：复用 retrieval 资源类型做快照存储（虚拟类型、无领域表、
 * 不污染资源库列表——retrieval 在 dstu list/search/收藏/回收站/FTS 中均被排除），
 * 前端注册 selection typeId 走快照模式 formatToBlocks（见 definitions/selection.ts）。
 *
 * 注意：locator 必须放在 data 内（而非仅 metadata）——createOrReuse 按 data hash
 * 去重，locator 不进 hash 会把「同一文本、不同位置」的选区错误合并。
 *
 * 设计文档：docs/plans/2026-09-06-canvas-patterns-absorption.md P0
 */

import { t } from '@/utils/i18n';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { sessionManager } from '@/features/chat/core/session/sessionManager';
import { ensureActiveChatSession } from '@/features/chat/pages/ensureActiveChatSession';
import { resourceStoreApi } from '@/features/chat/resources';
import type { ContextRef } from '@/features/chat/resources/types';
import { getErrorMessage } from '@/utils/errorUtils';
import { SELECTION_TYPE_ID } from './definitions/selection';

// ============================================================================
// 类型
// ============================================================================

/** 选区来源种类 */
export type SelectionSourceKind = 'pdf' | 'message' | 'mindmap' | 'note';

/**
 * 选区快照数据（存进 Resource.data 的 JSON）。
 */
export interface SelectionRefData {
  /** 选区文本（导图面为节点 + 子树大纲文本） */
  text: string;
  source: {
    kind: SelectionSourceKind;
    /** 源资源 id（pdf/note/mindmap），用于回链跳转与 agent 工具回读 */
    sourceId?: string;
    /** 定位符：'page:N' / 导图节点 id / 笔记 section 等 */
    locator?: string;
    /** 来源显示名（文档名 / 导图标题 / 会话标题） */
    title?: string;
    /** kind=message 时的消息 id */
    messageId?: string;
  };
}

export interface SelectionToChatParams {
  /** 选区文本 */
  text: string;
  source: SelectionRefData['source'];
}

export interface SelectionToChatResult {
  success: boolean;
  contextRef?: ContextRef;
  error?: string;
}

// ============================================================================
// 常量
// ============================================================================

const LOG_PREFIX = '[selectionToChat]';

/**
 * 选区文本上限：防止整文档框选把巨型快照塞进资源表。
 * 超出部分截断并附加标记；发送侧另有 truncateContextByTokens 做 token 预算。
 */
export const MAX_SELECTION_TEXT_CHARS = 20_000;

// ============================================================================
// 工具函数
// ============================================================================

/** 构建 chip / 通知用的来源显示名，如「《机器学习系统》第 47 页」 */
export function buildSelectionDisplayName(source: SelectionRefData['source']): string {
  const parts = [source.title, source.locator].filter(Boolean);
  if (parts.length > 0) return parts.join(' ');
  return t('selectionRef.fallbackName', { defaultValue: '选区引用' }, 'chatV2');
}

/** 序列化 SelectionRefData（截断在序列化前完成，保证 hash 与存储内容一致） */
export function serializeSelectionRefData(data: SelectionRefData): string {
  const text = data.text.length > MAX_SELECTION_TEXT_CHARS
    ? `${data.text.slice(0, MAX_SELECTION_TEXT_CHARS)}\n…`
    : data.text;
  return JSON.stringify({ ...data, text });
}

// ============================================================================
// 主入口
// ============================================================================

/**
 * 把选区作为结构化 contextRef 注入当前会话的 pendingContextRefs。
 *
 * 骨架仿 useReferenceToChat（ensureActiveChatSession → createOrReuse → addContextRef），
 * 有意差异：不做 getResourceRefsV2 后端解析（快照自足）、不创建伪附件、不开附件面板。
 * 直接拿 sessionManager，经典壳 / workbench 壳通用（不走事件通道）。
 */
export async function selectionToChat(
  params: SelectionToChatParams,
): Promise<SelectionToChatResult> {
  const { text, source } = params;

  if (!text.trim()) {
    return { success: false, error: 'empty selection' };
  }

  const activeSessionId = await ensureActiveChatSession();
  if (!activeSessionId || !sessionManager.has(activeSessionId)) {
    const errorMsg = t('selectionRef.noSession', { defaultValue: '没有可用的会话' }, 'chatV2');
    showGlobalNotification('warning', errorMsg);
    return { success: false, error: errorMsg };
  }

  const store = sessionManager.get(activeSessionId);
  if (!store) {
    const errorMsg = t('selectionRef.noSession', { defaultValue: '没有可用的会话' }, 'chatV2');
    showGlobalNotification('error', errorMsg);
    return { success: false, error: errorMsg };
  }

  try {
    const data: SelectionRefData = { text, source };
    const createResult = await resourceStoreApi.createOrReuse({
      type: 'retrieval',
      data: serializeSelectionRefData(data),
      // sourceId 仅用于跳转定位（kind=message 时无 VFS 资源，留空）
      sourceId: source.sourceId,
      metadata: {
        title: buildSelectionDisplayName(source),
        selectionKind: source.kind,
        locator: source.locator,
      },
    });

    const contextRef: ContextRef = {
      resourceId: createResult.resourceId,
      hash: createResult.hash,
      typeId: SELECTION_TYPE_ID,
      displayName: buildSelectionDisplayName(source),
    };

    store.getState().addContextRef(contextRef);

    showGlobalNotification(
      'success',
      t('selectionRef.added', { defaultValue: '已引用到对话' }, 'chatV2'),
      buildSelectionDisplayName(source),
    );

    console.log(LOG_PREFIX, 'selection added:', { kind: source.kind, locator: source.locator });
    return { success: true, contextRef };
  } catch (error) {
    const errorMsg = getErrorMessage(error);
    console.error(LOG_PREFIX, 'failed:', error);
    showGlobalNotification(
      'error',
      t('selectionRef.failed', { defaultValue: '引用失败' }, 'chatV2'),
      errorMsg,
    );
    return { success: false, error: errorMsg };
  }
}
