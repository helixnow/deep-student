/**
 * 思维导图错误边界组件
 * 
 * 捕获子组件渲染错误，防止整个应用崩溃
 */

import React from 'react';
import { WarningCircle, ArrowClockwise } from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
import i18next from 'i18next';

interface MindMapErrorBoundaryProps {
  children: React.ReactNode;
  onReset?: () => void;
  fallbackMessage?: string;
}

interface MindMapErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
}

export class MindMapErrorBoundary extends React.Component<
  MindMapErrorBoundaryProps,
  MindMapErrorBoundaryState
> {
  constructor(props: MindMapErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<MindMapErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    this.setState({ errorInfo });
    console.error('[MindMapErrorBoundary] Caught error:', error, errorInfo);
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: null, errorInfo: null });
    this.props.onReset?.();
  };

  render(): React.ReactNode {
    if (this.state.hasError) {
      // 视觉对齐加载错误卡：8px 圆角卡片 + --notes-popover-shadow，避免两处错误态样式漂移
      return (
        <div className="flex items-center justify-center h-full p-6 bg-[var(--mm-bg)]" role="alert">
          <div className="max-w-md w-full flex flex-col items-center gap-3 rounded-lg border border-[var(--mm-border)] bg-[var(--mm-bg-elevated)] p-5 text-center shadow-[var(--notes-popover-shadow)]">
            <WarningCircle size={32} className="text-destructive" />
            <p className="text-sm text-destructive font-medium">
              {this.props.fallbackMessage || i18next.t('mindmap:errorBoundary')}
            </p>
            {this.state.error && (
              <p className="text-xs text-muted-foreground break-words">
                {this.state.error.message}
              </p>
            )}
            <NotionButton
              variant="default"
              onClick={this.handleReset}
              className="mt-1"
            >
              <ArrowClockwise size={16} className="mr-2" />
              {i18next.t('mindmap:retryLoad')}
            </NotionButton>
            {import.meta.env.DEV && this.state.errorInfo && (
              <details className="mt-2 w-full text-xs text-muted-foreground text-left">
                <summary className="cursor-pointer">{i18next.t('mindmap:errorDetails')}</summary>
                <pre className="mt-2 p-2 bg-muted rounded overflow-auto max-h-40">
                  {this.state.errorInfo.componentStack}
                </pre>
              </details>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
