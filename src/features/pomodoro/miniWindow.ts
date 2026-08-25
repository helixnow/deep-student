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

// ---------------------------------------------------------------------------
// 小窗开启状态（主窗口侧镜像）：GlobalPomodoroWidget 用它隐藏悬浮药丸，
// 避免「置顶小窗 + 药丸」双重投影。useSyncExternalStore 友好的极简外部 store。
// ---------------------------------------------------------------------------

let miniWindowOpen = false;
const miniWindowListeners = new Set<() => void>();

/** 当前是否有置顶小窗（主窗口侧镜像；小窗被系统/用户直接关闭时经 destroyed 事件回落） */
export function isPomodoroMiniWindowOpen(): boolean {
  return miniWindowOpen;
}

export function subscribePomodoroMiniWindowOpen(listener: () => void): () => void {
  miniWindowListeners.add(listener);
  return () => {
    miniWindowListeners.delete(listener);
  };
}

/** 内部/测试用：写小窗开启镜像并通知订阅者 */
export function setPomodoroMiniWindowOpen(open: boolean): void {
  if (miniWindowOpen === open) return;
  miniWindowOpen = open;
  for (const listener of miniWindowListeners) listener();
}

/** 小窗被用户按钮/系统直接关闭（不经 closePomodoroMiniWindow）时同步镜像 */
function watchMiniWindowDestroyed(win: { once: (event: string, handler: () => void) => Promise<unknown> }): void {
  void win.once('tauri://destroyed', () => setPomodoroMiniWindowOpen(false));
}

/** 打开（或聚焦）置顶小窗；返回 false 表示失败（调用方负责 UI 反馈） */
export async function openPomodoroMiniWindow(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const existing = await WebviewWindow.getByLabel(POMODORO_MINI_LABEL);
    if (existing) {
      await existing.setFocus();
      setPomodoroMiniWindowOpen(true);
      watchMiniWindowDestroyed(existing);
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
      void win.once('tauri://created', () => {
        setPomodoroMiniWindowOpen(true);
        watchMiniWindowDestroyed(win);
        resolve(true);
      });
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
  setPomodoroMiniWindowOpen(false);
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
