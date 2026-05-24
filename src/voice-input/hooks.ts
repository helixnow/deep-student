import React, { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { RefObject } from 'react';
import type { TFunction } from 'i18next';

import { COMMAND_EVENTS } from '@/command-palette/hooks/useCommandEvents';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { setPendingSettingsRoute } from '@/utils/pendingSettingsTab';

import {
  VOICE_INPUT_CONFIG_CHANGED_EVENT,
} from './config';
import { createVoiceInputController } from './controller';
import { voiceInputProviderRegistry } from './providerRegistry';
import { loadVoiceInputRuntimeConfig } from './runtimeConfig';
import { createTextareaVoiceInputTarget, voiceInputTargetRegistry } from './targets';
import { VoiceInputControl } from './VoiceInputControl';

const voiceInputController = createVoiceInputController({
  getActiveTarget: () => voiceInputTargetRegistry.getActiveTarget(),
  getProvider: (providerId) => voiceInputProviderRegistry.get(providerId),
});
let globalVoiceInputListenerCount = 0;
let globalVoiceInputListenerCleanup: (() => void) | null = null;

function openSettingsTab(tab: 'general' | 'apis' | 'models'): void {
  setPendingSettingsRoute({ tab });
  window.dispatchEvent(new CustomEvent('navigate-to-tab', { detail: { tabName: 'settings' } }));
  window.dispatchEvent(new CustomEvent('SETTINGS_NAVIGATE_TAB', { detail: { tab } }));
}

function attachGlobalVoiceInputListeners(): () => void {
  const handleKeyDown = (event: KeyboardEvent) => {
    voiceInputController.handleHotkeyKeyDown(event);
  };
  const handleKeyUp = (event: KeyboardEvent) => {
    voiceInputController.handleHotkeyKeyUp(event);
  };
  const handleCommand = () => {
    void voiceInputController.toggleRecording();
  };
  const handleWindowBlur = () => {
    voiceInputController.handleWindowBlur();
  };
  const handleVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      voiceInputController.handleWindowBlur();
    }
  };

  document.addEventListener('keydown', handleKeyDown);
  document.addEventListener('keyup', handleKeyUp);
  window.addEventListener(COMMAND_EVENTS.CHAT_VOICE_INPUT, handleCommand as EventListener);
  window.addEventListener('blur', handleWindowBlur);
  document.addEventListener('visibilitychange', handleVisibilityChange);

  return () => {
    document.removeEventListener('keydown', handleKeyDown);
    document.removeEventListener('keyup', handleKeyUp);
    window.removeEventListener(COMMAND_EVENTS.CHAT_VOICE_INPUT, handleCommand as EventListener);
    window.removeEventListener('blur', handleWindowBlur);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  };
}

function retainGlobalVoiceInputListeners(): () => void {
  if (!globalVoiceInputListenerCleanup) {
    globalVoiceInputListenerCleanup = attachGlobalVoiceInputListeners();
  }
  globalVoiceInputListenerCount += 1;

  return () => {
    globalVoiceInputListenerCount = Math.max(0, globalVoiceInputListenerCount - 1);
    if (globalVoiceInputListenerCount > 0) {
      return;
    }

    globalVoiceInputListenerCleanup?.();
    globalVoiceInputListenerCleanup = null;
  };
}

function openVoiceSettings(): void {
  openSettingsTab('general');
}

function openModelSettings(): void {
  openSettingsTab('models');
}

function openApiSettings(): void {
  openSettingsTab('apis');
}

function createNotificationBridge(t: TFunction) {
  return {
    show(
      type: 'success' | 'error' | 'info' | 'warning',
      code: string,
      meta?: Record<string, unknown>
    ) {
      const messages: Record<
        string,
        {
          type: 'success' | 'error' | 'info' | 'warning';
          title: string;
          message: string;
          action?: { label: string; onClick: () => void };
        }
      > = {
        'permission-denied': {
          type: 'warning',
          title: t('inputBar.voiceInput.permissionDeniedTitle', 'Microphone permission needed'),
          message: t(
            'inputBar.voiceInput.permissionDeniedMessage',
            'Allow microphone access to use voice input.'
          ),
        },
        timeout: {
          type: 'warning',
          title: t('inputBar.voiceInput.timeoutTitle', 'Recording stopped'),
          message: t(
            'inputBar.voiceInput.timeoutMessage',
            'The recording reached the time limit and was sent for transcription.'
          ),
        },
        'empty-transcript': {
          type: 'warning',
          title: t('inputBar.voiceInput.emptyTranscriptTitle', 'No speech detected'),
          message: t(
            'inputBar.voiceInput.emptyTranscriptMessage',
            'No transcript was returned, so the input was left unchanged.'
          ),
        },
        'auth-failed': {
          type: 'error',
          title: t('inputBar.voiceInput.authFailedTitle', 'Voice input authentication failed'),
          message: t(
            'inputBar.voiceInput.authFailedMessage',
            'Check your SiliconFlow API key and try again.'
          ),
          action: {
            label: t('inputBar.voiceInput.openSettingsAction', 'Open Settings'),
            onClick: openApiSettings,
          },
        },
        'rate-limited': {
          type: 'warning',
          title: t('inputBar.voiceInput.rateLimitedTitle', 'Voice input is rate limited'),
          message: t(
            'inputBar.voiceInput.rateLimitedMessage',
            'Too many transcription requests were sent. Please wait a moment and try again.'
          ),
        },
        'network-failed': {
          type: 'error',
          title: t('inputBar.voiceInput.networkFailedTitle', 'Voice input network error'),
          message: t(
            'inputBar.voiceInput.networkFailedMessage',
            'The transcription request failed due to a network problem.'
          ),
        },
        'settings-required': {
          type: 'warning',
          title: t('inputBar.voiceInput.settingsRequiredTitle', 'Set up SiliconFlow first'),
          message: t(
            'inputBar.voiceInput.settingsRequiredMessage',
            'Add a SiliconFlow API key in Settings before using voice input.'
          ),
          action: {
            label: t('inputBar.voiceInput.openSettingsAction', 'Open Settings'),
            onClick: openApiSettings,
          },
        },
        'model-assignment-required': {
          type: 'warning',
          title: t('inputBar.voiceInput.modelAssignmentRequiredTitle', 'Assign a voice input model'),
          message: t(
            'inputBar.voiceInput.modelAssignmentRequiredMessage',
            'Choose a Voice Input ASR model in Settings before recording.'
          ),
          action: {
            label: t('inputBar.voiceInput.openSettingsAction', 'Open Settings'),
            onClick: openModelSettings,
          },
        },
        'model-config-missing': {
          type: 'warning',
          title: t('inputBar.voiceInput.modelConfigMissingTitle', 'Voice input model needs attention'),
          message: t(
            'inputBar.voiceInput.modelConfigMissingMessage',
            'The assigned ASR model is missing or no longer supports voice input. Pick another one in Settings > Models.'
          ),
          action: {
            label: t('inputBar.voiceInput.openSettingsAction', 'Open Settings'),
            onClick: openModelSettings,
          },
        },
        'model-disabled': {
          type: 'warning',
          title: t('inputBar.voiceInput.modelDisabledTitle', 'Voice input model is disabled'),
          message: t(
            'inputBar.voiceInput.modelDisabledMessage',
            'Enable the assigned ASR model or pick another one in Settings > Models.'
          ),
          action: {
            label: t('inputBar.voiceInput.openSettingsAction', 'Open Settings'),
            onClick: openModelSettings,
          },
        },
        'provider-unavailable': {
          type: 'error',
          title: t('inputBar.voiceInput.providerUnavailableTitle', 'Voice input provider unavailable'),
          message: t(
            'inputBar.voiceInput.providerUnavailableMessage',
            'The selected voice input provider is not available.'
          ),
          action: {
            label: t('inputBar.voiceInput.openSettingsAction', 'Open Settings'),
            onClick: openModelSettings,
          },
        },
        'no-active-target': {
          type: 'info',
          title: t('inputBar.voiceInput.noTargetTitle', 'Select an input first'),
          message: t(
            'inputBar.voiceInput.noTargetMessage',
            'Focus a supported text input before inserting a transcript.'
          ),
        },
        'recording-unavailable': {
          type: 'error',
          title: t('inputBar.voiceInput.recordingUnavailableTitle', 'Recording unavailable'),
          message: t(
            'inputBar.voiceInput.recordingUnavailableMessage',
            'This environment does not support microphone recording.'
          ),
          action: {
            label: t('inputBar.voiceInput.openVoiceSettingsAction', 'Open Voice Settings'),
            onClick: openVoiceSettings,
          },
        },
        'missing-get-user-media': {
          type: 'error',
          title: t(
            'inputBar.voiceInput.missingGetUserMediaTitle',
            'Recording runtime is incomplete'
          ),
          message: t(
            'inputBar.voiceInput.missingGetUserMediaMessage',
            'This build is not exposing microphone capture to the app. Check the Voice Input section in Settings.'
          ),
          action: {
            label: t('inputBar.voiceInput.openVoiceSettingsAction', 'Open Voice Settings'),
            onClick: openVoiceSettings,
          },
        },
        'insecure-context': {
          type: 'error',
          title: t(
            'inputBar.voiceInput.insecureContextTitle',
            'Recording runtime is not secure'
          ),
          message: t(
            'inputBar.voiceInput.insecureContextMessage',
            'This runtime is not exposing a secure microphone context, so voice input cannot start.'
          ),
          action: {
            label: t('inputBar.voiceInput.openVoiceSettingsAction', 'Open Voice Settings'),
            onClick: openVoiceSettings,
          },
        },
        'missing-recorder-backend': {
          type: 'error',
          title: t(
            'inputBar.voiceInput.missingRecorderBackendTitle',
            'No recording backend available'
          ),
          message: t(
            'inputBar.voiceInput.missingRecorderBackendMessage',
            'The runtime does not expose MediaRecorder or a PCM fallback, so voice input cannot record yet.'
          ),
          action: {
            label: t('inputBar.voiceInput.openVoiceSettingsAction', 'Open Voice Settings'),
            onClick: openVoiceSettings,
          },
        },
        'microphone-not-found': {
          type: 'warning',
          title: t('inputBar.voiceInput.microphoneNotFoundTitle', 'No microphone found'),
          message: t(
            'inputBar.voiceInput.microphoneNotFoundMessage',
            'Connect or enable a microphone before using voice input.'
          ),
        },
        'microphone-busy': {
          type: 'warning',
          title: t('inputBar.voiceInput.microphoneBusyTitle', 'Microphone unavailable'),
          message: t(
            'inputBar.voiceInput.microphoneBusyMessage',
            'Another app may already be using the microphone.'
          ),
        },
        'transcription-failed': {
          type: 'error',
          title: t('inputBar.voiceInput.failedTitle', 'Voice input failed'),
          message: t(
            'inputBar.voiceInput.failedMessage',
            'The recording could not be transcribed.'
          ),
        },
      };

      const entry = messages[code] ?? messages['transcription-failed'];
      showGlobalNotification(entry.type ?? type, entry.message, entry.title, {
        action: entry.action,
      });
    },
  };
}

export function useVoiceInputIntegration(options: {
  targetId: string;
  textareaRef: RefObject<HTMLTextAreaElement>;
  inputValue: string;
  onInputChange: (value: string) => void;
  afterInsert?: () => void;
  disabled?: boolean;
  t: TFunction;
}) {
  const inputValueRef = useRef(options.inputValue);
  const onInputChangeRef = useRef(options.onInputChange);
  const afterInsertRef = useRef(options.afterInsert);

  inputValueRef.current = options.inputValue;
  onInputChangeRef.current = options.onInputChange;
  afterInsertRef.current = options.afterInsert;

  const state = useSyncExternalStore(
    voiceInputController.subscribe,
    voiceInputController.getSnapshot,
    voiceInputController.getSnapshot
  );

  useEffect(() => {
    voiceInputController.setNotifications(createNotificationBridge(options.t));
  }, [options.t]);

  useEffect(() => {
    let cancelled = false;

    const syncRuntimeConfig = () => {
      void loadVoiceInputRuntimeConfig().then((config) => {
        if (cancelled) {
          return;
        }
        voiceInputController.setConfig(config);
      });
    };

    syncRuntimeConfig();
    window.addEventListener(VOICE_INPUT_CONFIG_CHANGED_EVENT, syncRuntimeConfig);
    window.addEventListener('model_assignments_changed', syncRuntimeConfig);
    window.addEventListener('api_configurations_changed', syncRuntimeConfig);
    window.addEventListener('siliconflow-apikey-changed', syncRuntimeConfig);

    return () => {
      cancelled = true;
      window.removeEventListener(VOICE_INPUT_CONFIG_CHANGED_EVENT, syncRuntimeConfig);
      window.removeEventListener('model_assignments_changed', syncRuntimeConfig);
      window.removeEventListener('api_configurations_changed', syncRuntimeConfig);
      window.removeEventListener('siliconflow-apikey-changed', syncRuntimeConfig);
    };
  }, []);

  useEffect(() => {
    const target = createTextareaVoiceInputTarget({
      id: options.targetId,
      getTextarea: () => options.textareaRef.current,
      getValue: () => inputValueRef.current,
      setValue: (value) => onInputChangeRef.current(value),
      afterInsert: () => afterInsertRef.current?.(),
    });
    voiceInputTargetRegistry.registerTarget(target);

    const textarea = options.textareaRef.current;
    const activateTarget = () => voiceInputTargetRegistry.setActiveTarget(options.targetId);

    textarea?.addEventListener('focus', activateTarget);
    textarea?.addEventListener('pointerdown', activateTarget);
    if (document.activeElement === textarea) {
      activateTarget();
    }

    return () => {
      textarea?.removeEventListener('focus', activateTarget);
      textarea?.removeEventListener('pointerdown', activateTarget);
      voiceInputTargetRegistry.unregisterTarget(options.targetId);
    };
  }, [options.targetId, options.textareaRef]);

  useEffect(() => {
    return retainGlobalVoiceInputListeners();
  }, []);

  const inputToolSlot = useMemo(
    () =>
      React.createElement(VoiceInputControl, {
        state,
        disabled: options.disabled,
        onToggleRecording: () => {
          void voiceInputController.toggleRecording();
        },
        onStartHoldRecording: () => {
          void voiceInputController.startHoldRecording();
        },
        onStopHoldRecording: () => {
          void voiceInputController.stopHoldRecording();
        },
        onCancelRecording: () => {
          void voiceInputController.cancelRecording();
        },
      }),
    [options.disabled, state]
  );

  return {
    state,
    inputToolSlot,
  };
}
