import { describe, expect, it, vi } from 'vitest';

import { createVoiceInputController } from '../controller';
import type { VoiceInputProvider, VoiceInputRuntimeConfig, VoiceInputTarget } from '../types';

const { appendVoiceInputHistoryEntryMock } = vi.hoisted(() => ({
  appendVoiceInputHistoryEntryMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../history', () => ({
  appendVoiceInputHistoryEntry: appendVoiceInputHistoryEntryMock,
}));

const defaultConfig: VoiceInputRuntimeConfig = {
  maxDurationMs: 60_000,
  insertMode: 'replace-selection',
  hotkey: 'mod+shift+space',
  hotkeyMode: 'hold-to-talk',
  assignedModel: {
    status: 'ready',
    configId: 'voice-asr',
    providerId: 'siliconflow',
    providerLabel: 'SiliconFlow',
    model: 'TeleAI/TeleSpeechASR',
    modelLabel: 'TeleAI/TeleSpeechASR',
  },
};

function createTarget(): VoiceInputTarget {
  return {
    id: 'chat-v2-input',
    insertTranscript: vi.fn().mockResolvedValue(true),
  };
}

function createProvider(result: { text: string }): VoiceInputProvider {
  return {
    id: 'siliconflow',
    transcribeOnce: vi.fn().mockResolvedValue({
      ...result,
      providerId: 'siliconflow',
      model: 'TeleAI/TeleSpeechASR',
    }),
  };
}

describe('voice input controller', () => {
  it('inserts transcription into the active target without auto-send', async () => {
    const target = createTarget();
    const provider = createProvider({ text: '你好，世界' });
    const notifications = { show: vi.fn() };

    const controller = createVoiceInputController({
      config: defaultConfig,
      notifications,
      getActiveTarget: () => target,
      getProvider: () => provider,
    });

    await controller.applyTranscript({
      blob: new Blob(['audio']),
      mimeType: 'audio/webm',
      durationMs: 1200,
    });

    expect(provider.transcribeOnce).toHaveBeenCalled();
    expect(target.insertTranscript).toHaveBeenCalledWith('你好，世界', 'replace-selection');
    expect(appendVoiceInputHistoryEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '你好，世界',
        providerId: 'siliconflow',
        model: 'TeleAI/TeleSpeechASR',
      })
    );
    expect(notifications.show).not.toHaveBeenCalled();
  });

  it('shows a warning and leaves the target untouched when transcript is empty', async () => {
    const target = createTarget();
    const provider = createProvider({ text: '   ' });
    const notifications = { show: vi.fn() };

    const controller = createVoiceInputController({
      config: defaultConfig,
      notifications,
      getActiveTarget: () => target,
      getProvider: () => provider,
    });

    await controller.applyTranscript({
      blob: new Blob(['audio']),
      mimeType: 'audio/webm',
      durationMs: 800,
    });

    expect(target.insertTranscript).not.toHaveBeenCalled();
    expect(notifications.show).toHaveBeenCalledWith('warning', 'empty-transcript');
  });

  it('surfaces specific recording support failures instead of collapsing them into a generic transcription error', async () => {
    const notifications = { show: vi.fn() };
    const controller = createVoiceInputController({
      config: defaultConfig,
      notifications,
      getActiveTarget: () => null,
      getProvider: () => null,
      createRecorderSession: vi.fn().mockRejectedValue(new Error('missing-get-user-media')),
    });

    await controller.toggleRecording();

    expect(notifications.show).toHaveBeenCalledWith('error', 'missing-get-user-media');
    expect(controller.getSnapshot().errorCode).toBe('missing-get-user-media');
  });

  it('treats legacy behavior-only configs as missing a model assignment instead of crashing', async () => {
    const target = createTarget();
    const notifications = { show: vi.fn() };
    const controller = createVoiceInputController({
      config: {
        maxDurationMs: 60_000,
        insertMode: 'replace-selection',
        hotkey: 'mod+shift+space',
      } as VoiceInputRuntimeConfig,
      notifications,
      getActiveTarget: () => target,
      getProvider: () => null,
    });

    await controller.applyTranscript({
      blob: new Blob(['audio']),
      mimeType: 'audio/webm',
      durationMs: 400,
    });

    expect(notifications.show).toHaveBeenCalledWith('error', 'model-assignment-required');
    expect(target.insertTranscript).not.toHaveBeenCalled();
  });

  it('does not let the hold hotkey hijack an existing toggle recording session', async () => {
    const stop = vi.fn().mockResolvedValue(null);
    const cancel = vi.fn().mockResolvedValue(undefined);
    const controller = createVoiceInputController({
      config: defaultConfig,
      notifications: { show: vi.fn() },
      getActiveTarget: () => null,
      getProvider: () => null,
      createRecorderSession: vi.fn().mockResolvedValue({
        stop,
        cancel,
      }),
    });

    await controller.toggleRecording();
    controller.handleHotkeyKeyDown(
      new KeyboardEvent('keydown', {
        key: ' ',
        ctrlKey: true,
        shiftKey: true,
      })
    );
    controller.handleHotkeyKeyUp(
      new KeyboardEvent('keyup', {
        key: ' ',
        ctrlKey: true,
        shiftKey: true,
      })
    );

    expect(stop).not.toHaveBeenCalled();
    await controller.cancelRecording();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('cancels an in-progress recording when the window loses focus', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const controller = createVoiceInputController({
      config: defaultConfig,
      notifications: { show: vi.fn() },
      getActiveTarget: () => null,
      getProvider: () => null,
      createRecorderSession: vi.fn().mockResolvedValue({
        stop: vi.fn().mockResolvedValue(null),
        cancel,
      }),
    });

    await controller.toggleRecording();
    expect(controller.getSnapshot().phase).toBe('recording');

    controller.handleWindowBlur();

    await Promise.resolve();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().phase).toBe('idle');
  });

  it('ignores the app-wide hotkey while the user is typing in an unrelated editable field', () => {
    const createRecorderSession = vi.fn();
    const ownedTextarea = document.createElement('textarea');
    const unrelatedInput = document.createElement('input');
    const target: VoiceInputTarget = {
      id: 'chat-v2-input',
      ownsNode: (node) => node === ownedTextarea,
      insertTranscript: vi.fn(),
    };
    const controller = createVoiceInputController({
      config: defaultConfig,
      notifications: { show: vi.fn() },
      getActiveTarget: () => target,
      getProvider: () => null,
      createRecorderSession,
    });
    const event = new KeyboardEvent('keydown', {
      key: ' ',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });

    Object.defineProperty(event, 'target', {
      configurable: true,
      value: unrelatedInput,
    });

    controller.handleHotkeyKeyDown(event);

    expect(createRecorderSession).not.toHaveBeenCalled();
    expect(controller.getSnapshot().phase).toBe('idle');
  });

  it('lets the configured hotkey behave like a toggle instead of hold-to-talk', async () => {
    const target = createTarget();
    const provider = createProvider({ text: 'toggle transcript' });
    const stop = vi.fn().mockResolvedValue({
      blob: new Blob(['audio']),
      mimeType: 'audio/webm',
      durationMs: 1500,
    });
    const controller = createVoiceInputController({
      config: {
        ...defaultConfig,
        hotkeyMode: 'toggle-to-record',
      },
      notifications: { show: vi.fn() },
      getActiveTarget: () => target,
      getProvider: () => provider,
      createRecorderSession: vi.fn().mockResolvedValue({
        stop,
        cancel: vi.fn().mockResolvedValue(undefined),
      }),
    });

    controller.handleHotkeyKeyDown(
      new KeyboardEvent('keydown', {
        key: ' ',
        ctrlKey: true,
        shiftKey: true,
      })
    );
    await Promise.resolve();
    expect(controller.getSnapshot().phase).toBe('recording');

    controller.handleHotkeyKeyUp(
      new KeyboardEvent('keyup', {
        key: ' ',
        ctrlKey: true,
        shiftKey: true,
      })
    );
    expect(stop).not.toHaveBeenCalled();

    controller.handleHotkeyKeyDown(
      new KeyboardEvent('keydown', {
        key: ' ',
        ctrlKey: true,
        shiftKey: true,
      })
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(target.insertTranscript).toHaveBeenCalledWith('toggle transcript', 'replace-selection');
  });
});
