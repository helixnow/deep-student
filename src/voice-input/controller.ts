import { buildShortcutString, normalizeShortcut } from '@/command-palette/registry/shortcutUtils';

import { buildVoiceInputPrompt, DEFAULT_VOICE_INPUT_CONFIG } from './config';
import { appendVoiceInputHistoryEntry } from './history';
import { startBrowserVoiceRecording } from './audio';
import type {
  RecordedAudioPayload,
  VoiceInputAssignedModelStatus,
  VoiceInputNotifications,
  VoiceInputProvider,
  VoiceInputRuntimeConfig,
  VoiceInputState,
  VoiceInputTarget,
  VoiceRecorderSession,
} from './types';

export interface VoiceInputControllerDeps {
  config?: VoiceInputRuntimeConfig;
  notifications?: VoiceInputNotifications;
  getActiveTarget?: () => VoiceInputTarget | null;
  getProvider?: (providerId: string) => VoiceInputProvider | null;
  createRecorderSession?: (options: {
    onLevel: (level: number) => void;
  }) => Promise<VoiceRecorderSession>;
}

function normalizeRuntimeConfig(
  input?: Partial<VoiceInputRuntimeConfig> | null
): VoiceInputRuntimeConfig {
  return {
    ...DEFAULT_VOICE_INPUT_CONFIG,
    ...(input ?? {}),
    assignedModel: input?.assignedModel ?? { status: 'model-assignment-required' },
  };
}

function createInitialState(config: VoiceInputRuntimeConfig): VoiceInputState {
  return {
    phase: 'idle',
    elapsedMs: 0,
    hotkey: config.hotkey,
    level: 0,
    errorCode: null,
  };
}

function getErrorCode(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
      ? error
      : typeof error === 'object' && error && 'message' in error && typeof error.message === 'string'
      ? error.message
      : '';
  const trimmed = raw.trim();

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed) as { code?: unknown };
      if (typeof parsed.code === 'string' && parsed.code.trim()) {
        return parsed.code.trim();
      }
    } catch {
      // Ignore invalid JSON and keep the fallback heuristics below.
    }
  }

  const lower = trimmed.toLowerCase();
  if (!lower) return 'transcription-failed';
  if (lower.includes('permission') || lower.includes('notallowederror')) return 'permission-denied';
  if (lower.includes('missing-get-user-media')) return 'missing-get-user-media';
  if (lower.includes('insecure-context')) return 'insecure-context';
  if (lower.includes('missing-recorder-backend')) return 'missing-recorder-backend';
  if (lower.includes('microphone-not-found') || lower.includes('notfounderror')) return 'microphone-not-found';
  if (lower.includes('microphone-busy') || lower.includes('notreadableerror') || lower.includes('trackstarterror')) return 'microphone-busy';
  if (lower.includes('recording-unavailable')) return 'recording-unavailable';
  if (lower.includes('timeout')) return 'timeout';
  if (lower.includes('429') || lower.includes('rate')) return 'rate-limited';
  if (lower.includes('401') || lower.includes('403') || lower.includes('auth')) return 'auth-failed';
  if (lower.includes('api key') || lower.includes('settings')) return 'settings-required';
  if (lower.includes('network') || lower.includes('fetch') || lower.includes('econn')) return 'network-failed';
  return 'transcription-failed';
}

function getSeverityForCode(code: string): 'warning' | 'error' {
  if (code === 'permission-denied' || code === 'timeout' || code === 'rate-limited') {
    return 'warning';
  }
  return 'error';
}

export function createVoiceInputController(deps: VoiceInputControllerDeps = {}) {
  let config = normalizeRuntimeConfig(deps.config);
  let state = createInitialState(config);
  let recorderSession: VoiceRecorderSession | null = null;
  let elapsedIntervalId: number | null = null;
  let timeoutId: number | null = null;
  let recordingStartedAt = 0;
  let holdHotkeyActive = false;
  const listeners = new Set<() => void>();

  const emit = () => {
    listeners.forEach((listener) => listener());
  };

  const setState = (partial: Partial<VoiceInputState>) => {
    state = { ...state, ...partial };
    emit();
  };

  const clearTimers = () => {
    if (elapsedIntervalId !== null) {
      window.clearInterval(elapsedIntervalId);
      elapsedIntervalId = null;
    }
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
      timeoutId = null;
    }
  };

  const resetToIdle = (errorCode: string | null = state.errorCode) => {
    clearTimers();
    setState({
      phase: 'idle',
      elapsedMs: 0,
      level: 0,
      errorCode,
      hotkey: config.hotkey,
    });
  };

  const notify = (code: string) => {
    deps.notifications?.show(getSeverityForCode(code), code);
  };

  const getProvider = () => {
    const providerId =
      config.assignedModel.status === 'ready' ? config.assignedModel.providerId : undefined;
    return providerId ? deps.getProvider?.(providerId) ?? null : null;
  };
  const getTarget = () => deps.getActiveTarget?.() ?? null;
  const eventTargetsUnrelatedEditable = (event: KeyboardEvent): boolean => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return false;
    }

    const isEditableTarget =
      target.isContentEditable ||
      ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
      target.getAttribute('role') === 'textbox';

    if (!isEditableTarget) {
      return false;
    }

    return !(getTarget()?.ownsNode?.(target) ?? false);
  };
  const getModelResolutionCode = (): VoiceInputAssignedModelStatus | null =>
    config.assignedModel.status === 'ready' ? null : config.assignedModel.status;

  const applyTranscript = async (payload: RecordedAudioPayload) => {
    const target = getTarget();
    if (!target) {
      notify('no-active-target');
      resetToIdle('no-active-target');
      return;
    }

    const modelResolutionCode = getModelResolutionCode();
    if (modelResolutionCode) {
      notify(modelResolutionCode);
      resetToIdle(modelResolutionCode);
      return;
    }

    const provider = getProvider();
    if (!provider) {
      notify('provider-unavailable');
      resetToIdle('provider-unavailable');
      return;
    }

    setState({ phase: 'transcribing', level: 0, errorCode: null });

    try {
      const result = await provider.transcribeOnce({
        blob: payload.blob,
        mimeType: payload.mimeType,
        providerId: config.assignedModel.providerId!,
        model: config.assignedModel.model!,
        configId: config.assignedModel.configId,
        language: config.language,
        prompt: buildVoiceInputPrompt(config),
        durationMs: payload.durationMs,
      });
      const transcript = result.text?.trim() ?? '';
      if (!transcript) {
        deps.notifications?.show('warning', 'empty-transcript');
        resetToIdle('empty-transcript');
        return;
      }

      void appendVoiceInputHistoryEntry({
        text: transcript,
        providerId: result.providerId,
        model: result.model,
        language: result.language,
        durationMs: result.durationMs ?? payload.durationMs,
      });

      await target.insertTranscript(transcript, config.insertMode);
      resetToIdle(null);
    } catch (error) {
      const code = getErrorCode(error);
      notify(code);
      resetToIdle(code);
    }
  };

  const startRecording = async () => {
    if (state.phase !== 'idle') {
      return;
    }

    try {
      recorderSession = await (deps.createRecorderSession ?? startBrowserVoiceRecording)({
        onLevel: (level) => setState({ level }),
      });
      recordingStartedAt = Date.now();
      setState({ phase: 'recording', elapsedMs: 0, level: 0, errorCode: null });

      elapsedIntervalId = window.setInterval(() => {
        setState({ elapsedMs: Date.now() - recordingStartedAt });
      }, 120);

      timeoutId = window.setTimeout(() => {
        deps.notifications?.show('warning', 'timeout');
        void stopRecording();
      }, config.maxDurationMs);
    } catch (error) {
      const code = getErrorCode(error);
      notify(code);
      resetToIdle(code);
    }
  };

  const stopRecording = async () => {
    if (!recorderSession) {
      return;
    }

    const currentSession = recorderSession;
    recorderSession = null;
    clearTimers();
    setState({ phase: 'transcribing', level: 0, errorCode: null });

    try {
      const payload = await currentSession.stop();
      if (!payload) {
        deps.notifications?.show('warning', 'empty-transcript');
        resetToIdle('empty-transcript');
        return;
      }
      await applyTranscript(payload);
    } catch (error) {
      const code = getErrorCode(error);
      notify(code);
      resetToIdle(code);
    }
  };

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      return state;
    },
    setNotifications(notifications: VoiceInputNotifications) {
      deps.notifications = notifications;
    },
    setConfig(nextConfig: VoiceInputRuntimeConfig) {
      config = normalizeRuntimeConfig(nextConfig);
      setState({ hotkey: config.hotkey });
    },
    async applyTranscript(payload: RecordedAudioPayload) {
      await applyTranscript(payload);
    },
    async toggleRecording() {
      if (state.phase === 'recording') {
        await stopRecording();
        return;
      }
      if (state.phase === 'idle') {
        await startRecording();
      }
    },
    async startHoldRecording() {
      if (state.phase === 'idle') {
        await startRecording();
      }
    },
    async stopHoldRecording() {
      if (state.phase === 'recording') {
        await stopRecording();
      }
    },
    async cancelRecording() {
      if (!recorderSession) {
        return;
      }

      const currentSession = recorderSession;
      recorderSession = null;
      clearTimers();
      holdHotkeyActive = false;
      try {
        await currentSession.cancel();
      } finally {
        resetToIdle(null);
      }
    },
    handleHotkeyKeyDown(event: KeyboardEvent) {
      if (eventTargetsUnrelatedEditable(event)) {
        return;
      }

      const shortcut = buildShortcutString(event);
      if (normalizeShortcut(shortcut ?? '') !== normalizeShortcut(config.hotkey)) {
        return;
      }

      if (config.hotkeyMode === 'toggle-to-record') {
        if (event.repeat) {
          event.preventDefault();
          return;
        }
        if (state.phase === 'transcribing') {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        void this.toggleRecording();
        return;
      }

      if (event.repeat || holdHotkeyActive) {
        event.preventDefault();
        return;
      }
      if (state.phase !== 'idle') {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      holdHotkeyActive = true;
      void this.startHoldRecording();
    },
    handleHotkeyKeyUp(event: KeyboardEvent) {
      if (eventTargetsUnrelatedEditable(event)) {
        return;
      }

      if (config.hotkeyMode === 'toggle-to-record') {
        const shortcut = buildShortcutString(event);
        if (normalizeShortcut(shortcut ?? '') === normalizeShortcut(config.hotkey)) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }

      const shortcut = buildShortcutString(event);
      if (!holdHotkeyActive || normalizeShortcut(shortcut ?? '') !== normalizeShortcut(config.hotkey)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      holdHotkeyActive = false;
      void this.stopHoldRecording();
    },
    handleWindowBlur() {
      holdHotkeyActive = false;
      if (state.phase === 'recording') {
        void this.cancelRecording();
      }
    },
  };
}
