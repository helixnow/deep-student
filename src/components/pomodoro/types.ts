export type PomodoroMode = 'idle' | 'work' | 'short_break' | 'long_break';
export type PomodoroStatus = 'running' | 'paused';

export interface PomodoroSettings {
  workDuration: number;      // in seconds
  shortBreak: number;        // in seconds
  longBreak: number;         // in seconds
  longBreakInterval: number; // number of pomodoros before a long break
}

export const DEFAULT_POMODORO_SETTINGS: PomodoroSettings = {
  workDuration: 25 * 60,
  shortBreak: 5 * 60,
  longBreak: 15 * 60,
  longBreakInterval: 4,
};

export interface PomodoroState {
  mode: PomodoroMode;
  status: PomodoroStatus;
  timeLeft: number;
  currentTaskId: string | null;
  currentTaskTitle: string | null;
  sessionStartTime: string | null;
  settings: PomodoroSettings;
  completedPomodorosToday: number;
  
  // Actions
  start: (taskId?: string, taskTitle?: string) => void;
  pause: () => void;
  resume: () => void;
  stop: (interrupted?: boolean) => void;
  tick: () => void;
  completeCurrentSession: () => void;
  updateSettings: (settings: Partial<PomodoroSettings>) => void;
}
