/**
 * ★ 3.2 番茄钟置顶小窗（独立 webview 渲染入口）
 *
 * 由 main.tsx 在 ?window=pomodoro-mini 时挂载。
 * 不运行计时逻辑——状态完全来自主窗口广播（pomodoro-mini:state），
 * 操作通过 pomodoro-mini:command 事件回传主窗口执行。
 */
import '@/styles/tailwind.css';
import '@/styles/shadcn-variables.css';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pause, Play, Square, Coffee, Brain, X } from '@phosphor-icons/react';
import { listen, emit } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
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

  const sendCommand = (action: PomodoroMiniCommand['action']) => {
    void emit(EVT_MINI_COMMAND, { action });
  };

  const handleClose = () => {
    void getCurrentWindow().close();
  };

  const modeIcon = state?.mode === 'work'
    ? <Brain size={15} className="text-orange-500" weight="fill" />
    : <Coffee size={15} className={state?.mode === 'long_break' ? 'text-blue-500' : 'text-green-500'} weight="fill" />;

  const hidePause = Boolean(state?.strictMode && state.mode === 'work' && state.status === 'running');

  return (
    <div
      data-tauri-drag-region
      className="flex h-screen w-screen select-none items-center gap-2 overflow-hidden rounded-full border border-border bg-background px-3.5 pr-1.5 shadow-lg"
    >
      {state ? (
        <>
          <span data-tauri-drag-region className="shrink-0">{modeIcon}</span>
          <span
            data-tauri-drag-region
            className="font-mono text-[15px] font-semibold tracking-wider text-foreground tabular-nums"
          >
            {formatTime(state.timeLeft)}
          </span>
          {state.taskTitle && (
            <span
              data-tauri-drag-region
              className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground"
              title={state.taskTitle}
            >
              {state.taskTitle}
            </span>
          )}
          {!state.taskTitle && <span data-tauri-drag-region className="flex-1" />}
          <div className="flex shrink-0 items-center">
            {!hidePause && (
              <button
                onClick={() => sendCommand(state.status === 'running' ? 'pause' : 'resume')}
                className="rounded-full p-1.5 text-foreground/80 transition-colors hover:bg-muted"
                title={state.status === 'running' ? t('pomodoro.controls.pause') : t('pomodoro.controls.resume')}
              >
                {state.status === 'running' ? <Pause size={13} weight="fill" /> : <Play size={13} weight="fill" />}
              </button>
            )}
            <button
              onClick={() => sendCommand('stop')}
              className="rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
              title={t('pomodoro.controls.stop')}
            >
              <Square size={13} weight="fill" />
            </button>
            <button
              onClick={handleClose}
              className="rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title={t('pomodoro.miniWindow.close')}
            >
              <X size={13} weight="bold" />
            </button>
          </div>
        </>
      ) : (
        <span data-tauri-drag-region className="flex-1 text-center text-[12px] text-muted-foreground">
          …
        </span>
      )}
    </div>
  );
};

export default PomodoroMiniWindow;
