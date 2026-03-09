import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { PomodoroState, PomodoroMode } from './types';
import { DEFAULT_POMODORO_SETTINGS } from './types';
import { createPomodoroRecord } from './api';

// TODO: Replace with Tauri system notifications in Phase 3
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
    actualDuration,
    type,
    status,
  }).catch((err) => {
    console.error('[Pomodoro] Failed to record session:', err);
  });
};

export const usePomodoroStore = create<PomodoroState>()(
  persist(
    (set, get) => ({
      mode: 'idle',
      status: 'paused',
      timeLeft: DEFAULT_POMODORO_SETTINGS.workDuration,
      currentTaskId: null,
      currentTaskTitle: null,
      sessionStartTime: null,
      settings: DEFAULT_POMODORO_SETTINGS,
      completedPomodorosToday: 0,
      lastActiveDate: null,
      isImmersive: false,

      start: (taskId?: string, taskTitle?: string) => {
        const { mode, settings } = get();
        
        // 跨天归零
        const today = new Date().toDateString();
        const { lastActiveDate, completedPomodorosToday } = get();
        const shouldReset = lastActiveDate !== today;
        
        if (mode === 'idle') {
          set({
            mode: 'work',
            status: 'running',
            timeLeft: settings.workDuration,
            currentTaskId: taskId || null,
            currentTaskTitle: taskTitle || null,
            sessionStartTime: new Date().toISOString(),
            completedPomodorosToday: shouldReset ? 0 : completedPomodorosToday,
            lastActiveDate: today,
          });
        } else {
          set({ status: 'running', lastActiveDate: today });
        }
      },

      pause: () => {
        set({ status: 'paused' });
      },

      resume: () => {
        const { sessionStartTime } = get();
        set({
          status: 'running',
          sessionStartTime: sessionStartTime || new Date().toISOString(),
        });
      },

      stop: (interrupted = true) => {
        const { mode, currentTaskId, settings, sessionStartTime, timeLeft } = get();
        
        if (interrupted && mode === 'work' && sessionStartTime) {
          const actualDuration = settings.workDuration - timeLeft;
          recordSession(
            currentTaskId,
            sessionStartTime,
            settings.workDuration,
            actualDuration,
            'work',
            'interrupted',
          );
        }

        set({
          mode: 'idle',
          status: 'paused',
          timeLeft: settings.workDuration,
          currentTaskId: null,
          currentTaskTitle: null,
          sessionStartTime: null,
        });
      },

      tick: () => {
        const { status, timeLeft } = get();
        
        if (status !== 'running') return;

        if (timeLeft > 0) {
          set({ timeLeft: timeLeft - 1 });
        } else {
          get().completeCurrentSession();
        }
      },

      completeCurrentSession: () => {
        const { mode, settings, completedPomodorosToday, currentTaskId, sessionStartTime } = get();
        
        playNotificationSound();

        if (mode === 'work') {
          const newCompletedCount = completedPomodorosToday + 1;
          
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

          set({
            completedPomodorosToday: newCompletedCount,
            lastActiveDate: new Date().toDateString(),
            mode: nextMode,
            status: 'paused',
            timeLeft: nextTimeLeft,
            sessionStartTime: new Date().toISOString(),
          });
        } else {
          // Break completed — record it too
          const breakType: 'short_break' | 'long_break' = mode === 'long_break' ? 'long_break' : 'short_break';
          const breakDuration = mode === 'long_break' ? settings.longBreak : settings.shortBreak;
          if (sessionStartTime) {
            recordSession(null, sessionStartTime, breakDuration, breakDuration, breakType, 'completed');
          }

          set({
            mode: 'idle',
            status: 'paused',
            timeLeft: settings.workDuration,
            sessionStartTime: null,
          });
        }
      },

      updateSettings: (newSettings) => {
        set((state) => ({
          settings: { ...state.settings, ...newSettings },
          timeLeft: state.mode === 'idle' ? 
            (newSettings.workDuration !== undefined ? newSettings.workDuration : state.timeLeft) 
            : state.timeLeft
        }));
      },

      setImmersive: (value: boolean) => {
        set({ isImmersive: value });
      },
    }),
    {
      name: 'pomodoro-storage',
      partialize: (state) => ({ 
        settings: state.settings,
        completedPomodorosToday: state.completedPomodorosToday,
        lastActiveDate: state.lastActiveDate,
      }),
    }
  )
);
