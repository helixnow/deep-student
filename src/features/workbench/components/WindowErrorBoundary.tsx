/**
 * WindowErrorBoundary（P3 / O9）— 单窗崩溃隔离。
 *
 * 某个应用窗口内容抛错时，只有该窗口显示重载卡片，桌面其余窗口不受影响。
 * 「重新加载」通过递增内部 resetKey 强制重建子树。
 * O9：崩溃卡升级为玻璃材质 + 图标 + 错误摘要，与整体设计语言一致。
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowClockwise, WarningCircle } from '@phosphor-icons/react';
import i18n from 'i18next';
import { appRegistry } from '../core/appRegistry';
import { useWindowStore } from '../core/windowStore';
import { announceWorkbench } from '../hooks/useWorkbenchA11y';
import './WindowLifecycle.css';

interface WindowErrorBoundaryProps {
  windowId?: string;
  /** 子树重建前的额外清理钩子（可选） */
  onReset?: () => void;
  children: React.ReactNode;
}

interface WindowErrorBoundaryState {
  error: Error | null;
  resetKey: number;
}

const CrashCard: React.FC<{ error: Error; onReload: () => void }> = ({ error, onReload }) => {
  const { t } = useTranslation('workbench');
  return (
    <div role="alert" className="wb-body-crash" data-wb-crash-card>
      <div className="wb-body-crash-card wb-glass wb-glass-highlight">
        <span className="wb-body-crash-icon" aria-hidden>
          <WarningCircle size={40} weight="duotone" />
        </span>
        <div className="wb-body-crash-title">
          {t('workbench:window.crashTitle')}
        </div>
        <div className="wb-body-crash-summary">
          {error.message || t('workbench:window.crashUnknown')}
        </div>
        <button
          type="button"
          onClick={onReload}
          className="wb-body-crash-reload"
        >
          <ArrowClockwise size={14} aria-hidden />
          {t('workbench:window.reload')}
        </button>
      </div>
    </div>
  );
};

export class WindowErrorBoundary extends React.Component<
  WindowErrorBoundaryProps,
  WindowErrorBoundaryState
> {
  state: WindowErrorBoundaryState = { error: null, resetKey: 0 };

  static getDerivedStateFromError(error: Error): Partial<WindowErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error(
      `[workbench] window ${this.props.windowId ?? '?'} app crashed:`,
      error,
      info.componentStack,
    );
    const windowId = this.props.windowId;
    let name = '';
    if (windowId) {
      const win = useWindowStore.getState().windows[windowId];
      const def = win ? appRegistry.get(win.typeId) : undefined;
      name =
        win?.title ||
        (def ? i18n.t(def.nameKey) : '') ||
        windowId;
    }
    announceWorkbench(
      i18n.t('workbench:a11y.appCrashed', { name: name || 'App' }),
      'assertive',
    );
  }

  private handleReload = (): void => {
    this.props.onReset?.();
    this.setState((s) => ({ error: null, resetKey: s.resetKey + 1 }));
  };

  render(): React.ReactNode {
    if (this.state.error) {
      return <CrashCard error={this.state.error} onReload={this.handleReload} />;
    }
    return <React.Fragment key={this.state.resetKey}>{this.props.children}</React.Fragment>;
  }
}

export default WindowErrorBoundary;
