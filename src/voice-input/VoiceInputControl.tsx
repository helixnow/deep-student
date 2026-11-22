import React, { useCallback, useMemo, useRef } from 'react';
import { CircleNotch, Microphone, X } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

import { DsButton } from '@/components/ui/DsButton';
import { cn } from '@/lib/utils';
import { useEventRegistry } from '@/hooks/useEventRegistry';
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

  const handleEscapeKeyDown = useCallback((event: Event) => {
    const keyEvent = event as KeyboardEvent;
    if (keyEvent.key !== 'Escape') {
      return;
    }
    keyEvent.preventDefault();
    onCancelRecording();
  }, [onCancelRecording]);

  useEventRegistry(
    isRecording
      ? [{ target: 'window', type: 'keydown', listener: handleEscapeKeyDown }]
      : [],
    [isRecording, handleEscapeKeyDown],
  );

  const clearHoldTimer = () => {
    if (holdTimerRef.current !== null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (disabled || isTranscribing) {
      return;
    }
    if (typeof event.currentTarget.setPointerCapture === 'function' && event.pointerId !== undefined) {
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // 合成事件或不支持 pointer capture 的环境安全降级
      }
    }
    clearHoldTimer();
    holdTimerRef.current = window.setTimeout(() => {
      holdStartedRef.current = true;
      suppressNextClickRef.current = true;
      onStartHoldRecording();
    }, HOLD_THRESHOLD_MS);
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (
      typeof event.currentTarget.hasPointerCapture === 'function' &&
      typeof event.currentTarget.releasePointerCapture === 'function' &&
      event.pointerId !== undefined &&
      event.currentTarget.hasPointerCapture(event.pointerId)
    ) {
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // ignore
      }
    }
    clearHoldTimer();
    if (holdStartedRef.current) {
      holdStartedRef.current = false;
      onStopHoldRecording();
    }
  };

  const handlePointerLeave = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (
      typeof event.currentTarget.hasPointerCapture === 'function' &&
      event.pointerId !== undefined &&
      event.currentTarget.hasPointerCapture(event.pointerId)
    ) {
      return;
    }
    if (event.pointerType === 'touch') {
      return;
    }
    handlePointerUp(event);
  };

  const handleClick = () => {
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      return;
    }
    onToggleRecording();
  };

  const recordButton = (
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
      onPointerLeave={handlePointerLeave}
      onPointerCancel={handlePointerUp}
      onContextMenu={(event) => {
        if (coarsePointer) event.preventDefault();
      }}
      className={cn(
        'native-touch-target touch-none select-none [-webkit-touch-callout:none] inline-flex h-8 items-center gap-2 rounded-full border px-2.5 text-sm font-medium transition-colors motion-reduce:transition-none',
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

  if (!isRecording) {
    return recordButton;
  }

  const cancelLabel = t('inputBar.voiceInput.cancel', { defaultValue: '取消录音' });
  const cancelText = t('common:actions.cancel', { defaultValue: '取消' });

  return (
    <span className="inline-flex items-center gap-1">
      {recordButton}
      <DsButton
        type="button"
        variant="ghost"
        size="sm"
        data-testid="voice-input-cancel-btn"
        aria-label={cancelLabel}
        title={cancelLabel}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onCancelRecording();
        }}
        className={cn(
          'h-8 rounded-full border px-2 text-xs font-medium',
          'border-[color:var(--button-plain-border)] bg-[var(--button-plain-bg)] text-muted-foreground hover:bg-[var(--button-plain-hover-bg)] hover:text-foreground',
        )}
      >
        <X size={13} aria-hidden="true" />
        <span>{cancelText}</span>
      </DsButton>
    </span>
  );
}

export default VoiceInputControl;
