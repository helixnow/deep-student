import React, { useEffect, useMemo, useRef } from 'react';
import { CircleNotch, Microphone } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { formatShortcut } from '@/command-palette/registry/shortcutUtils';

import type { VoiceInputState } from './types';

const HOLD_THRESHOLD_MS = 200;

/** 触屏设备判定（能力，不是布局断点）：隐藏桌面热键提示 + 长按录音为主交互 */
function isCoarsePointer(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(pointer: coarse)').matches;
}

export interface VoiceInputControlProps {
  state: VoiceInputState;
  disabled?: boolean;
  onToggleRecording: () => void;
  onStartHoldRecording: () => void;
  onStopHoldRecording: () => void;
  onCancelRecording: () => void;
}

function formatElapsedMs(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

export function VoiceInputControl({
  state,
  disabled = false,
  onToggleRecording,
  onStartHoldRecording,
  onStopHoldRecording,
  onCancelRecording,
}: VoiceInputControlProps) {
  const { t } = useTranslation('chatV2');
  const holdTimerRef = useRef<number | null>(null);
  const holdStartedRef = useRef(false);
  const suppressNextClickRef = useRef(false);

  const isRecording = state.phase === 'recording';
  const isTranscribing = state.phase === 'transcribing';
  const hotkeyLabel = useMemo(() => formatShortcut(state.hotkey), [state.hotkey]);
  // P2-3: 触屏设备没有物理键盘，title 里不再拼桌面热键文案
  const coarsePointer = useMemo(() => isCoarsePointer(), []);
  const buttonLabel = t('inputBar.voiceInput.button');
  const tooltipLabel = isTranscribing
    ? t('inputBar.voiceInput.transcribing')
    : isRecording
    ? t('inputBar.voiceInput.stop')
    : t('inputBar.voiceInput.start');
  const titleLabel = coarsePointer ? tooltipLabel : `${tooltipLabel} · ${hotkeyLabel}`;

  useEffect(() => {
    if (!isRecording) {
      return;
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      event.preventDefault();
      onCancelRecording();
    };

    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [isRecording, onCancelRecording]);

  const clearHoldTimer = () => {
    if (holdTimerRef.current !== null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  };

  const handlePointerDown = () => {
    if (disabled || isTranscribing) {
      return;
    }
    clearHoldTimer();
    holdTimerRef.current = window.setTimeout(() => {
      holdStartedRef.current = true;
      suppressNextClickRef.current = true;
      onStartHoldRecording();
    }, HOLD_THRESHOLD_MS);
  };

  const handlePointerUp = () => {
    clearHoldTimer();
    if (holdStartedRef.current) {
      holdStartedRef.current = false;
      onStopHoldRecording();
    }
  };

  const handleClick = () => {
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      return;
    }
    onToggleRecording();
  };

  return (
    <button
      type="button"
      data-phase={state.phase}
      data-error={state.errorCode ?? undefined}
      aria-label={buttonLabel}
      title={titleLabel}
      disabled={disabled || isTranscribing}
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
      onPointerCancel={handlePointerUp}
      className={cn(
        'inline-flex h-8 items-center gap-2 rounded-full border px-2.5 text-sm font-medium transition-colors motion-reduce:transition-none',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]',
        // 触屏直接给 44px 物理最小高（px 固定，不受 rem 锚点 14px 缩水影响），
        // 与输入栏其余工具按钮（发送/添加均为 44px）对齐
        '[@media(pointer:coarse)]:min-h-[var(--touch-target-size)]',
        isRecording
          ? 'border-destructive/40 bg-destructive/10 text-destructive shadow-[0_0_0_3px_hsl(var(--destructive)/0.08)]'
          : 'border-[color:var(--button-plain-border)] bg-[var(--button-plain-bg)] text-[color:var(--button-utility-foreground)] hover:bg-[var(--button-plain-hover-bg)] hover:text-[color:var(--text-primary)]',
        (disabled || isTranscribing) && 'opacity-60'
      )}
    >
      {isTranscribing ? (
        <CircleNotch size={14} className="animate-spin motion-reduce:animate-none" />
      ) : (
        <Microphone size={14} weight={isRecording ? 'fill' : 'regular'} />
      )}
      {(isRecording || isTranscribing) && (
        <span className="inline-flex items-center gap-1">
          {/* P2-3: 录音中加红色呼吸点，强化"正在录音"状态（尊重 reduced-motion） */}
          {isRecording && (
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-destructive animate-pulse motion-reduce:animate-none"
            />
          )}
          <span className="tabular-nums">{formatElapsedMs(state.elapsedMs)}</span>
          {isRecording && (
            <span
              aria-hidden="true"
              className="h-1.5 w-6 rounded-full bg-current/15"
            >
              <span
                className="block h-full rounded-full bg-current transition-[width] duration-150 motion-reduce:transition-none"
                style={{ width: `${Math.max(20, Math.round(state.level * 100))}%` }}
              />
            </span>
          )}
        </span>
      )}
    </button>
  );
}

export default VoiceInputControl;
