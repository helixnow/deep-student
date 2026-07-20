/**
 * StatusBarItems — 学习状态菜单栏右侧信号项
 *
 * 无信号不占位：番茄 / 闪卡 due / 制卡任务。
 * due / tasks / automation 由父 StatusBar 单侧订阅后 props 下传，避免双订阅。
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { ChartBar, Robot, Stack, Timer } from '@phosphor-icons/react';
import { workbenchBus } from '../core/workbenchBus';
import { usePomodoroStore } from '@/features/pomodoro/stores/usePomodoroStore';
import type { AutomationSummary } from '@/features/settings/components/automationSettingsApi';

/** 规格 m:ss（分不强制两位，秒两位） */
export function formatStatusBarTime(totalSeconds: number): string {
  const sec = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * automation 状态项私有样式：running 呼吸脉冲 + failed 红点角标。
 * 内联 <style> 保持本文件自包含（StatusBar.css 由其他并行改造持有）；
 * prefers-reduced-motion 下取消动画。
 */
const AUTOMATION_ITEM_CSS = `
@keyframes wb-menubar-automation-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}
.wb-menubar-automation-iconwrap {
  position: relative;
  display: inline-flex;
  align-items: center;
}
.wb-menubar-automation-iconwrap[data-pulse='true'] .wb-menubar-item-icon {
  animation: wb-menubar-automation-pulse 1.6s ease-in-out infinite;
}
.wb-menubar-automation-dot {
  position: absolute;
  top: -2px;
  right: -3px;
  width: 6px;
  height: 6px;
  border-radius: 9999px;
  background: hsl(var(--destructive));
  pointer-events: none;
}
@media (prefers-reduced-motion: reduce) {
  .wb-menubar-automation-iconwrap[data-pulse='true'] .wb-menubar-item-icon {
    animation: none;
  }
}
`;

/**
 * 就地实现的相对时间（"2 小时后"式），仅供 automation tooltip 使用。
 * 不跨目录 import，避免与并行改造的新工具文件耦合。
 */
function formatAutomationRelative(
  nextRunAt: string,
  t: (key: string, options?: Record<string, unknown>) => string,
): string | null {
  const target = Date.parse(nextRunAt);
  if (Number.isNaN(target)) return null;
  const diffMs = target - Date.now();
  if (diffMs <= 45_000) return t('menubar.automationsRelativeSoon');
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 60) return t('menubar.automationsRelativeMinutes', { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t('menubar.automationsRelativeHours', { count: hours });
  return t('menubar.automationsRelativeDays', { count: Math.round(hours / 24) });
}

const FLASHCARDS_DUE_PAYLOAD = { screen: 'session', mode: 'due' } as const;

function launchApp(typeId: 'pomodoro' | 'taskDashboard'): void {
  workbenchBus.launch({ typeId, reason: 'api' });
}

function launchFlashcardsDue(): void {
  void workbenchBus.activate({
    typeId: 'flashcards',
    instanceKey: '',
    action: 'startReview',
    payload: FLASHCARDS_DUE_PAYLOAD,
    fallbackLaunch: {
      typeId: 'flashcards',
      reason: 'api',
      payload: FLASHCARDS_DUE_PAYLOAD,
    },
  });
}

function launchAutomations(): void {
  void workbenchBus.activate({
    typeId: 'todo',
    instanceKey: '',
    action: 'showAutomations',
    fallbackLaunch: {
      typeId: 'todo',
      reason: 'api',
      payload: { todoView: 'automations' },
    },
  });
}

/** 番茄信号叶子：单独订阅 timeLeft，专注中 1Hz 重渲染只落在本按钮 */
const PomodoroStatusItem: React.FC = () => {
  const { t } = useTranslation('workbench');
  const timeLeft = usePomodoroStore((s) => s.timeLeft);
  const pomodoroTime = formatStatusBarTime(timeLeft);
  const pomodoroLabel = t('menubar.pomodoroFocus', { time: pomodoroTime });
  return (
    <button
      type="button"
      className="wb-menubar-item"
      data-testid="wb-menubar-pomodoro"
      data-wb-status-item="pomodoro"
      aria-label={pomodoroLabel}
      title={pomodoroLabel}
      onClick={() => launchApp('pomodoro')}
    >
      <Timer size={14} weight="duotone" className="wb-menubar-item-icon" aria-hidden />
      <span className="wb-menubar-item-value">{pomodoroTime}</span>
    </button>
  );
};

export interface StatusBarItemsProps {
  dueCount: number;
  taskCount: number;
  automation: AutomationSummary | null;
}

export const StatusBarItems: React.FC<StatusBarItemsProps> = ({
  dueCount,
  taskCount,
  automation,
}) => {
  const { t } = useTranslation('workbench');

  // 只订阅 mode（idle 与否）；timeLeft 的 1Hz 更新隔离在 PomodoroStatusItem 叶子
  const mode = usePomodoroStore((s) => s.mode);
  const showPomodoro = mode !== 'idle';

  // 悬停 tooltip 与 aria-label 同文案，保持读屏与鼠标一致
  const flashcardsLabel = t('menubar.flashcardsDue', { count: dueCount });
  const tasksLabel = t('menubar.tasksRunning', { count: taskCount });

  const automationCount = automation?.runningCount
    ? automation.runningCount
    : automation?.failedCount
      ? automation.failedCount
      : automation?.enabledCount ?? 0;

  // tooltip："3 个启用 · 下次运行 2 小时后 · 1 个最近失败"式摘要
  const automationRelative = automation?.nextRunAt
    ? formatAutomationRelative(automation.nextRunAt, (key, options) => String(t(key, options)))
    : null;
  const automationTitle = automation
    ? [
        t('menubar.automationsEnabledShort', { count: automation.enabledCount }),
        automationRelative
          ? t('menubar.automationsNextRun', { relative: automationRelative })
          : null,
        automation.failedCount > 0
          ? t('menubar.automationsFailedShort', { count: automation.failedCount })
          : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : t('menubar.automationsTitle');

  return (
    <>
      <style>{AUTOMATION_ITEM_CSS}</style>
      {showPomodoro ? <PomodoroStatusItem /> : null}

      {dueCount > 0 ? (
        <button
          type="button"
          className="wb-menubar-item"
          data-testid="wb-menubar-flashcards"
          data-wb-status-item="flashcards"
          aria-label={flashcardsLabel}
          title={flashcardsLabel}
          onClick={launchFlashcardsDue}
        >
          <Stack size={14} weight="duotone" className="wb-menubar-item-icon" aria-hidden />
          <span className="wb-menubar-item-value">{dueCount}</span>
        </button>
      ) : null}

      {taskCount > 0 ? (
        <button
          type="button"
          className="wb-menubar-item"
          data-testid="wb-menubar-anki-tasks"
          data-wb-status-item="ankiTasks"
          aria-label={tasksLabel}
          title={tasksLabel}
          onClick={() => launchApp('taskDashboard')}
        >
          <ChartBar size={14} weight="duotone" className="wb-menubar-item-icon" aria-hidden />
          <span className="wb-menubar-item-value">{taskCount}</span>
        </button>
      ) : null}

      <button
        type="button"
        className="wb-menubar-item"
        data-testid="wb-menubar-automations"
        data-wb-status-item="automations"
        data-status={automation?.runningCount ? 'running' : automation?.failedCount ? 'error' : 'idle'}
        aria-label={t('menubar.automations', {
          enabled: automation?.enabledCount ?? 0,
          running: automation?.runningCount ?? 0,
          failed: automation?.failedCount ?? 0,
        })}
        title={automationTitle}
        onClick={launchAutomations}
      >
        <span
          className="wb-menubar-automation-iconwrap"
          data-pulse={(automation?.runningCount ?? 0) > 0 ? 'true' : undefined}
          aria-hidden
        >
          <Robot size={14} weight="duotone" className="wb-menubar-item-icon" aria-hidden />
          {(automation?.failedCount ?? 0) > 0 ? (
            <span className="wb-menubar-automation-dot" data-testid="wb-menubar-automations-failed-dot" />
          ) : null}
        </span>
        {automationCount > 0 ? <span className="wb-menubar-item-value">{automationCount}</span> : null}
      </button>
    </>
  );
};

export default StatusBarItems;
