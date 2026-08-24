/**
 * WindowErrorBoundary（P3 / O9）— 单窗崩溃隔离。
 *
 * 某个应用窗口内容抛错时，只有该窗口显示重载卡片，桌面其余窗口不受影响。
 * 「重新加载」通过递增内部 resetKey 强制重建子树。
 * O9：崩溃卡升级为玻璃材质 + 图标 + 错误摘要，与整体设计语言一致。
 *
 * 连续崩溃冷却（2026-08）：挂载即崩的应用会形成「崩溃 → 重载 → 立即再崩」
 * 循环（用户连点或肌肉记忆连按 Enter），每轮循环都全量重建子树 + 上报错误。
 * 30s 内连续崩溃达 3 次后，重载按钮进入 5s 冷却（禁用 + 秒数倒计时 +
 * 循环提示文案），到点自动恢复。冷却只影响按钮，不吞错误上报。
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowClockwise, WarningCircle } from '@phosphor-icons/react';
import i18n from 'i18next';
import { appRegistry } from '../core/appRegistry';
import { useWindowStore } from '../core/windowStore';
import { announceWorkbench } from '../hooks/useWorkbenchA11y';
import { reportFrontendError } from '@/logging/errorReporter';
import './WindowLifecycle.css';

/** 距上次崩溃不超过该间隔视为「连续崩溃」（计入连击数） */
export const CRASH_LOOP_WINDOW_MS = 30_000;
/** 连续崩溃达到该次数后重载按钮进入冷却 */
export const CRASH_LOOP_THRESHOLD = 3;
/** 重载按钮冷却时长 */
export const CRASH_COOLDOWN_MS = 5_000;

interface WindowErrorBoundaryProps {
  windowId?: string;
  /** 子树重建前的额外清理钩子（可选） */
  onReset?: () => void;
  children: React.ReactNode;
}

interface WindowErrorBoundaryState {
  error: Error | null;
  resetKey: number;
  /** 非 0 = 重载按钮冷却截止时间戳（连续崩溃保护） */
  cooldownUntil: number;
}

const CrashCard: React.FC<{
  error: Error;
  onReload: () => void;
  cooldownUntil: number;
}> = ({ error, onReload, cooldownUntil }) => {
  const { t } = useTranslation('workbench');
  const [nowMs, setNowMs] = React.useState(() => Date.now());

  // 冷却期内每 500ms 刷新一次倒计时；到点后停表（依赖 cooldownUntil 重启）
  React.useEffect(() => {
    if (cooldownUntil <= Date.now()) return undefined;
    setNowMs(Date.now());
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNowMs(current);
      if (current >= cooldownUntil) window.clearInterval(timer);
    }, 500);
    return () => window.clearInterval(timer);
  }, [cooldownUntil]);

  const remainingMs = Math.max(0, cooldownUntil - nowMs);
  const coolingDown = remainingMs > 0;
  const remainingSeconds = Math.max(1, Math.ceil(remainingMs / 1000));

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
        {coolingDown && (
          <div className="wb-body-crash-loop-hint" data-wb-crash-cooldown>
            {t('workbench:window.crashLoopHint')}
          </div>
        )}
        <button
          type="button"
          onClick={onReload}
          disabled={coolingDown}
          className="wb-body-crash-reload"
        >
          <ArrowClockwise size={14} aria-hidden />
          {coolingDown
            ? t('workbench:window.reloadCooldown', { seconds: remainingSeconds })
            : t('workbench:window.reload')}
        </button>
      </div>
    </div>
  );
};

export class WindowErrorBoundary extends React.Component<
  WindowErrorBoundaryProps,
  WindowErrorBoundaryState
> {
  state: WindowErrorBoundaryState = { error: null, resetKey: 0, cooldownUntil: 0 };

  /** 最近一次崩溃时间戳（实例字段：不需要触发渲染） */
  private lastCrashAt = 0;

  /** 30s 窗口内的连续崩溃计数 */
  private crashStreak = 0;

  static getDerivedStateFromError(error: Error): Partial<WindowErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    const nowMs = Date.now();
    this.crashStreak =
      nowMs - this.lastCrashAt <= CRASH_LOOP_WINDOW_MS ? this.crashStreak + 1 : 1;
    this.lastCrashAt = nowMs;
    if (this.crashStreak >= CRASH_LOOP_THRESHOLD) {
      this.setState({ cooldownUntil: nowMs + CRASH_COOLDOWN_MS });
    }

    console.error(
      `[workbench] window ${this.props.windowId ?? '?'} app crashed:`,
      error,
      info.componentStack,
    );
    void reportFrontendError(error, {
      kind: 'REACT_ERROR_BOUNDARY',
      component: 'workbench-window',
      extra: {
        windowId: this.props.windowId,
        componentStack: info.componentStack,
        crashStreak: this.crashStreak,
      },
    }).catch(() => undefined);
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
    // 双保险：disabled 按钮理论上点不到，键盘合成事件 / 测试路径仍要拦
    if (Date.now() < this.state.cooldownUntil) return;
    this.props.onReset?.();
    this.setState((s) => ({ error: null, resetKey: s.resetKey + 1 }));
  };

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <CrashCard
          error={this.state.error}
          onReload={this.handleReload}
          cooldownUntil={this.state.cooldownUntil}
        />
      );
    }
    return <React.Fragment key={this.state.resetKey}>{this.props.children}</React.Fragment>;
  }
}

export default WindowErrorBoundary;
