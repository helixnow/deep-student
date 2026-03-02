/**
 * Chat V2 - MessageItem 单条消息组件
 *
 * 职责：订阅单条消息，渲染块列表
 */

import React, { useMemo, useCallback, useState, useRef, useEffect } from 'react';
import { Copy, Check, RotateCcw, Trash2, GitBranch } from 'lucide-react';
import { useStore } from 'zustand';
import { useTranslation } from 'react-i18next';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import type { StoreApi } from 'zustand';
import { cn } from '@/utils/cn';
import { NotionButton } from '@/components/ui/NotionButton';
import { BlockRendererWithStore } from './BlockRenderer';
import { ContextRefsDisplay, hasContextRefs } from './ContextRefsDisplay';
import type { ContextRef } from '../context/types';
import { useVariantUI } from '../hooks/useVariantUI';
import { useImagePreviewsFromRefs } from '../hooks/useImagePreviewsFromRefs';
import { useFilePreviewsFromRefs } from '../hooks/useFilePreviewsFromRefs';
import { ParallelVariantView } from './Variant';
import { MessageActions, MessageInlineEdit } from './message';
import { resolveSingleVariantDisplayMeta } from './message/variantMetaResolver';
import { TokenUsageDisplay } from './TokenUsageDisplay';
// 🔧 移除 ModelRetryDialog，改用底部面板模型选择重试
import { SourcePanelV2, hasSourcesInBlocks } from './panels';
import type { TokenUsage } from '../core/types';
import { ActivityTimelineWithStore, isTimelineBlockType } from './ActivityTimeline';
import { ProviderIcon } from '@/components/ui/ProviderIcon';
import type { ChatStore, Block } from '../core/types';
import { sessionSwitchPerf } from '../debug/sessionSwitchPerf';
import { getModelDisplayName, formatMessageTime } from '@/utils/formatUtils';
import { useBreakpoint } from '@/hooks/useBreakpoint';
// 🔧 编辑/重试调试日志
import { logChatV2 } from '../debug/chatV2Logger';
// 🆕 调试信息导出
import { copyDebugInfoToClipboard } from '../debug/exportSessionDebug';
// 🆕 开发者选项：显示请求体 + 过滤配置
import { useDevShowRawRequest, useCopyFilterConfig, type CopyFilterConfig } from '../hooks/useDevShowRawRequest';
// 🆕 AI 内容标识（合规）
import { AiContentLabel } from '@/components/shared/AiContentLabel';
import { dispatchContextRefPreview } from '../utils/contextRefPreview';
import { notesDstuAdapter } from '@/dstu/adapters/notesDstuAdapter';
import { fileManager } from '@/utils/fileManager';
import { copyTextToClipboard } from '@/utils/clipboardUtils';

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 聚合多个变体的 Token 使用统计
 * @param variants 变体列表
 * @returns 聚合后的 TokenUsage 或 undefined
 */
function aggregateVariantUsage(variants: { usage?: TokenUsage }[]): TokenUsage | undefined {
  const usages = variants.map(v => v.usage).filter((u): u is TokenUsage => !!u);
  if (usages.length === 0) return undefined;

  return {
    promptTokens: usages.reduce((sum, u) => sum + u.promptTokens, 0),
    completionTokens: usages.reduce((sum, u) => sum + u.completionTokens, 0),
    totalTokens: usages.reduce((sum, u) => sum + u.totalTokens, 0),
    reasoningTokens: usages.some(u => u.reasoningTokens !== undefined)
      ? usages.reduce((sum, u) => sum + (u.reasoningTokens ?? 0), 0)
      : undefined,
    cachedTokens: usages.some(u => u.cachedTokens !== undefined)
      ? usages.reduce((sum, u) => sum + (u.cachedTokens ?? 0), 0)
      : undefined,
    source: usages.length > 1 ? 'mixed' : usages[0].source,
  };
}

/**
 * 检查消息是否有共享上下文来源（多变体使用）
 * @param message 消息对象
 * @returns 是否有来源
 */
function hasSharedContextSources(message: { sharedContext?: {
  ragSources?: unknown[];
  memorySources?: unknown[];
  graphSources?: unknown[];
  webSearchSources?: unknown[];
  multimodalSources?: unknown[];
} }): boolean {
  const ctx = message.sharedContext;
  if (!ctx) return false;
  return !!(
    (ctx.ragSources && ctx.ragSources.length > 0) ||
    (ctx.memorySources && ctx.memorySources.length > 0) ||
    (ctx.graphSources && ctx.graphSources.length > 0) ||
    (ctx.webSearchSources && ctx.webSearchSources.length > 0) ||
    (ctx.multimodalSources && ctx.multimodalSources.length > 0)
  );
}

// ============================================================================
// 复制过滤：按 CopyFilterConfig 分段处理请求体
// ============================================================================

type RawRequest = { _source?: string; model?: string; url?: string; body?: unknown; logFilePath?: string };

async function applyCopyFilter(
  raw: RawRequest,
  isBackendLlm: boolean,
  fallbackText: string,
  cfg: CopyFilterConfig,
  t: (key: string, options?: Record<string, unknown>) => string,
  notify: (type: 'warning' | 'info', msg: string) => void,
): Promise<string> {
  const needsFullSource = cfg.images === 'full' || cfg.tools === 'full';

  let body: Record<string, unknown>;
  if (needsFullSource && raw.logFilePath) {
    try {
      const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
      const fullContent = await tauriInvoke<string>('read_debug_log_file', { path: raw.logFilePath });
      body = JSON.parse(fullContent) as Record<string, unknown>;
    } catch {
      notify('warning', t('messageItem.rawRequest.logReadFailed'));
      body = (isBackendLlm && raw.body ? raw.body : raw) as Record<string, unknown>;
    }
  } else if (needsFullSource && !raw.logFilePath) {
    notify('warning', t('messageItem.rawRequest.persistentLogRequired'));
    body = (isBackendLlm && raw.body ? raw.body : raw) as Record<string, unknown>;
  } else {
    body = (isBackendLlm && raw.body ? raw.body : raw) as Record<string, unknown>;
  }

  const result: Record<string, unknown> = {};

  // 标量参数始终保留
  for (const k of ['model', 'stream', 'temperature', 'max_tokens', 'max_completion_tokens', 'tool_choice']) {
    if (body[k] !== undefined) result[k] = body[k];
  }

  // Thinking
  if (cfg.thinking === 'full') {
    for (const k of ['enable_thinking', 'thinking_budget', 'thinking']) {
      if (body[k] !== undefined) result[k] = body[k];
    }
  }

  // Messages
  const msgs = body.messages as Array<{ role?: string; content?: unknown }> | undefined;
  if (msgs) {
    if (cfg.messages === 'full') {
      result.messages = filterImages(msgs, cfg.images);
    } else if (cfg.messages === 'truncate') {
      result.messages = filterImages(msgs, cfg.images).map((m: Record<string, unknown>) => {
        if (typeof m.content === 'string' && m.content.length > cfg.messageTruncateLength) {
          return { ...m, content: m.content.slice(0, cfg.messageTruncateLength) + `...[truncated, total ${m.content.length} chars]` };
        }
        if (Array.isArray(m.content)) {
          return { ...m, content: truncateMultimodalContent(m.content as Array<Record<string, unknown>>, cfg) };
        }
        return m;
      });
    } else {
      result.messages_summary = msgs.map(m => ({
        role: m.role,
        content_type: Array.isArray(m.content) ? 'multimodal' : 'text',
        content_size: typeof m.content === 'string' ? m.content.length : Array.isArray(m.content) ? m.content.length : 0,
      }));
    }
  }

  // Tools
  const toolsArr = body.tools as Array<Record<string, unknown>> | undefined;
  if (toolsArr) {
    if (cfg.tools === 'full') {
      result.tools = toolsArr;
    } else if (cfg.tools === 'summary') {
      const names = extractToolNames(toolsArr);
      result.tools = [{ _summary: `${toolsArr.length} tools: [${names.join(', ')}]` }];
    } else if (cfg.tools === 'names_only') {
      result.tool_names = extractToolNames(toolsArr);
    }
    // 'remove' → 不包含 tools
  }

  return JSON.stringify(result, null, 2);
}

function extractToolNames(toolsArr: Array<Record<string, unknown>>): string[] {
  return toolsArr.flatMap(t => {
    const name = (t.function as Record<string, unknown> | undefined)?.name;
    if (typeof name === 'string') return [name];
    const summary = t._summary;
    if (typeof summary === 'string') {
      const match = summary.match(/\[(.+)\]/);
      return match ? match[1].split(',').map(s => s.trim()) : [];
    }
    return [];
  });
}

function filterImages(msgs: Array<Record<string, unknown>>, mode: CopyFilterConfig['images']): Array<Record<string, unknown>> {
  if (mode === 'full') return msgs;
  return msgs.map(msg => {
    if (!Array.isArray(msg.content)) return msg;
    const filtered = (msg.content as Array<Record<string, unknown>>)
      .map(part => {
        if (part.type !== 'image_url') return part;
        if (mode === 'remove') return null;
        const urlVal = (part.image_url as Record<string, unknown> | undefined)?.url;
        if (typeof urlVal === 'string' && urlVal.startsWith('data:')) {
          const base64Len = urlVal.indexOf(',') >= 0 ? urlVal.length - urlVal.indexOf(',') - 1 : urlVal.length;
          return { type: 'image_url', image_url: { url: `[base64 image: ~${Math.round(base64Len * 3 / 4 / 1024)}KB, ${base64Len} chars]` } };
        }
        return part;
      })
      .filter(Boolean);
    return { ...msg, content: filtered };
  });
}

function truncateMultimodalContent(parts: Array<Record<string, unknown>>, cfg: CopyFilterConfig): Array<Record<string, unknown>> {
  return parts.map(part => {
    if (part.type === 'text' && typeof part.text === 'string' && part.text.length > cfg.messageTruncateLength) {
      return { ...part, text: part.text.slice(0, cfg.messageTruncateLength) + `...[truncated, total ${part.text.length} chars]` };
    }
    return part;
  });
}

// ============================================================================
// 请求体统计信息提取
// ============================================================================

interface RequestBodyStats {
  bodyChars: number;
  messageCount: number;
  imageCount: number;
  toolCount: number;
  toolCallMsgCount: number;
  toolResultMsgCount: number;
  systemPromptChars: number;
}

function extractRequestStats(body: unknown): RequestBodyStats {
  const stats: RequestBodyStats = {
    bodyChars: 0,
    messageCount: 0,
    imageCount: 0,
    toolCount: 0,
    toolCallMsgCount: 0,
    toolResultMsgCount: 0,
    systemPromptChars: 0,
  };

  if (!body || typeof body !== 'object') return stats;

  stats.bodyChars = JSON.stringify(body).length;
  const obj = body as Record<string, unknown>;

  const msgs = obj.messages as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(msgs)) {
    stats.messageCount = msgs.length;
    for (const msg of msgs) {
      const role = msg.role as string | undefined;
      if (role === 'system' && typeof msg.content === 'string') {
        stats.systemPromptChars += msg.content.length;
      }
      if (role === 'tool') stats.toolResultMsgCount++;
      if (msg.tool_calls) stats.toolCallMsgCount++;

      if (Array.isArray(msg.content)) {
        for (const part of msg.content as Array<Record<string, unknown>>) {
          if (part.type === 'image_url') stats.imageCount++;
        }
      }
    }
  }

  const tools = obj.tools as unknown[] | undefined;
  if (Array.isArray(tools)) {
    stats.toolCount = tools.length;

    // 后端标准级别会把 tools 合并为一个 _summary 对象，尝试从中提取数量
    if (tools.length === 1) {
      const first = tools[0] as Record<string, unknown>;
      if (typeof first._summary === 'string') {
        const match = (first._summary as string).match(/^(\d+) tools:/);
        if (match) stats.toolCount = parseInt(match[1], 10);
      }
    }
  }

  return stats;
}

function formatStatsLine(
  stats: RequestBodyStats,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const parts: string[] = [];
  parts.push(t('messageItem.rawRequest.stats.bodyChars', { kb: (stats.bodyChars / 1024).toFixed(1) }));
  parts.push(t('messageItem.rawRequest.stats.messages', { count: stats.messageCount }));
  if (stats.imageCount > 0) parts.push(t('messageItem.rawRequest.stats.images', { count: stats.imageCount }));
  if (stats.toolCount > 0) parts.push(t('messageItem.rawRequest.stats.tools', { count: stats.toolCount }));
  if (stats.toolCallMsgCount > 0) parts.push(t('messageItem.rawRequest.stats.toolCalls', { count: stats.toolCallMsgCount }));
  if (stats.toolResultMsgCount > 0) parts.push(t('messageItem.rawRequest.stats.toolResults', { count: stats.toolResultMsgCount }));
  return parts.join(' · ');
}

// ============================================================================
// 请求体预览子组件（独立组件以遵守 Hooks 规则）
// ============================================================================

interface RawRequestPreviewProps {
  rawRequests?: Array<{ _source: string; model: string; url: string; body: unknown; logFilePath?: string; round: number }>;
  rawRequest?: RawRequest;
  copyFilterConfig: CopyFilterConfig;
}

function RawRequestPreview({ rawRequests, rawRequest, copyFilterConfig }: RawRequestPreviewProps) {
  const { t } = useTranslation();
  const rounds = rawRequests ?? [];
  const fallbackRaw = rawRequest;

  const allRounds = rounds.length > 0 ? rounds : (fallbackRaw ? [{
    _source: fallbackRaw._source ?? '',
    model: fallbackRaw.model ?? '',
    url: fallbackRaw.url ?? '',
    body: fallbackRaw._source === 'backend_llm' ? fallbackRaw.body : fallbackRaw,
    logFilePath: fallbackRaw.logFilePath,
    round: 1,
  }] : []);

  const [selectedRound, setSelectedRound] = React.useState(allRounds.length);

  React.useEffect(() => {
    setSelectedRound(allRounds.length);
  }, [allRounds.length]);

  if (allRounds.length === 0) return null;

  const activeIdx = Math.min(selectedRound, allRounds.length) - 1;
  const current = allRounds[activeIdx];
  const isBackendLlm = current._source === 'backend_llm';
  const displayBody = current.body;
  const displayText = JSON.stringify(displayBody, null, 2);
  const stats = extractRequestStats(displayBody);

  const handleCopy = async () => {
    try {
      const asRaw: RawRequest = {
        _source: current._source,
        model: current.model,
        url: current.url,
        body: current.body,
        logFilePath: current.logFilePath,
      };
      const textToCopy = await applyCopyFilter(asRaw, isBackendLlm, displayText, copyFilterConfig, t, showGlobalNotification);
      await copyTextToClipboard(textToCopy);
      showGlobalNotification('success', t('messageItem.rawRequest.copySuccess'));
    } catch (error: unknown) {
      showGlobalNotification('error', getErrorMessage(error), t('messageItem.rawRequest.copyFailed'));
    }
  };

  return (
    <div className="mt-4 rounded-md border border-border/50 bg-muted/30 p-3">
      <div className="mb-2 text-xs font-medium text-muted-foreground flex items-center justify-between">
        <div className="flex items-center gap-2">
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
          </svg>
          {isBackendLlm
            ? `${t('messageItem.rawRequest.title')} — ${current.model}`
            : t('messageItem.rawRequest.title')}
          {current.logFilePath && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-600 dark:text-green-400">{t('messageItem.rawRequest.persisted')}</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <NotionButton variant="ghost" size="sm" onClick={handleCopy} title={t('messageItem.rawRequest.copy')}>
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            {t('messageItem.rawRequest.copy')}
          </NotionButton>
        </div>
      </div>

      <div className="mb-2 text-[11px] text-muted-foreground/70 flex flex-wrap gap-x-2.5 gap-y-0.5">
        <span>{formatStatsLine(stats, t)}</span>
      </div>

      {allRounds.length > 1 && (
        <div className="mb-2 flex items-center gap-1 flex-wrap">
          {allRounds.map((r, i) => {
            const rStats = extractRequestStats(r.body);
            return (
              <button
                key={i}
                onClick={() => setSelectedRound(i + 1)}
                className={`px-2 py-0.5 text-[10px] rounded transition-colors ${
                  i === activeIdx
                    ? 'bg-primary/10 text-primary font-medium'
                    : 'text-muted-foreground/60 hover:bg-muted/50'
                }`}
                title={rStats.toolCallMsgCount > 0
                  ? t('messageItem.rawRequest.roundTooltipWithToolCalls', {
                    round: i + 1,
                    messageCount: rStats.messageCount,
                    toolCallMsgCount: rStats.toolCallMsgCount,
                  })
                  : t('messageItem.rawRequest.roundTooltip', {
                    round: i + 1,
                    messageCount: rStats.messageCount,
                  })}
              >
                R{i + 1}
                {rStats.toolCallMsgCount > 0 && <span className="ml-0.5 opacity-60">🔧</span>}
              </button>
            );
          })}
        </div>
      )}

      {isBackendLlm && current.url && (
        <div className="mb-1.5 text-[11px] text-muted-foreground/70 font-mono truncate" title={current.url}>
          POST {current.url}
        </div>
      )}

      <pre className="overflow-x-auto rounded bg-background/80 p-2 text-xs text-foreground/80 font-mono max-h-80 overflow-y-auto">
        {displayText}
      </pre>
    </div>
  );
}

// ============================================================================
// Props 定义
// ============================================================================

export interface MessageItemProps {
  /** 消息 ID */
  messageId: string;
  /** Store 实例 */
  store: StoreApi<ChatStore>;
  /** 自定义类名 */
  className?: string;
  /** 是否显示操作按钮 */
  showActions?: boolean;
  /** 是否是第一条消息（用于添加顶部间距） */
  isFirst?: boolean;
}

// ============================================================================
// 组件实现
// ============================================================================

/**
 * MessageItem 单条消息组件
 *
 * 功能：
 * 1. 根据角色渲染不同样式
 * 2. 渲染消息包含的所有块
 * 3. 操作按钮（复制、重试、编辑、删除）
 */
const MessageItemInner: React.FC<MessageItemProps> = ({
  messageId,
  store,
  className,
  showActions = true,
  isFirst = false,
}) => {
  // 📊 细粒度打点：MessageItem render
  sessionSwitchPerf.mark('mi_render', { messageId });
  
  const { t } = useTranslation('chatV2');

  // 🆕 开发者选项：是否显示请求体 + 过滤级别
  const showRawRequest = useDevShowRawRequest();
  const copyFilterConfig = useCopyFilterConfig();

  // 使用变体 UI Hook 获取变体状态和操作
  // 注意：useVariantUI 内部已订阅 message，无需额外调用 useMessage
  const {
    message,
    variants,
    activeVariant,
    isMultiVariant,
    showParallelView,
    displayBlockIds,
    getVariantBlocks,
    switchVariant,
    cancelVariant,
    retryVariant,
    deleteVariant,
    stopAllVariants,
    retryAllVariants,
  } = useVariantUI({ store, messageId });

  // 🚀 P1 性能优化：移除订阅整个 blocks Map
  // 改为：
  // 1. 渲染时使用 BlockRendererWithStore，每个块独立订阅
  // 2. 操作回调（copy/edit）中使用 store.getState().blocks 即时获取
  
  // 🔧 辅助函数：获取当前显示块列表（用于操作回调，不订阅）
  const getDisplayBlocks = useCallback((): Block[] => {
    const blocksMap = store.getState().blocks;
    return displayBlockIds
      .map((id) => blocksMap.get(id))
      .filter((b): b is Block => b !== undefined);
  }, [store, displayBlockIds]);

  // 🚀 性能优化：hasSources 改用即时计算（在需要时调用）
  // 避免订阅整个 blocks Map
  const checkHasSources = useCallback((): boolean => {
    const blocks = getDisplayBlocks();
    return hasSourcesInBlocks(blocks);
  }, [getDisplayBlocks]);
  
  // hasSources 状态（初始值为 false，在 useEffect 中更新）
  // 使用 ref 追踪，避免无限循环
  const [hasSources, setHasSources] = useState(false);
  const prevDisplayBlockIdsRef = useRef<string[]>([]);
  
  // 当 displayBlockIds 变化时更新 hasSources
  useEffect(() => {
    // 只在 displayBlockIds 真正变化时更新
    if (
      displayBlockIds.length !== prevDisplayBlockIdsRef.current.length ||
      !displayBlockIds.every((id, i) => id === prevDisplayBlockIdsRef.current[i])
    ) {
      prevDisplayBlockIdsRef.current = displayBlockIds;
      setHasSources(checkHasSources());
    }
  }, [displayBlockIds, checkHasSources]);


  // 🔧 P1修复：使用响应式订阅替代直接调用 getState()
  // 订阅会话状态来判断操作可用性
  const sessionStatus = useStore(store, (s) => s.sessionStatus);
  
  // 🔧 P0修复：精确布尔选择器，避免 Set 引用变化导致全量重渲染
  // 选择器返回 boolean，Zustand 的 Object.is() 比较只在真正变化时触发更新
  const hasActiveBlockSelector = useCallback(
    (s: ChatStore) => displayBlockIds.some(blockId => s.activeBlockIds.has(blockId)),
    [displayBlockIds]
  );
  const hasActiveBlock = useStore(store, hasActiveBlockSelector);
  
  // 派生状态：消息是否锁定
  // 🔧 P1修复：同时检查 sending/streaming/aborting 状态，与 Store 守卫保持一致
  const isLocked = sessionStatus === 'sending' || sessionStatus === 'streaming' || sessionStatus === 'aborting' || hasActiveBlock;

  // 派生状态：是否可以编辑/删除
  // 注意：这里使用本地派生状态而非调用 store.canEdit/canDelete
  // 因为需要额外检查 message.role === 'user'，且 Hook 规则不允许条件调用
  const canEdit = useMemo(() => {
    if (!message) return false;
    if (isLocked) return false;
    return message.role === 'user'; // 只有用户消息可编辑
  }, [message, isLocked]);

  // 🔧 调试日志：记录 canEdit 状态变化
  useEffect(() => {
    if (message?.role === 'user') {
      logChatV2('message', 'ui', 'canEdit_computed', {
        messageId,
        canEdit,
        isLocked,
        sessionStatus,
        hasActiveBlock,
        displayBlockIds,
      }, canEdit ? 'info' : 'warning', { messageId });
    }
  }, [canEdit, isLocked, sessionStatus, hasActiveBlock, messageId, message?.role, displayBlockIds]);

  const canDelete = useMemo(() => {
    if (!message) return false;
    if (isLocked) return false;
    return true; // 非锁定状态下可删除
  }, [message, isLocked]);

  // 判断是否是用户消息
  const isUser = message?.role === 'user';

  // 🆕 判断是否正在等待首次响应（助手消息 + 流式中 + 无内容块）
  const isWaitingForContent = !isUser && sessionStatus === 'streaming' && displayBlockIds.length === 0;

  // 📱 移动端适配：检测是否为小屏幕
  const { isSmallScreen } = useBreakpoint();

  // 📱 移动端多变体：需要使用不同布局（头像和内容分行显示）
  const isMobileMultiVariant = isSmallScreen && isMultiVariant && !isUser;
  
  // 🧮 Token 汇总：多变体判断不依赖并行视图开关
  const hasMultipleVariants = variants.length > 1;
  const singleVariantDisplay = useMemo(
    () => resolveSingleVariantDisplayMeta(message, variants),
    [message, variants]
  );
  const singleVariantUsage = singleVariantDisplay.resolvedUsage;
  const singleVariantModelId = singleVariantDisplay.resolvedModelId;

  // 🆕 提取消息内容文本（content 块优先；为空时回退 thinking + mcp_tool）
  const extractMessageContent = useCallback((): string => {
    const blocks = getDisplayBlocks();
    const contentBlocks = blocks.filter(b => b.type === 'content');
    let text = contentBlocks.map(b => b.content || '').join('\n').trim();
    if (!text) {
      const parts: string[] = [];
      for (const b of blocks) {
        if (b.type === 'thinking' && b.content) {
          parts.push(`<thinking>\n${b.content}\n</thinking>`);
        } else if (b.type === 'mcp_tool' && b.content) {
          parts.push(b.content);
        }
      }
      text = parts.join('\n\n').trim();
    }
    return text;
  }, [getDisplayBlocks]);

  // 🆕 从内容中提取笔记标题（剥离 XML 标签，防止 <thinking> 作为标题）
  const extractNoteTitle = useCallback((content: string): string => {
    const headingMatch = content.match(/^#\s+(.+)$/m);
    if (headingMatch) return headingMatch[1].trim().slice(0, 100);
    const firstLine = content.split('\n')[0].replace(/<\/?[^>]+>/g, '').trim();
    if (firstLine.length > 0) return firstLine.slice(0, 60) + (firstLine.length > 60 ? '...' : '');
    return `Chat Note ${new Date().toLocaleDateString()}`;
  }, []);

  // 复制消息内容
  // 默认只复制 content 块（向后兼容）；当 content 为空时，回退包含 thinking / tool 结果
  // 🔧 重构：复用 extractMessageContent 避免逻辑重复
  const handleCopy = useCallback(async () => {
    if (!message) return;
    const text = extractMessageContent();
    if (!text) return; // 仍为空则不做任何操作

    try {
      await copyTextToClipboard(text);
      showGlobalNotification('success', t('messageItem.actions.copySuccess'));
    } catch (error: unknown) {
      console.error('[MessageItem] Copy failed:', error);
      showGlobalNotification('error', getErrorMessage(error), t('messageItem.actions.copyFailed'));
    }
  }, [message, extractMessageContent, t]);

  // 多变体：底部行内操作（与时间同一行）
  const [multiCopied, setMultiCopied] = useState(false);
  const [isRetryingAllVariants, setIsRetryingAllVariants] = useState(false);
  const [isDeletingMultiMessage, setIsDeletingMultiMessage] = useState(false);

  const handleMultiVariantCopy = useCallback(async () => {
    if (multiCopied) return;
    await handleCopy();
    setMultiCopied(true);
    setTimeout(() => setMultiCopied(false), 2000);
  }, [multiCopied, handleCopy]);

  const handleRetryAllVariantsInline = useCallback(async () => {
    if (!retryAllVariants || isLocked || isRetryingAllVariants) return;
    setIsRetryingAllVariants(true);
    try {
      await retryAllVariants();
    } catch (error: unknown) {
      console.error('[MessageItem] Retry all variants failed:', error);
    } finally {
      setIsRetryingAllVariants(false);
    }
  }, [retryAllVariants, isLocked, isRetryingAllVariants]);

  const handleDeleteMultiMessageInline = useCallback(async () => {
    if (!canDelete || isDeletingMultiMessage) return;
    setIsDeletingMultiMessage(true);
    try {
      await store.getState().deleteMessage(messageId);
      showGlobalNotification('success', t('messageItem.actions.deleteSuccess'));
    } catch (error: unknown) {
      console.error('[MessageItem] Delete multi-variant message failed:', error);
      showGlobalNotification('error', getErrorMessage(error), t('messageItem.actions.deleteFailed'));
    } finally {
      setIsDeletingMultiMessage(false);
    }
  }, [canDelete, isDeletingMultiMessage, store, messageId, t]);

  // 复制调试信息（JSON 格式，完整不截断）
  const handleCopyDebug = useCallback(async () => {
    try {
      await copyDebugInfoToClipboard(store, 'json');
      showGlobalNotification('success', t('debug.copySuccessDesc'), t('debug.copySuccess'));
    } catch (error: unknown) {
      showGlobalNotification('error', t('debug.copyFailed'));
    }
  }, [store, t]);

  // 重试消息
  const handleRetry = useCallback(async () => {
    // 🔧 调试日志：记录 handleRetry 调用
    logChatV2('message', 'ui', 'handleRetry_called', {
      messageId,
      isLocked,
      hasMessage: !!message,
    }, 'info', { messageId });

    if (!message || isLocked) {
      // 🔧 调试日志：记录 handleRetry 被阻止
      logChatV2('message', 'ui', 'handleRetry_blocked', {
        messageId,
        reason: !message ? 'message=null' : 'isLocked=true',
        isLocked,
      }, 'warning', { messageId });
      return;
    }

    // 🔧 L-015 修复：重试前检查是否有后续消息将被删除，需用户确认
    const currentState = store.getState();
    const msgIndex = currentState.messageOrder.indexOf(messageId);
    const subsequentCount = msgIndex >= 0 ? currentState.messageOrder.length - msgIndex - 1 : 0;

    if (subsequentCount > 0) {
      const confirmed = window.confirm(
        t('messageItem.actions.retryDeleteConfirm', { count: subsequentCount })
      );
      if (!confirmed) {
        logChatV2('message', 'ui', 'handleRetry_cancelled_by_user', {
          messageId,
          subsequentCount,
        }, 'info', { messageId });
        return;
      }
    }

    try {
      await store.getState().retryMessage(messageId);
      // 🔧 调试日志：retryMessage 调用返回（无异常）
      logChatV2('message', 'ui', 'handleRetry_completed', {
        messageId,
      }, 'success', { messageId });
    } catch (error: unknown) {
      // 🔧 调试日志：retryMessage 抛出异常
      logChatV2('message', 'ui', 'handleRetry_error', {
        messageId,
        error: getErrorMessage(error),
      }, 'error', { messageId });
      console.error('[MessageItem] Retry failed:', error);
      showGlobalNotification('error', getErrorMessage(error), t('messageItem.actions.retryFailed'));
    }
  }, [message, messageId, isLocked, store, t]);

  // 重新发送用户消息
  const handleResend = useCallback(async () => {
    if (!message || isLocked) return;
    const blocks = getDisplayBlocks();
    const contentBlock = blocks.find((b) => b.type === 'content');
    const currentContent = contentBlock?.content || '';

    if (!currentContent.trim()) {
      showGlobalNotification('error', t('messageItem.actions.emptyContent'), t('messageItem.actions.resendFailed'));
      return;
    }

    try {
      await store.getState().editAndResend(messageId, currentContent);
    } catch (error: unknown) {
      console.error('[MessageItem] Resend failed:', error);
      showGlobalNotification('error', getErrorMessage(error), t('messageItem.actions.resendFailed'));
    }
  }, [message, messageId, isLocked, getDisplayBlocks, store, t]);

  // 编辑状态
  const [isSubmittingEdit, setIsSubmittingEdit] = useState(false);
  const [isInlineEditing, setIsInlineEditing] = useState(false);
  const [editText, setEditText] = useState('');
  
  // 🔧 上下文引用预览回调
  // 发射事件让上层组件（ChatContainer/ChatV2Page）处理跳转到 Learning Hub
  const handleContextRefPreview = useCallback((ref: ContextRef) => {
    console.log('[MessageItem] Context ref preview:', ref);
    
    // 发射自定义事件，携带 ContextRef 信息
    // 事件将被 ChatContainer 或 App 层监听并处理跳转
    dispatchContextRefPreview(ref, message?._meta?.contextSnapshot?.pathMap);
  }, [message]);
  
  // 🆕 从上下文引用获取图片预览（新架构：消息只存引用，图片从 VFS 动态获取）
  const { imagePreviews, isLoading: isLoadingImages } = useImagePreviewsFromRefs(
    message?._meta?.contextSnapshot
  );
  
  // 🆕 从上下文引用获取文件预览（新架构：消息只存引用，文件从 VFS 动态获取）
  const { filePreviews, isLoading: isLoadingFiles } = useFilePreviewsFromRefs(
    message?._meta?.contextSnapshot
  );
  
  // ★ 统一使用 VFS 引用模式（直接使用完整的 ImagePreview 对象）
  // 不再需要映射，因为 ContextRefsDisplay 现在接收完整的 ImagePreview 类型

  // 开始内联编辑
  const handleEdit = useCallback(() => {
    // 🔧 调试日志：记录 handleEdit 调用
    logChatV2('message', 'ui', 'handleEdit_called', {
      messageId,
      canEdit,
      isSubmittingEdit,
      hasMessage: !!message,
    }, 'info', { messageId });

    if (!canEdit || !message || isSubmittingEdit) {
      // 🔧 调试日志：记录 handleEdit 被阻止
      logChatV2('message', 'ui', 'handleEdit_blocked', {
        messageId,
        reason: !canEdit ? 'canEdit=false' : !message ? 'message=null' : 'isSubmittingEdit=true',
        canEdit,
        isSubmittingEdit,
      }, 'warning', { messageId });
      return;
    }

    const blocks = getDisplayBlocks();
    const contentBlock = blocks.find((b) => b.type === 'content');
    const originalText = contentBlock?.content || '';
    setEditText(originalText);
    setIsInlineEditing(true);

    // 🔧 调试日志：记录编辑模式开启
    logChatV2('message', 'ui', 'handleEdit_started', {
      messageId,
      originalTextLength: originalText.length,
    }, 'success', { messageId });
  }, [canEdit, message, isSubmittingEdit, getDisplayBlocks, messageId]);

  // 确认编辑并重发
  const handleConfirmEdit = useCallback(async () => {
    // 🔧 调试日志：记录 handleConfirmEdit 调用
    logChatV2('message', 'ui', 'handleConfirmEdit_called', {
      messageId,
      editTextLength: editText.length,
    }, 'info', { messageId });

    const blocks = getDisplayBlocks();
    const contentBlock = blocks.find((b) => b.type === 'content');
    const originalText = contentBlock?.content || '';

    if (editText === originalText) {
      // 🔧 调试日志：内容未修改
      logChatV2('message', 'ui', 'handleConfirmEdit_content_unchanged', {
        messageId,
      }, 'warning', { messageId });
      // 🔧 修复：内容未修改时给用户反馈
      showGlobalNotification('info', t('messageItem.actions.contentUnchanged'));
      setIsInlineEditing(false);
      return;
    }

    if (!editText.trim()) {
      // 🔧 调试日志：内容为空
      logChatV2('message', 'ui', 'handleConfirmEdit_empty_content', {
        messageId,
      }, 'error', { messageId });
      showGlobalNotification('error', t('messageItem.actions.emptyContent'), t('messageItem.actions.editFailed'));
      return;
    }

    setIsInlineEditing(false);
    setIsSubmittingEdit(true);

    // 🔧 调试日志：开始提交编辑
    logChatV2('message', 'ui', 'handleConfirmEdit_submitted', {
      messageId,
      newContentLength: editText.length,
      originalContentLength: originalText.length,
    }, 'info', { messageId });

    try {
      await store.getState().editAndResend(messageId, editText);
      // 🔧 调试日志：editAndResend 调用返回（无异常）
      logChatV2('message', 'ui', 'handleConfirmEdit_completed', {
        messageId,
      }, 'success', { messageId });
    } catch (error: unknown) {
      // 🔧 调试日志：editAndResend 抛出异常
      logChatV2('message', 'ui', 'handleConfirmEdit_error', {
        messageId,
        error: getErrorMessage(error),
      }, 'error', { messageId });
      console.error('[MessageItem] Edit failed:', error);
      showGlobalNotification('error', getErrorMessage(error), t('messageItem.actions.editFailed'));
    } finally {
      setIsSubmittingEdit(false);
    }
  }, [getDisplayBlocks, editText, messageId, store, t]);

  // 取消内联编辑
  const handleCancelEdit = useCallback(() => {
    setIsInlineEditing(false);
    setEditText('');
  }, []);

  // 删除消息
  const handleDelete = useCallback(async () => {
    if (!canDelete) return;
    try {
      await store.getState().deleteMessage(messageId);
      showGlobalNotification('success', t('messageItem.actions.deleteSuccess'));
    } catch (error: unknown) {
      console.error('[MessageItem] Delete failed:', error);
      showGlobalNotification('error', getErrorMessage(error), t('messageItem.actions.deleteFailed'));
    }
  }, [canDelete, messageId, store, t]);

  // 🔧 P0 修复：继续执行——优先调用后端 continue_message（同消息内继续），失败时 fallback 到 sendMessage
  const handleContinue = useCallback(async () => {
    if (isLocked) {
      // 使用 getState() 获取实时状态用于日志，避免将 sessionStatus/hasActiveBlock 加入依赖数组
      const s = store.getState();
      console.warn('[MessageItem] handleContinue blocked: isLocked=true', {
        sessionStatus: s.sessionStatus,
        activeBlockIds: Array.from(s.activeBlockIds).slice(0, 5),
        messageId,
      });
      return;
    }
    try {
      await store.getState().continueMessage(messageId, activeVariant?.id);
    } catch (error: unknown) {
      console.error('[MessageItem] Continue failed:', error);
      showGlobalNotification('error', getErrorMessage(error), t('messageItem.actions.continueFailed'));
    }
  }, [isLocked, store, messageId, activeVariant?.id, t]);

  // 🆕 保存为 VFS 笔记
  const handleSaveAsNote = useCallback(async () => {
    if (!message) return;
    const text = extractMessageContent();
    if (!text) {
      showGlobalNotification('error', t('messageItem.actions.noContentToExport'));
      return;
    }
    const title = extractNoteTitle(text);
    try {
      const result = await notesDstuAdapter.createNote(title, text);
      if (result.ok) {
        showGlobalNotification('success', t('messageItem.actions.saveAsNoteSuccess', { title }));
      } else {
        showGlobalNotification('error', result.error.toUserMessage(), t('messageItem.actions.saveAsNoteFailed'));
      }
    } catch (error: unknown) {
      console.error('[MessageItem] Save as note failed:', error);
      showGlobalNotification('error', getErrorMessage(error), t('messageItem.actions.saveAsNoteFailed'));
    }
  }, [message, extractMessageContent, extractNoteTitle, t]);

  // 🆕 会话分支：从此消息处创建新会话
  const isBranchingRef = useRef(false);
  const handleBranch = useCallback(async () => {
    if (isBranchingRef.current || isLocked || !message) return;
    isBranchingRef.current = true;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const sessionId = store.getState().sessionId;
      if (!sessionId) throw new Error('No active session');
      const newSession = await invoke('chat_v2_branch_session', {
        sourceSessionId: sessionId,
        upToMessageId: messageId,
      });
      // 通知 ChatV2Page 插入新会话并切换
      window.dispatchEvent(new CustomEvent('CHAT_V2_BRANCH_SESSION', {
        detail: { session: newSession },
      }));
      showGlobalNotification('success', t('messageItem.actions.branchSuccess'));
    } catch (error: unknown) {
      console.error('[MessageItem] Branch session failed:', error);
      showGlobalNotification('error', getErrorMessage(error), t('messageItem.actions.branchFailed'));
    } finally {
      isBranchingRef.current = false;
    }
  }, [isLocked, message, store, messageId, t]);

  // 🆕 导出为 Markdown 文件
  const handleExportMarkdown = useCallback(async () => {
    if (!message) return;
    const text = extractMessageContent();
    if (!text) {
      showGlobalNotification('error', t('messageItem.actions.noContentToExport'));
      return;
    }
    const title = extractNoteTitle(text);
    const safeFileName = title.replace(/[<>:"/\\|?*]/g, '_').slice(0, 80);
    try {
      const result = await fileManager.saveTextFile({
        content: text,
        title: t('messageItem.actions.exportMarkdown'),
        defaultFileName: `${safeFileName}.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      });
      if (result.canceled) return;
      showGlobalNotification('success', t('messageItem.actions.exportMarkdownSuccess'));
    } catch (error: unknown) {
      console.error('[MessageItem] Export markdown failed:', error);
      showGlobalNotification('error', getErrorMessage(error), t('messageItem.actions.exportMarkdownFailed'));
    }
  }, [message, extractMessageContent, extractNoteTitle, t]);

  // 🆕 打开笔记（笔记工具预览点击时触发，在右侧 DSTU 面板中打开）
  const handleOpenNote = useCallback((noteId: string) => {
    // 发送 DSTU 导航事件，在学习资源侧边栏中打开笔记
    window.dispatchEvent(new CustomEvent('DSTU_OPEN_NOTE', { 
      detail: { noteId, source: 'note_tool_preview' } 
    }));
  }, []);

  // 🔒 审计修复: 将 useCallback 移到条件返回之前，避免 React Hooks 调用顺序违规
  // 🔧 P0修复：使用精确的 store 选择器判断块是否正在流式生成
  const isBlockStreaming = useCallback((blockId: string) => {
    return store.getState().activeBlockIds.has(blockId);
  }, [store]);

  // 消息不存在
  if (!message) {
    return null;
  }

  return (
    <div
      className={cn(
        'group px-4 py-4',
        isUser
          ? 'bg-muted/20'
          : 'bg-background',
        // 第一条消息添加顶部间距
        isFirst && 'pt-6',
        className
      )}
    >
      {/* 📱 移动端多变体：使用垂直布局，不显示外层头像（卡片内已有） */}
      {isMobileMultiVariant ? (
        <div className="max-w-3xl mx-auto group">
          {/* 多变体内容：居中显示，使用全宽 */}
          <ParallelVariantView
            store={store}
            messageId={messageId}
            variants={variants}
            activeVariantId={activeVariant?.id}
            onSwitchVariant={switchVariant}
            onCancelVariant={cancelVariant}
            onRetryVariant={retryVariant}
            onDeleteVariant={deleteVariant}
            onRetryAllVariants={retryAllVariants}
            onDeleteMessage={handleDelete}
            onCopy={handleCopy}
            isLocked={isLocked}
            onBranchSession={handleBranch}
            hideMessageLevelActions={!isSmallScreen}
          />
        </div>
      ) : (
        /* 💻 桌面端/非多变体：使用标准水平布局（头像+内容同行） */
        <div
          className={cn(
            'mx-auto',
            // 多变体模式使用全宽容器，让卡片均分填满聊天区域
            isMultiVariant ? 'max-w-full' : 'max-w-3xl',
            // items-start 防止头像列拉伸到消息全高
            isUser ? 'flex flex-row-reverse gap-4 items-start' : (isMultiVariant ? '' : 'flex gap-4 items-start')
          )}
        >
          {/* 头像和模型信息（多变体模式不显示，卡片内已有头像） */}
          {(isUser || !isMultiVariant) && (
          <div className="flex-shrink-0 flex flex-col items-center gap-1">
            {/* 头像 */}
            <div
              className={cn(
                'w-8 h-8 min-w-8 min-h-8 rounded-full flex items-center justify-center flex-shrink-0',
                isUser
                  ? 'bg-primary text-primary-foreground'
                  : ''
              )}
            >
              {isUser ? (
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                  <path
                    fillRule="evenodd"
                    d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z"
                    clipRule="evenodd"
                  />
                </svg>
              ) : (
                <ProviderIcon
                  modelId={singleVariantModelId || message._meta?.modelId || ''}
                  size={32}
                  showTooltip={true}
                />
              )}
            </div>
          </div>
          )}

          {/* 消息内容 */}
          <div className={cn('flex-1 min-w-0', isUser && 'pt-1')}>
            {/* 内联编辑模式 */}
            {isUser && isInlineEditing ? (
              <MessageInlineEdit
                value={editText}
                onChange={setEditText}
                onConfirm={handleConfirmEdit}
                onCancel={handleCancelEdit}
                isSubmitting={isSubmittingEdit}
              />
            ) : (
              <>
                {/* 多变体并行卡片视图 - 🚀 P0修复：由 BlockRendererWithStore 内部订阅 */}
                {!isUser && isMultiVariant ? (
                  <ParallelVariantView
                    store={store}
                    messageId={messageId}
                    variants={variants}
                    activeVariantId={activeVariant?.id}
                    onSwitchVariant={switchVariant}
                    onCancelVariant={cancelVariant}
                    onRetryVariant={retryVariant}
                    onDeleteVariant={deleteVariant}
                    onRetryAllVariants={retryAllVariants}
                    onDeleteMessage={handleDelete}
                    onCopy={handleCopy}
                    isLocked={isLocked}
                    onContinue={handleContinue}
                    onBranchSession={handleBranch}
                    hideMessageLevelActions={!isSmallScreen}
                  />
                ) : (
                /* 单变体：正常块列表渲染 */
                <div className={cn(
                  'space-y-2',
                  isUser && 'flex flex-col items-end',
                  // 用户消息优化字体和间距
                  isUser && 'text-[15px] leading-relaxed tracking-wide'
                )}>
                  {/* 🚀 P1 性能优化：分组渲染使用 BlockRendererWithStore 独立订阅 */}
                  {(() => {
                    if (isUser) {
                      // 🚀 用户消息：每个块独立订阅，使用 BlockRendererWithStore
                      return displayBlockIds.map((blockId) => (
                        <BlockRendererWithStore
                          key={blockId}
                          store={store}
                          blockId={blockId}
                        />
                      ));
                    }

                    // 助手消息：需要分组渲染（时间线块 vs 普通块）
                    // 🔧 即时获取 blocks 用于分组判断（不触发订阅）
                    const blocks = getDisplayBlocks();

                    // 🆕 等待首次响应：displayBlockIds 为空且正在流式生成
                    if (blocks.length === 0 && sessionStatus === 'streaming') {
                      return (
                        <div className="chat-thinking-indicator">
                          <span />
                          <span />
                          <span />
                        </div>
                      );
                    }

                    // 收集分组信息：记录 blockId 和是否为时间线类型
                    type RenderSegment = {
                      type: 'timeline' | 'content';
                      blockIds: string[];  // 🚀 改为存储 blockIds
                      key: string;
                      // 🔧 P4修复：附加的流式空 content 块，需要单独渲染但不分割时间线
                      streamingEmptyBlockIds?: string[];
                    };

                    const segments: RenderSegment[] = [];
                    let currentTimelineBlockIds: string[] = [];
                    // 🔧 P4修复：收集流式空 content 块，附加到当前时间线 segment
                    let currentStreamingEmptyBlockIds: string[] = [];

                    for (const block of blocks) {
                      // 🔧 paper_save 工具使用专用 PaperSaveBlock 渲染进度条，
                      // 不进时间线分组，走 BlockRendererWithStore → McpToolBlockComponent → PaperSaveBlock 路径
                      const isPaperSaveBlock = block.type === 'mcp_tool' && (
                        block.toolName === 'paper_save' ||
                        block.toolName === 'builtin-paper_save' ||
                        block.toolName?.replace(/^builtin[-:]/, '').replace(/^mcp_/, '') === 'paper_save'
                      );
                      if (isTimelineBlockType(block.type) && !isPaperSaveBlock) {
                        // 时间线类型块，累积
                        currentTimelineBlockIds.push(block.id);
                      } else {
                        // 非时间线类型块
                        // 🔧 P2修复：如果是 content 块且内容为空或只有空白，视为时间线块的一部分
                        // 避免 LLM 在工具调用之间返回的空内容分隔时间线
                        const isEmptyContent = block.type === 'content' && (!block.content || block.content.trim() === '');
                        
                        // 🔧 P3修复：流式进行中的块（pending/running）即使内容为空也必须渲染
                        // 否则 BlockRenderer 不会挂载，无法订阅后续 chunk 更新
                        const isStreamingBlock = block.status === 'pending' || block.status === 'running';

                        if (isEmptyContent) {
                          if (isStreamingBlock) {
                            // 🔧 P4修复：流式空 content 块附加到时间线，不分割
                            currentStreamingEmptyBlockIds.push(block.id);
                          }
                          // 空 content 块不分隔时间线
                          continue;
                        }
                        // 1. 先把累积的时间线块作为一个段落
                        if (currentTimelineBlockIds.length > 0) {
                          segments.push({
                            type: 'timeline',
                            blockIds: currentTimelineBlockIds,
                            key: `timeline-${currentTimelineBlockIds[0]}`,
                            streamingEmptyBlockIds: currentStreamingEmptyBlockIds.length > 0 ? currentStreamingEmptyBlockIds : undefined,
                          });
                          currentTimelineBlockIds = [];
                          currentStreamingEmptyBlockIds = [];
                        }
                        // 2. 当前块作为单独段落
                        segments.push({
                          type: 'content',
                          blockIds: [block.id],
                          key: `content-${block.id}`,
                        });
                      }
                    }
                    // 处理末尾可能残留的时间线块
                    if (currentTimelineBlockIds.length > 0) {
                      segments.push({
                        type: 'timeline',
                        blockIds: currentTimelineBlockIds,
                        key: `timeline-${currentTimelineBlockIds[0]}`,
                        streamingEmptyBlockIds: currentStreamingEmptyBlockIds.length > 0 ? currentStreamingEmptyBlockIds : undefined,
                      });
                    } else if (currentStreamingEmptyBlockIds.length > 0) {
                      // 🔧 P5修复：没有时间线块但有流式空 content 块时，直接作为 content segment 渲染
                      // 确保 BlockRendererWithStore 挂载，订阅后续 chunk 更新
                      for (const blockId of currentStreamingEmptyBlockIds) {
                        segments.push({
                          type: 'content',
                          blockIds: [blockId],
                          key: `streaming-content-${blockId}`,
                        });
                      }
                    }

                    // 渲染所有段落
                    return segments.map((segment) => {
                      if (segment.type === 'timeline') {
                        // 🔧 P0修复：使用 ActivityTimelineWithStore 响应式订阅块状态变化
                        return (
                          <React.Fragment key={segment.key}>
                            <ActivityTimelineWithStore
                              store={store}
                              blockIds={segment.blockIds}
                              onContinue={handleContinue}
                              onOpenNote={handleOpenNote}
                            />
                            {/* 🔧 P4修复：渲染流式空 content 块（正常显示），BlockRenderer 内部订阅 chunk 更新 */}
                            {segment.streamingEmptyBlockIds?.map((blockId) => (
                              <BlockRendererWithStore
                                key={blockId}
                                store={store}
                                blockId={blockId}
                              />
                            ))}
                          </React.Fragment>
                        );
                      } else {
                        // 🚀 普通块使用 BlockRendererWithStore 独立订阅
                        return segment.blockIds.map((blockId) => (
                          <BlockRendererWithStore
                            key={blockId}
                            store={store}
                            blockId={blockId}
                          />
                        ));
                      }
                    });
                  })()}
                </div>
              )}
            </>
          )}

          {/* 来源面板（仅助手消息且有来源时显示） */}
          {/* 🚀 P1 优化：不传 blocks，让 SourcePanelV2 自己订阅 */}
          {/* 单变体：使用 blocks 中的 citations */}
          {!isUser && !isMultiVariant && hasSources && (
            <div className="mt-3">
              <SourcePanelV2
                store={store}
                messageId={messageId}
                className="text-left"
              />
            </div>
          )}
          {/* 多变体：使用 sharedContext 作为 sources（在卡片外部显示汇总） */}
          {!isUser && isMultiVariant && hasSharedContextSources(message) && (
            <div className="mt-3">
              <SourcePanelV2
                store={store}
                messageId={messageId}
                sharedContext={message.sharedContext}
                className="text-left"
              />
            </div>
          )}

          {/* ★ 统一上下文引用和附件显示（用户消息）
              原 ContextRefsDisplay + MessageAttachments 合并为一个组件
              - 普通引用（note、textbook 等）：图标 + 标签
              - 图片：64x64 缩略图，点击全屏
              - 文件：图标 + 文件名，点击预览 */}
          {isUser && (hasContextRefs(message._meta?.contextSnapshot) || imagePreviews.length > 0 || filePreviews.length > 0 || isLoadingImages || isLoadingFiles) && (
            <div className="mt-2 flex justify-end">
              <ContextRefsDisplay
                contextSnapshot={message._meta?.contextSnapshot}
                onPreview={handleContextRefPreview}
                className="justify-end"
                compact
                imagePreviews={imagePreviews}
                filePreviews={filePreviews}
                isLoadingImages={isLoadingImages}
                isLoadingFiles={isLoadingFiles}
              />
            </div>
          )}

          {/* Token 统计 + 操作按钮（等待状态时隐藏） */}
          {/* 🔧 统一：多变体也在底部显示汇总 Token 统计 */}
          {showActions && !isInlineEditing && !isWaitingForContent && (
            <div className={cn(
              'mt-3 md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100 transition-opacity',
              // 多变体：底部汇总计数/操作与单变体保持同一内容宽度定位
              isMultiVariant && 'max-w-3xl mx-auto',
              // 桌面端多变体（助手消息）：补齐单变体头像列(8) + 间距(4) = 12，确保与上方单变体竖向参考线对齐
              !isSmallScreen && !isUser && isMultiVariant && 'pl-12',
              // 📱 移动端 AI 消息：向左扩展到头像位置，利用左侧空间避免右侧溢出
              isSmallScreen && !isUser && !isMultiVariant && '-ml-12 w-[calc(100%+3rem)]'
            )}>
              {/* 第一行：移动端 = Token用量(左) + 操作按钮+时间(右)；桌面端 = 模型名+操作按钮+时间(左) + AI标识+Token(右) */}
              <div
                className={cn(
                  'flex items-center gap-2',
                  isUser ? 'justify-end' : 'justify-between'
                )}
              >
                {/* 📱 移动端左侧：Token 用量 */}
                {isSmallScreen && !isUser && (
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {!hasMultipleVariants && singleVariantUsage && (
                      <TokenUsageDisplay usage={singleVariantUsage} compact />
                    )}
                    {hasMultipleVariants && (() => {
                      const aggregatedUsage = aggregateVariantUsage(variants);
                      return aggregatedUsage ? (
                        <TokenUsageDisplay usage={aggregatedUsage} compact />
                      ) : null;
                    })()}
                  </div>
                )}

                {/* 💻 桌面端左侧：模型名称 + 操作按钮 + 时间 */}
                {!isSmallScreen && (
                  <div className="flex items-center gap-1 min-w-0">
                    {!isUser && !isMultiVariant && singleVariantModelId && (
                      <NotionButton
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          store.getState().setModelRetryTarget(messageId);
                          store.getState().setPanelState('model', true);
                        }}
                        disabled={isLocked}
                        className={cn(
                          '!h-auto !px-1.5 !py-0.5 mr-1',
                          'text-[11px] text-muted-foreground/70',
                          'hover:text-foreground'
                        )}
                        title={t('messageItem.modelRetry.clickToRetry')}
                      >
                        {getModelDisplayName(message._meta?.modelDisplayName || singleVariantModelId)}
                      </NotionButton>
                    )}
                    {!isMultiVariant && (
                      <MessageActions
                        messageId={messageId}
                        isUser={isUser}
                        isLocked={isLocked}
                        canEdit={canEdit}
                        canDelete={canDelete}
                        onCopy={handleCopy}
                        onCopyDebug={showRawRequest ? handleCopyDebug : undefined}
                        onRetry={!isUser && !isMultiVariant ? handleRetry : undefined}
                        onResend={isUser ? handleResend : undefined}
                        onEdit={isUser ? handleEdit : undefined}
                        onDelete={handleDelete}
                        onSaveAsNote={!isUser ? handleSaveAsNote : undefined}
                        onBranchSession={handleBranch}
                      />
                    )}
                    {!isUser && isMultiVariant && (
                      <div className="flex items-center gap-1">
                        <NotionButton
                          variant="ghost"
                          size="icon"
                          iconOnly
                          onClick={handleMultiVariantCopy}
                          aria-label={t('messageItem.actions.copy')}
                          title={t('messageItem.actions.copy')}
                        >
                          {multiCopied ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
                        </NotionButton>
                        <NotionButton
                          variant="ghost"
                          size="icon"
                          iconOnly
                          onClick={handleBranch}
                          disabled={isLocked}
                          aria-label={t('messageItem.actions.branch')}
                          title={t('messageItem.actions.branch')}
                        >
                          <GitBranch className="w-4 h-4" />
                        </NotionButton>
                        <NotionButton
                          variant="ghost"
                          size="icon"
                          iconOnly
                          onClick={handleRetryAllVariantsInline}
                          disabled={isLocked || isRetryingAllVariants}
                          aria-label={t('variant.retryAll')}
                          title={t('variant.retryAll')}
                        >
                          <RotateCcw className={cn('w-4 h-4', isRetryingAllVariants && 'animate-spin')} />
                        </NotionButton>
                        <NotionButton
                          variant="ghost"
                          size="icon"
                          iconOnly
                          onClick={handleDeleteMultiMessageInline}
                          disabled={!canDelete || isDeletingMultiMessage}
                          className={cn(!canDelete || isDeletingMultiMessage ? '' : 'hover:text-destructive')}
                          aria-label={t('messageItem.actions.delete')}
                          title={t('messageItem.actions.delete')}
                        >
                          <Trash2 className={cn('w-4 h-4', isDeletingMultiMessage && 'animate-pulse')} />
                        </NotionButton>
                      </div>
                    )}
                    {message.timestamp && (
                      <span
                        className="text-[11px] text-muted-foreground/50 flex items-center ml-1 whitespace-nowrap shrink-0"
                        title={new Date(message.timestamp).toLocaleString()}
                      >
                        {formatMessageTime(message.timestamp)}
                      </span>
                    )}
                  </div>
                )}

                {/* 📱 移动端右侧：操作按钮 + 用户消息时间 */}
                {isSmallScreen && (
                  <div className="flex items-center gap-1">
                    {!isMultiVariant && (
                      <MessageActions
                        messageId={messageId}
                        isUser={isUser}
                        isLocked={isLocked}
                        canEdit={canEdit}
                        canDelete={canDelete}
                        onCopy={handleCopy}
                        onCopyDebug={showRawRequest ? handleCopyDebug : undefined}
                        onRetry={!isUser && !isMultiVariant ? handleRetry : undefined}
                        onResend={isUser ? handleResend : undefined}
                        onEdit={isUser ? handleEdit : undefined}
                        onDelete={handleDelete}
                        onSaveAsNote={!isUser ? handleSaveAsNote : undefined}
                        onBranchSession={handleBranch}
                      />
                    )}
                    {/* 移动端用户消息的时间显示（AI 消息时间在第二行渲染） */}
                    {isUser && message.timestamp && (
                      <span
                        className="text-[11px] text-muted-foreground/50 flex items-center"
                        title={new Date(message.timestamp).toLocaleString()}
                      >
                        {formatMessageTime(message.timestamp)}
                      </span>
                    )}
                  </div>
                )}

                {/* 💻 桌面端右侧：AI 标识 + Token 统计 */}
                {!isSmallScreen && (
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {!isUser && <AiContentLabel variant="badge" />}
                    {!isUser && !hasMultipleVariants && singleVariantUsage && (
                      <TokenUsageDisplay usage={singleVariantUsage} compact />
                    )}
                    {!isUser && hasMultipleVariants && (() => {
                      const aggregatedUsage = aggregateVariantUsage(variants);
                      return aggregatedUsage ? (
                        <TokenUsageDisplay usage={aggregatedUsage} compact />
                      ) : null;
                    })()}
                  </div>
                )}
              </div>

              {/* 📱 第二行（移动端）：模型名称(左) + AI 标识(右) */}
              {isSmallScreen && !isUser && (
                <div className="mt-1 flex items-center justify-between">
                  {!isMultiVariant && singleVariantModelId ? (
                    <NotionButton
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        store.getState().setModelRetryTarget(messageId);
                        store.getState().setPanelState('model', true);
                      }}
                      disabled={isLocked}
                      className={cn(
                        '!h-auto !px-1.5 !py-0.5',
                        'text-[11px] text-muted-foreground/70',
                        'hover:text-foreground'
                      )}
                      title={t('messageItem.modelRetry.clickToRetry')}
                    >
                      {getModelDisplayName(message._meta?.modelDisplayName || singleVariantModelId)}
                    </NotionButton>
                  ) : <span />}
                  <div className="flex items-center gap-2">
                    {message.timestamp && (
                      <span
                        className="text-[11px] text-muted-foreground/50 flex items-center"
                        title={new Date(message.timestamp).toLocaleString()}
                      >
                        {formatMessageTime(message.timestamp)}
                      </span>
                    )}
                    <AiContentLabel variant="badge" />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 开发者调试：显示请求体（仅助手消息且设置开启时显示） */}
          {showRawRequest && !isUser && (message._meta?.rawRequests?.length || message._meta?.rawRequest) && (
            <RawRequestPreview
              rawRequests={message._meta.rawRequests as RawRequestPreviewProps['rawRequests']}
              rawRequest={message._meta.rawRequest as RawRequest}
              copyFilterConfig={copyFilterConfig}
            />
          )}
        </div>
      </div>
      )}

      {/* 🔧 移除模态框，改用底部面板 */}
    </div>
  );
};

// 🚀 性能优化：使用 React.memo 避免不必要的重渲染
// 只有当 messageId 或 store 引用变化时才重渲染
// ⚠️ 重要：必须使用此 memoized 版本（MessageItem），而非内部的 MessageItemInner
// 在 MessageList 直接渲染模式下（useDirectRender = true），memo 是防止列表级
// 重渲染扩散到每条消息的关键性能屏障。
export const MessageItem = React.memo(MessageItemInner, (prevProps, nextProps) => {
  return (
    prevProps.messageId === nextProps.messageId &&
    prevProps.store === nextProps.store &&
    prevProps.showActions === nextProps.showActions &&
    prevProps.className === nextProps.className &&
    prevProps.isFirst === nextProps.isFirst
  );
});

export default MessageItem;
