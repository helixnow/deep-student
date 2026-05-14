import React, { useEffect, useMemo, useRef } from 'react';
import { CircleNotch, Microphone } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { formatShortcut } from '@/command-palette/registry/shortcutUtils';

import type { VoiceInputState } from './types';

const HOLD_THRESHOLD_MS = 200;

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
  const buttonLabel = t('inputBar.voiceInput.button', 'Voice Input');
  const tooltipLabel = isTranscribing
    ? t('inputBar.voiceInput.transcribing', 'Transcribing...')
    : isRecording
    ? t('inputBar.voiceInput.stop', 'Stop recording')
    : t('inputBar.voiceInput.start', 'Start voice input');

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
      title={`${tooltipLabel} · ${hotkeyLabel}`}
      disabled={disabled || isTranscribing}
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
      onPointerCancel={handlePointerUp}
      className={cn(
        'inline-flex h-8 items-center gap-2 rounded-full border px-2.5 text-[12px] font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]',
        isRecording
          ? 'border-red-500/30 bg-red-500/10 text-red-600'
          : 'border-[color:var(--button-plain-border)] bg-[var(--button-plain-bg)] text-[color:var(--button-utility-foreground)] hover:bg-[var(--button-plain-hover-bg)] hover:text-[color:var(--text-primary)]',
        (disabled || isTranscribing) && 'opacity-60'
      )}
    >
      {isTranscribing ? (
        <CircleNotch size={14} className="animate-spin" />
      ) : (
        <Microphone size={14} />
      )}
      {(isRecording || isTranscribing) && (
        <span className="inline-flex items-center gap-1">
          <span>{formatElapsedMs(state.elapsedMs)}</span>
          {isRecording && (
            <span
              aria-hidden="true"
              className="h-1.5 w-6 rounded-full bg-current/15"
            >
              <span
                className="block h-full rounded-full bg-current transition-[width] duration-150"
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
