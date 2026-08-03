/**
 * ★ 3.2 番茄钟置顶小窗（独立 webview 渲染入口）
 *
 * 由 main.tsx 在 ?window=pomodoro-mini 时挂载。
 * 不运行计时逻辑——状态完全来自主窗口广播（pomodoro-mini:state），
 * 操作通过 pomodoro-mini:command 事件回传主窗口执行。
 *
 * 交互（对标系统级悬浮计时器）：
 * - 控制按钮 hover / 键盘聚焦时横向滑出（grid-cols 0fr→1fr），
 *   平时把宽度留给任务名，保持极简
 * - 置顶开关：临时取消 always-on-top（如需要被其他窗口盖住时）
 * - 暂停态：倒计时数字降低透明度 + 进度条转中性色
 * - 挂载后若迟迟收不到状态广播，每 1.5s 重发 ready 请求（覆盖主窗口
 *   刚重载 / 事件竞态导致的首帧丢失）
 *
 * 协议兼容：progress / countUp 为可选扩展字段，旧版主窗口不发送时
 * 进度条隐藏、完成按钮不显示，其余功能不受影响。
 */
import '@/styles/tailwind.css';
import '@/styles/shadcn-variables.css';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pause, Play, Square, Coffee, Brain, X, CheckCircle, PushPin, PushPinSlash } from '@phosphor-icons/react';
import { listen, emit } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { cn } from '@/lib/utils';
import useTheme from '@/hooks/useTheme';
import {
  EVT_MINI_STATE,
  EVT_MINI_COMMAND,
  EVT_MINI_READY,
  type PomodoroMiniState,
  type PomodoroMiniCommand,
} from '../miniWindow';

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

export const PomodoroMiniWindow: React.FC = () => {
  const { t } = useTranslation('todo');
  useTheme(); // 应用主题 class / 变量（与主窗口共享 localStorage）
  const [state, setState] = useState<PomodoroMiniState | null>(null);
  // 置顶开关（窗口创建即 always-on-top，故初值 true）
  const [pinned, setPinned] = useState(true);

  // 透明窗口：根元素背景透明，让圆角药丸外露
  useEffect(() => {
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
  }, []);

  useEffect(() => {
    let unlistenState: (() => void) | null = null;
    let disposed = false;

    listen<PomodoroMiniState>(EVT_MINI_STATE, (event) => {
      const next = event.payload;
      setState(next);
      // 主窗口已停止番茄 → 小窗自我关闭
      if (next.mode === 'idle') {
        void getCurrentWindow().close();
      }
    }).then((fn) => {
      if (disposed) fn();
      else unlistenState = fn;
    });

    // 请求主窗口立即广播一次状态
    void emit(EVT_MINI_READY, {});

    return () => {
      disposed = true;
      unlistenState?.();
    };
  }, []);

  // 首帧兜底：未收到状态前每 1.5s 重发 ready（主窗口重载/事件竞态时自动恢复）
  useEffect(() => {
    if (state) return;
    const id = window.setInterval(() => {
      void emit(EVT_MINI_READY, {});
    }, 1500);
    return () => window.clearInterval(id);
  }, [state]);

  const sendCommand = (action: PomodoroMiniCommand['action']) => {
    void emit(EVT_MINI_COMMAND, { action });
  };

  const handleClose = () => {
    void getCurrentWindow().close();
  };

  const handleTogglePin = () => {
    const next = !pinned;
    setPinned(next);
    getCurrentWindow()
      .setAlwaysOnTop(next)
      .catch(() => setPinned(!next));
  };

  const isPaused = state?.status === 'paused';

  // 阶段语义色（与主窗口一致：work = primary，short_break = success，long_break = info）
  const modeColorClass =
    state?.mode === 'work' ? 'text-primary'
      : state?.mode === 'long_break' ? 'text-info'
        : 'text-success';
  const modeBarClass =
    state?.mode === 'work' ? 'bg-primary'
      : state?.mode === 'long_break' ? 'bg-info'
        : 'bg-success';

  const modeIcon = state?.mode === 'work'
    ? <Brain size={15} className={modeColorClass} weight="fill" />
    : <Coffee size={15} className={modeColorClass} weight="fill" />;

  const modeLabel =
    state?.mode === 'work' ? t('pomodoro.modes.focusing')
      : state?.mode === 'long_break' ? t('pomodoro.modes.longBreak')
        : t('pomodoro.modes.shortBreak');

  const hidePause = Boolean(state?.strictMode && state.mode === 'work' && state.status === 'running');
  const showFinish = Boolean(state?.countUp && state.mode === 'work' && state.status === 'running');
  const progress = state?.progress != null ? Math.min(1, Math.max(0, state.progress)) : null;

  return (
    <div
      data-tauri-drag-region
      className="group relative flex h-screen w-screen select-none items-center gap-2 overflow-hidden rounded-full border border-border bg-background px-3.5 pr-1.5 shadow-lg"
    >
      {state ? (
        <>
          <span data-tauri-drag-region className="shrink-0">{modeIcon}</span>
          <span
            data-tauri-drag-region
            className={cn(
              'font-mono text-md font-semibold tracking-wider tabular-nums transition-[color,opacity] duration-200 motion-reduce:transition-none',
              isPaused ? 'text-foreground/50' : 'text-foreground',
            )}
            title={isPaused ? t('pomodoro.controls.resume') : modeLabel}
          >
            {formatTime(state.timeLeft)}
          </span>
          {state.taskTitle && (
            <span
              data-tauri-drag-region
              className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
              title={state.taskTitle}
            >
              {state.taskTitle}
            </span>
          )}
          {!state.taskTitle && <span data-tauri-drag-region className="flex-1" />}

          {/* 控制簇：hover / 键盘聚焦时横向滑出，平时把空间让给任务名 */}
          <div
            className={cn(
              'grid shrink-0 grid-cols-[0fr] opacity-0 transition-[grid-template-columns,opacity] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]',
              'group-hover:grid-cols-[1fr] group-hover:opacity-100 focus-within:grid-cols-[1fr] focus-within:opacity-100',
              'motion-reduce:transition-none',
            )}
          >
            <div className="flex min-w-0 items-center overflow-hidden">
              {showFinish && (
                <button
                  onClick={() => sendCommand('finish')}
                  className="rounded-full p-1.5 text-success transition-colors hover:bg-success/10 motion-reduce:transition-none"
                  title={t('pomodoro.controls.finish')}
                  aria-label={t('pomodoro.controls.finish')}
                >
                  <CheckCircle size={13} weight="fill" />
                </button>
              )}
              {!hidePause && (
                <button
                  onClick={() => sendCommand(state.status === 'running' ? 'pause' : 'resume')}
                  className="rounded-full p-1.5 text-foreground/80 transition-colors hover:bg-muted motion-reduce:transition-none"
                  title={state.status === 'running' ? t('pomodoro.controls.pause') : t('pomodoro.controls.resume')}
                  aria-label={state.status === 'running' ? t('pomodoro.controls.pause') : t('pomodoro.controls.resume')}
                >
                  {state.status === 'running' ? <Pause size={13} weight="fill" /> : <Play size={13} weight="fill" />}
                </button>
              )}
              <button
                onClick={() => sendCommand('stop')}
                className="rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive motion-reduce:transition-none"
                title={t('pomodoro.controls.stop')}
                aria-label={t('pomodoro.controls.stop')}
              >
                <Square size={13} weight="fill" />
              </button>
              <button
                onClick={handleTogglePin}
                className={cn(
                  'rounded-full p-1.5 transition-colors motion-reduce:transition-none',
                  pinned
                    ? 'text-foreground/80 hover:bg-muted'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
                title={pinned
                  ? t('pomodoro.miniWindow.unpin', { defaultValue: '取消置顶' })
                  : t('pomodoro.miniWindow.pin', { defaultValue: '窗口置顶' })}
                aria-label={pinned
                  ? t('pomodoro.miniWindow.unpin', { defaultValue: '取消置顶' })
                  : t('pomodoro.miniWindow.pin', { defaultValue: '窗口置顶' })}
                aria-pressed={pinned}
              >
                {pinned ? <PushPin size={13} weight="fill" /> : <PushPinSlash size={13} />}
              </button>
              <button
                onClick={handleClose}
                className="rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground motion-reduce:transition-none"
                title={t('pomodoro.miniWindow.close')}
                aria-label={t('pomodoro.miniWindow.close')}
              >
                <X size={13} weight="bold" />
              </button>
            </div>
          </div>

          {/* 细进度条（旧版主窗口不发送 progress 时隐藏）；暂停态转中性色 */}
          {progress != null && (
            <div
              className="pointer-events-none absolute inset-x-4 bottom-[3px] h-[2px] overflow-hidden rounded-full bg-border/60"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progress * 100)}
              aria-label={modeLabel}
            >
              <div
                className={cn(
                  'h-full rounded-full transition-[width,background-color] duration-1000 ease-linear motion-reduce:transition-none',
                  isPaused ? 'bg-muted-foreground/50' : modeBarClass,
                )}
                style={{ width: `${progress * 100}%` }}
              />
            </div>
          )}
        </>
      ) : (
        <span data-tauri-drag-region className="flex-1 text-center text-sm text-muted-foreground">
          …
        </span>
      )}
    </div>
  );
};

export default PomodoroMiniWindow;
