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
  /**
   * 环境音跟随专注：开启后专注（work）开始时自动播放环境音，
   * 进入休息 / 停止 / 跳过休息回 idle 时自动停止。
   * 暂停（pause）不停止环境音——短暂中断保持氛围。关闭时完全手动控制。
   */
  noiseAutoWithFocus: boolean;
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
  noiseAutoWithFocus: false,
  dailyGoal: 8,
};

/** completeCurrentSession 的可选上下文（全部可选，兼容既有零参调用） */
export interface PomodoroCompleteOptions {
  /**
   * 离线/休眠期间流逝的超出时长（ms）。
   * syncWallClock 检测到大幅时间跳变时传入：完成本阶段但静音提示音、
   * 通知改用「在你离开期间完成」文案，且不自动开始下一阶段（避免惊吓与连锁完成）。
   */
  awayMs?: number;
}

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
  /**
   * 当前工作会话锁定的计时模式（会话开始时的 settings.countUp 快照，持久化）。
   * 会话进行中切换 countUp 设置只影响下一个会话；UI 派生「正计时/倒计时」
   * 展示应以此字段为准（null = 无进行中的工作会话，回退 settings.countUp）。
   */
  sessionCountUp: boolean | null;
  settings: PomodoroSettings;
  completedPomodorosToday: number;
  lastActiveDate: string | null;
  isImmersive: boolean;
  /** 环境音是否开启（应用级共享，非持久化——重启后不自动恢复播放） */
  noiseEnabled: boolean;
  /** 连续达成每日目标的天数（持久化，供 UI 展示 streak） */
  streakDays: number;
  /** 最近一次达成每日目标的本地日期（Date#toDateString 格式，持久化） */
  lastGoalMetDate: string | null;
  /** 结束前提醒已触发的阶段标识（= phaseEndsAt；非持久化） */
  endReminderFiredPhase: number | null;

  // Actions
  start: (taskId?: string, taskTitle?: string) => void;
  pause: () => void;
  resume: () => void;
  stop: (interrupted?: boolean) => void;
  /**
   * 跳过休息：break 阶段直接结束——autoStartWork 开启时立即开始下一个番茄，
   * 否则回 idle 待命。不写任何记录（跳过休息不是「中断」）。
   */
  skipBreak: () => void;
  /** 等待由 stop/switch/complete 触发的后端记录落盘；普通 UI 无需调用。 */
  flushPendingRecords: () => Promise<void>;
  tick: () => void;
  /** 墙钟矫正：rehydrate / visibilitychange / focus 时调用 */
  syncWallClock: () => void;
  completeCurrentSession: (options?: PomodoroCompleteOptions) => void;
  updateSettings: (settings: Partial<PomodoroSettings>) => void;
  setImmersive: (value: boolean) => void;
  /** 开/关环境音（内部驱动 noiseEngine，参数取 settings.noiseType/noiseVolume） */
  setNoiseEnabled: (on: boolean) => void;
}
