/**
 * Chat V2 - MessageItem 单条消息组件
 *
 * 职责：订阅单条消息，渲染块列表
 */

import React, { useMemo, useCallback, useState, useRef, useEffect } from 'react';
import { Copy, Check, ArrowCounterClockwise, Trash, GitBranch, ArrowBendDownRight } from '@phosphor-icons/react';
import { useStore } from 'zustand';
import { useTranslation } from 'react-i18next';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import type { StoreApi } from 'zustand';
import { cn } from '@/utils/cn';
import { DsButton } from '@/components/ui/DsButton';
import { BlockRendererWithStore } from './BlockRenderer';
import { ContextRefsDisplay, hasContextRefs } from './ContextRefsDisplay';
import type { ContextRef } from '../context/types';
import { useVariantUI } from '../hooks/useVariantUI';
import { useBlocksByIds } from '../hooks/useChatStore';
import { useImagePreviewsFromRefs } from '../hooks/useImagePreviewsFromRefs';
import { useFilePreviewsFromRefs } from '../hooks/useFilePreviewsFromRefs';
import { ParallelVariantView } from './Variant';
import { MessageActions, MessageInlineEdit, MessageTouchActionBar, UserMessageBubble } from './message';
import { resolveSingleVariantDisplayMeta } from './message/variantMetaResolver';
import { TokenUsageDisplay } from './TokenUsageDisplay';
// 🔧 移除 ModelRetryDialog，改用底部面板模型选择重试
import { SourcePanelV2, hasSourcesInBlocks } from './panels';
import type { TokenUsage } from '../core/types';
import { ActivityTimelineWithStore, isTimelineBlockType } from './ActivityTimeline';

import type { ChatStore, Block } from '../core/types';
import { sessionSwitchPerf } from '../debug/sessionSwitchPerf';
import { getModelDisplayName, formatMessageTime } from '@/utils/formatUtils';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { useLongPress } from '@/hooks/mobile';
// 🔧 编辑/重试调试日志
import { logChatV2 } from '../debug/chatV2Logger';
// 🆕 开发者选项：显示请求体 + 过滤配置
import { useDevShowRawRequest, useCopyFilterConfig } from '../hooks/useDevShowRawRequest';
import { RawRequestPreview, type RawRequestPreviewProps, type RawRequest } from './message/RawRequestPreview';
import { ThreadContentShell } from './ui/ThreadContentShell';
import { TextShimmer } from './ui/TextShimmer';
import { ThinkingIndicator } from './ThinkingIndicator';
import { StreamingSkeleton } from './StreamingSkeleton';
import { dispatchContextRefPreview } from '../utils/contextRefPreview';
import { notesDstuAdapter } from '@/dstu/adapters/notesDstuAdapter';
import { fileManager } from '@/utils/fileManager';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { useTextSelection } from '../hooks/useTextSelection';
import { SelectionToolbar } from './SelectionToolbar';
import { TranslationPopover } from './TranslationPopover';
import { ExplainPopover } from './ExplainPopover';
import { generateCardsFromSelection } from '../services/selectionCardGeneration';

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
// 请求体预览：已抽为独立组件 ./message/RawRequestPreview
//（★ 中-7 修复：删除本文件内嵌的重复旧副本，统一引用独立实现）
// ============================================================================

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
  /** 是否是最新一条消息（用于默认展开操作区） */
  isLatest?: boolean;
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
  isLatest = false,
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
    displayBlockIds,
    switchVariant,
    cancelVariant,
    retryVariant,
    deleteVariant,
    retryAllVariants,
  } = useVariantUI({ store, messageId });

  // 订阅当前消息实际显示的块，确保晚到的 content 更新会触发消息级重新分段渲染。
  const displayBlocks = useBlocksByIds(store, displayBlockIds);
  const getDisplayBlocks = useCallback((): Block[] => displayBlocks, [displayBlocks]);
  const hasSources = useMemo(() => hasSourcesInBlocks(displayBlocks), [displayBlocks]);


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

  const canDelete = useMemo(() => {
    if (!message) return false;
    if (isLocked) return false;
    return true; // 非锁定状态下可删除
  }, [message, isLocked]);

  // 判断是否是用户消息
  const isUser = message?.role === 'user';
  const streamReconnectState = isUser ? undefined : message?._meta?.streamReconnect;
  const reconnectInlineText = streamReconnectState
    ? t('messageItem.reconnect.inline', {
        attempt: streamReconnectState.retryAttempt,
        max: streamReconnectState.retryMax,
      })
    : '';

  // 🆕 判断是否正在等待首次响应（助手消息 + 流式中 + 无内容块）
  const isWaitingForContent = !isUser && sessionStatus === 'streaming' && displayBlockIds.length === 0;
  const shouldShowReconnectInline = !isUser && Boolean(streamReconnectState);

  // 📱 移动端适配：检测是否为小屏幕
  const { isSmallScreen } = useBreakpoint();
  // 📱 触屏平板（≥768 但无 hover）：历史消息 footer 的 hover 显隐对触屏不可达，coarse 指针下保持常显
  const isCoarsePointer = useMediaQuery('(pointer: coarse)');

  // 📱 移动端多变体：需要使用不同布局（头像和内容分行显示）
  const isMobileMultiVariant = isSmallScreen && isMultiVariant && !isUser;

  // 🆕 文本选择浮动工具栏
  const messageContentRef = useRef<HTMLDivElement>(null);
  const textSelection = useTextSelection(messageContentRef);
  // P0-3: 选区工具栏的定位容器 = 消息根元素（position: relative），
  // SelectionToolbar 在其内部 absolute 定位、随消息一起滚动
  const messageRootRef = useRef<HTMLDivElement>(null);

  // P0-2: 移动端长按消息（~450ms）呼出消息下方的内联操作条（非 Sheet / 非 Portal）。
  // 多变体消息有独立的卡片工具栏，不参与。
  const [touchBarOpen, setTouchBarOpen] = useState(false);
  const longPressEnabled = isSmallScreen && !isMultiVariant;
  const handleMessageLongPress = useCallback(() => {
    // ★ P0 修复：长按已经拉起文字选区时让位系统选择（否则 SelectionToolbar
    // 的复制片段/AI解释/翻译在触屏永远不可达），仅"空长按"呼出消息操作条
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && String(selection).trim().length > 0) {
      return;
    }
    // 长按误起的折叠选区一并清掉，避免操作条与系统选区手柄叠加
    selection?.removeAllRanges();
    textSelection.clear();
    setTouchBarOpen(true);
  }, [textSelection]);
  const longPress = useLongPress({
    onLongPress: handleMessageLongPress,
    disabled: !longPressEnabled,
    // ★ P0 修复：延时 450→600ms 让系统文本选择（~500ms）先行；
    // 不再抑制原生 contextmenu / 选择菜单，与系统选区共存
    delay: 600,
    preventContextMenu: false,
  });
  // 交互元素（按钮/链接/输入框）上按住不算长按；桌面路径不挂任何监听
  const longPressBind = useMemo(() => {
    if (!longPressEnabled) return {};
    return {
      ...longPress.bind,
      onPointerDown: (e: React.PointerEvent) => {
        const target = e.target as Element | null;
        if (target?.closest('button, a, input, textarea, select, [role="button"], [contenteditable="true"]')) {
          return;
        }
        longPress.bind.onPointerDown(e);
      },
    };
  }, [longPressEnabled, longPress.bind]);
  const closeTouchBar = useCallback(() => setTouchBarOpen(false), []);

  // 🆕 翻译 Popover 状态（P0-3：内联卡片挂在消息 DOM 流内，不再需要选区 rect）
  const [translationPopoverState, setTranslationPopoverState] = useState<{
    isVisible: boolean;
    sourceText: string;
    contextBefore: string;
    contextAfter: string;
  }>({ isVisible: false, sourceText: '', contextBefore: '', contextAfter: '' });

  // 🆕 解释 Popover 状态
  const [explainPopoverState, setExplainPopoverState] = useState<{
    isVisible: boolean;
    sourceText: string;
  }>({ isVisible: false, sourceText: '' });

  // 选中文本后的操作回调：发送消息
  const handleSelectionSendMessage = useCallback((content: string) => {
    store.getState().sendMessage(content);
  }, [store]);

  // 选中文本后的操作回调：解释（打开 popover）
  const handleSelectionExplain = useCallback((text: string) => {
    setExplainPopoverState({
      isVisible: true,
      sourceText: text,
    });
  }, []);

  // 关闭解释 popover
  const handleExplainPopoverClose = useCallback(() => {
    setExplainPopoverState({ isVisible: false, sourceText: '' });
  }, []);

  // 选中文本后的操作回调：翻译（打开 popover）
  const handleSelectionTranslate = useCallback((text: string) => {
    setTranslationPopoverState({
      isVisible: true,
      sourceText: text,
      contextBefore: textSelection.contextBefore,
      contextAfter: textSelection.contextAfter,
    });
  }, [textSelection.contextBefore, textSelection.contextAfter]);

  // 关闭翻译 popover
  const handleTranslationPopoverClose = useCallback(() => {
    setTranslationPopoverState({ isVisible: false, sourceText: '', contextBefore: '', contextAfter: '' });
  }, []);

  // 选中文本后的操作回调：添加到聊天输入框
  const handleSelectionAddToChat = useCallback((text: string) => {
    window.dispatchEvent(new CustomEvent('CHAT_V2_SET_INPUT', {
      detail: { content: text, autoSend: false },
    }));
  }, []);

  // 选中文本后的操作回调：划词制卡
  const handleSelectionMakeCards = useCallback((text: string) => {
    const sessionId = store.getState().sessionId;
    void generateCardsFromSelection({
      selectedText: text,
      sessionId,
      contextBefore: textSelection.contextBefore,
      contextAfter: textSelection.contextAfter,
      t,
    });
  }, [store, textSelection.contextBefore, textSelection.contextAfter, t]);
  
  // 🧮 Token 汇总：多变体判断不依赖并行视图开关
  const hasMultipleVariants = variants.length > 1;
  // 🔧 性能：memo 聚合结果，保持 usage 对象引用稳定，让 TokenUsageDisplay 的 memo 生效
  const aggregatedUsage = useMemo(
    () => (hasMultipleVariants ? aggregateVariantUsage(variants) : undefined),
    [hasMultipleVariants, variants]
  );
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

  const assistantBlocks = useMemo(() => {
    if (isUser) return [] as Block[];
    return displayBlocks;
  }, [displayBlocks, isUser]);

  const hasConsumableAssistantContent = useMemo(() => {
    if (isUser) return false;
    return extractMessageContent().length > 0;
  }, [extractMessageContent, isUser]);

  const assistantFailureDetails = useMemo(() => {
    if (isUser) return null;

    const metaError = message?._meta?.terminalError?.trim();
    if (metaError) return metaError;

    const variantError = activeVariant?.error?.trim();
    if (variantError) return variantError;

    const blockError = assistantBlocks.find((block) => typeof block.error === 'string' && block.error.trim().length > 0)?.error?.trim();
    return blockError || null;
  }, [activeVariant?.error, assistantBlocks, isUser, message?._meta?.terminalError]);

  const hasZeroOutputFailure = useMemo(() => {
    if (isUser || isMultiVariant) return false;
    const hasAssistantFailure = Boolean(message?._meta?.terminalError) || assistantBlocks.some((block) => block.status === 'error');
    return hasAssistantFailure && !hasConsumableAssistantContent;
  }, [assistantBlocks, hasConsumableAssistantContent, isMultiVariant, isUser, message?._meta?.terminalError]);

  const shouldHideLatestAssistantFooter = !isUser && isLatest && (sessionStatus === 'streaming' || hasActiveBlock);
  const showAssistantFooterAlways = !isUser && isLatest && !shouldHideLatestAssistantFooter;
  // ≥768 触屏平板无 hover：coarse 指针下与小屏一样常显，避免历史消息操作（复制/重试/编辑/删除）不可达
  // 注：|| 优先级高于 ?:，等价于 (showAssistantFooterAlways || isCoarsePointer) ? ...，且保留桌面端 fine 指针的 hover 显隐契约
  const assistantFooterClassName = showAssistantFooterAlways || isCoarsePointer
    ? 'mt-3'
    : 'mt-3 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 transition-opacity';

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
      // 🔧 修复：向上抛出，让调用方（MessageActions 等）不要展示"已复制"的成功对勾
      throw error;
    }
  }, [message, extractMessageContent, t]);

  // 多变体：底部行内操作（与时间同一行）
  const [multiCopied, setMultiCopied] = useState(false);
  const [isRetryingAllVariants, setIsRetryingAllVariants] = useState(false);
  const [isDeletingMultiMessage, setIsDeletingMultiMessage] = useState(false);
  const [isRetryingFailure, setIsRetryingFailure] = useState(false);

  // 🔧 修复：复制反馈定时器需要在卸载时清理，避免卸载后 setState
  const multiCopiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (multiCopiedTimerRef.current) clearTimeout(multiCopiedTimerRef.current);
  }, []);

  const handleMultiVariantCopy = useCallback(async () => {
    if (multiCopied) return;
    try {
      await handleCopy();
    } catch {
      // 复制失败：错误提示由 handleCopy 内部展示，不显示成功态对勾
      return;
    }
    setMultiCopied(true);
    multiCopiedTimerRef.current = setTimeout(() => setMultiCopied(false), 2000);
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

  // 🔧 P1-4: 重试破坏性确认改为内联确认条（替代 window.confirm，禁模态）
  // 记录待确认的"将被删除的后续消息数"；null 表示未展开确认条
  const [retryConfirmCount, setRetryConfirmCount] = useState<number | null>(null);

  // 真正执行重试（确认后 / 无后续消息时直接调用）
  const performRetry = useCallback(async () => {
    setRetryConfirmCount(null);
    try {
      await store.getState().retryMessage(messageId);
      logChatV2('message', 'ui', 'handleRetry_completed', {
        messageId,
      }, 'success', { messageId });
    } catch (error: unknown) {
      logChatV2('message', 'ui', 'handleRetry_error', {
        messageId,
        error: getErrorMessage(error),
      }, 'error', { messageId });
      console.error('[MessageItem] Retry failed:', error);
      showGlobalNotification('error', getErrorMessage(error), t('messageItem.actions.retryFailed'));
    }
  }, [messageId, store, t]);

  // 重试入口：有后续消息将被删除时先展开内联确认条，否则直接重试
  const handleRetry = useCallback(async () => {
    if (!message || isLocked) {
      logChatV2('message', 'ui', 'handleRetry_blocked', {
        messageId,
        reason: !message ? 'message=null' : 'isLocked=true',
        isLocked,
      }, 'warning', { messageId });
      return;
    }

    // 🔧 L-015: 重试会删除后续消息，需用户确认（内联确认条，非阻塞）
    const currentState = store.getState();
    const msgIndex = currentState.messageOrder.indexOf(messageId);
    const subsequentCount = msgIndex >= 0 ? currentState.messageOrder.length - msgIndex - 1 : 0;

    if (subsequentCount > 0) {
      setRetryConfirmCount(subsequentCount);
      return;
    }

    await performRetry();
  }, [message, messageId, isLocked, store, performRetry]);

  const handleRetryConfirmCancel = useCallback(() => {
    logChatV2('message', 'ui', 'handleRetry_cancelled_by_user', {
      messageId,
      subsequentCount: retryConfirmCount,
    }, 'info', { messageId });
    setRetryConfirmCount(null);
  }, [messageId, retryConfirmCount]);

  // 会话进入锁定态（如另一条消息开始流式）时自动收起确认条，避免过期确认
  useEffect(() => {
    if (isLocked) setRetryConfirmCount(null);
  }, [isLocked]);

  const handleRetryFromFailureBar = useCallback(async () => {
    if (isRetryingFailure || isLocked) return;
    setIsRetryingFailure(true);
    try {
      await handleRetry();
    } finally {
      setIsRetryingFailure(false);
    }
  }, [handleRetry, isLocked, isRetryingFailure]);

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

  // P0-2: 进入内联编辑时收起长按操作条（操作条在编辑态不渲染，同时复位 select-none）
  useEffect(() => {
    if (isInlineEditing) {
      setTouchBarOpen(false);
    }
  }, [isInlineEditing]);
  
  // 🔧 上下文引用预览回调
  // 发射事件让上层组件（ChatContainer/ChatV2Page）处理跳转到 Learning Hub
  const handleContextRefPreview = useCallback((ref: ContextRef) => {
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
      // 🔧 修复：提交失败时恢复编辑态，避免用户已修改的内容丢失（editText 仍保留在 state 中）
      setIsInlineEditing(true);
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

  // 🆕 导出为 Markdown 文件（入口：MessageActions 更多菜单）
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

  // 消息不存在
  if (!message) {
    return null;
  }

  return (
    <div
      ref={messageRootRef}
      // P0-2: 移动端长按呼出内联操作条（桌面路径 longPressBind 为空对象，零监听）
      {...longPressBind}
      className={cn(
        // 与 InputBar/MessageList 空态/scroll 按钮共享 px-4 md:px-8，避免左右不对齐
        // P0-3: relative = SelectionToolbar 的 absolute 定位容器
        'group relative px-4 py-4 md:px-8',
        // 🔧 P0-B1: 接通 chat.css / chat-beautify.css 的
        // `.message.assistant .message-content` 排版选择器（此前 DOM 缺类名导致
        // Streamdown-inspired Typography 整段失效）
        'message',
        isUser ? 'user' : 'assistant',
        !isUser && 'bg-background',
        // 操作条展开期间抑制文字选择，避免误触拖选；关闭/进入编辑态自动复位
        touchBarOpen && 'select-none',
        // 第一条消息添加顶部间距
        isFirst && 'pt-6',
        className
      )}
    >
      {/* 📱 移动端多变体：使用垂直布局，不显示外层头像（卡片内已有） */}
      {isMobileMultiVariant ? (
        <ThreadContentShell className="group">
          {/* P0-2: 多变体内容同样包进 message-selectable-area 并挂载共享 ref，
              使选区工具栏（翻译/解释/复制）在移动端多变体下可用 */}
          <div className="min-w-0 message-content message-selectable-area" ref={messageContentRef}>
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
            onSaveAsNote={handleSaveAsNote}
            onExportMarkdown={handleExportMarkdown}
            messageTimestamp={message?.timestamp}
            aggregatedUsage={aggregatedUsage}
            hideMessageLevelActions={!isSmallScreen}
          />
          </div>
        </ThreadContentShell>
      ) : (
        /* 💻 桌面端/非多变体：消息内容布局 */
        <ThreadContentShell
          // 与输入栏 (InputBarUI: max-w-thread) 严格对齐
          width={isMultiVariant ? 'full' : 'thread'}
        >
          {/* 消息内容（message-content: 接通 assistant 阅读排版选择器） */}
          <div className="min-w-0 message-content message-selectable-area" ref={messageContentRef}>
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
                    onSaveAsNote={handleSaveAsNote}
                    onExportMarkdown={handleExportMarkdown}
                    messageTimestamp={message?.timestamp}
                    aggregatedUsage={aggregatedUsage}
                    hideMessageLevelActions={!isSmallScreen}
                  />
                ) : (
                /* 单变体：正常块列表渲染 */
                <div className={cn(
                  'space-y-2',
                  isUser && 'flex flex-col items-end',
                  // 用户消息优化字体和间距
                  isUser && 'text-md leading-relaxed tracking-wide'
                )}>
                  {/* 🚀 P1 性能优化：分组渲染使用 BlockRendererWithStore 独立订阅 */}
                  {(() => {
                    if (isUser) {
                      // 🚀 用户消息：气泡容器 + 截断
                      const isSteered = message?._meta?.steered === true;
                      return (
                        <>
                          {isSteered && (
                            <div
                              className="flex items-center justify-end gap-1 mb-1.5 text-xs text-muted-foreground/70 select-none"
                              aria-label={t('queue.steeredBadge')}
                            >
                              <ArrowBendDownRight size={12} weight="regular" aria-hidden="true" />
                              <span>{t('queue.steeredBadge')}</span>
                            </div>
                          )}
                          <UserMessageBubble>
                            {displayBlockIds.map((blockId) => (
                              <BlockRendererWithStore
                                key={blockId}
                                store={store}
                                blockId={blockId}
                              />
                            ))}
                          </UserMessageBubble>
                        </>
                      );
                    }

                    // 助手消息：需要分组渲染（时间线块 vs 普通块）
                    // 🔧 即时获取 blocks 用于分组判断（不触发订阅）
                    const blocks = displayBlocks;

                    // 🆕 等待首次响应：displayBlockIds 为空且正在流式生成
                    if (blocks.length === 0 && sessionStatus === 'streaming') {
                      // 🔧 重连中：显示重连文本（正文样式），而非"正在思考"
                      if (shouldShowReconnectInline && streamReconnectState) {
                        return (
                          <div
                            className={cn(
                              'prose prose-sm dark:prose-invert max-w-none',
                              'text-foreground',
                              'prose-p:text-md prose-p:leading-relaxed prose-p:tracking-wide'
                            )}
                          >
                            <p className="m-0 text-md leading-relaxed tracking-wide text-foreground">
                              <TextShimmer className="text-md leading-relaxed tracking-wide text-foreground" duration={1.6} spread={3}>
                                {reconnectInlineText}
                              </TextShimmer>
                            </p>
                          </div>
                        );
                      }
                      // 🔧 P1-6: 首 token 前的等待态 = 状态文案（呼吸点）+ shimmer 骨架，
                      // 均复用 motion.css 共享类，自带 reduced-motion 降级
                      return (
                        <div className="chat-fade-in">
                          <ThinkingIndicator />
                          <StreamingSkeleton className="mt-1" />
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

          {!isInlineEditing && !isWaitingForContent && shouldShowReconnectInline && streamReconnectState && (
            <div
              className={cn(
                'prose prose-sm dark:prose-invert max-w-none',
                'text-foreground',
                'prose-p:text-md prose-p:leading-relaxed prose-p:tracking-wide',
                'mt-2'
              )}
            >
              <p className="m-0 text-md leading-relaxed tracking-wide text-foreground">
                <TextShimmer className="text-md leading-relaxed tracking-wide text-foreground" duration={1.6} spread={3}>
                  {reconnectInlineText}
                </TextShimmer>
              </p>
            </div>
          )}

          {showActions && !isInlineEditing && !isWaitingForContent && hasZeroOutputFailure && (
            <div className="mt-2">
              <div
                className={cn(
                  'prose prose-sm dark:prose-invert max-w-none',
                  'text-foreground',
                  'prose-p:text-md prose-p:leading-relaxed prose-p:tracking-wide'
                )}
              >
                <p className="m-0 whitespace-pre-wrap break-words text-md leading-relaxed text-foreground">
                  {assistantFailureDetails || t('messageItem.failure.genericError')}
                </p>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <DsButton
                  variant="ghost"
                  size="sm"
                  onClick={handleRetryFromFailureBar}
                  disabled={isLocked || isRetryingFailure}
                  className="text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                >
                  <ArrowCounterClockwise className={cn('w-4 h-4', isRetryingFailure && 'animate-spin')} />
                  {t('messageItem.failure.retry')}
                </DsButton>
              </div>
            </div>
          )}

          {/* 🔧 P1-4: 重试破坏性操作的内联确认条（替代 window.confirm；无模态） */}
          {!isUser && retryConfirmCount !== null && (
            <div
              className={cn(
                'chat-fade-in mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5',
                'rounded-[var(--chat-radius-md,12px)] border border-border/60 bg-muted/40 px-3 py-2'
              )}
              role="alert"
              data-slot="message-retry-inline-confirm"
            >
              <span className="text-ui leading-relaxed text-foreground/85">
                {t('messageItem.actions.retryDeleteConfirm', { count: retryConfirmCount })}
              </span>
              <div className="ml-auto flex items-center gap-1">
                <DsButton variant="ghost" size="sm" onClick={handleRetryConfirmCancel}>
                  {t('common:actions.cancel')}
                </DsButton>
                <DsButton
                  variant="ghost"
                  size="sm"
                  onClick={performRetry}
                  disabled={isLocked}
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  <ArrowCounterClockwise className="w-3.5 h-3.5" />
                  {t('messageItem.actions.retryConfirmAction')}
                </DsButton>
              </div>
            </div>
          )}

          {/* Token 统计 + 操作按钮（等待状态时隐藏） */}
          {/* 🔧 统一：多变体也在底部显示汇总 Token 统计 */}
          {showActions && !isInlineEditing && !isWaitingForContent && !hasZeroOutputFailure && !shouldHideLatestAssistantFooter && (
            <div className={cn(
              isUser ? 'mt-3' : assistantFooterClassName,
              isMultiVariant && 'max-w-thread mx-auto',
            )}>
              {/* 第一行：移动端 = 时间(左) + 精简操作(右)；桌面端 = 模型名+操作按钮+时间(左) + Token(右) */}
              <div
                className={cn(
                  'flex items-center gap-1.5',
                  isUser ? 'justify-end' : 'justify-between'
                )}
              >
                {/* 📱 移动端左侧：弱化元信息，只保留必要状态 */}
                {isSmallScreen && !isUser && (
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {message.timestamp && (
                      <span
                        className="text-2xs leading-none text-muted-foreground/45 flex items-center whitespace-nowrap"
                        title={new Date(message.timestamp).toLocaleString()}
                      >
                        {formatMessageTime(message.timestamp)}
                      </span>
                    )}
                  </div>
                )}

                {/* 💻 桌面端左侧：模型名称 + 操作按钮 + 时间 */}
                {!isSmallScreen && (
                  <div className="flex items-center gap-1 min-w-0">
                    {!isUser && !isMultiVariant && singleVariantModelId && (
                      <DsButton
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
                      </DsButton>
                    )}
                    {!isMultiVariant && (
                      <MessageActions
                        messageId={messageId}
                        isUser={isUser}
                        isLocked={isLocked}
                        canEdit={canEdit}
                        canDelete={canDelete}
                        alwaysExpanded={showAssistantFooterAlways}
                        anchorCopyToEnd={isUser}
                        onCopy={handleCopy}
                        onRetry={!isUser && !isMultiVariant ? handleRetry : undefined}
                        onResend={isUser ? handleResend : undefined}
                        onEdit={isUser ? handleEdit : undefined}
                        onDelete={handleDelete}
                        onSaveAsNote={!isUser ? handleSaveAsNote : undefined}
                        onExportMarkdown={!isUser ? handleExportMarkdown : undefined}
                        onBranchSession={handleBranch}
                      />
                    )}
                    {!isUser && isMultiVariant && (
                      <div className="flex items-center gap-1">
                        <DsButton
                          variant="ghost"
                          size="icon"
                          iconOnly
                          onClick={handleMultiVariantCopy}
                          aria-label={t('messageItem.actions.copy')}
                          title={t('messageItem.actions.copy')}
                        >
                          {multiCopied ? <Check className="w-4 h-4 text-success" /> : <Copy className="w-4 h-4" />}
                        </DsButton>
                        <DsButton
                          variant="ghost"
                          size="icon"
                          iconOnly
                          onClick={handleBranch}
                          disabled={isLocked}
                          aria-label={t('messageItem.actions.branch')}
                          title={t('messageItem.actions.branch')}
                        >
                          <GitBranch className="w-4 h-4" />
                        </DsButton>
                        <DsButton
                          variant="ghost"
                          size="icon"
                          iconOnly
                          onClick={handleRetryAllVariantsInline}
                          disabled={isLocked || isRetryingAllVariants}
                          aria-label={t('variant.retryAll')}
                          title={t('variant.retryAll')}
                        >
                          <ArrowCounterClockwise className={cn('w-4 h-4', isRetryingAllVariants && 'animate-spin')} />
                        </DsButton>
                        <DsButton
                          variant="ghost"
                          size="icon"
                          iconOnly
                          onClick={handleDeleteMultiMessageInline}
                          disabled={!canDelete || isDeletingMultiMessage}
                          className={cn(!canDelete || isDeletingMultiMessage ? '' : 'hover:text-destructive')}
                          aria-label={t('messageItem.actions.delete')}
                          title={t('messageItem.actions.delete')}
                        >
                          <Trash className={cn('w-4 h-4', isDeletingMultiMessage && 'animate-pulse')} />
                        </DsButton>
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
                  <div className="flex items-center gap-0.5">
                    {!isMultiVariant && (
                      <MessageActions
                        messageId={messageId}
                        isUser={isUser}
                        isLocked={isLocked}
                        canEdit={canEdit}
                        canDelete={canDelete}
                        alwaysExpanded={showAssistantFooterAlways}
                        onCopy={handleCopy}
                        onRetry={!isUser && !isMultiVariant ? handleRetry : undefined}
                        onResend={isUser ? handleResend : undefined}
                        onEdit={isUser ? handleEdit : undefined}
                        onDelete={handleDelete}
                        onSaveAsNote={!isUser ? handleSaveAsNote : undefined}
                        onExportMarkdown={!isUser ? handleExportMarkdown : undefined}
                        onBranchSession={handleBranch}
                        compactMobile
                        tokenUsage={!isUser ? (hasMultipleVariants ? aggregatedUsage : singleVariantUsage) : undefined}
                      />
                    )}
                    {/* 移动端用户消息的时间显示 */}
                    {isUser && message.timestamp && (
                      <span
                        className="text-2xs leading-none text-muted-foreground/45 flex items-center"
                        title={new Date(message.timestamp).toLocaleString()}
                      >
                        {formatMessageTime(message.timestamp)}
                      </span>
                    )}
                  </div>
                )}

                {/* 💻 桌面端右侧：Token 统计 */}
                {!isSmallScreen && (
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {!isUser && !hasMultipleVariants && singleVariantUsage && (
                      <TokenUsageDisplay usage={singleVariantUsage} compact />
                    )}
                    {!isUser && hasMultipleVariants && aggregatedUsage && (
                      <TokenUsageDisplay usage={aggregatedUsage} compact />
                    )}
                  </div>
                )}
              </div>

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

          {/* P0-2: 长按呼出的内联操作条（DOM 流内展开，非 Sheet/Portal） */}
          {longPressEnabled && !isInlineEditing && (
            <MessageTouchActionBar
              open={touchBarOpen}
              isUser={isUser}
              isLocked={isLocked}
              canEdit={canEdit}
              canDelete={canDelete}
              onCopy={handleCopy}
              onEdit={isUser ? handleEdit : undefined}
              onRetry={!isUser ? handleRetry : undefined}
              onDelete={handleDelete}
              onClose={closeTouchBar}
            />
          )}
        </div>
      </ThreadContentShell>
      )}

      {/* 🔧 移除模态框，改用底部面板 */}

      {/* 🆕 文本选中工具栏（P0-3: absolute 定位在消息根元素内，随消息滚动） */}
      <SelectionToolbar
        selectedText={textSelection.selectedText}
        selectionRect={textSelection.selectionRect}
        isVisible={textSelection.isVisible && !translationPopoverState.isVisible && !explainPopoverState.isVisible}
        containerRef={messageRootRef}
        onClear={textSelection.clear}
        onSendMessage={handleSelectionSendMessage}
        onExplain={handleSelectionExplain}
        onTranslate={handleSelectionTranslate}
        onAddToChat={handleSelectionAddToChat}
        onMakeCards={handleSelectionMakeCards}
      />

      {/* 🆕 翻译/解释内联卡片（P0-3: DOM 流内展开在消息下方，与消息列对齐） */}
      {(translationPopoverState.isVisible || explainPopoverState.isVisible) && (
        <ThreadContentShell width={isMultiVariant ? 'full' : 'thread'}>
          <TranslationPopover
            sourceText={translationPopoverState.sourceText}
            isVisible={translationPopoverState.isVisible}
            contextBefore={translationPopoverState.contextBefore}
            contextAfter={translationPopoverState.contextAfter}
            onClose={handleTranslationPopoverClose}
            onAddToInput={handleSelectionAddToChat}
          />
          <ExplainPopover
            sourceText={explainPopoverState.sourceText}
            isVisible={explainPopoverState.isVisible}
            onClose={handleExplainPopoverClose}
            onAddToInput={handleSelectionAddToChat}
          />
        </ThreadContentShell>
      )}
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
    prevProps.isFirst === nextProps.isFirst &&
    prevProps.isLatest === nextProps.isLatest
  );
});

export default MessageItem;
