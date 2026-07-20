import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import i18n from '@/i18n';
import type {
  PomodoroState,
  PomodoroMode,
  PomodoroCompleteOptions,
} from '../types';
import { DEFAULT_POMODORO_SETTINGS } from '../types';
import { createPomodoroRecord } from '../api';
import { noiseEngine } from '../noiseEngine';

// ★ I2 修复：阶段完成时发送系统通知（应用在后台时用户也能感知）
// ★ 8.1 统一通知策略：默认 background 档（前台时有声音+UI 反馈，无需系统通知）
// 通知失败静默吞掉：通知只是增强，绝不能让状态机流程抛未处理拒绝
const sendSystemNotification = async (title: string, body: string) => {
  try {
    const { sendSystemNotification: send } = await import('@/utils/systemNotification');
    await send(title, body);
  } catch {
    /* ignore */
  }
};

type ChimeKind = 'work-complete' | 'break-complete' | 'reminder';

/**
 * 提示音共享 AudioContext：懒创建、跨提示音复用。
 * 每次 new AudioContext 在部分平台（Safari/WebKit）有实例数上限，
 * 高频提示（结束前提醒 + 完成音）反复建销上下文既浪费也有失败风险。
 */
let chimeCtx: AudioContext | null = null;
const getChimeContext = (): AudioContext => {
  if (!chimeCtx || chimeCtx.state === 'closed') {
    chimeCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  }
  if (chimeCtx.state === 'suspended') {
    void chimeCtx.resume().catch(() => {});
  }
  return chimeCtx;
};

/**
 * 提示音（WebAudio 合成，无资源文件）：
 * - work-complete：三角波上行三连音（C5-E5-G5 大三和弦琶音），庆祝感
 * - break-complete：正弦波上行双音（D5-A5），轻快提醒回到专注
 * - reminder：单个短促柔和正弦音，结束前轻提示
 */
const playChime = (kind: ChimeKind, volume = 1) => {
  try {
    const ctx = getChimeContext();
    const spec: { type: OscillatorType; notes: Array<[number, number]>; decay: number } =
      kind === 'work-complete'
        ? { type: 'triangle', notes: [[523.25, 0], [659.25, 0.16], [783.99, 0.32]], decay: 0.9 }
        : kind === 'break-complete'
          ? { type: 'sine', notes: [[587.33, 0], [880, 0.18]], decay: 0.7 }
          : { type: 'sine', notes: [[660, 0]], decay: 0.45 };

    for (const [freq, at] of spec.notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = spec.type;
      osc.frequency.value = freq;
      osc.connect(gain);
      gain.connect(ctx.destination);
      const t0 = ctx.currentTime + at;
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(volume * 0.8, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + spec.decay);
      osc.start(t0);
      osc.stop(t0 + spec.decay + 0.05);
      // 播完自动断开，共享上下文常驻不积累节点
      osc.onended = () => {
        osc.disconnect();
        gain.disconnect();
      };
    }
  } catch (e) {
    console.error('Failed to play notification sound', e);
  }
};

/** 墙钟跳变超过该值视为「离开」（休眠/合盖）：完成阶段但温和提示、不自动连锁开下一阶段 */
const AWAY_JUMP_MS = 5 * 60 * 1000;

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

const localYesterday = () => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toDateString();
};

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
      sessionCountUp: null,
      phaseExtraSeconds: 0,
      settings: DEFAULT_POMODORO_SETTINGS,
      completedPomodorosToday: 0,
      lastActiveDate: null,
      isImmersive: false,
      noiseEnabled: false,
      streakDays: 0,
      lastGoalMetDate: null,
      endReminderFiredPhase: null,

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
          sessionCountUp,
          phaseExtraSeconds,
        } = get();

        const today = localToday();
        const shouldReset = lastActiveDate !== today;
        const baseCount = shouldReset ? 0 : completedPomodorosToday;

        const beginWork = () => {
          // 会话开始时锁定计时模式：中途改 countUp 设置只影响下一个会话
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
            sessionCountUp: isCountUp,
            phaseExtraSeconds: 0,
            completedPomodorosToday: baseCount,
            lastActiveDate: today,
            endReminderFiredPhase: null,
          });
          // 环境音跟随专注：专注开始自动播放
          if (settings.noiseAutoWithFocus) {
            get().setNoiseEnabled(true);
          }
        };

        if (mode === 'idle') {
          beginWork();
          return;
        }

        // 休息阶段带任务点「开始」：用户意图显然是「开始专注」而非恢复休息——
        // 直接跳过剩余休息开新番茄（跳过休息不是中断，不写记录）
        if ((mode === 'short_break' || mode === 'long_break') && taskId) {
          beginWork();
          return;
        }

        // 选择了另一个任务：结束当前工作（记录已专注的部分为 interrupted），
        // 立即为新任务开启新番茄——而不是静默忽略新任务
        const isSwitchingTask = !!taskId && taskId !== currentTaskId;
        if (isSwitchingTask) {
          if (mode === 'work' && sessionStartTime) {
            // 以会话锁定的计时模式为准；旧持久化状态（无锁定字段）回退运行时特征推断
            const isCountUpPhase =
              sessionCountUp ??
              (phaseStartedAt != null || (status === 'paused' && phaseEndsAt == null && settings.countUp));
            if (isCountUpPhase) {
              const elapsed = status === 'running' ? countUpElapsed(phaseStartedAt, timeLeft) : timeLeft;
              if (elapsed > 0) {
                recordSession(currentTaskId, sessionStartTime, elapsed, elapsed, 'work', 'interrupted');
              }
            } else {
              // 计划总时长含 extendPhase 加时
              const planned = settings.workDuration + phaseExtraSeconds;
              const remaining =
                status === 'running' ? wallClockRemaining(phaseEndsAt, timeLeft) : timeLeft;
              const actualDuration = planned - remaining;
              if (actualDuration > 0) {
                recordSession(
                  currentTaskId,
                  sessionStartTime,
                  planned,
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
        // 环境音在暂停时保持播放（短暂中断维持氛围，见 noiseAutoWithFocus 语义注释）
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
        const {
          sessionStartTime,
          timeLeft,
          status,
          mode,
          settings,
          sessionCountUp,
          lastActiveDate,
          completedPomodorosToday,
        } = get();
        if (status === 'running') return;
        // 空闲态没有可恢复的阶段：直接 resume 会造出 mode='idle' 的幽灵计时，
        // tick 超时后还会走「休息完成」分支——入口一律 start()
        if (mode === 'idle') return;
        // 正计时工作阶段：以「已专注秒数」反推起算时刻。
        // 判断依据是会话锁定的 sessionCountUp（而非实时 settings.countUp），
        // 修复「暂停后切换 countUp 设置再恢复，把剩余秒当已专注秒」的错乱
        const isCountUpWork = mode === 'work' && (sessionCountUp ?? settings.countUp);
        // 跨午夜暂停后恢复：与 start() 的日期翻转一致，先按新的一天把今日计数归零，
        // 否则这里刷新 lastActiveDate 后 completeCurrentSession 会把昨天的计数当今天的底数
        const today = localToday();
        set({
          status: 'running',
          phaseEndsAt: isCountUpWork ? null : Date.now() + Math.max(0, timeLeft) * 1000,
          phaseStartedAt: isCountUpWork ? Date.now() - Math.max(0, timeLeft) * 1000 : null,
          sessionStartTime: sessionStartTime || new Date().toISOString(),
          completedPomodorosToday: lastActiveDate === today ? completedPomodorosToday : 0,
          lastActiveDate: today,
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
          sessionCountUp,
          phaseExtraSeconds,
        } = get();

        if (interrupted && mode === 'work' && sessionStartTime) {
          const isCountUpPhase =
            sessionCountUp ??
            (phaseStartedAt != null || (phaseEndsAt == null && status === 'paused' && settings.countUp));
          if (isCountUpPhase) {
            // 正计时：已专注秒数即实际时长
            const elapsed = status === 'running' ? countUpElapsed(phaseStartedAt, timeLeft) : timeLeft;
            if (elapsed > 0) {
              recordSession(currentTaskId, sessionStartTime, elapsed, elapsed, 'work', 'interrupted');
            }
          } else {
            // 计划总时长含 extendPhase 加时
            const planned = settings.workDuration + phaseExtraSeconds;
            const remaining =
              status === 'running' ? wallClockRemaining(phaseEndsAt, timeLeft) : timeLeft;
            const actualDuration = planned - remaining;
            if (actualDuration > 0) {
              recordSession(
                currentTaskId,
                sessionStartTime,
                planned,
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
          sessionCountUp: null,
          phaseExtraSeconds: 0,
          endReminderFiredPhase: null,
        });
        // 环境音跟随专注：停止（含 ACR undo 的 stop(false)）自动停播；手动模式不干预
        if (settings.noiseAutoWithFocus && get().noiseEnabled) {
          get().setNoiseEnabled(false);
        }
      },

      skipBreak: () => {
        const { mode, settings, lastActiveDate, completedPomodorosToday } = get();
        if (mode !== 'short_break' && mode !== 'long_break') return;
        // 跳过休息既不是「完成」也不是「中断」，不写任何记录
        if (settings.autoStartWork) {
          // 直接开始下一个番茄（沿用当前任务，与休息自然结束的 autoStartWork 路径一致）
          const isCountUp = settings.countUp;
          // 休息跨午夜后被跳过：与 start()/resume() 的日期翻转一致，先重置今日计数
          const today = localToday();
          set({
            mode: 'work',
            status: 'running',
            timeLeft: isCountUp ? 0 : settings.workDuration,
            phaseEndsAt: isCountUp ? null : Date.now() + settings.workDuration * 1000,
            phaseStartedAt: isCountUp ? Date.now() : null,
            sessionStartTime: new Date().toISOString(),
            sessionCountUp: isCountUp,
            phaseExtraSeconds: 0,
            completedPomodorosToday: lastActiveDate === today ? completedPomodorosToday : 0,
            lastActiveDate: today,
            endReminderFiredPhase: null,
          });
          if (settings.noiseAutoWithFocus) {
            get().setNoiseEnabled(true);
          }
        } else {
          set({
            mode: 'idle',
            status: 'paused',
            timeLeft: settings.countUp ? 0 : settings.workDuration,
            phaseEndsAt: null,
            phaseStartedAt: null,
            sessionStartTime: null,
            sessionCountUp: null,
            phaseExtraSeconds: 0,
            endReminderFiredPhase: null,
          });
          if (settings.noiseAutoWithFocus && get().noiseEnabled) {
            get().setNoiseEnabled(false);
          }
        }
      },

      extendPhase: (seconds: number) => {
        const {
          mode,
          status,
          phaseEndsAt,
          phaseStartedAt,
          timeLeft,
          phaseExtraSeconds,
          sessionCountUp,
          settings,
        } = get();
        if (mode === 'idle') return;
        // 正计时工作阶段无目标时长，加时没有意义。
        // 运行中以 phaseStartedAt 识别；暂停中 phaseStartedAt 已被冻结置空，
        // 必须再查会话锁定的 sessionCountUp（旧持久化会话回退运行时特征推断）——
        // 否则会把加时秒数误加进 timeLeft（正计时语义下是「已专注秒数」）
        const isCountUpWork =
          mode === 'work' &&
          (sessionCountUp ??
            (phaseStartedAt != null ||
              (phaseEndsAt == null && status === 'paused' && settings.countUp)));
        if (isCountUpWork || phaseStartedAt != null) return;
        const extra = Math.max(0, Math.round(seconds));
        if (extra <= 0) return;
        if (status === 'running' && phaseEndsAt != null) {
          set({
            phaseEndsAt: phaseEndsAt + extra * 1000,
            timeLeft: wallClockRemaining(phaseEndsAt + extra * 1000, timeLeft + extra),
            phaseExtraSeconds: phaseExtraSeconds + extra,
            // 结束时刻变化，本阶段的结束前提醒允许重新触发
            endReminderFiredPhase: null,
          });
        } else {
          set({
            timeLeft: timeLeft + extra,
            phaseExtraSeconds: phaseExtraSeconds + extra,
            endReminderFiredPhase: null,
          });
        }
      },

      flushPendingRecords,

      tick: () => {
        const { status, phaseEndsAt, phaseStartedAt, timeLeft, settings, mode, endReminderFiredPhase } = get();
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

        // 结束前提醒：剩余进入阈值窗口时轻提示一次（每阶段一次，以 phaseEndsAt 标识阶段）
        if (
          settings.endReminderSeconds > 0 &&
          phaseEndsAt != null &&
          remaining > 0 &&
          remaining <= settings.endReminderSeconds &&
          endReminderFiredPhase !== phaseEndsAt
        ) {
          set({ endReminderFiredPhase: phaseEndsAt });
          playChime('reminder', 0.35);
          // 精度修正：≥60s 用四舍五入的分钟数；<60s 改用秒数文案（不再把 30 秒说成 1 分钟）
          const body =
            remaining >= 60
              ? i18n.t(
                  mode === 'work'
                    ? 'todo:pomodoro.notifications.endReminderBodyWork'
                    : 'todo:pomodoro.notifications.endReminderBodyBreak',
                  { minutes: Math.max(1, Math.round(remaining / 60)) },
                )
              : i18n.t(
                  mode === 'work'
                    ? 'todo:pomodoro.notifications.endReminderBodyWorkSeconds'
                    : 'todo:pomodoro.notifications.endReminderBodyBreakSeconds',
                  {
                    seconds: remaining,
                    defaultValue:
                      mode === 'work'
                        ? '专注还剩约 {{seconds}} 秒，准备收尾'
                        : '休息还剩约 {{seconds}} 秒',
                  },
                );
          void sendSystemNotification(
            i18n.t('todo:pomodoro.notifications.endReminderTitle'),
            body,
          );
        }

        if (remaining <= 0) {
          get().completeCurrentSession();
        } else if (remaining !== timeLeft) {
          set({ timeLeft: remaining });
        }
      },

      // 墙钟矫正：应用重启 rehydrate、窗口重新可见、系统休眠唤醒后调用。
      // 运行中已超时 → 按完成处理；超时幅度大（> AWAY_JUMP_MS，典型是长时间休眠）
      // 则走「离开期间完成」温和路径：静音、换文案、不自动连锁开下一阶段
      syncWallClock: () => {
        const { status, phaseEndsAt, phaseStartedAt, timeLeft, mode } = get();
        if (status !== 'running' || mode === 'idle') return;

        if (phaseStartedAt != null) {
          const elapsed = countUpElapsed(phaseStartedAt, timeLeft);
          // 正计时 + 大幅跳变：休眠时间不该算进专注时长，自动暂停并冻结在离开前的秒数
          if ((elapsed - timeLeft) * 1000 > AWAY_JUMP_MS) {
            set({ status: 'paused', phaseStartedAt: null });
            void sendSystemNotification(
              i18n.t('todo:pomodoro.notifications.awayPausedTitle', {
                defaultValue: '专注已自动暂停',
              }),
              i18n.t('todo:pomodoro.notifications.awayPausedBody', {
                defaultValue: '检测到你离开了一段时间，正计时已在离开时暂停，回来后手动继续即可',
              }),
            );
            return;
          }
          if (elapsed !== timeLeft) {
            set({ timeLeft: elapsed });
          }
          return;
        }

        if (phaseEndsAt == null) return;
        const remaining = wallClockRemaining(phaseEndsAt, timeLeft);
        if (remaining <= 0) {
          const overdueMs = Date.now() - phaseEndsAt;
          get().completeCurrentSession(overdueMs > AWAY_JUMP_MS ? { awayMs: overdueMs } : undefined);
        } else if (remaining !== timeLeft) {
          set({ timeLeft: remaining });
        }
      },

      completeCurrentSession: (options?: PomodoroCompleteOptions) => {
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
          sessionCountUp,
          phaseExtraSeconds,
          streakDays,
          lastGoalMetDate,
        } = get();

        // 空闲态无可完成的阶段（防御外部直调：小窗命令 / agent 控制）
        if (mode === 'idle') return;

        // 离开期间完成（休眠唤醒后补记）：不放提示音，避免唤醒瞬间惊吓
        const away = (options?.awayMs ?? 0) > 0;
        if (!away) {
          playChime(mode === 'work' ? 'work-complete' : 'break-complete');
        }

        if (mode === 'work') {
          // 正计时手动完成：实际时长 = 已专注秒数；倒计时 = 设定工作时长。
          // 以会话锁定的计时模式为准，旧持久化状态回退运行时特征推断
          const isCountUpPhase =
            sessionCountUp ??
            (phaseStartedAt != null || (settings.countUp && get().phaseEndsAt == null));
          const workSeconds = isCountUpPhase
            ? (status === 'running' ? countUpElapsed(phaseStartedAt, timeLeft) : timeLeft)
            : settings.workDuration + phaseExtraSeconds;

          // 跨午夜完成：当天计数从 1 重新开始。正计时不足 1 分钟不计数（防误触）
          const today = localToday();
          const countsAsPomodoro = !isCountUpPhase || workSeconds >= 60;
          const base = lastActiveDate === today ? completedPomodorosToday : 0;
          const newCompletedCount = countsAsPomodoro ? base + 1 : base;

          const isLongBreak =
            newCompletedCount > 0 && newCompletedCount % settings.longBreakInterval === 0;
          const nextMode: PomodoroMode = isLongBreak ? 'long_break' : 'short_break';
          const nextTimeLeft = isLongBreak ? settings.longBreak : settings.shortBreak;

          // 统计口径一致：不计番茄的（正计时 <60s）也不算 completed，记为 interrupted，
          // 与「今日番茄数」及后端 completed_pomodoros 递增口径对齐
          if (sessionStartTime && workSeconds > 0) {
            recordSession(
              currentTaskId,
              sessionStartTime,
              workSeconds,
              workSeconds,
              'work',
              countsAsPomodoro ? 'completed' : 'interrupted',
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

          // streak：达成每日目标时更新连续天数（昨天也达成 → +1，否则重置为 1）
          let nextStreakDays = streakDays;
          let nextGoalMetDate = lastGoalMetDate;
          if (reachedDailyGoal && lastGoalMetDate !== today) {
            nextStreakDays = lastGoalMetDate === localYesterday() ? streakDays + 1 : 1;
            nextGoalMetDate = today;
          }

          void sendSystemNotification(
            away
              ? i18n.t('todo:pomodoro.notifications.awayWorkCompleteTitle', {
                  defaultValue: '番茄已完成',
                })
              : i18n.t(
                  reachedDailyGoal
                    ? 'todo:pomodoro.notifications.dailyGoalTitle'
                    : 'todo:pomodoro.notifications.workCompleteTitle',
                ),
            away
              ? i18n.t('todo:pomodoro.notifications.awayWorkCompleteBody', {
                  value: newCompletedCount,
                  defaultValue:
                    '这个番茄在你离开期间完成了（今日 {{value}} 个）。休息计时未自动开始',
                })
              : i18n.t(
                  reachedDailyGoal
                    ? 'todo:pomodoro.notifications.dailyGoalBody'
                    : 'todo:pomodoro.notifications.workCompleteBody',
                  { value: newCompletedCount },
                ),
          );

          // 离开期间完成：不自动开始休息，避免唤醒后发现休息也早已「跑完」的连锁错乱
          const autoStart = !away && settings.autoStartBreaks;
          set({
            completedPomodorosToday: newCompletedCount,
            lastActiveDate: today,
            mode: nextMode,
            status: autoStart ? 'running' : 'paused',
            timeLeft: nextTimeLeft,
            phaseEndsAt: autoStart ? Date.now() + nextTimeLeft * 1000 : null,
            phaseStartedAt: null,
            sessionStartTime: new Date().toISOString(),
            sessionCountUp: null,
            phaseExtraSeconds: 0,
            endReminderFiredPhase: null,
            streakDays: nextStreakDays,
            lastGoalMetDate: nextGoalMetDate,
          });
          // 环境音跟随专注：进入休息自动停播
          if (settings.noiseAutoWithFocus && get().noiseEnabled) {
            get().setNoiseEnabled(false);
          }
        } else {
          // Break completed — record it too
          const breakType: 'short_break' | 'long_break' =
            mode === 'long_break' ? 'long_break' : 'short_break';
          const breakDuration =
            (mode === 'long_break' ? settings.longBreak : settings.shortBreak) + phaseExtraSeconds;
          if (sessionStartTime) {
            recordSession(null, sessionStartTime, breakDuration, breakDuration, breakType, 'completed');
          }

          void sendSystemNotification(
            away
              ? i18n.t('todo:pomodoro.notifications.awayBreakCompleteTitle', {
                  defaultValue: '休息已结束',
                })
              : i18n.t('todo:pomodoro.notifications.breakCompleteTitle'),
            away
              ? i18n.t('todo:pomodoro.notifications.awayBreakCompleteBody', {
                  defaultValue: '休息在你离开期间结束了，准备好后手动开始下一个番茄',
                })
              : i18n.t('todo:pomodoro.notifications.breakCompleteBody'),
          );

          // 离开期间结束：不自动开始下一个番茄（否则唤醒瞬间「已专注」一大段幽灵时间）
          if (!away && settings.autoStartWork) {
            // 自动开始下一个番茄（沿用当前任务）
            const isCountUp = settings.countUp;
            // 休息阶段跨午夜自然结束：与 start()/resume() 的日期翻转一致，先重置今日计数
            const nextToday = localToday();
            const { lastActiveDate: lad, completedPomodorosToday: cpt } = get();
            set({
              mode: 'work',
              status: 'running',
              timeLeft: isCountUp ? 0 : settings.workDuration,
              phaseEndsAt: isCountUp ? null : Date.now() + settings.workDuration * 1000,
              phaseStartedAt: isCountUp ? Date.now() : null,
              sessionStartTime: new Date().toISOString(),
              sessionCountUp: isCountUp,
              phaseExtraSeconds: 0,
              completedPomodorosToday: lad === nextToday ? cpt : 0,
              lastActiveDate: nextToday,
              endReminderFiredPhase: null,
            });
            if (settings.noiseAutoWithFocus) {
              get().setNoiseEnabled(true);
            }
          } else {
            set({
              mode: 'idle',
              status: 'paused',
              timeLeft: settings.countUp ? 0 : settings.workDuration,
              phaseEndsAt: null,
              phaseStartedAt: null,
              sessionStartTime: null,
              sessionCountUp: null,
              phaseExtraSeconds: 0,
              endReminderFiredPhase: null,
            });
          }
        }
      },

      updateSettings: (newSettings) => {
        const state = get();
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
        if (state.mode === 'idle') {
          // 空闲态同步显示新的工作时长（正计时模式空闲显示 0）
          next.timeLeft = merged.countUp ? 0 : merged.workDuration;
        } else {
          // 进行中（运行或暂停）的倒计时阶段：对应阶段时长变化时立即生效——
          // 保持「已消耗时间」不变，按新时长重算剩余与 phaseEndsAt。
          // 选择即时生效而非「仅影响下一阶段」：用户中途改时长通常就是想调整当前这一段；
          // 若新时长 ≤ 已消耗，剩余归 0，下一次 tick 会自然完成本阶段。
          // 正计时工作会话没有目标时长，不受影响（sessionCountUp 锁定，见 types.ts）
          const durationKey =
            state.mode === 'work'
              ? 'workDuration'
              : state.mode === 'short_break'
                ? 'shortBreak'
                : 'longBreak';
          const oldDuration = state.settings[durationKey];
          const newDuration = merged[durationKey];
          const isCountUpWork =
            state.mode === 'work' && (state.sessionCountUp ?? state.settings.countUp);
          if (!isCountUpWork && newDuration !== oldDuration) {
            const remaining =
              state.status === 'running' && state.phaseEndsAt != null
                ? wallClockRemaining(state.phaseEndsAt, state.timeLeft)
                : state.timeLeft;
            // 计划总时长含 extendPhase 加时（新旧同加，差值只随设置变化）
            const elapsed = Math.max(0, oldDuration + state.phaseExtraSeconds - remaining);
            const newRemaining = Math.max(0, newDuration + state.phaseExtraSeconds - elapsed);
            next.timeLeft = newRemaining;
            if (state.status === 'running' && state.phaseEndsAt != null) {
              next.phaseEndsAt = Date.now() + newRemaining * 1000;
              // phaseEndsAt 变了，本阶段的结束前提醒允许重新触发一次
              next.endReminderFiredPhase = null;
            }
          }
        }
        set(next as PomodoroState);

        // 环境音播放中：音色/音量设置改动即时同步到引擎
        if (get().noiseEnabled) {
          noiseEngine.setVolume(merged.noiseVolume);
          noiseEngine.setType(merged.noiseType);
        }
      },

      setImmersive: (value: boolean) => {
        set({ isImmersive: value });
      },

      setNoiseEnabled: (on: boolean) => {
        const { settings } = get();
        if (on) {
          noiseEngine.start(settings.noiseType, settings.noiseVolume);
        } else {
          noiseEngine.stop();
        }
        set({ noiseEnabled: on });
      },
    }),
    {
      name: 'pomodoro-storage',
      // 持久化运行状态：应用重启后可恢复进行中的番茄
      //（计时基于 phaseEndsAt 墙钟，重启期间时间照常流逝）
      // noiseEnabled / endReminderFiredPhase 有意不持久化：
      // 重启后不自动恢复播放环境音；提醒标识随进程重置
      partialize: (state) => ({
        mode: state.mode,
        status: state.status,
        timeLeft: state.timeLeft,
        phaseEndsAt: state.phaseEndsAt,
        phaseStartedAt: state.phaseStartedAt,
        currentTaskId: state.currentTaskId,
        currentTaskTitle: state.currentTaskTitle,
        sessionStartTime: state.sessionStartTime,
        sessionCountUp: state.sessionCountUp,
        phaseExtraSeconds: state.phaseExtraSeconds,
        settings: state.settings,
        completedPomodorosToday: state.completedPomodorosToday,
        lastActiveDate: state.lastActiveDate,
        streakDays: state.streakDays,
        lastGoalMetDate: state.lastGoalMetDate,
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<PomodoroState>;
        return {
          ...current,
          ...p,
          // 旧版本 settings 缺少新增字段时回填默认值（含 noiseAutoWithFocus）
          settings: { ...DEFAULT_POMODORO_SETTINGS, ...(p.settings ?? {}) },
        };
      },
    },
  ),
);
