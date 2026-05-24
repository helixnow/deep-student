import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import { InputBarUI } from '../InputBarUI';
import { createDefaultPanelStates } from '../../../core/types/common';
import { COMMAND_EVENTS } from '@/command-palette/hooks/useCommandEvents';

const { startBrowserVoiceRecordingMock } = vi.hoisted(() => ({
  startBrowserVoiceRecordingMock: vi.fn(() => new Promise(() => undefined)),
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (_key: string, options?: Record<string, unknown> | string) => {
      if (typeof options === 'string') {
        return options;
      }
      if (typeof options === 'object' && typeof options.defaultValue === 'string') {
        return options.defaultValue;
      }
      return _key;
    },
  }),
}));

vi.mock('@/hooks/usePdfProcessingProgress', () => ({
  usePdfProcessingProgress: vi.fn(),
}));

vi.mock('@/hooks/useTauriDragAndDrop', () => ({
  useTauriDragAndDrop: () => ({
    isDragging: false,
    dropZoneProps: {},
  }),
}));

vi.mock('@/components/layout/MobileLayoutContext', () => ({
  useMobileLayoutSafe: () => ({
    isMobile: false,
    isFullscreenContent: false,
  }),
}));

vi.mock('@/voice-input/audio', () => ({
  blobToBase64: vi.fn(),
  startBrowserVoiceRecording: startBrowserVoiceRecordingMock,
}));

function renderInputBar(overrides: Partial<React.ComponentProps<typeof InputBarUI>> = {}) {
  const props: React.ComponentProps<typeof InputBarUI> = {
    inputValue: '',
    canSend: true,
    canAbort: false,
    isStreaming: false,
    attachments: [],
    panelStates: createDefaultPanelStates(),
    onInputChange: vi.fn(),
    onSend: vi.fn(),
    onAbort: vi.fn(),
    onAddAttachment: vi.fn(),
    onUpdateAttachment: vi.fn(),
    onRemoveAttachment: vi.fn(),
    onClearAttachments: vi.fn(),
    onSetPanelState: vi.fn(),
    placeholder: '输入消息',
    sessionId: 'session-voice-slot',
    ...overrides,
  };

  return render(<InputBarUI {...props} />);
}

describe('InputBarUI voice input slot', () => {
  it('renders a stable inline tool slot next to the send action rail', () => {
    renderInputBar({
      inputToolSlot: <div data-testid="voice-input-slot">mic</div>,
    } as Partial<React.ComponentProps<typeof InputBarUI>>);

    const slot = screen.getByTestId('voice-input-slot');
    const sendButton = screen.getByTestId('btn-send');

    expect(slot).toBeInTheDocument();
    expect(slot.compareDocumentPosition(sendButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps the built-in voice input control even when an external tool slot is provided', () => {
    renderInputBar({
      inputToolSlot: <div data-testid="voice-input-slot">extra</div>,
    } as Partial<React.ComponentProps<typeof InputBarUI>>);

    expect(screen.getByTestId('voice-input-slot')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /voice input/i })).toBeInTheDocument();
  });

  it('shares one global voice input trigger across multiple mounted targets', async () => {
    startBrowserVoiceRecordingMock.mockClear();

    render(
      <>
        <InputBarUI
          inputValue=""
          canSend
          canAbort={false}
          isStreaming={false}
          attachments={[]}
          panelStates={createDefaultPanelStates()}
          onInputChange={vi.fn()}
          onSend={vi.fn()}
          onAbort={vi.fn()}
          onAddAttachment={vi.fn()}
          onUpdateAttachment={vi.fn()}
          onRemoveAttachment={vi.fn()}
          onClearAttachments={vi.fn()}
          onSetPanelState={vi.fn()}
          placeholder="输入消息"
          sessionId="session-voice-slot-a"
        />
        <InputBarUI
          inputValue=""
          canSend
          canAbort={false}
          isStreaming={false}
          attachments={[]}
          panelStates={createDefaultPanelStates()}
          onInputChange={vi.fn()}
          onSend={vi.fn()}
          onAbort={vi.fn()}
          onAddAttachment={vi.fn()}
          onUpdateAttachment={vi.fn()}
          onRemoveAttachment={vi.fn()}
          onClearAttachments={vi.fn()}
          onSetPanelState={vi.fn()}
          placeholder="输入消息"
          sessionId="session-voice-slot-b"
        />
      </>
    );

    window.dispatchEvent(new Event(COMMAND_EVENTS.CHAT_VOICE_INPUT));

    await waitFor(() => {
      expect(startBrowserVoiceRecordingMock).toHaveBeenCalledTimes(1);
    });
  });
});
