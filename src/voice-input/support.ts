export type VoiceRecordingPermissionState = PermissionState | 'unsupported' | 'unknown';
export type VoiceRecordingMode = 'media-recorder' | 'pcm-wav' | 'unavailable';
export type VoiceRecordingReasonCode =
  | 'permission-denied'
  | 'missing-get-user-media'
  | 'missing-recorder-backend'
  | 'insecure-context';

export interface VoiceRecordingSupport {
  canRecord: boolean;
  recorderMode: VoiceRecordingMode;
  permissionState: VoiceRecordingPermissionState;
  reasonCode: VoiceRecordingReasonCode | null;
  isSecureContext: boolean;
  hasGetUserMedia: boolean;
  hasMediaRecorder: boolean;
  hasPcmFallback: boolean;
}

export interface VoiceRecordingSupportEnvironment {
  isSecureContext: boolean;
  mediaDevices: Pick<MediaDevices, 'getUserMedia'> | null;
  mediaRecorder: { isTypeSupported?: (mimeType: string) => boolean } | null;
  audioContext: (new (...args: any[]) => unknown) | null;
  permissions: {
    query?: (descriptor: PermissionDescriptor) => Promise<{ state: PermissionState }>;
  } | null;
}

function getDefaultEnvironment(): VoiceRecordingSupportEnvironment {
  const runtime = globalThis as typeof globalThis & {
    MediaRecorder?: typeof MediaRecorder;
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
    isSecureContext?: boolean;
  };

  return {
    isSecureContext: runtime.isSecureContext ?? true,
    mediaDevices: typeof navigator !== 'undefined' ? navigator.mediaDevices ?? null : null,
    mediaRecorder: runtime.MediaRecorder
      ? {
          isTypeSupported: runtime.MediaRecorder.isTypeSupported?.bind(runtime.MediaRecorder),
        }
      : null,
    audioContext: runtime.AudioContext ?? runtime.webkitAudioContext ?? null,
    permissions: typeof navigator !== 'undefined' ? navigator.permissions ?? null : null,
  };
}

async function resolvePermissionState(
  permissions: VoiceRecordingSupportEnvironment['permissions']
): Promise<VoiceRecordingPermissionState> {
  if (!permissions?.query) {
    return 'unsupported';
  }

  try {
    const result = await permissions.query({ name: 'microphone' as PermissionName });
    return result.state;
  } catch {
    return 'unknown';
  }
}

function hasMediaRecorderSupport(
  mediaRecorder: VoiceRecordingSupportEnvironment['mediaRecorder']
): boolean {
  if (!mediaRecorder) {
    return false;
  }

  if (typeof mediaRecorder.isTypeSupported !== 'function') {
    return true;
  }

  return (
    mediaRecorder.isTypeSupported('audio/webm;codecs=opus') ||
    mediaRecorder.isTypeSupported('audio/webm') ||
    mediaRecorder.isTypeSupported('audio/mp4') ||
    mediaRecorder.isTypeSupported('audio/mpeg')
  );
}

function hasPcmFallbackSupport(
  audioContext: VoiceRecordingSupportEnvironment['audioContext']
): boolean {
  if (!audioContext) {
    return false;
  }

  const prototype = audioContext.prototype as
    | {
        createScriptProcessor?: unknown;
        createMediaStreamSource?: unknown;
        createAnalyser?: unknown;
      }
    | undefined;

  return Boolean(
    prototype &&
      typeof prototype.createScriptProcessor === 'function' &&
      typeof prototype.createMediaStreamSource === 'function' &&
      typeof prototype.createAnalyser === 'function'
  );
}

export type VoiceRecordingRequestErrorCode =
  | VoiceRecordingReasonCode
  | 'microphone-not-found'
  | 'microphone-busy'
  | 'recording-unavailable';

export function mapGetUserMediaErrorCode(error: unknown): VoiceRecordingRequestErrorCode {
  const name =
    typeof error === 'object' && error && 'name' in error && typeof error.name === 'string'
      ? error.name
      : '';
  const lowerName = name.toLowerCase();
  if (lowerName === 'notallowederror' || lowerName === 'securityerror') {
    return 'permission-denied';
  }
  if (
    lowerName === 'notfounderror' ||
    lowerName === 'devicesnotfounderror' ||
    lowerName === 'overconstrainederror'
  ) {
    return 'microphone-not-found';
  }
  if (
    lowerName === 'notreadableerror' ||
    lowerName === 'trackstarterror' ||
    lowerName === 'aborterror'
  ) {
    return 'microphone-busy';
  }
  return 'recording-unavailable';
}

function stopMediaStream(stream: MediaStream): void {
  stream.getTracks().forEach((track) => track.stop());
}

export async function detectVoiceRecordingSupport(
  overrides: Partial<VoiceRecordingSupportEnvironment> = {}
): Promise<VoiceRecordingSupport> {
  const environment: VoiceRecordingSupportEnvironment = {
    ...getDefaultEnvironment(),
    ...overrides,
  };
  const permissionState = await resolvePermissionState(environment.permissions);
  const hasGetUserMedia = Boolean(environment.mediaDevices?.getUserMedia);
  const hasMediaRecorder = hasMediaRecorderSupport(environment.mediaRecorder);
  const hasPcmFallback = hasPcmFallbackSupport(environment.audioContext);

  if (permissionState === 'denied') {
    return {
      canRecord: false,
      recorderMode: 'unavailable',
      permissionState,
      reasonCode: 'permission-denied',
      isSecureContext: environment.isSecureContext,
      hasGetUserMedia,
      hasMediaRecorder,
      hasPcmFallback,
    };
  }

  if (!hasGetUserMedia) {
    return {
      canRecord: false,
      recorderMode: 'unavailable',
      permissionState,
      reasonCode: environment.isSecureContext ? 'missing-get-user-media' : 'insecure-context',
      isSecureContext: environment.isSecureContext,
      hasGetUserMedia,
      hasMediaRecorder,
      hasPcmFallback,
    };
  }

  if (hasMediaRecorder) {
    return {
      canRecord: true,
      recorderMode: 'media-recorder',
      permissionState,
      reasonCode: null,
      isSecureContext: environment.isSecureContext,
      hasGetUserMedia,
      hasMediaRecorder,
      hasPcmFallback,
    };
  }

  if (hasPcmFallback) {
    return {
      canRecord: true,
      recorderMode: 'pcm-wav',
      permissionState,
      reasonCode: null,
      isSecureContext: environment.isSecureContext,
      hasGetUserMedia,
      hasMediaRecorder,
      hasPcmFallback,
    };
  }

  return {
    canRecord: false,
    recorderMode: 'unavailable',
    permissionState,
    reasonCode: 'missing-recorder-backend',
    isSecureContext: environment.isSecureContext,
    hasGetUserMedia,
    hasMediaRecorder,
    hasPcmFallback,
  };
}

export async function requestVoiceRecordingPermission(
  overrides: Partial<VoiceRecordingSupportEnvironment> = {}
): Promise<VoiceRecordingSupport> {
  const environment: VoiceRecordingSupportEnvironment = {
    ...getDefaultEnvironment(),
    ...overrides,
  };
  const initialSupport = await detectVoiceRecordingSupport(overrides);

  if (!environment.mediaDevices?.getUserMedia) {
    throw new Error(initialSupport.reasonCode ?? 'missing-get-user-media');
  }

  try {
    const stream = await environment.mediaDevices.getUserMedia({ audio: true });
    stopMediaStream(stream);
    return detectVoiceRecordingSupport(overrides);
  } catch (error) {
    throw new Error(mapGetUserMediaErrorCode(error));
  }
}
