import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import i18n from '@/i18n';
import type { PomodoroState, PomodoroMode, PomodoroSettings } from '../types';
import { DEFAULT_POMODORO_SETTINGS } from '../types';
import { createPomodoroRecord } from '../api';

// ★ I2 修复：阶段完成时发送系统通知（应用在后台时用户也能感知）
const sendSystemNotification = async (title: string, body: string) => {
  try {
    const { isPermissionGranted, requestPermission, sendNotification } = await import(
      '@tauri-apps/plugin-notification'
    );
    let granted = await isPermissionGranted();
    if (!granted) {
      granted = (await requestPermission()) === 'granted';
    }
    if (granted) {
      sendNotification({ title, body });
    }
  } catch (e) {
    console.warn('[Pomodoro] System notification failed:', e);
  }
};

const playNotificationSound = () => {
  try {
    const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    oscillator.type = 'sine';
    oscillator.frequency.value = 800;

    gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
    gainNode.gain.linearRampToValueAtTime(1, audioCtx.currentTime + 0.01);
    gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 1);

    oscillator.start(audioCtx.currentTime);
    oscillator.stop(audioCtx.currentTime + 1);
  } catch (e) {
    console.error('Failed to play notification sound', e);
  }
};

/** Record a pomodoro session to the backend (fire-and-forget) */
const recordSession = (
  todoItemId: string | null,
  startTime: string,
  duration: number,
  actualDuration: number,
  type: 'work' | 'short_break' | 'long_break',
  status: 'completed' | 'interrupted',
) => {
  const endTime = new Date().toISOString();
  createPomodoroRecord({
    todoItemId: todoItemId ?? undefined,
    startTime,
    endTime,
    duration,
    actualDuration: Math.max(0, actualDuration),
    type,
    status,
  })
    .then(() => {
      // ★ I11 修复：完成的工作番茄会在后端递增 todo_items.completed_pomodoros，
      // 记录成功后刷新 todo 视图，让计数立即反映到 UI
      if (todoItemId && type === 'work' && status === 'completed') {
        void import('@/features/todo/stores/useTodoStore')
          .then(({ useTodoStore }) => useTodoStore.getState().reloadCurrentView())
          .catch(() => {});
      }
    })
    .catch((err) => {
      console.error('[Pomodoro] Failed to record session:', err);
    });
};

const localToday = () => new Date().toDateString();

/** 运行中阶段的真实剩余秒数（墙钟基准，不受定时器节流影响） */
const wallClockRemaining = (phaseEndsAt: number | null, fallback: number): number => {
  if (phaseEndsAt == null) return fallback;
  return Math.max(0, Math.ceil((phaseEndsAt - Date.now()) / 1000));
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
          timeLeft,
          lastActiveDate,
          completedPomodorosToday,
        } = get();

        const today = localToday();
        const shouldReset = lastActiveDate !== today;
        const baseCount = shouldReset ? 0 : completedPomodorosToday;

        const beginWork = () => {
          set({
            mode: 'work',
            status: 'running',
            timeLeft: settings.workDuration,
            phaseEndsAt: Date.now() + settings.workDuration * 1000,
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
          beginWork();
          return;
        }

        // 同任务/无任务：恢复当前阶段
        get().resume();
      },

      pause: () => {
        const { status, phaseEndsAt, timeLeft } = get();
        if (status !== 'running') return;
        set({
          status: 'paused',
          timeLeft: wallClockRemaining(phaseEndsAt, timeLeft),
          phaseEndsAt: null,
        });
      },

      resume: () => {
        const { sessionStartTime, timeLeft, status } = get();
        if (status === 'running') return;
        set({
          status: 'running',
          phaseEndsAt: Date.now() + Math.max(0, timeLeft) * 1000,
          sessionStartTime: sessionStartTime || new Date().toISOString(),
          lastActiveDate: localToday(),
        });
      },

      stop: (interrupted = true) => {
        const { mode, status, currentTaskId, settings, sessionStartTime, phaseEndsAt, timeLeft } =
          get();

        if (interrupted && mode === 'work' && sessionStartTime) {
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

        set({
          mode: 'idle',
          status: 'paused',
          timeLeft: settings.workDuration,
          phaseEndsAt: null,
          currentTaskId: null,
          currentTaskTitle: null,
          sessionStartTime: null,
        });
      },

      tick: () => {
        const { status, phaseEndsAt, timeLeft } = get();
        if (status !== 'running') return;

        const remaining = wallClockRemaining(phaseEndsAt, timeLeft);
        if (remaining <= 0) {
          get().completeCurrentSession();
        } else if (remaining !== timeLeft) {
          set({ timeLeft: remaining });
        }
      },

      // 墙钟矫正：应用重启 rehydrate、窗口重新可见、系统休眠唤醒后调用。
      // 运行中已超时 → 直接按完成处理（计时基于 phaseEndsAt，离线期间也在走）
      syncWallClock: () => {
        const { status, phaseEndsAt, timeLeft, mode } = get();
        if (status !== 'running' || mode === 'idle' || phaseEndsAt == null) return;

        const remaining = wallClockRemaining(phaseEndsAt, timeLeft);
        if (remaining <= 0) {
          get().completeCurrentSession();
        } else if (remaining !== timeLeft) {
          set({ timeLeft: remaining });
        }
      },

      completeCurrentSession: () => {
        const { mode, settings, completedPomodorosToday, lastActiveDate, currentTaskId, sessionStartTime } =
          get();

        playNotificationSound();

        if (mode === 'work') {
          // 跨午夜完成：当天计数从 1 重新开始
          const today = localToday();
          const newCompletedCount = lastActiveDate === today ? completedPomodorosToday + 1 : 1;

          const isLongBreak = newCompletedCount % settings.longBreakInterval === 0;
          const nextMode: PomodoroMode = isLongBreak ? 'long_break' : 'short_break';
          const nextTimeLeft = isLongBreak ? settings.longBreak : settings.shortBreak;

          // Record completed work session to backend
          if (sessionStartTime) {
            recordSession(
              currentTaskId,
              sessionStartTime,
              settings.workDuration,
              settings.workDuration,
              'work',
              'completed',
            );
          }

          // ★ I2 修复：系统通知
          void sendSystemNotification(
            i18n.t('todo:pomodoro.notifications.workCompleteTitle'),
            i18n.t('todo:pomodoro.notifications.workCompleteBody', { value: newCompletedCount }),
          );

          const autoStart = settings.autoStartBreaks;
          set({
            completedPomodorosToday: newCompletedCount,
            lastActiveDate: today,
            mode: nextMode,
            status: autoStart ? 'running' : 'paused',
            timeLeft: nextTimeLeft,
            phaseEndsAt: autoStart ? Date.now() + nextTimeLeft * 1000 : null,
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
            set({
              mode: 'work',
              status: 'running',
              timeLeft: settings.workDuration,
              phaseEndsAt: Date.now() + settings.workDuration * 1000,
              sessionStartTime: new Date().toISOString(),
              lastActiveDate: localToday(),
            });
          } else {
            set({
              mode: 'idle',
              status: 'paused',
              timeLeft: settings.workDuration,
              phaseEndsAt: null,
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

          const next: Partial<PomodoroState> = { settings: merged };
          // 空闲态同步显示新的工作时长
          if (state.mode === 'idle') {
            next.timeLeft = merged.workDuration;
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
