/**
 * 番茄钟投射源（P9）
 *
 * 数据源：`usePomodoroStore`（zustand，持久化运行状态）。
 * - mode !== 'idle'（专注/休息进行中）→ 存活实例 'pomodoro'：
 *   投射管理器据此保证有一个番茄钟窗口（后台开窗，不抢焦点）；
 * - 回到 idle → 实例延迟 POMODORO_CLOSE_LINGER_MS 后消失（stop 的「余韵」：
 *   窗口短暂停留在 idle 态，用户可立即点「开始专注」续上；期间重新开始
 *   则取消关窗）；
 * - Dock 角标：运行中 = dot（不打扰的存在感提示）。
 */
import i18n from '@/i18n';
import { usePomodoroStore } from '@/features/pomodoro/stores/usePomodoroStore';
import type { ProjectionInstance, ProjectionSource } from '../../core/projection';
import type { AppBadge } from '../../core/types';

export const POMODORO_INSTANCE_KEY = 'pomodoro';

/** stop → idle 后窗口保留的余韵时长（可在 idle 态直接重新开始） */
export const POMODORO_CLOSE_LINGER_MS = 2500;

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
        i18n.t('workbench:apps.pomodoro'),
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
    let lingerTimer: ReturnType<typeof setTimeout> | null = null;
    const cancelLinger = () => {
      if (lingerTimer != null) {
        clearTimeout(lingerTimer);
        lingerTimer = null;
      }
    };
    const unsubscribe = usePomodoroStore.subscribe((state) => {
      const active = state.mode !== 'idle';
      const title = state.currentTaskTitle;
      // R2-10 开窗时序：idle→active 立即 project；运行中换任务标题也刷新实例元数据
      if (active === prevActive && title === prevTitle) return;
      prevActive = active;
      prevTitle = title;
      if (active) {
        cancelLinger();
        notify(currentInstances());
        return;
      }
      // stop 余韵：不瞬间关窗——idle 态窗口保留 2.5s（可直接重新开始）；
      // 到期仍 idle 才收口，期间重新开始由上面的 cancelLinger 取消
      cancelLinger();
      lingerTimer = setTimeout(() => {
        lingerTimer = null;
        if (!isRunning()) notify([]);
      }, POMODORO_CLOSE_LINGER_MS);
    });
    return () => {
      cancelLinger();
      unsubscribe();
    };
  },
};

/** Dock 角标源：番茄钟进行中显示圆点 */
export function pomodoroBadgeSource(): AppBadge | null {
  return isRunning() ? { kind: 'dot' } : null;
}
