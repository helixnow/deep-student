/**
 * 番茄钟投射源（P9）
 *
 * 数据源：`usePomodoroStore`（zustand，持久化运行状态）。
 * - mode !== 'idle'（专注/休息进行中）→ 存活实例 'pomodoro'：
 *   投射管理器据此保证有一个番茄钟窗口；
 * - 回到 idle → 实例消失，窗口自动关闭；
 * - Dock 角标：运行中 = dot（不打扰的存在感提示）。
 */
import i18n from '@/i18n';
import { usePomodoroStore } from '@/features/pomodoro/stores/usePomodoroStore';
import type { ProjectionInstance, ProjectionSource } from '../../core/projection';
import type { AppBadge } from '../../core/types';

export const POMODORO_INSTANCE_KEY = 'pomodoro';

function isRunning(): boolean {
  return usePomodoroStore.getState().mode !== 'idle';
}

function currentInstances(): ProjectionInstance[] {
  const state = usePomodoroStore.getState();
  if (state.mode === 'idle') return [];
  return [
    {
      instanceKey: POMODORO_INSTANCE_KEY,
      title:
        state.currentTaskTitle ||
        i18n.t('workbench:apps.pomodoro', { defaultValue: '番茄钟' }),
      initialFrame: { w: 380, h: 560 },
    },
  ];
}

export const pomodoroProjectionSource: ProjectionSource = {
  subscribe(notify) {
    // 订阅时立即同步一次（含已在运行的恢复场景）
    notify(currentInstances());
    let prevActive = isRunning();
    let prevTitle = usePomodoroStore.getState().currentTaskTitle;
    return usePomodoroStore.subscribe((state) => {
      const active = state.mode !== 'idle';
      const title = state.currentTaskTitle;
      // R2-10 开窗时序：idle→active 立即 project；运行中换任务标题也刷新实例元数据
      if (active === prevActive && title === prevTitle) return;
      prevActive = active;
      prevTitle = title;
      notify(currentInstances());
    });
  },
};

/** Dock 角标源：番茄钟进行中显示圆点 */
export function pomodoroBadgeSource(): AppBadge | null {
  return isRunning() ? { kind: 'dot' } : null;
}
