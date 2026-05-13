/**
 * 思维导图错误边界组件
 * 
 * 捕获子组件渲染错误，防止整个应用崩溃
 */

import React from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
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
      return (
        <div className="flex flex-col items-center justify-center h-full gap-4 p-8 bg-[var(--mm-bg)]">
          <AlertCircle className="w-12 h-12 text-destructive" />
          <p className="text-destructive font-medium">
            {this.props.fallbackMessage || i18next.t('mindmap:errorBoundary')}
          </p>
          {this.state.error && (
            <p className="text-sm text-muted-foreground max-w-md text-center">
              {this.state.error.message}
            </p>
          )}
          <NotionButton
            variant="default"
            onClick={this.handleReset}
            className="mt-2"
          >
            <RefreshCw className="w-4 h-4 mr-2" />
            {i18next.t('mindmap:retryLoad')}
          </NotionButton>
          {import.meta.env.DEV && this.state.errorInfo && (
            <details className="mt-4 text-xs text-muted-foreground max-w-lg">
              <summary className="cursor-pointer">{i18next.t('mindmap:errorDetails')}</summary>
              <pre className="mt-2 p-2 bg-muted rounded overflow-auto max-h-40">
                {this.state.errorInfo.componentStack}
              </pre>
            </details>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}
