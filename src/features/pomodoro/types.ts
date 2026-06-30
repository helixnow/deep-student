import type { NoiseType } from './noiseEngine';

export type PomodoroMode = 'idle' | 'work' | 'short_break' | 'long_break';
export type PomodoroStatus = 'running' | 'paused';

export interface PomodoroSettings {
  workDuration: number;      // in seconds
  shortBreak: number;        // in seconds
  longBreak: number;         // in seconds
  longBreakInterval: number; // number of pomodoros before a long break
  autoStartBreaks: boolean;  // 工作结束后自动开始休息
  autoStartWork: boolean;    // 休息结束后自动开始下一个番茄
  /** 严格模式：专注进行中禁止暂停（对标番茄ToDo/Forest 的强制专注） */
  strictMode: boolean;
  /** 正计时模式：专注阶段秒表向上计时，手动「完成」收尾（对标滴答清单） */
  countUp: boolean;
  /** 结束前提醒（秒）：倒计时剩余该秒数时轻提示；0 = 关闭 */
  endReminderSeconds: number;
  /** 环境音类型 */
  noiseType: NoiseType;
  /** 环境音音量 0-1 */
  noiseVolume: number;
  /** 每日专注目标（番茄数）；0 = 不设目标 */
  dailyGoal: number;
}

export const DEFAULT_POMODORO_SETTINGS: PomodoroSettings = {
  workDuration: 25 * 60,
  shortBreak: 5 * 60,
  longBreak: 15 * 60,
  longBreakInterval: 4,
  autoStartBreaks: false,
  autoStartWork: false,
  strictMode: false,
  countUp: false,
  endReminderSeconds: 0,
  noiseType: 'brown',
  noiseVolume: 0.12,
  dailyGoal: 8,
};

export interface PomodoroState {
  mode: PomodoroMode;
  status: PomodoroStatus;
  /** 倒计时 = 剩余秒数；正计时（countUp 工作阶段）= 已专注秒数 */
  timeLeft: number;
  /** 运行中倒计时阶段的结束时刻（epoch ms）；暂停/空闲/正计时为 null */
  phaseEndsAt: number | null;
  /** 运行中正计时阶段的起算时刻（epoch ms，已折算暂停）；其余为 null */
  phaseStartedAt: number | null;
  currentTaskId: string | null;
  currentTaskTitle: string | null;
  sessionStartTime: string | null;
  settings: PomodoroSettings;
  completedPomodorosToday: number;
  lastActiveDate: string | null;
  isImmersive: boolean;

  // Actions
  start: (taskId?: string, taskTitle?: string) => void;
  pause: () => void;
  resume: () => void;
  stop: (interrupted?: boolean) => void;
  tick: () => void;
  /** 墙钟矫正：rehydrate / visibilitychange / focus 时调用 */
  syncWallClock: () => void;
  completeCurrentSession: () => void;
  updateSettings: (settings: Partial<PomodoroSettings>) => void;
  setImmersive: (value: boolean) => void;
}
