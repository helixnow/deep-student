import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { VoiceInputSettingsSection } from '../VoiceInputSettingsSection';

const {
  loadVoiceInputConfigMock,
  saveVoiceInputConfigMock,
  detectVoiceRecordingSupportMock,
  requestVoiceRecordingPermissionMock,
  loadVoiceInputHistoryMock,
  clearVoiceInputHistoryMock,
} = vi.hoisted(() => ({
  loadVoiceInputConfigMock: vi.fn(),
  saveVoiceInputConfigMock: vi.fn(),
  detectVoiceRecordingSupportMock: vi.fn(),
  requestVoiceRecordingPermissionMock: vi.fn(),
  loadVoiceInputHistoryMock: vi.fn(),
  clearVoiceInputHistoryMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
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

vi.mock('@/voice-input/config', () => ({
  DEFAULT_VOICE_INPUT_CONFIG: {
    maxDurationMs: 60000,
    insertMode: 'replace-selection',
    hotkey: 'mod+shift+space',
    hotkeyMode: 'hold-to-talk',
  },
  loadVoiceInputConfig: loadVoiceInputConfigMock,
  saveVoiceInputConfig: saveVoiceInputConfigMock,
}));

vi.mock('@/voice-input/history', () => ({
  VOICE_INPUT_HISTORY_CHANGED_EVENT: 'voice-input-history-changed',
  loadVoiceInputHistory: loadVoiceInputHistoryMock,
  clearVoiceInputHistory: clearVoiceInputHistoryMock,
}));

vi.mock('@/voice-input/support', () => ({
  detectVoiceRecordingSupport: detectVoiceRecordingSupportMock,
  requestVoiceRecordingPermission: requestVoiceRecordingPermissionMock,
}));

describe('VoiceInputSettingsSection', () => {
  it('loads behavior settings and shows the assigned ASR model summary', async () => {
    loadVoiceInputConfigMock.mockResolvedValue({
      maxDurationMs: 60000,
      insertMode: 'replace-selection',
      hotkey: 'mod+shift+space',
      hotkeyMode: 'hold-to-talk',
    });
    loadVoiceInputHistoryMock.mockResolvedValue([]);
    detectVoiceRecordingSupportMock.mockResolvedValue({
      canRecord: true,
      recorderMode: 'media-recorder',
      reasonCode: null,
      permissionState: 'granted',
    });

    render(
      <VoiceInputSettingsSection
        assignedModel={{
          status: 'ready',
          configId: 'voice-asr',
          providerId: 'siliconflow',
          providerLabel: 'SiliconFlow',
          model: 'TeleAI/TeleSpeechASR',
          modelLabel: 'SiliconFlow - TeleAI/TeleSpeechASR',
          disabled: false,
        }}
      />
    );

    expect(await screen.findByText('SiliconFlow - TeleAI/TeleSpeechASR')).toBeInTheDocument();
    expect(screen.getByDisplayValue('mod+shift+space')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('TeleAI/TeleSpeechASR')).not.toBeInTheDocument();
  });

  it('persists updated hotkey and duration values without editing model selection in this tab', async () => {
    loadVoiceInputConfigMock.mockResolvedValue({
      maxDurationMs: 60000,
      insertMode: 'replace-selection',
      hotkey: 'mod+shift+space',
      hotkeyMode: 'hold-to-talk',
    });
    loadVoiceInputHistoryMock.mockResolvedValue([]);
    detectVoiceRecordingSupportMock.mockResolvedValue({
      canRecord: true,
      recorderMode: 'pcm-wav',
      reasonCode: null,
      permissionState: 'prompt',
    });
    saveVoiceInputConfigMock.mockResolvedValue({
      maxDurationMs: 90000,
      insertMode: 'replace-selection',
      hotkey: 'alt+space',
      hotkeyMode: 'toggle-to-record',
      dictationVocabulary: ['DeepStudent', 'Anki'],
    });

    render(
      <VoiceInputSettingsSection
        assignedModel={{
          status: 'ready',
          configId: 'voice-asr',
          providerId: 'siliconflow',
          providerLabel: 'SiliconFlow',
          model: 'TeleAI/TeleSpeechASR',
          modelLabel: 'SiliconFlow - TeleAI/TeleSpeechASR',
          disabled: false,
        }}
      />
    );

    const hotkeyInput = await screen.findByDisplayValue('mod+shift+space');
    fireEvent.change(hotkeyInput, { target: { value: 'alt+space' } });
    fireEvent.blur(hotkeyInput);

    const durationInput = screen.getByDisplayValue('60000');
    fireEvent.change(durationInput, { target: { value: '90000' } });
    fireEvent.blur(durationInput);

    await waitFor(() => {
      expect(saveVoiceInputConfigMock).toHaveBeenCalledWith(
        expect.objectContaining({ hotkey: 'alt+space' })
      );
    });

    await waitFor(() => {
        expect(saveVoiceInputConfigMock).toHaveBeenCalledWith(
        expect.objectContaining({ maxDurationMs: 90000 })
      );
    });

    const toggleCard = screen.getByRole('radio', {
      name: /Tap once to start, tap once to stop/i,
    });
    fireEvent.click(toggleCard);

    await waitFor(() => {
      expect(saveVoiceInputConfigMock).toHaveBeenCalledWith(
        expect.objectContaining({ hotkeyMode: 'toggle-to-record' })
      );
    });

    const dictionary = screen.getByPlaceholderText(/Photosynthesis/i);
    fireEvent.change(dictionary, { target: { value: 'DeepStudent\nAnki' } });
    fireEvent.blur(dictionary);

    await waitFor(() => {
      expect(saveVoiceInputConfigMock).toHaveBeenCalledWith(
        expect.objectContaining({ dictationVocabulary: ['DeepStudent', 'Anki'] })
      );
    });
  });

  it('lets users request microphone access from the voice input settings panel', async () => {
    loadVoiceInputConfigMock.mockResolvedValue({
      maxDurationMs: 60000,
      insertMode: 'replace-selection',
      hotkey: 'mod+shift+space',
      hotkeyMode: 'hold-to-talk',
    });
    loadVoiceInputHistoryMock.mockResolvedValue([]);
    detectVoiceRecordingSupportMock
      .mockResolvedValueOnce({
        canRecord: false,
        recorderMode: 'unavailable',
        reasonCode: 'permission-denied',
        permissionState: 'denied',
      })
      .mockResolvedValueOnce({
        canRecord: true,
        recorderMode: 'media-recorder',
        reasonCode: null,
        permissionState: 'granted',
      });
    requestVoiceRecordingPermissionMock.mockResolvedValue({
      canRecord: true,
      recorderMode: 'media-recorder',
      reasonCode: null,
      permissionState: 'granted',
    });

    render(
      <VoiceInputSettingsSection
        assignedModel={{
          status: 'ready',
          configId: 'voice-asr',
          providerId: 'siliconflow',
          providerLabel: 'SiliconFlow',
          model: 'TeleAI/TeleSpeechASR',
          modelLabel: 'SiliconFlow - TeleAI/TeleSpeechASR',
          disabled: false,
        }}
      />
    );

    const requestButton = await screen.findByRole('button', {
      name: 'Request microphone access',
    });
    fireEvent.click(requestButton);

    await waitFor(() => {
      expect(requestVoiceRecordingPermissionMock).toHaveBeenCalledTimes(1);
    });
  });

  it('offers a direct route to usage statistics from the voice input settings panel', async () => {
    loadVoiceInputConfigMock.mockResolvedValue({
      maxDurationMs: 60000,
      insertMode: 'replace-selection',
      hotkey: 'mod+shift+space',
      hotkeyMode: 'hold-to-talk',
    });
    loadVoiceInputHistoryMock.mockResolvedValue([
      {
        id: 'history-1',
        text: 'Recovered transcript',
        createdAt: '2026-05-08T10:00:00.000Z',
        providerId: 'siliconflow',
        model: 'TeleAI/TeleSpeechASR',
        durationMs: 1800,
      },
    ]);
    detectVoiceRecordingSupportMock.mockResolvedValue({
      canRecord: true,
      recorderMode: 'media-recorder',
      reasonCode: null,
      permissionState: 'granted',
    });
    const dispatchEventSpy = vi.spyOn(window, 'dispatchEvent');

    render(
      <VoiceInputSettingsSection
        assignedModel={{
          status: 'ready',
          configId: 'voice-asr',
          providerId: 'siliconflow',
          providerLabel: 'SiliconFlow',
          model: 'TeleAI/TeleSpeechASR',
          modelLabel: 'SiliconFlow - TeleAI/TeleSpeechASR',
          disabled: false,
        }}
      />
    );

    const button = await screen.findByRole('button', {
      name: 'Open Usage Statistics',
    });
    fireEvent.click(button);

    expect(dispatchEventSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'SETTINGS_NAVIGATE_TAB',
        detail: { tab: 'statistics' },
      })
    );

    expect(await screen.findByText('Recovered transcript')).toBeInTheDocument();
  });

  it('can render in embedded mode without the outer section spacing while keeping the dictation heading', async () => {
    loadVoiceInputConfigMock.mockResolvedValue({
      maxDurationMs: 60000,
      insertMode: 'replace-selection',
      hotkey: 'mod+shift+space',
      hotkeyMode: 'hold-to-talk',
    });
    loadVoiceInputHistoryMock.mockResolvedValue([]);
    detectVoiceRecordingSupportMock.mockResolvedValue({
      canRecord: true,
      recorderMode: 'media-recorder',
      reasonCode: null,
      permissionState: 'granted',
    });

    const { container } = render(
      <VoiceInputSettingsSection
        embedded
        assignedModel={{
          status: 'ready',
          configId: 'voice-asr',
          providerId: 'siliconflow',
          providerLabel: 'SiliconFlow',
          model: 'TeleAI/TeleSpeechASR',
          modelLabel: 'SiliconFlow - TeleAI/TeleSpeechASR',
          disabled: false,
        }}
      />
    );

    const section = container.querySelector('section');
    expect(section?.className).not.toContain('mt-8');
    expect(await screen.findByText('Dictation')).toBeInTheDocument();
  });
});
