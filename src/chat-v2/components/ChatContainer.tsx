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

import React, { useMemo, useCallback, useState, useEffect, useRef } from 'react';
import { useStore } from 'zustand';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '@/utils/cn';
import { MessageList } from './MessageList';
import { InputBarV2 } from './input-bar';
import { ChatErrorBoundary } from './ChatErrorBoundary';
// 🔧 严重修复：使用 useConnectedSession 确保后端连接
import { useConnectedSession } from '../hooks/useConnectedSession';
import { useSessionStatus } from '../hooks/useChatStore';
// 🔧 多变体支持：获取可用模型列表
import { useAvailableModels } from '../hooks/useAvailableModels';
// 🆕 Canvas 上下文引用管理 - 白板功能已移除
import { modeRegistry } from '../registry';
// 🗑️ Anki 面板已从 Chat V2 移除
// 🔧 TextbookContext 已废弃，教材功能通过 DSTU + Learning Hub 实现
// 🆕 工作区状态恢复
import { useWorkspaceStore } from '../workspace/workspaceStore';
// 🆕 2026-01-20: 工作区状态恢复
import { useWorkspaceRestore } from '../workspace/hooks';
// ★ 图谱模块已废弃 - GraphSelectDialog 已移除
// import { GraphSelectDialog } from '@/components/graph-manager/GraphSelectDialog';
// 🆕 工具审批卡片（文档 29 P1-3）- 已移至 InputBarV2 内部渲染
// 🆕 AI 内容免责提示（合规）
import { Info } from 'lucide-react';

// ============================================================================
// Props 定义
// ============================================================================

export interface ChatContainerProps {
  /** 会话 ID */
  sessionId: string;
  /** 自定义类名 */
  className?: string;
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
  showInputBar = true,
  onViewAgentSession,
  forceEmptyPreview = false,
}) => {
  const { t } = useTranslation(['chatV2', 'common']);

  // ★ 文梣28清理：移除 currentSubject，记忆提取功能内部获取 subject

  // 🔧 严重修复：使用 useConnectedSession 获取 Store 并连接后端
  // 这确保了：
  // 1. Store 被正确创建/获取
  // 2. TauriAdapter 被设置并开始监听后端事件
  // 3. 发送消息、中断流式等操作能正常工作
  const {
    store,
    isReady: adapterReady,
    error: adapterError,
  } = useConnectedSession(sessionId, { preload: true });

  // 获取会话状态
  const sessionStatus = useSessionStatus(store);
  
  // 🚀 性能优化：直接从 Store 读取 isDataLoaded
  // 即使 adapter 未就绪，只要数据已加载就可以渲染消息列表
  const isDataLoaded = useStore(store, (s) => s.isDataLoaded);

  // 🚀 防闪动优化：只有加载超过 500ms 才显示骨架屏
  const isActuallyLoading = !isDataLoaded && !adapterReady;
  const [showSkeleton, setShowSkeleton] = useState(false);
  
  useEffect(() => {
    if (isActuallyLoading) {
      // 加载开始，延迟 500ms 后显示骨架屏
      const timer = setTimeout(() => {
        setShowSkeleton(true);
      }, 500);
      return () => clearTimeout(timer);
    } else {
      // 加载完成，立即隐藏骨架屏
      setShowSkeleton(false);
    }
  }, [isActuallyLoading]);

  // 🆕 工具审批请求（文档 29 P1-3）
  const pendingApprovalRequest = useStore(store, (s) => s.pendingApprovalRequest);

  // 🔧 P1修复：使用响应式订阅获取模式，而非直接调用 getState()
  const mode = useStore(store, (s) => s.mode);
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

  // 🆕 Canvas 上下文引用管理 - 白板功能已移除
  // useCanvasContextRef({ store });


  // 创建骨架屏组件
  const ChatSkeleton = () => (
    <div className="flex flex-col h-full p-4 animate-pulse">
      {/* 模拟消息列表 */}
      <div className="flex-1 space-y-4">
        {/* 用户消息骨架 */}
        <div className="flex justify-end">
          <div className="w-2/3 h-16 bg-muted rounded-lg" />
        </div>
        {/* 助手消息骨架 */}
        <div className="flex justify-start gap-3">
          <div className="w-8 h-8 bg-muted rounded-full flex-shrink-0" />
          <div className="flex-1 space-y-2">
            <div className="w-full h-4 bg-muted rounded" />
            <div className="w-3/4 h-4 bg-muted rounded" />
            <div className="w-1/2 h-4 bg-muted rounded" />
          </div>
        </div>
        {/* 用户消息骨架 */}
        <div className="flex justify-end">
          <div className="w-1/2 h-12 bg-muted rounded-lg" />
        </div>
        {/* 助手消息骨架 */}
        <div className="flex justify-start gap-3">
          <div className="w-8 h-8 bg-muted rounded-full flex-shrink-0" />
          <div className="flex-1 space-y-2">
            <div className="w-full h-4 bg-muted rounded" />
            <div className="w-2/3 h-4 bg-muted rounded" />
          </div>
        </div>
      </div>
      {/* 输入框骨架 */}
      <div className="mt-4 h-24 bg-muted rounded-2xl" />
    </div>
  );

  // 🚀 性能优化：不再等待 adapterReady
  // 只要 store 存在，就可以渲染消息列表和输入框
  // adapter 未就绪时，只是无法发送消息，但可以查看历史记录
  //
  // 🚀 防闪动优化：只有加载超过 500ms 才显示骨架屏
  // 如果加载很快（< 500ms），不显示任何加载指示器，避免闪动
  if (isActuallyLoading && showSkeleton) {
    return (
      <div className={cn('flex flex-col h-full', className)}>
        <ChatSkeleton />
      </div>
    );
  }
  
  // 加载中但未超过 500ms，显示空白而非骨架屏
  if (isActuallyLoading) {
    return (
      <div className={cn('flex flex-col h-full', className)} />
    );
  }

  // 适配器初始化错误
  if (adapterError) {
    return (
      <div className={cn(
        'flex flex-col items-center justify-center h-full p-4',
        'text-center',
        className
      )}>
        <div className="text-destructive mb-4">
          <svg
            className="w-12 h-12 mx-auto mb-2"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
          <p className="text-sm font-medium">{t('error.loadFailed')}</p>
          <p className="text-xs text-muted-foreground mt-1">
            {adapterError}
          </p>
        </div>
      </div>
    );
  }

  return (
    <ChatErrorBoundary>
    <div
      className={cn(
        'chat-v2',
        'flex flex-col h-full',
        'bg-background',
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

      {/* 消息列表 - 与输入框布局完全分离 */}
      {/* 🚀 性能优化：使用 key={sessionId} 强制重新挂载组件 */}
      <div className="flex-1 overflow-hidden relative">
        <MessageList key={sessionId} store={store} forceEmptyPreview={forceEmptyPreview} />
        {/* 🎨 底部渐变过渡：平滑边缘效果 */}
        <div 
          className="pointer-events-none absolute left-0 right-0 bottom-0 z-10 h-6"
          style={{
            background: 'linear-gradient(to bottom, transparent 0%, hsl(var(--background)) 100%)',
          }}
        />
      </div>

      {/* 模式插件 Footer */}
      {FooterComponent && (
        <div className="flex-shrink-0 border-t border-border">
          <FooterComponent store={store} />
        </div>
      )}

      {/* 🆕 工具审批卡片已移至 InputBarV2 内部，作为浮动面板渲染，避免遮挡问题 */}

      {/* AI 内容免责提示（合规要求） */}
      {showInputBar && (
        <div className="text-center px-4 py-1">
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/50 select-none">
            <Info className="h-3 w-3" />
            {t('common:aiDisclaimer.chatHint')}
          </span>
        </div>
      )}

      {/* 输入栏 */}
      {showInputBar && (
        <InputBarV2
          store={store}
          textbookOpen={textbookOpen}
          onTextbookToggle={onTextbookToggle}
          availableModels={availableModels}
        />
      )}

      {/* 🗑️ Anki 面板已从 Chat V2 移除 */}

      {/* 记忆提取对话框 */}
      {(
        <>
          {/* ★ 图谱模块已废弃 - GraphSelectDialog 已移除 */}
        </>
      )}
    </div>
    </ChatErrorBoundary>
  );
};

export default ChatContainer;
