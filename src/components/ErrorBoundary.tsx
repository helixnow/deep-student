import React from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import i18n from '@/i18n';

type ErrorBoundaryProps = {
  name?: string;
  fallback?: React.ReactNode | ((error: any, componentStack?: string) => React.ReactNode);
  onError?: (error: any, info: any) => void;
  children: React.ReactNode;
};

type ErrorBoundaryState = { hasError: boolean; error?: any; componentStack?: string };

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: any) {
    return { hasError: true, error };
  }

  componentDidCatch(error: any, info: any) {
    try {
      this.setState({ componentStack: info?.componentStack ?? undefined });
    } catch {}
    try {
      // Reuse existing debug bus if available
      (window as any)?.emitDebug?.({ channel: 'error', eventName: 'error_boundary', payload: { name: this.props.name, error: String(error), info } });
    } catch {}
    try { this.props.onError?.(error, info); } catch {}
  }

  render() {
    if (this.state.hasError) {
      if (typeof this.props.fallback === 'function') {
        return this.props.fallback(this.state.error, this.state.componentStack);
      }
      return this.props.fallback ?? (
        <div className="flex flex-col items-center justify-center p-8 text-center">
          <div className="text-destructive text-lg mb-2">⚠️</div>
          <p className="text-sm text-muted-foreground mb-3">
            {i18n.t('common:errorBoundary.title', 'Something went wrong')}
          </p>
          <NotionButton variant="primary" size="sm" onClick={() => this.setState({ hasError: false })} className="text-xs !px-3 !py-1.5 bg-primary text-primary-foreground hover:opacity-90">
            {i18n.t('common:errorBoundary.retry', 'Try again')}
          </NotionButton>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;

