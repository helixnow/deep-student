/**
 * ★ 3.2 番茄钟置顶小窗（主窗口侧）
 *
 * 用 Tauri 多窗口把番茄钟药丸弹成 always-on-top 小窗，
 * 切到其他应用（网页/PDF）也能看到倒计时。
 *
 * 事件协议（全局广播）：
 * - pomodoro-mini:state   主窗口 → 小窗：{ mode, status, timeLeft, taskTitle, strictMode, progress?, countUp? }
 * - pomodoro-mini:command 小窗 → 主窗口：{ action: 'pause' | 'resume' | 'stop' | 'finish' }
 * - pomodoro-mini:ready   小窗 → 主窗口：挂载完成，请求立即广播一次状态
 *
 * 向后兼容约定：事件名与既有字段不变；state 只增可选字段，command 只增 action 值
 * （旧小窗遇到未知字段/新主窗遇到旧 command 均无副作用）。
 */
import { emit } from '@tauri-apps/api/event';
import type { PomodoroMode, PomodoroStatus } from './types';

export const POMODORO_MINI_LABEL = 'pomodoro-mini';
export const EVT_MINI_STATE = 'pomodoro-mini:state';
export const EVT_MINI_COMMAND = 'pomodoro-mini:command';
export const EVT_MINI_READY = 'pomodoro-mini:ready';

export interface PomodoroMiniState {
  mode: PomodoroMode;
  status: PomodoroStatus;
  timeLeft: number;
  taskTitle: string | null;
  strictMode: boolean;
  /** 当前阶段进度 0–1（正计时相对设定时长封顶）；旧版主窗口不发送 */
  progress?: number;
  /** 当前工作阶段是否正计时（小窗据此显示"完成"按钮）；旧版主窗口不发送 */
  countUp?: boolean;
}

export interface PomodoroMiniCommand {
  /** pause/resume/stop 为既有动作；finish = 正计时手动完成（旧版主窗口会忽略） */
  action: 'pause' | 'resume' | 'stop' | 'finish';
}

function isTauri(): boolean {
  return typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__);
}

/** 打开（或聚焦）置顶小窗；返回 false 表示失败（调用方负责 UI 反馈） */
export async function openPomodoroMiniWindow(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const existing = await WebviewWindow.getByLabel(POMODORO_MINI_LABEL);
    if (existing) {
      await existing.setFocus();
      return true;
    }
    const win = new WebviewWindow(POMODORO_MINI_LABEL, {
      url: 'index.html?window=pomodoro-mini',
      // 264：容纳 hover 滑出的完整控制簇（完成/暂停/停止/置顶/关闭）仍留出任务名空间
      width: 264,
      height: 56,
      resizable: false,
      decorations: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      shadow: false,
      title: 'Pomodoro',
    });
    return await new Promise<boolean>((resolve) => {
      void win.once('tauri://created', () => resolve(true));
      void win.once('tauri://error', (e) => {
        console.warn('[PomodoroMini] window create failed:', e);
        resolve(false);
      });
    });
  } catch (e) {
    console.warn('[PomodoroMini] openPomodoroMiniWindow failed:', e);
    return false;
  }
}

/** 关闭置顶小窗（若存在） */
export async function closePomodoroMiniWindow(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const existing = await WebviewWindow.getByLabel(POMODORO_MINI_LABEL);
    if (existing) await existing.close();
  } catch {
    // 窗口已不存在
  }
}

/** 广播番茄钟状态给小窗 */
export function broadcastPomodoroState(state: PomodoroMiniState): void {
  if (!isTauri()) return;
  emit(EVT_MINI_STATE, state).catch(() => { /* 小窗不存在时无害 */ });
}
