import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { VoiceInputControl } from '../VoiceInputControl';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback || _key,
  }),
}));

function renderControl(overrides: Partial<React.ComponentProps<typeof VoiceInputControl>> = {}) {
  const props: React.ComponentProps<typeof VoiceInputControl> = {
    state: {
      phase: 'idle',
      elapsedMs: 0,
      hotkey: 'mod+shift+space',
      level: 0,
      errorCode: null,
    },
    disabled: false,
    onToggleRecording: vi.fn(),
    onStartHoldRecording: vi.fn(),
    onStopHoldRecording: vi.fn(),
    onCancelRecording: vi.fn(),
    ...overrides,
  };

  return render(<VoiceInputControl {...props} />);
}

describe('VoiceInputControl', () => {
  it('renders idle, recording, transcribing, disabled, and error states', () => {
    const { rerender } = renderControl();
    expect(screen.getByRole('button', { name: /voice input/i })).toHaveAttribute('data-phase', 'idle');

    rerender(
      <VoiceInputControl
        state={{ phase: 'recording', elapsedMs: 1500, hotkey: 'mod+shift+space', level: 0.42, errorCode: null }}
        disabled={false}
        onToggleRecording={vi.fn()}
        onStartHoldRecording={vi.fn()}
        onStopHoldRecording={vi.fn()}
        onCancelRecording={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: /voice input/i })).toHaveAttribute('data-phase', 'recording');
    expect(screen.getByText('00:01')).toBeInTheDocument();

    rerender(
      <VoiceInputControl
        state={{ phase: 'transcribing', elapsedMs: 1500, hotkey: 'mod+shift+space', level: 0, errorCode: null }}
        disabled={false}
        onToggleRecording={vi.fn()}
        onStartHoldRecording={vi.fn()}
        onStopHoldRecording={vi.fn()}
        onCancelRecording={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: /voice input/i })).toHaveAttribute('data-phase', 'transcribing');

    rerender(
      <VoiceInputControl
        state={{ phase: 'idle', elapsedMs: 0, hotkey: 'mod+shift+space', level: 0, errorCode: 'network' }}
        disabled={true}
        onToggleRecording={vi.fn()}
        onStartHoldRecording={vi.fn()}
        onStopHoldRecording={vi.fn()}
        onCancelRecording={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: /voice input/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /voice input/i })).toHaveAttribute('data-error', 'network');
  });

  it('toggles on click, supports hold-to-talk after the press threshold, and lets Esc cancel recording', () => {
    vi.useFakeTimers();
    const onToggleRecording = vi.fn();
    const onStartHoldRecording = vi.fn();
    const onStopHoldRecording = vi.fn();
    const onCancelRecording = vi.fn();

    renderControl({
      state: { phase: 'recording', elapsedMs: 2200, hotkey: 'mod+shift+space', level: 0.6, errorCode: null },
      onToggleRecording,
      onStartHoldRecording,
      onStopHoldRecording,
      onCancelRecording,
    });

    const button = screen.getByRole('button', { name: /voice input/i });
    fireEvent.click(button);
    fireEvent.pointerDown(button);
    vi.advanceTimersByTime(250);
    fireEvent.pointerUp(button);
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onToggleRecording).toHaveBeenCalledTimes(1);
    expect(onStartHoldRecording).toHaveBeenCalledTimes(1);
    expect(onStopHoldRecording).toHaveBeenCalledTimes(1);
    expect(onCancelRecording).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
