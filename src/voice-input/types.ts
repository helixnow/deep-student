export type VoiceInputInsertMode = 'replace-selection';
export type VoiceInputHotkeyMode = 'hold-to-talk' | 'toggle-to-record';

export interface VoiceInputConfig {
  maxDurationMs: number;
  insertMode: VoiceInputInsertMode;
  hotkey: string;
  hotkeyMode: VoiceInputHotkeyMode;
  dictationVocabulary?: string[];
  language?: string;
  prompt?: string;
}

export type VoiceInputAssignedModelStatus =
  | 'ready'
  | 'model-assignment-required'
  | 'model-config-missing'
  | 'model-disabled'
  | 'provider-unavailable';

export interface VoiceInputAssignedModel {
  status: VoiceInputAssignedModelStatus;
  configId?: string;
  providerId?: string;
  providerLabel?: string;
  model?: string;
  modelLabel?: string;
  disabled?: boolean;
}

export interface VoiceInputRuntimeConfig extends VoiceInputConfig {
  assignedModel: VoiceInputAssignedModel;
}

export interface VoiceInputHistoryEntry {
  id: string;
  text: string;
  createdAt: string;
  providerId?: string;
  model?: string;
  language?: string;
  durationMs?: number;
}

export interface VoiceInputTarget {
  id: string;
  insertTranscript: (text: string, mode: VoiceInputInsertMode) => Promise<boolean> | boolean;
  ownsNode?: (node: Node | null) => boolean;
}

export interface VoiceInputTranscriptRequest {
  blob: Blob;
  mimeType: string;
  providerId: string;
  model: string;
  configId?: string;
  language?: string;
  prompt?: string;
  durationMs?: number;
}

export interface VoiceInputTranscriptionResult {
  text: string;
  language?: string;
  durationMs?: number;
  providerId: string;
  model: string;
}

export interface VoiceInputProvider {
  id: string;
  transcribeOnce: (request: VoiceInputTranscriptRequest) => Promise<VoiceInputTranscriptionResult>;
  streamTranscription?: (_stream: MediaStream) => AsyncIterable<VoiceInputTranscriptionResult>;
}

export type VoiceInputPhase = 'idle' | 'recording' | 'transcribing';

export interface VoiceInputState {
  phase: VoiceInputPhase;
  elapsedMs: number;
  hotkey: string;
  level: number;
  errorCode: string | null;
}

export interface VoiceInputNotifications {
  show: (
    type: 'success' | 'error' | 'info' | 'warning',
    code: string,
    meta?: Record<string, unknown>
  ) => void;
}

export interface RecordedAudioPayload {
  blob: Blob;
  mimeType: string;
  durationMs: number;
}

export interface VoiceRecorderSession {
  stop: () => Promise<RecordedAudioPayload | null>;
  cancel: () => Promise<void>;
}
