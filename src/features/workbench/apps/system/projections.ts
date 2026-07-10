/**
 * 系统投射源接线（P9）
 *
 * - 番茄钟：专注/休息进行中 → 投射 pomodoro 窗口 + Dock 圆点角标；
 * - 制卡任务：badge-only 源，subscribe 即启动后台 watcher
 *   （轮询 + anki_generation_event 触发刷新），驱动 taskDashboard Dock 计数角标；
 * - 闪卡到期：badge-only 源，subscribe 即启动 fsrs_get_due 轮询，驱动 flashcards Dock 角标。
 *
 * 由 P11 在 workbench 挂载时调用 registerSystemProjections()，
 * 卸载（关闭实验开关）时调用返回的清理函数；开关打开/快照恢复完成后
 * 调用 core/projection 的 resyncProjections() 补投已存活实例。
 */
import { registerProjectionSource } from '../../core/projection';
import { ankiTaskProjectionSource } from './ankiTaskSource';
import { flashcardsDueProjectionSource } from './flashcardsDueSource';
import { pomodoroProjectionSource } from './pomodoroSource';

let disposers: Array<() => void> | null = null;

/** 幂等注册系统投射源。返回整体清理函数。 */
export function registerSystemProjections(): () => void {
  if (!disposers) {
    disposers = [
      registerProjectionSource('pomodoro', pomodoroProjectionSource),
      registerProjectionSource('taskDashboard', ankiTaskProjectionSource),
      registerProjectionSource('flashcards', flashcardsDueProjectionSource),
    ];
  }
  return () => {
    disposers?.forEach((dispose) => dispose());
    disposers = null;
  };
}
