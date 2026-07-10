/**
 * StatusBarItems — 学习状态菜单栏右侧信号项
 *
 * 无信号不占位：番茄 / 闪卡 due / 制卡任务。
 * due / tasks 由父 StatusBar 单侧订阅后 props 下传，避免双订阅。
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { ChartBar, Stack, Timer } from '@phosphor-icons/react';
import { workbenchBus } from '../core/workbenchBus';
import { usePomodoroStore } from '@/features/pomodoro/stores/usePomodoroStore';

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
  workbenchBus.launch({
    typeId: 'flashcards',
    reason: 'api',
    payload: FLASHCARDS_DUE_PAYLOAD,
  });
}

export interface StatusBarItemsProps {
  dueCount: number;
  taskCount: number;
}

export const StatusBarItems: React.FC<StatusBarItemsProps> = ({ dueCount, taskCount }) => {
  const { t } = useTranslation('workbench');

  const mode = usePomodoroStore((s) => s.mode);
  const timeLeft = usePomodoroStore((s) => s.timeLeft);

  const showPomodoro = mode !== 'idle';
  const pomodoroTime = formatStatusBarTime(timeLeft);

  if (!showPomodoro && dueCount <= 0 && taskCount <= 0) {
    return null;
  }

  return (
    <>
      {showPomodoro ? (
        <button
          type="button"
          className="wb-menubar-item"
          data-testid="wb-menubar-pomodoro"
          data-wb-status-item="pomodoro"
          aria-label={t('menubar.pomodoroFocus', {
            time: pomodoroTime,
            defaultValue: `专注剩余 ${pomodoroTime}`,
          })}
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
          aria-label={t('menubar.flashcardsDue', {
            count: dueCount,
            defaultValue: `${dueCount} 张到期闪卡`,
          })}
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
          aria-label={t('menubar.tasksRunning', {
            count: taskCount,
            defaultValue: `${taskCount} 个制卡任务进行中`,
          })}
          onClick={() => launchApp('taskDashboard')}
        >
          <ChartBar size={14} weight="duotone" className="wb-menubar-item-icon" aria-hidden />
          <span className="wb-menubar-item-value">{taskCount}</span>
        </button>
      ) : null}
    </>
  );
};

export default StatusBarItems;
