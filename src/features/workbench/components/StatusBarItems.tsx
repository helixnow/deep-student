/**
 * StatusBarItems — 学习状态菜单栏右侧信号项
 *
 * 无信号不占位：番茄 / 闪卡 due / 制卡任务。
 * due / tasks / automation 由父 StatusBar 单侧订阅后 props 下传，避免双订阅。
 * 样式统一在 StatusBar.css（automation 呼吸脉冲/失败红点等此前的内联
 * <style> 已于 2026-08 迁入；本文件不再持有样式）。
 * 番茄状态项文案区分状态：专注剩余 / 已专注（正计时）/ 休息剩余 / 已暂停
 *（data-status = focus|break|paused 供 CSS 暂停态压暗）。
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { ChartBar, Robot, Stack, Timer } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { workbenchBus } from '../core/workbenchBus';
import { usePomodoroStore } from '@/features/pomodoro/stores/usePomodoroStore';
import type { AutomationSummary } from '@/features/settings/components/automationSettingsApi';
import './StatusBar.css';

/** 规格 m:ss（分不强制两位，秒两位） */
export function formatStatusBarTime(totalSeconds: number): string {
  const sec = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

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
  const mode = usePomodoroStore((s) => s.mode);
  const status = usePomodoroStore((s) => s.status);
  const sessionCountUp = usePomodoroStore((s) => s.sessionCountUp);
  const countUpSetting = usePomodoroStore((s) => s.settings.countUp);
  const pomodoroTime = formatStatusBarTime(timeLeft);
  // 文案与实际阶段/状态一致：已暂停 > 休息剩余 > 已专注（正计时）> 专注剩余
  const isBreak = mode === 'short_break' || mode === 'long_break';
  const paused = status === 'paused';
  const isCountUpWork = mode === 'work' && (sessionCountUp ?? countUpSetting);
  const pomodoroLabel = paused
    ? t('menubar.pomodoroPaused', { time: pomodoroTime })
    : isBreak
      ? t('menubar.pomodoroBreakRemaining', { time: pomodoroTime })
      : isCountUpWork
        ? t('menubar.pomodoroFocusElapsed', { time: pomodoroTime })
        : t('menubar.pomodoroFocus', { time: pomodoroTime });
  const pomodoroTag = paused
    ? t('menubar.pomodoroTagPaused')
    : isBreak
      ? t('menubar.pomodoroTagBreak')
      : t('menubar.pomodoroTagFocus');
  return (
    <button
      type="button"
      className={cn(
        'wb-menubar-item',
        paused ? 'bg-muted/40' : isBreak ? 'bg-emerald-500/10' : 'bg-primary/10',
      )}
      data-testid="wb-menubar-pomodoro"
      data-wb-status-item="pomodoro"
      data-status={paused ? 'paused' : isBreak ? 'break' : 'focus'}
      aria-label={pomodoroLabel}
      title={pomodoroLabel}
      onClick={() => launchApp('pomodoro')}
    >
      <Timer size={14} weight="duotone" className="wb-menubar-item-icon" aria-hidden />
      <span
        className="wb-menubar-item-tag hidden lg:inline text-2xs opacity-80"
        data-testid="wb-menubar-pomodoro-tag"
        aria-hidden="true"
      >
        {pomodoroTag}
      </span>
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

  const runningCount = automation?.runningCount ?? 0;
  const failedCount = automation?.failedCount ?? 0;
  const enabledCount = automation?.enabledCount ?? 0;
  const automationCount = runningCount
    ? runningCount
    : failedCount
      ? failedCount
      : enabledCount;
  const automationHasActivity = runningCount > 0 || failedCount > 0 || enabledCount > 0;

  // tooltip：前缀语义标题 + 运行/启用/下次执行/异常摘要 + 点击操作提示
  const automationRelative = automation?.nextRunAt
    ? formatAutomationRelative(automation.nextRunAt, (key, options) => String(t(key, options)))
    : null;
  const automationTitle = automationHasActivity
    ? [
        t('menubar.automationsTitle'),
        runningCount > 0 ? t('menubar.automationsRunningShort', { count: runningCount }) : null,
        t('menubar.automationsEnabledShort', { count: enabledCount }),
        automationRelative
          ? t('menubar.automationsNextRun', { relative: automationRelative })
          : null,
        failedCount > 0
          ? t('menubar.automationsFailedShort', { count: failedCount })
          : null,
        t('menubar.automationsClickHint'),
      ]
        .filter(Boolean)
        .join(' · ')
    : t('menubar.automationsIdleHint');

  const automationAriaLabel = automationHasActivity
    ? t('menubar.automations', {
        enabled: enabledCount,
        running: runningCount,
        failed: failedCount,
      })
    : t('menubar.automationsIdleHint');

  const automationTag =
    runningCount > 0
      ? t('menubar.automationsTagRunning')
      : failedCount > 0
        ? t('menubar.automationsTagFailed')
        : enabledCount > 0
          ? t('menubar.automationsTagActive')
          : null;

  return (
    <>
      {showPomodoro ? <PomodoroStatusItem /> : null}

      {dueCount > 0 ? (
        <button
          type="button"
          className="wb-menubar-item bg-amber-500/10"
          data-testid="wb-menubar-flashcards"
          data-wb-status-item="flashcards"
          aria-label={flashcardsLabel}
          title={flashcardsLabel}
          onClick={launchFlashcardsDue}
        >
          <Stack size={14} weight="duotone" className="wb-menubar-item-icon" aria-hidden />
          <span
            className="wb-menubar-item-tag hidden lg:inline text-2xs opacity-80"
            data-testid="wb-menubar-flashcards-tag"
            aria-hidden="true"
          >
            {t('menubar.flashcardsTag')}
          </span>
          <span className="wb-menubar-item-value">{dueCount}</span>
        </button>
      ) : null}

      {taskCount > 0 ? (
        <button
          type="button"
          className="wb-menubar-item bg-primary/10"
          data-testid="wb-menubar-anki-tasks"
          data-wb-status-item="ankiTasks"
          aria-label={tasksLabel}
          title={tasksLabel}
          onClick={() => launchApp('taskDashboard')}
        >
          <ChartBar size={14} weight="duotone" className="wb-menubar-item-icon" aria-hidden />
          <span
            className="wb-menubar-item-tag hidden lg:inline text-2xs opacity-80"
            data-testid="wb-menubar-anki-tasks-tag"
            aria-hidden="true"
          >
            {t('menubar.tasksTag')}
          </span>
          <span className="wb-menubar-item-value">{taskCount}</span>
        </button>
      ) : null}

      <button
        type="button"
        className={cn(
          'wb-menubar-item',
          runningCount > 0
            ? 'bg-primary/10'
            : failedCount > 0
              ? 'bg-destructive/10'
              : undefined,
        )}
        data-testid="wb-menubar-automations"
        data-wb-status-item="automations"
        data-status={runningCount > 0 ? 'running' : failedCount > 0 ? 'error' : 'idle'}
        aria-label={automationAriaLabel}
        title={automationTitle}
        onClick={launchAutomations}
      >
        <span
          className="wb-menubar-automation-iconwrap"
          data-pulse={runningCount > 0 ? 'true' : undefined}
          aria-hidden
        >
          <Robot size={14} weight="duotone" className="wb-menubar-item-icon" aria-hidden />
          {failedCount > 0 ? (
            <span className="wb-menubar-automation-dot" data-testid="wb-menubar-automations-failed-dot" />
          ) : null}
        </span>
        {automationTag ? (
          <span
            className={cn(
              'wb-menubar-item-tag text-2xs',
              runningCount > 0 || failedCount > 0
                ? 'hidden lg:inline opacity-85'
                : 'hidden xl:inline opacity-75',
            )}
            data-testid="wb-menubar-automations-tag"
            aria-hidden="true"
          >
            {automationTag}
          </span>
        ) : null}
        {automationCount > 0 ? <span className="wb-menubar-item-value">{automationCount}</span> : null}
      </button>
    </>
  );
};

export default StatusBarItems;
