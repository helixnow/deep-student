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

  const mode = usePomodoroStore((s) => s.mode);
  const timeLeft = usePomodoroStore((s) => s.timeLeft);

  const showPomodoro = mode !== 'idle';
  const pomodoroTime = formatStatusBarTime(timeLeft);

  // 悬停 tooltip 与 aria-label 同文案，保持读屏与鼠标一致
  const pomodoroLabel = t('menubar.pomodoroFocus', { time: pomodoroTime });
  const flashcardsLabel = t('menubar.flashcardsDue', { count: dueCount });
  const tasksLabel = t('menubar.tasksRunning', { count: taskCount });

  const automationCount = automation?.runningCount
    ? automation.runningCount
    : automation?.failedCount
      ? automation.failedCount
      : automation?.enabledCount ?? 0;

  return (
    <>
      {showPomodoro ? (
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
      ) : null}

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
        title={t('menubar.automationsTitle')}
        onClick={launchAutomations}
      >
        <Robot size={14} weight="duotone" className="wb-menubar-item-icon" aria-hidden />
        {automationCount > 0 ? <span className="wb-menubar-item-value">{automationCount}</span> : null}
      </button>
    </>
  );
};

export default StatusBarItems;
