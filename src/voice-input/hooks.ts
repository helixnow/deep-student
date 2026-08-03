import React, { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { RefObject } from 'react';
import type { TFunction } from 'i18next';

import { COMMAND_EVENTS } from '@/command-palette/hooks/useCommandEvents';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { setPendingSettingsRoute } from '@/utils/pendingSettingsTab';
import { APP_EVENTS, dispatchAppEvent } from '@/events';

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
  dispatchAppEvent(APP_EVENTS.NAVIGATE_TO_TAB, { tabName: 'settings' });
  dispatchAppEvent(APP_EVENTS.SETTINGS_NAVIGATE_TAB, { tab });
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
          title: t('inputBar.voiceInput.permissionDeniedTitle'),
          message: t(
            'inputBar.voiceInput.permissionDeniedMessage'
          ),
        },
        timeout: {
          type: 'warning',
          title: t('inputBar.voiceInput.timeoutTitle'),
          message: t(
            'inputBar.voiceInput.timeoutMessage'
          ),
        },
        'empty-transcript': {
          type: 'warning',
          title: t('inputBar.voiceInput.emptyTranscriptTitle'),
          message: t(
            'inputBar.voiceInput.emptyTranscriptMessage'
          ),
        },
        'auth-failed': {
          type: 'error',
          title: t('inputBar.voiceInput.authFailedTitle'),
          message: t(
            'inputBar.voiceInput.authFailedMessage'
          ),
          action: {
            label: t('inputBar.voiceInput.openSettingsAction'),
            onClick: openApiSettings,
          },
        },
        'rate-limited': {
          type: 'warning',
          title: t('inputBar.voiceInput.rateLimitedTitle'),
          message: t(
            'inputBar.voiceInput.rateLimitedMessage'
          ),
        },
        'network-failed': {
          type: 'error',
          title: t('inputBar.voiceInput.networkFailedTitle'),
          message: t(
            'inputBar.voiceInput.networkFailedMessage'
          ),
        },
        'settings-required': {
          type: 'warning',
          title: t('inputBar.voiceInput.settingsRequiredTitle'),
          message: t(
            'inputBar.voiceInput.settingsRequiredMessage'
          ),
          action: {
            label: t('inputBar.voiceInput.openSettingsAction'),
            onClick: openApiSettings,
          },
        },
        'model-assignment-required': {
          type: 'warning',
          title: t('inputBar.voiceInput.modelAssignmentRequiredTitle'),
          message: t(
            'inputBar.voiceInput.modelAssignmentRequiredMessage'
          ),
          action: {
            label: t('inputBar.voiceInput.openSettingsAction'),
            onClick: openModelSettings,
          },
        },
        'model-config-missing': {
          type: 'warning',
          title: t('inputBar.voiceInput.modelConfigMissingTitle'),
          message: t(
            'inputBar.voiceInput.modelConfigMissingMessage'
          ),
          action: {
            label: t('inputBar.voiceInput.openSettingsAction'),
            onClick: openModelSettings,
          },
        },
        'model-disabled': {
          type: 'warning',
          title: t('inputBar.voiceInput.modelDisabledTitle'),
          message: t(
            'inputBar.voiceInput.modelDisabledMessage'
          ),
          action: {
            label: t('inputBar.voiceInput.openSettingsAction'),
            onClick: openModelSettings,
          },
        },
        'provider-unavailable': {
          type: 'error',
          title: t('inputBar.voiceInput.providerUnavailableTitle'),
          message: t(
            'inputBar.voiceInput.providerUnavailableMessage'
          ),
          action: {
            label: t('inputBar.voiceInput.openSettingsAction'),
            onClick: openModelSettings,
          },
        },
        'no-active-target': {
          type: 'info',
          title: t('inputBar.voiceInput.noTargetTitle'),
          message: t(
            'inputBar.voiceInput.noTargetMessage'
          ),
        },
        'recording-unavailable': {
          type: 'error',
          title: t('inputBar.voiceInput.recordingUnavailableTitle'),
          message: t(
            'inputBar.voiceInput.recordingUnavailableMessage'
          ),
          action: {
            label: t('inputBar.voiceInput.openVoiceSettingsAction'),
            onClick: openVoiceSettings,
          },
        },
        'missing-get-user-media': {
          type: 'error',
          title: t(
            'inputBar.voiceInput.missingGetUserMediaTitle'
          ),
          message: t(
            'inputBar.voiceInput.missingGetUserMediaMessage'
          ),
          action: {
            label: t('inputBar.voiceInput.openVoiceSettingsAction'),
            onClick: openVoiceSettings,
          },
        },
        'insecure-context': {
          type: 'error',
          title: t(
            'inputBar.voiceInput.insecureContextTitle'
          ),
          message: t(
            'inputBar.voiceInput.insecureContextMessage'
          ),
          action: {
            label: t('inputBar.voiceInput.openVoiceSettingsAction'),
            onClick: openVoiceSettings,
          },
        },
        'missing-recorder-backend': {
          type: 'error',
          title: t(
            'inputBar.voiceInput.missingRecorderBackendTitle'
          ),
          message: t(
            'inputBar.voiceInput.missingRecorderBackendMessage'
          ),
          action: {
            label: t('inputBar.voiceInput.openVoiceSettingsAction'),
            onClick: openVoiceSettings,
          },
        },
        'microphone-not-found': {
          type: 'warning',
          title: t('inputBar.voiceInput.microphoneNotFoundTitle'),
          message: t(
            'inputBar.voiceInput.microphoneNotFoundMessage'
          ),
        },
        'microphone-busy': {
          type: 'warning',
          title: t('inputBar.voiceInput.microphoneBusyTitle'),
          message: t(
            'inputBar.voiceInput.microphoneBusyMessage'
          ),
        },
        'transcription-failed': {
          type: 'error',
          title: t('inputBar.voiceInput.failedTitle'),
          message: t(
            'inputBar.voiceInput.failedMessage'
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
