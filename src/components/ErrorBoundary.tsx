import React from 'react';
import i18n from '@/i18n';

type ErrorBoundaryProps = {
  name?: string;
  fallback?: React.ReactNode;
  onError?: (error: any, info: any) => void;
  children: React.ReactNode;
};

type ErrorBoundaryState = { hasError: boolean; error?: any };

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
      // Reuse existing debug bus if available
      (window as any)?.emitDebug?.({ channel: 'error', eventName: 'error_boundary', payload: { name: this.props.name, error: String(error), info } });
    } catch {}
    try { this.props.onError?.(error, info); } catch {}
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? (
        <div className="flex flex-col items-center justify-center p-8 text-center">
          <div className="text-destructive text-lg mb-2">⚠️</div>
          <p className="text-sm text-muted-foreground mb-3">
            {i18n.t('common:errorBoundary.title', 'Something went wrong')}
          </p>
          <button
            onClick={() => this.setState({ hasError: false })}
            className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground hover:opacity-90"
          >
            {i18n.t('common:errorBoundary.retry', 'Try again')}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;

