export type PomodoroMode = 'idle' | 'work' | 'short_break' | 'long_break';
export type PomodoroStatus = 'running' | 'paused';

export interface PomodoroSettings {
  workDuration: number;      // in seconds
  shortBreak: number;        // in seconds
  longBreak: number;         // in seconds
  longBreakInterval: number; // number of pomodoros before a long break
  autoStartBreaks: boolean;  // 工作结束后自动开始休息
  autoStartWork: boolean;    // 休息结束后自动开始下一个番茄
}

export const DEFAULT_POMODORO_SETTINGS: PomodoroSettings = {
  workDuration: 25 * 60,
  shortBreak: 5 * 60,
  longBreak: 15 * 60,
  longBreakInterval: 4,
  autoStartBreaks: false,
  autoStartWork: false,
};

export interface PomodoroState {
  mode: PomodoroMode;
  status: PomodoroStatus;
  /** 剩余秒数（展示用；运行中由墙钟矫正） */
  timeLeft: number;
  /** 运行中阶段的结束时刻（epoch ms）；暂停/空闲时为 null。计时以它为准 */
  phaseEndsAt: number | null;
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
