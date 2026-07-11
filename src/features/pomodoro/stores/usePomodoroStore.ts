import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import i18n from '@/i18n';
import type { PomodoroState, PomodoroMode, PomodoroSettings } from '../types';
import { DEFAULT_POMODORO_SETTINGS } from '../types';
import { createPomodoroRecord } from '../api';

// ★ I2 修复：阶段完成时发送系统通知（应用在后台时用户也能感知）
// ★ 8.1 统一通知策略：默认 background 档（前台时有声音+UI 反馈，无需系统通知）
const sendSystemNotification = async (title: string, body: string) => {
  const { sendSystemNotification: send } = await import('@/utils/systemNotification');
  await send(title, body);
};

const playNotificationSound = (volume = 1) => {
  try {
    const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    oscillator.type = 'sine';
    oscillator.frequency.value = 800;

    gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
    gainNode.gain.linearRampToValueAtTime(volume, audioCtx.currentTime + 0.01);
    gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 1);

    oscillator.start(audioCtx.currentTime);
    oscillator.stop(audioCtx.currentTime + 1);
  } catch (e) {
    console.error('Failed to play notification sound', e);
  }
};

// 结束前提醒：每个倒计时阶段只触发一次（以 phaseEndsAt 为阶段标识，非持久化）
let endReminderFiredPhase: number | null = null;

type RecordOutcome = { error?: unknown };
const pendingRecordRequests = new Set<Promise<RecordOutcome>>();

/** Record a pomodoro session. UI calls remain fire-and-forget; ACR can flush the boundary. */
const recordSession = (
  todoItemId: string | null,
  startTime: string,
  duration: number,
  actualDuration: number,
  type: 'work' | 'short_break' | 'long_break',
  status: 'completed' | 'interrupted',
) => {
  const endTime = new Date().toISOString();
  const request = createPomodoroRecord({
    todoItemId: todoItemId ?? undefined,
    startTime,
    endTime,
    duration,
    actualDuration: Math.max(0, actualDuration),
    type,
    status,
  });
  const outcome = request
    .then(() => ({}) as RecordOutcome)
    .catch((error) => {
      console.error('[Pomodoro] Failed to record session:', error);
      return { error };
    });
  pendingRecordRequests.add(outcome);
  void outcome.finally(() => pendingRecordRequests.delete(outcome));
  outcome.then((result) => {
    if (!result.error) {
      // ★ I11 修复：完成的工作番茄会在后端递增 todo_items.completed_pomodoros，
      // 记录成功后刷新 todo 视图，让计数立即反映到 UI
      if (todoItemId && type === 'work' && status === 'completed') {
        void import('@/features/todo/stores/useTodoStore')
          .then(({ useTodoStore }) => useTodoStore.getState().reloadCurrentView())
          .catch(() => {});
      }
    }
  });
};

async function flushPendingRecords(): Promise<void> {
  const requests = [...pendingRecordRequests];
  const outcomes = await Promise.all(requests);
  const errors = outcomes.flatMap((outcome) =>
    outcome.error === undefined ? [] : [outcome.error],
  );
  if (errors.length > 0) {
    const first = errors[0];
    const detail = first instanceof Error ? first.message : String(first);
    throw new Error(
      errors.length > 1 ? `${detail}（另有 ${errors.length - 1} 条失败）` : detail,
    );
  }
}

const localToday = () => new Date().toDateString();

/** 运行中阶段的真实剩余秒数（墙钟基准，不受定时器节流影响） */
const wallClockRemaining = (phaseEndsAt: number | null, fallback: number): number => {
  if (phaseEndsAt == null) return fallback;
  return Math.max(0, Math.ceil((phaseEndsAt - Date.now()) / 1000));
};

/** 正计时阶段的已专注秒数（phaseStartedAt 已折算暂停时间） */
const countUpElapsed = (phaseStartedAt: number | null, fallback: number): number => {
  if (phaseStartedAt == null) return fallback;
  return Math.max(0, Math.floor((Date.now() - phaseStartedAt) / 1000));
};

const phaseDuration = (mode: PomodoroMode, settings: PomodoroSettings): number => {
  switch (mode) {
    case 'work':
      return settings.workDuration;
    case 'short_break':
      return settings.shortBreak;
    case 'long_break':
      return settings.longBreak;
    default:
      return settings.workDuration;
  }
};

export const usePomodoroStore = create<PomodoroState>()(
  persist(
    (set, get) => ({
      mode: 'idle',
      status: 'paused',
      timeLeft: DEFAULT_POMODORO_SETTINGS.workDuration,
      phaseEndsAt: null,
      phaseStartedAt: null,
      currentTaskId: null,
      currentTaskTitle: null,
      sessionStartTime: null,
      settings: DEFAULT_POMODORO_SETTINGS,
      completedPomodorosToday: 0,
      lastActiveDate: null,
      isImmersive: false,

      start: (taskId?: string, taskTitle?: string) => {
        const {
          mode,
          status,
          settings,
          currentTaskId,
          sessionStartTime,
          phaseEndsAt,
          phaseStartedAt,
          timeLeft,
          lastActiveDate,
          completedPomodorosToday,
        } = get();

        const today = localToday();
        const shouldReset = lastActiveDate !== today;
        const baseCount = shouldReset ? 0 : completedPomodorosToday;

        const beginWork = () => {
          const isCountUp = settings.countUp;
          set({
            mode: 'work',
            status: 'running',
            timeLeft: isCountUp ? 0 : settings.workDuration,
            phaseEndsAt: isCountUp ? null : Date.now() + settings.workDuration * 1000,
            phaseStartedAt: isCountUp ? Date.now() : null,
            currentTaskId: taskId || null,
            currentTaskTitle: taskTitle || null,
            sessionStartTime: new Date().toISOString(),
            completedPomodorosToday: baseCount,
            lastActiveDate: today,
          });
        };

        if (mode === 'idle') {
          beginWork();
          return;
        }

        // 选择了另一个任务：结束当前工作（记录已专注的部分为 interrupted），
        // 立即为新任务开启新番茄——而不是静默忽略新任务
        const isSwitchingTask = !!taskId && taskId !== currentTaskId;
        if (isSwitchingTask) {
          if (mode === 'work' && sessionStartTime) {
            const isCountUpPhase = phaseStartedAt != null || (status === 'paused' && phaseEndsAt == null && settings.countUp);
            if (isCountUpPhase) {
              const elapsed = status === 'running' ? countUpElapsed(phaseStartedAt, timeLeft) : timeLeft;
              if (elapsed > 0) {
                recordSession(currentTaskId, sessionStartTime, elapsed, elapsed, 'work', 'interrupted');
              }
            } else {
              const remaining =
                status === 'running' ? wallClockRemaining(phaseEndsAt, timeLeft) : timeLeft;
              const actualDuration = settings.workDuration - remaining;
              if (actualDuration > 0) {
                recordSession(
                  currentTaskId,
                  sessionStartTime,
                  settings.workDuration,
                  actualDuration,
                  'work',
                  'interrupted',
                );
              }
            }
          }
          beginWork();
          return;
        }

        // 同任务/无任务：恢复当前阶段
        get().resume();
      },

      pause: () => {
        const { status, mode, phaseEndsAt, phaseStartedAt, timeLeft, settings } = get();
        if (status !== 'running') return;
        // 严格模式：专注阶段不可暂停（对标番茄ToDo 强制专注）
        if (settings.strictMode && mode === 'work') return;
        if (phaseStartedAt != null) {
          // 正计时：冻结已专注秒数
          set({
            status: 'paused',
            timeLeft: countUpElapsed(phaseStartedAt, timeLeft),
            phaseStartedAt: null,
          });
          return;
        }
        set({
          status: 'paused',
          timeLeft: wallClockRemaining(phaseEndsAt, timeLeft),
          phaseEndsAt: null,
        });
      },

      resume: () => {
        const { sessionStartTime, timeLeft, status, mode, settings } = get();
        if (status === 'running') return;
        // 正计时工作阶段：以「已专注秒数」反推起算时刻
        const isCountUpWork = mode === 'work' && settings.countUp;
        set({
          status: 'running',
          phaseEndsAt: isCountUpWork ? null : Date.now() + Math.max(0, timeLeft) * 1000,
          phaseStartedAt: isCountUpWork ? Date.now() - Math.max(0, timeLeft) * 1000 : null,
          sessionStartTime: sessionStartTime || new Date().toISOString(),
          lastActiveDate: localToday(),
        });
      },

      stop: (interrupted = true) => {
        const {
          mode,
          status,
          currentTaskId,
          settings,
          sessionStartTime,
          phaseEndsAt,
          phaseStartedAt,
          timeLeft,
        } = get();

        if (interrupted && mode === 'work' && sessionStartTime) {
          if (phaseStartedAt != null || (phaseEndsAt == null && status === 'paused' && settings.countUp)) {
            // 正计时：已专注秒数即实际时长
            const elapsed = status === 'running' ? countUpElapsed(phaseStartedAt, timeLeft) : timeLeft;
            if (elapsed > 0) {
              recordSession(currentTaskId, sessionStartTime, elapsed, elapsed, 'work', 'interrupted');
            }
          } else {
            const remaining =
              status === 'running' ? wallClockRemaining(phaseEndsAt, timeLeft) : timeLeft;
            const actualDuration = settings.workDuration - remaining;
            if (actualDuration > 0) {
              recordSession(
                currentTaskId,
                sessionStartTime,
                settings.workDuration,
                actualDuration,
                'work',
                'interrupted',
              );
            }
          }
        }

        set({
          mode: 'idle',
          status: 'paused',
          timeLeft: settings.countUp ? 0 : settings.workDuration,
          phaseEndsAt: null,
          phaseStartedAt: null,
          currentTaskId: null,
          currentTaskTitle: null,
          sessionStartTime: null,
        });
      },

      flushPendingRecords,

      tick: () => {
        const { status, phaseEndsAt, phaseStartedAt, timeLeft, settings, mode } = get();
        if (status !== 'running') return;

        // 正计时：向上累加，无自动完成
        if (phaseStartedAt != null) {
          const elapsed = countUpElapsed(phaseStartedAt, timeLeft);
          if (elapsed !== timeLeft) {
            set({ timeLeft: elapsed });
          }
          return;
        }

        const remaining = wallClockRemaining(phaseEndsAt, timeLeft);

        // 结束前提醒：剩余进入阈值窗口时轻提示一次（每阶段一次）
        if (
          settings.endReminderSeconds > 0 &&
          phaseEndsAt != null &&
          remaining > 0 &&
          remaining <= settings.endReminderSeconds &&
          endReminderFiredPhase !== phaseEndsAt
        ) {
          endReminderFiredPhase = phaseEndsAt;
          playNotificationSound(0.35);
          void sendSystemNotification(
            i18n.t('todo:pomodoro.notifications.endReminderTitle'),
            i18n.t(
              mode === 'work'
                ? 'todo:pomodoro.notifications.endReminderBodyWork'
                : 'todo:pomodoro.notifications.endReminderBodyBreak',
              { minutes: Math.max(1, Math.ceil(remaining / 60)) },
            ),
          );
        }

        if (remaining <= 0) {
          get().completeCurrentSession();
        } else if (remaining !== timeLeft) {
          set({ timeLeft: remaining });
        }
      },

      // 墙钟矫正：应用重启 rehydrate、窗口重新可见、系统休眠唤醒后调用。
      // 运行中已超时 → 直接按完成处理（计时基于 phaseEndsAt，离线期间也在走）
      syncWallClock: () => {
        const { status, phaseEndsAt, phaseStartedAt, timeLeft, mode } = get();
        if (status !== 'running' || mode === 'idle') return;

        if (phaseStartedAt != null) {
          const elapsed = countUpElapsed(phaseStartedAt, timeLeft);
          if (elapsed !== timeLeft) {
            set({ timeLeft: elapsed });
          }
          return;
        }

        if (phaseEndsAt == null) return;
        const remaining = wallClockRemaining(phaseEndsAt, timeLeft);
        if (remaining <= 0) {
          get().completeCurrentSession();
        } else if (remaining !== timeLeft) {
          set({ timeLeft: remaining });
        }
      },

      completeCurrentSession: () => {
        const {
          mode,
          status,
          settings,
          completedPomodorosToday,
          lastActiveDate,
          currentTaskId,
          sessionStartTime,
          phaseStartedAt,
          timeLeft,
        } = get();

        playNotificationSound();

        if (mode === 'work') {
          // 正计时手动完成：实际时长 = 已专注秒数；倒计时 = 设定工作时长
          const isCountUpPhase = phaseStartedAt != null || (settings.countUp && get().phaseEndsAt == null);
          const workSeconds = isCountUpPhase
            ? (status === 'running' ? countUpElapsed(phaseStartedAt, timeLeft) : timeLeft)
            : settings.workDuration;

          // 跨午夜完成：当天计数从 1 重新开始。正计时不足 1 分钟不计数（防误触）
          const today = localToday();
          const countsAsPomodoro = !isCountUpPhase || workSeconds >= 60;
          const base = lastActiveDate === today ? completedPomodorosToday : 0;
          const newCompletedCount = countsAsPomodoro ? base + 1 : base;

          const isLongBreak =
            newCompletedCount > 0 && newCompletedCount % settings.longBreakInterval === 0;
          const nextMode: PomodoroMode = isLongBreak ? 'long_break' : 'short_break';
          const nextTimeLeft = isLongBreak ? settings.longBreak : settings.shortBreak;

          // Record completed work session to backend
          if (sessionStartTime && workSeconds > 0) {
            recordSession(
              currentTaskId,
              sessionStartTime,
              isCountUpPhase ? workSeconds : settings.workDuration,
              workSeconds,
              'work',
              'completed',
            );
          }

          // ★ I2 修复：系统通知（达成每日目标时换庆祝文案）。
          // 用"跨越阈值"判断而非严格相等：目标在当日中途被调高/调低后，
          // 计数可能跳过 === 的精确命中点；base < goal <= new 保证当日只庆祝一次
          const reachedDailyGoal =
            settings.dailyGoal > 0 &&
            countsAsPomodoro &&
            base < settings.dailyGoal &&
            newCompletedCount >= settings.dailyGoal;
          void sendSystemNotification(
            i18n.t(
              reachedDailyGoal
                ? 'todo:pomodoro.notifications.dailyGoalTitle'
                : 'todo:pomodoro.notifications.workCompleteTitle',
            ),
            i18n.t(
              reachedDailyGoal
                ? 'todo:pomodoro.notifications.dailyGoalBody'
                : 'todo:pomodoro.notifications.workCompleteBody',
              { value: newCompletedCount },
            ),
          );

          const autoStart = settings.autoStartBreaks;
          set({
            completedPomodorosToday: newCompletedCount,
            lastActiveDate: today,
            mode: nextMode,
            status: autoStart ? 'running' : 'paused',
            timeLeft: nextTimeLeft,
            phaseEndsAt: autoStart ? Date.now() + nextTimeLeft * 1000 : null,
            phaseStartedAt: null,
            sessionStartTime: new Date().toISOString(),
          });
        } else {
          // Break completed — record it too
          const breakType: 'short_break' | 'long_break' =
            mode === 'long_break' ? 'long_break' : 'short_break';
          const breakDuration = mode === 'long_break' ? settings.longBreak : settings.shortBreak;
          if (sessionStartTime) {
            recordSession(null, sessionStartTime, breakDuration, breakDuration, breakType, 'completed');
          }

          // ★ I2 修复：系统通知
          void sendSystemNotification(
            i18n.t('todo:pomodoro.notifications.breakCompleteTitle'),
            i18n.t('todo:pomodoro.notifications.breakCompleteBody'),
          );

          if (settings.autoStartWork) {
            // 自动开始下一个番茄（沿用当前任务）
            const isCountUp = settings.countUp;
            set({
              mode: 'work',
              status: 'running',
              timeLeft: isCountUp ? 0 : settings.workDuration,
              phaseEndsAt: isCountUp ? null : Date.now() + settings.workDuration * 1000,
              phaseStartedAt: isCountUp ? Date.now() : null,
              sessionStartTime: new Date().toISOString(),
              lastActiveDate: localToday(),
            });
          } else {
            set({
              mode: 'idle',
              status: 'paused',
              timeLeft: settings.countUp ? 0 : settings.workDuration,
              phaseEndsAt: null,
              phaseStartedAt: null,
              sessionStartTime: null,
            });
          }
        }
      },

      updateSettings: (newSettings) => {
        set((state) => {
          const merged = { ...state.settings, ...newSettings };
          // 防呆：时长至少 1 分钟，间隔至少 1
          merged.workDuration = Math.max(60, merged.workDuration);
          merged.shortBreak = Math.max(60, merged.shortBreak);
          merged.longBreak = Math.max(60, merged.longBreak);
          merged.longBreakInterval = Math.max(1, Math.round(merged.longBreakInterval));
          merged.endReminderSeconds = Math.max(0, Math.round(merged.endReminderSeconds));
          merged.noiseVolume = Math.max(0, Math.min(1, merged.noiseVolume));
          merged.dailyGoal = Math.max(0, Math.min(99, Math.round(merged.dailyGoal)));

          const next: Partial<PomodoroState> = { settings: merged };
          // 空闲态同步显示新的工作时长（正计时模式空闲显示 0）
          if (state.mode === 'idle') {
            next.timeLeft = merged.countUp ? 0 : merged.workDuration;
          }
          return next as PomodoroState;
        });
      },

      setImmersive: (value: boolean) => {
        set({ isImmersive: value });
      },
    }),
    {
      name: 'pomodoro-storage',
      // 持久化运行状态：应用重启后可恢复进行中的番茄
      //（计时基于 phaseEndsAt 墙钟，重启期间时间照常流逝）
      partialize: (state) => ({
        mode: state.mode,
        status: state.status,
        timeLeft: state.timeLeft,
        phaseEndsAt: state.phaseEndsAt,
        phaseStartedAt: state.phaseStartedAt,
        currentTaskId: state.currentTaskId,
        currentTaskTitle: state.currentTaskTitle,
        sessionStartTime: state.sessionStartTime,
        settings: state.settings,
        completedPomodorosToday: state.completedPomodorosToday,
        lastActiveDate: state.lastActiveDate,
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<PomodoroState>;
        return {
          ...current,
          ...p,
          // 旧版本 settings 缺少新增字段时回填默认值
          settings: { ...DEFAULT_POMODORO_SETTINGS, ...(p.settings ?? {}) },
        };
      },
    },
  ),
);
