/**
 * Chat V2 - ChatContainer 主容器组件
 *
 * 职责：获取 Store，渲染 MessageList + InputBarV2
 *
 * 注意：此组件会自动导入 Chat V2 初始化模块，确保：
 * 1. 所有样式文件被加载
 * 2. 所有插件被注册
 * 3. 全局配置被初始化
 */

// 确保 Chat V2 初始化（样式 + 插件注册）
import '../init';
import { TodayReviewHint, useTodayReviewHintAvailability } from '@/features/learning-today';

import React, { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { StoreApi } from 'zustand';
import type { ChatStore } from '../core/types';
import { useStore } from 'zustand';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Info, X } from '@phosphor-icons/react';
import { cn } from '@/utils/cn';
import { APP_EVENTS, dispatchAppEvent } from '@/events';
import { useViewStore } from '@/stores/viewStore';
import type { CurrentView } from '@/types/navigation';
import {
  clearChatHandoffReturnView,
  getChatHandoffReturnView,
  subscribeChatHandoffReturnView,
} from '@/utils/chatHandoffReturn';
import { MessageList } from './MessageList';
import { InputBarV2 } from './input-bar';
import { SuperInboxPausedBanner } from '../superSession/SuperInboxPausedBanner';
import { ChatErrorBoundary, ErrorFallback } from './ChatErrorBoundary';
import { ThreadContentShell } from './ui/ThreadContentShell';
import { useMobileLayoutSafe } from '@/components/layout/MobileLayoutContext';
import { useBreakpoint } from '@/hooks/useBreakpoint';
// 🔧 严重修复：使用 useConnectedSession 确保后端连接
import { useConnectedSession } from '../hooks/useConnectedSession';
// 🔧 多变体支持：获取可用模型列表
import { useAvailableModels } from '../hooks/useAvailableModels';
// 🆕 Canvas 上下文引用管理 - 白板功能已移除
import { modeRegistry } from '../registry';
// 🗑️ Anki 面板已从 Chat V2 移除
// 🔧 TextbookContext 已废弃，教材功能通过 DSTU + Learning Hub 实现
// 🆕 2026-01-20: 工作区状态恢复
import { useWorkspaceRestore } from '../workspace/hooks';
import { AgentTaskPanel } from './AgentTaskPanel';
import { groupCache } from '../core/store/groupCache';
import { isStoreSubagentSession } from '../core/subagentSession';
// ★ 图谱模块已废弃 - GraphSelectDialog 已移除
// import { GraphSelectDialog } from '@/components/graph-manager/GraphSelectDialog';
// 🆕 工具审批卡片（文档 29 P1-3）- 已移至 InputBarV2 内部渲染

// ============================================================================
// Props 定义
// ============================================================================

// 空会话点击居中 Logo 展开的冲刺/复习卡片渲染器（桌面与移动统一，模块级常量保证 MessageList memo 稳定）
const renderEmptyTodayReviewHint = () => <TodayReviewHint embedded />;

export interface ChatContainerProps {
  /** 会话 ID */
  sessionId: string;
  /** 自定义类名 */
  className?: string;
  /** 空态中显示的当前分组名；未分组时不显示 */
  emptyStateGroupName?: string | null;
  /** 是否显示输入框 */
  showInputBar?: boolean;
  /** 🆕 2026-01-20: 点击 Worker Agent 查看输出的回调（用于切换到对应会话） */
  onViewAgentSession?: (agentSessionId: string) => void;
  /** 🆕 强制显示空态（用于空态预览） */
  forceEmptyPreview?: boolean;
}

// ============================================================================
// 组件实现
// ============================================================================

// 冷启动骨架屏。定义在组件外：若在 ChatContainer 内部定义，每次渲染都会生成
// 新的组件类型，导致骨架子树整体 remount、animate-pulse 动画反复重启
const ChatSkeleton: React.FC = () => (
  <ThreadContentShell
    data-slot="chat-loading-shell"
    className="flex h-full flex-col px-4 py-4 md:px-8"
  >
    <div className="flex h-full flex-col animate-pulse">
      {/* 模拟消息列表 */}
      <div data-slot="chat-loading-messages" className="flex-1 space-y-4">
        {/* 用户消息骨架 */}
        <div className="flex justify-end">
          <div className="h-16 w-2/3 rounded-lg bg-muted" />
        </div>
        {/* 助手消息骨架 */}
        <div className="flex justify-start gap-3">
          <div className="h-8 w-8 flex-shrink-0 rounded-full bg-muted" />
          <div className="flex-1 space-y-2">
            <div className="h-4 w-full rounded bg-muted" />
            <div className="h-4 w-3/4 rounded bg-muted" />
            <div className="h-4 w-1/2 rounded bg-muted" />
          </div>
        </div>
        {/* 用户消息骨架 */}
        <div className="flex justify-end">
          <div className="h-12 w-1/2 rounded-lg bg-muted" />
        </div>
        {/* 助手消息骨架 */}
        <div className="flex justify-start gap-3">
          <div className="h-8 w-8 flex-shrink-0 rounded-full bg-muted" />
          <div className="flex-1 space-y-2">
            <div className="h-4 w-full rounded bg-muted" />
            <div className="h-4 w-2/3 rounded bg-muted" />
          </div>
        </div>
      </div>
      {/* 输入框骨架 */}
      <div data-slot="chat-loading-composer" className="mt-4">
        <div className="chat-loading-shell__composer-panel rounded-[var(--radius-shell-toolbar)] border border-[color:var(--input-shell-border)] bg-[color:var(--shell-inspector-panel)] p-3 shadow-[var(--shadow-shell-soft)]">
          <div className="mb-3 flex items-center gap-2">
            <div className="h-8 w-8 rounded-full bg-muted" />
            <div className="h-8 w-24 rounded-full bg-muted" />
            <div className="h-8 w-8 rounded-full bg-muted" />
          </div>
          <div className="space-y-2">
            <div className="h-4 w-5/6 rounded bg-muted" />
            <div className="h-4 w-2/5 rounded bg-muted" />
          </div>
        </div>
      </div>
    </div>
  </ThreadContentShell>
);

/**
 * ChatContainer 主容器组件
 *
 * 功能：
 * 1. 通过 sessionId 获取/创建 Store
 * 2. 渲染模式插件提供的 Header（如果有）
 * 3. 渲染 MessageList
 * 4. 渲染 InputBar
 * 5. 渲染模式插件提供的 Footer（如果有）
 */
export const ChatContainer: React.FC<ChatContainerProps> = ({
  sessionId,
  className,
  emptyStateGroupName = null,
  showInputBar = true,
  onViewAgentSession,
  forceEmptyPreview = false,
}) => {
  const { t } = useTranslation(['chatV2', 'common']);
  const mobileLayout = useMobileLayoutSafe();
  // MobileLayoutProvider 缺失时回退到 useBreakpoint（订阅 resize，
  // 避免只读一次 window.innerWidth 导致空态布局分支在窗口变化后粘死）
  const { isSmallScreen } = useBreakpoint();
  const isMobile = mobileLayout?.isMobile ?? isSmallScreen;

  // ★ 文梣28清理：移除 currentSubject，记忆提取功能内部获取 subject

  // 🔧 严重修复：使用 useConnectedSession 获取 Store 并连接后端
  // 这确保了：
  // 1. Store 被正确创建/获取
  // 2. TauriAdapter 被设置并开始监听后端事件
  // 3. 发送消息、中断流式等操作能正常工作
  const {
    store: targetStore,
    isReady: adapterReady,
    error: adapterError,
  } = useConnectedSession(sessionId, { preload: true });

  const targetDataLoaded = useStore(targetStore, (s) => s.isDataLoaded);
  const targetCanRender = targetDataLoaded || adapterReady;

  // 切换至未加载会话时保留上一会话画面，避免空白等待（LRU 命中则 targetCanRender 为 true，不走此路径）
  const lastRenderableRef = useRef<{ sessionId: string; store: StoreApi<ChatStore> } | null>(null);
  if (targetCanRender) {
    lastRenderableRef.current = { sessionId, store: targetStore };
  }

  const isSwitchingToUnloaded =
    !targetCanRender
    && lastRenderableRef.current !== null
    && lastRenderableRef.current.sessionId !== sessionId;
  const isColdStart = !targetCanRender && lastRenderableRef.current === null;

  const store = targetCanRender
    ? targetStore
    : (lastRenderableRef.current?.store ?? targetStore);

  // 子代理会话只读：按当前展示的 store 判定。切换到未加载会话时仍展示旧
  // store，不能用目标 prop sessionId 提前隐藏其输入栏或错误显示只读提示。
  const displayedSessionId = useStore(store, (s) => s.sessionId);
  const displayedMode = useStore(store, (s) => s.mode);
  const displayedSessionMetadata = useStore(store, (s) => s.sessionMetadata);
  const isSubagentSession = isStoreSubagentSession({
    sessionId: displayedSessionId,
    mode: displayedMode,
    sessionMetadata: displayedSessionMetadata,
  });
  const effectiveShowInputBar = showInputBar && !isSubagentSession;

  const messageCount = useStore(store, (s) => s.messageOrder.length);
  const sessionGroupId = useStore(store, (s) => s.groupId);
  const resolvedEmptyStateGroupName = emptyStateGroupName ?? (
    sessionGroupId
      ? groupCache.get(sessionGroupId)?.name ?? null
      : null
  );

  // 仅冷启动（无任何可展示会话）时显示骨架屏；切换中保留旧画面
  const isActuallyLoading = isColdStart;

  // 会话切换轻入场：不 remount MessageList，仅重播包裹层 animation。
  // 以展示 store 为基准（而非 sessionId）：切到未缓存会话时旧画面继续显示，
  // 直到数据就绪 store 才切换——此刻才是新内容真正落地、应播入场的时机
  const threadShellRef = useRef<HTMLDivElement>(null);
  const prevDisplayStoreRef = useRef(store);
  useEffect(() => {
    if (prevDisplayStoreRef.current === store) return;
    prevDisplayStoreRef.current = store;
    const el = threadShellRef.current;
    if (!el) return;
    if (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return;
    }
    el.classList.remove('chat-thread-enter');
    void el.offsetHeight;
    el.classList.add('chat-thread-enter');
  }, [store]);

  // 🆕 阻塞交互请求（审批卡片）已移至 InputBarV2 内部订阅渲染，
  // 此处不再订阅 pendingBlockingInteraction，避免整个容器随之重渲染

  // 🔧 P1修复：使用响应式订阅获取模式，而非直接调用 getState()
  const mode = displayedMode;
  // 使用 getResolved 获取合并了继承链的完整插件
  const modePlugin = useMemo(() => modeRegistry.getResolved(mode), [mode]);

  // Header 组件
  const HeaderComponent = modePlugin?.renderHeader;

  // Footer 组件
  const FooterComponent = modePlugin?.renderFooter;

  // 🔧 TextbookContext 已废弃，教材功能通过 DSTU + Learning Hub 实现
  const textbookOpen = undefined;
  const onTextbookToggle = undefined;

  // 🔧 多变体支持：获取可用模型列表
  const { models: availableModels } = useAvailableModels();

  // 🆕 2026-01-20: 工作区状态恢复（刷新页面后自动恢复）
  useWorkspaceRestore({ currentSessionId: sessionId, enabled: true });

  const shouldUseEmptyComposerLayout = effectiveShowInputBar && (forceEmptyPreview || messageCount === 0);
  const shouldUseDesktopEmptyComposerLayout = shouldUseEmptyComposerLayout && !isMobile;
  // 移动端进入空会话时不强弹键盘，避免软键盘压住欢迎态与今日复习入口
  const shouldAutoFocusMobileEmptyComposer = false;

  // 跨学习页跳 AI 时的「返回刚才的学习」胶囊状态
  const handoffReturnView = useSyncExternalStore(
    subscribeChatHandoffReturnView,
    getChatHandoffReturnView,
    () => null,
  );
  const currentView = useViewStore((s) => s.currentView);
  const previousView = useViewStore((s) => s.previousView);
  useEffect(() => {
    if (handoffReturnView && previousView === 'chat-v2' && currentView !== 'chat-v2') {
      clearChatHandoffReturnView();
    }
  }, [handoffReturnView, previousView, currentView]);

  const handoffReturnViewLabel = useMemo(() => {
    const viewLabels: Partial<Record<CurrentView, string>> = {
      'learning-hub': t('chatV2:handoffReturn.views.learningHub', { defaultValue: '学习资源' }),
      'pdf-reader': t('chatV2:handoffReturn.views.pdfReader', { defaultValue: 'PDF 阅读' }),
      flashcards: t('chatV2:handoffReturn.views.flashcards', { defaultValue: '闪卡复习' }),
      media: t('chatV2:handoffReturn.views.media', { defaultValue: '音视频学习' }),
      todo: t('chatV2:handoffReturn.views.todo', { defaultValue: '待办' }),
      'task-dashboard': t('chatV2:handoffReturn.views.taskDashboard', { defaultValue: '制卡任务台' }),
      dashboard: t('chatV2:handoffReturn.views.dashboard', { defaultValue: '学习概览' }),
    };
    return handoffReturnView ? viewLabels[handoffReturnView] ?? null : null;
  }, [handoffReturnView, t]);

  const handleReturnToOriginView = useCallback(() => {
    if (!handoffReturnView) return;
    const targetView = handoffReturnView;
    clearChatHandoffReturnView();
    dispatchAppEvent(APP_EVENTS.NAVIGATE_TO_VIEW, { view: targetView });
  }, [handoffReturnView]);

  // 桌面与移动端空会话统一：订阅今日冲刺/待复习卡片可用性；默认隐藏卡片，仅在居中 Logo 角标提示并由点击切换
  const reviewHintAvailability = useTodayReviewHintAvailability(shouldUseEmptyComposerLayout);

  // 🆕 Canvas 上下文引用管理 - 白板功能已移除
  // useCanvasContextRef({ store });

  // 🚀 性能优化：不再等待 adapterReady
  // 只要 store 存在，就可以渲染消息列表和输入框
  // adapter 未就绪时，只是无法发送消息，但可以查看历史记录
  if (isActuallyLoading) {
    return (
      <div className={cn('flex flex-col h-full chat-loading-shell-defer', className)}>
        <ChatSkeleton />
      </div>
    );
  }

  // 适配器初始化错误 —— 与错误边界 fallback 共用同一套错误视觉（ErrorFallback）
  if (adapterError) {
    return (
      <div className={cn('flex flex-col h-full', className)}>
        <ErrorFallback
          title={t('error.loadFailed')}
          error={adapterError}
        />
      </div>
    );
  }

  const renderMessageList = ({
    className: messageListSlotClassName,
    compact = false,
  }: {
    className?: string;
    compact?: boolean;
  } = {}) => (
    // 不按 sessionId remount：MessageList 内部随 store 切换重置；入场动画由 threadShellRef 重播
    <div
      ref={threadShellRef}
      className={cn(
        'chat-thread-enter relative',
        compact ? 'relative overflow-visible' : 'min-h-0 flex-1 overflow-hidden relative',
        messageListSlotClassName,
        isSwitchingToUnloaded && 'pointer-events-none'
      )}
    >
      {isSwitchingToUnloaded ? (
        // 纯色蒙层（不用 backdrop-blur：大面积 backdrop-filter 在弱机上掉帧）
        <div
          aria-hidden
          className="absolute inset-0 z-20 bg-[color:var(--shell-workspace-panel)]/60"
        />
      ) : null}
      <MessageList
        store={store}
        emptyStateGroupName={resolvedEmptyStateGroupName}
        forceEmptyPreview={forceEmptyPreview}
        emptyStateCardAvailable={shouldUseEmptyComposerLayout && reviewHintAvailability.hasContent}
        emptyStateCardAccent={reviewHintAvailability.hasDueItems}
        emptyStateCardResetKey={displayedSessionId}
        renderEmptyStateCard={shouldUseEmptyComposerLayout ? renderEmptyTodayReviewHint : undefined}
      />
    </div>
  );

  const renderFooter = (className?: string) => FooterComponent ? (
    <div className={cn('flex-shrink-0 border-t border-border', className)}>
      <FooterComponent store={store} />
    </div>
  ) : null;

  const renderInputBar = (
    className?: string,
    motionState: 'empty' | 'docked' = 'docked',
    autoFocusOnMount = false
  ) => effectiveShowInputBar ? (
    <div
      className={cn(
        'chat-composer-motion-frame',
        motionState === 'empty'
          ? 'chat-composer-motion-frame--empty'
          : 'chat-composer-motion-frame--docked',
        isSwitchingToUnloaded && 'pointer-events-none opacity-50'
      )}
    >
      <div className="w-full">
        <InputBarV2
          store={targetCanRender ? targetStore : store}
          textbookOpen={textbookOpen}
          onTextbookToggle={onTextbookToggle}
          availableModels={availableModels}
          className={className}
          autoFocus={autoFocusOnMount}
        />
      </div>
    </div>
  ) : isSubagentSession && showInputBar ? (
    // 子代理会话打开为整页时：以只读提示替代输入栏
    <div className="flex-shrink-0 px-4 py-2 text-center">
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground/60 select-none">
        <Info size={12} className="h-3 w-3" />
        {t('chatV2:subagentSession.readOnlyNotice')}
      </span>
    </div>
  ) : null;

  return (
    // resetKey：切换会话自动走出错误态并 remount 子树；重试逻辑内建于边界（mountCycle remount）
    <ChatErrorBoundary resetKey={sessionId}>
    <div
      className={cn(
        'chat-v2',
        'flex flex-col h-full min-h-0',
        'bg-[color:var(--shell-workspace-panel)]',
        'relative',
        'overflow-hidden',
        className
      )}
    >
      {/* 模式插件 Header */}
      {HeaderComponent && (
        <div className="flex-shrink-0 border-b border-border">
          <HeaderComponent store={store} />
        </div>
      )}

      {/* 跨学习页跳 AI 后的「返回原学习现场」轻量胶囊 */}
      {handoffReturnView && (
        <div
          data-slot="chat-handoff-return-bar"
          className="flex-shrink-0 px-4 pt-2 md:px-8"
        >
          <ThreadContentShell className="flex items-center">
            <div className="inline-flex max-w-full items-center gap-0.5 rounded-full border border-border/60 bg-background/90 p-0.5 shadow-sm backdrop-blur-sm">
              <button
                type="button"
                onClick={handleReturnToOriginView}
                className="inline-flex min-h-8 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium text-foreground/90 transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:px-3"
              >
                <ArrowLeft size={14} weight="bold" aria-hidden="true" className="shrink-0 text-primary" />
                <span className="truncate">
                  {handoffReturnViewLabel
                    ? t('chatV2:handoffReturn.buttonWithView', {
                        defaultValue: '返回刚才的学习（{{view}}）',
                        view: handoffReturnViewLabel,
                      })
                    : t('chatV2:handoffReturn.button', { defaultValue: '返回刚才的学习' })}
                </span>
              </button>
              <button
                type="button"
                onClick={clearChatHandoffReturnView}
                aria-label={t('common:close', { defaultValue: '关闭' })}
                title={t('common:close', { defaultValue: '关闭' })}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
              >
                <X size={13} aria-hidden="true" />
              </button>
            </div>
          </ThreadContentShell>
        </div>
      )}

      {shouldUseDesktopEmptyComposerLayout ? (
        <div className="chat-empty-composer-layout">
          <ThreadContentShell className="chat-empty-composer-layout__stack px-4 md:px-8">
            {renderMessageList({
              className: 'chat-empty-composer-layout__message-list',
              compact: true,
            })}
            {renderFooter('chat-empty-composer-layout__footer')}
            {/* Super 会话：自动投递暂停提示条（非 Super / 未暂停时不渲染） */}
            <SuperInboxPausedBanner sessionId={displayedSessionId} />
            <AgentTaskPanel store={store} chatStore={store} />
            {renderInputBar('chat-empty-composer-layout__input', 'empty')}
          </ThreadContentShell>
        </div>
      ) : (
        <>
          {/* 消息列表 - 与输入框布局完全分离；切换会话不 remount，由 MessageList 随 store 更新 */}
          {renderMessageList()}

          {/* 模式插件 Footer */}
          {renderFooter()}

          {/* 🆕 工具审批卡片已移至 InputBarV2 内部，作为浮动面板渲染，避免遮挡问题 */}

          {/* Super 会话：自动投递暂停提示条（非 Super / 未暂停时不渲染） */}
          <SuperInboxPausedBanner sessionId={displayedSessionId} />

          {/* Agent todo panel — 贴在输入栏上方 */}
          <AgentTaskPanel store={store} chatStore={store} />

          {/* 输入栏 */}
          {renderInputBar(undefined, 'docked', shouldAutoFocusMobileEmptyComposer)}
        </>
      )}

    </div>
    </ChatErrorBoundary>
  );
};

export default ChatContainer;
