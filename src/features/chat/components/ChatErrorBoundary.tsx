import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Warning, ArrowClockwise } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { reportFrontendError } from '@/logging/errorReporter';

interface ChatErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  /**
   * 额外的重试回调（如重新拉取会话数据）。
   * 无论是否传入，重试都会强制 remount 子树（见 handleRetry），
   * 保证「重试」不是只清 state 的空操作。
   */
  onRetry?: () => void;
  /**
   * 复位键（通常传 sessionId）：值变化且当前处于错误态时自动清除错误并
   * remount 子树——切换会话即可离开错误页，无需用户手动操作。
   * 不直接给边界加 key：那会在每次会话切换时 remount 整个子树，
   * 破坏 ChatContainer「切会话不 remount MessageList」的性能设计。
   */
  resetKey?: unknown;
  className?: string;
}

interface ChatErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  retryCount: number;
  /** 子树 remount 计数：作为 children 包裹层的 key，每次重试自增强制重建 */
  mountCycle: number;
}

interface ErrorFallbackProps {
  /** Error 对象或纯文本错误信息（适配器错误只有 string） */
  error?: Error | string | null;
  /** 标题；缺省为「聊天组件出现错误」 */
  title?: ReactNode;
  onRetry?: () => void;
  /** 重试按钮文案；缺省为「重试」 */
  retryLabel?: ReactNode;
  className?: string;
}

/**
 * Chat V2 统一错误态视觉：Warning 图标 + 标题 + 描述 + 可选重试按钮。
 * 错误边界 fallback 与适配器初始化错误共用这一套（消除双套错误 UI）。
 */
const ErrorFallback: React.FC<ErrorFallbackProps> = ({ error, title, onRetry, retryLabel, className }) => {
  const { t } = useTranslation('chatV2');
  const errorMessage = typeof error === 'string' ? error : error?.message;
  const errorStack = typeof error === 'string' ? null : error?.stack;
  return (
    <div className={cn(
      'flex flex-col items-center justify-center h-full min-h-[200px] p-6 text-center',
      className
    )}>
      <Warning size={48} className="text-destructive mb-4" />
      <h3 className="text-lg font-semibold text-foreground mb-2">
        {title ?? t('errorBoundary.chatComponentError')}
      </h3>
      <p className="text-sm text-muted-foreground mb-4 max-w-md">
        {errorMessage || t('errorBoundary.unknownErrorRefresh')}
      </p>
      {onRetry && (
        <DsButton variant="primary" size="sm" onClick={onRetry} className="bg-primary text-primary-foreground hover:bg-primary/90 [@media(pointer:coarse)]:!min-h-11">
          <ArrowClockwise size={16} />
          {retryLabel ?? t('errorBoundary.retry')}
        </DsButton>
      )}
      {import.meta.env.DEV && errorStack && (
        <details className="mt-4 text-left w-full max-w-lg">
          <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground [@media(pointer:coarse)]:min-h-11">
            {t('errorBoundary.viewErrorDetails')}
          </summary>
          <CustomScrollArea orientation="both" fullHeight={false} className="mt-2 max-h-40 rounded-md bg-muted" viewportClassName="max-h-40">
            <pre className="p-3 text-xs">{errorStack}</pre>
          </CustomScrollArea>
        </details>
      )}
    </div>
  );
};

export class ChatErrorBoundary extends Component<ChatErrorBoundaryProps, ChatErrorBoundaryState> {
  private static readonly MAX_RETRIES = 3;

  constructor(props: ChatErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, retryCount: 0, mountCycle: 0 };
  }

  static getDerivedStateFromError(error: Error): Partial<ChatErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('[ChatErrorBoundary] Caught error:', error, errorInfo);
    void reportFrontendError(error, {
      kind: 'REACT_ERROR_BOUNDARY',
      component: 'chat-v2',
      extra: { componentStack: errorInfo.componentStack },
    }).catch(() => undefined);
    this.props.onError?.(error, errorInfo);
  }

  componentDidUpdate(prevProps: ChatErrorBoundaryProps): void {
    // resetKey（如 sessionId）变化时自动走出错误态：换会话 = 全新子树
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState((prev) => ({
        hasError: false,
        error: null,
        retryCount: 0,
        mountCycle: prev.mountCycle + 1,
      }));
    }
  }

  handleRetry = (): void => {
    if (this.state.retryCount >= ChatErrorBoundary.MAX_RETRIES) {
      return;
    }
    // mountCycle 自增 → children 包裹层 key 变化 → 子树真正 remount，
    // 让崩溃组件从干净的初始状态重建（而非仅清本地 state 后原地再崩）
    this.setState((prev) => ({
      hasError: false,
      error: null,
      retryCount: prev.retryCount + 1,
      mountCycle: prev.mountCycle + 1,
    }));
    this.props.onRetry?.();
  };

  /** 达到重试上限后的兜底：清零计数并强制 remount，避免用户卡死在错误页 */
  handleHardReload = (): void => {
    this.setState((prev) => ({
      hasError: false,
      error: null,
      retryCount: 0,
      mountCycle: prev.mountCycle + 1,
    }));
    this.props.onRetry?.();
  };

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }
      const canRetry = this.state.retryCount < ChatErrorBoundary.MAX_RETRIES;
      return (
        <ChatErrorBoundaryFallback
          error={this.state.error}
          canRetry={canRetry}
          onRetry={canRetry ? this.handleRetry : this.handleHardReload}
          className={this.props.className}
        />
      );
    }

    return (
      <React.Fragment key={this.state.mountCycle}>
        {this.props.children}
      </React.Fragment>
    );
  }
}

/** 边界内部 fallback：重试次数耗尽后按钮切换为「重新加载会话」而非消失 */
const ChatErrorBoundaryFallback: React.FC<{
  error: Error | null;
  canRetry: boolean;
  onRetry: () => void;
  className?: string;
}> = ({ error, canRetry, onRetry, className }) => {
  const { t } = useTranslation('chatV2');
  return (
    <ErrorFallback
      error={error}
      onRetry={onRetry}
      retryLabel={canRetry ? t('errorBoundary.retry') : t('errorBoundary.reloadSession')}
      className={className}
    />
  );
};

export { ErrorFallback };
export type { ChatErrorBoundaryProps, ErrorFallbackProps };
