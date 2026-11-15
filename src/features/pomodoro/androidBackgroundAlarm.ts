import { invoke } from '@tauri-apps/api/core';
import i18n from '@/i18n';
import { isAndroidMobileShell } from '@/utils/platform';
import { ensureSystemNotificationPermission } from '@/utils/systemNotification';
import { usePomodoroStore } from './stores/usePomodoroStore';
import type { PomodoroState } from './types';

export function initAndroidPomodoroAlarm(): (() => void) | undefined {
  if (!isAndroidMobileShell()) return;
  const sync = (state: PomodoroState, previous?: PomodoroState) => {
    if (previous && state.status === previous.status && state.phaseEndsAt === previous.phaseEndsAt &&
        state.mode === previous.mode && state.settings.androidBackgroundCompletion === previous.settings.androidBackgroundCompletion) return;
    const deadline = state.settings.androidBackgroundCompletion && state.status === 'running' &&
      state.mode !== 'idle' ? state.phaseEndsAt ?? 0 : 0;
    const title = state.mode === 'work'
      ? i18n.t('todo:pomodoro.notifications.workCompleteTitle')
      : i18n.t('todo:pomodoro.notifications.breakCompleteTitle');
    const body = state.mode === 'work'
      ? i18n.t('todo:pomodoro.notifications.androidBackgroundWorkBody')
      : i18n.t('todo:pomodoro.notifications.breakCompleteBody');
    void invoke('mobile_set_pomodoro_alarm', { deadline, title, body })
      .catch((error: unknown) => console.warn('[Pomodoro] Could not update Android countdown notification:', error));
  };
  sync(usePomodoroStore.getState());
  return usePomodoroStore.subscribe(sync);
}

export function setAndroidBackgroundCompletion(enabled: boolean): void {
  if (enabled) void ensureSystemNotificationPermission();
  usePomodoroStore.getState().updateSettings({ androidBackgroundCompletion: enabled });
}
