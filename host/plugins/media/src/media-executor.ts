/**
 * `src/chat_v2/tools/media_executor.rs`: capability payload, tool gate, sensitivity
 * and fail-closed audio signature sniffing for managed transcription
 * (executor: `tools/media-tool-executor.ts`).
 */
import { stripToolNamespace } from './document-processing.ts';

export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
export const MAX_MEDIA_IMPORT_BYTES = 4 * 1024 * 1024 * 1024;

export interface VoiceInputAsrCapability {
  providerId: string;
  providerName: string;
  model: string;
  configured: boolean;
}

export function canHandle(toolName: string): boolean {
  const name = stripToolNamespace(toolName);
  return name === 'media_capabilities' || name === 'media_transcribe';
}

export function sensitivityLevel(toolName: string): 'medium' | 'low' {
  return stripToolNamespace(toolName) === 'media_transcribe' ? 'medium' : 'low';
}

export interface CapabilityReport {
  ok: true;
  capability: 'managed_audio_transcription';
  available: boolean;
  runtime: 'existing_voice_input_asr';
  provider: {
    id: string | null;
    name: string | null;
    model: string | null;
    externalProcessing: true;
  };
  supportedAudio: string[];
  unavailableReasonCode: 'APP_STATE_UNAVAILABLE' | 'ASR_NOT_CONFIGURED' | null;
  videoAudioExtraction: {
    available: true;
    scope: 'vfs_resource';
    runtime: 'media_transcription_pipeline';
    containers: string[];
    codecs: string[];
    unsupportedCodecs: string[];
    maxBytes: number;
    resumable: true;
    reason: string;
  };
  configuration: { configured: boolean; requirement: string };
}

type CapabilityValue = Record<string, unknown>;

export function capability(asr: VoiceInputAsrCapability | null): CapabilityValue {
  const available = asr !== null && asr.configured;
  const unavailableReasonCode = available
    ? null
    : asr !== null ? 'ASR_NOT_CONFIGURED' : 'APP_STATE_UNAVAILABLE';
  return {
    ok: true,
    capability: 'managed_audio_transcription',
    available,
    runtime: 'existing_voice_input_asr',
    provider: {
      id: asr === null ? null : asr.providerId,
      name: asr === null ? null : asr.providerName,
      model: asr === null ? null : asr.model,
      externalProcessing: true,
    },
    supportedAudio: [
      'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/flac', 'audio/mp4', 'audio/aac',
    ],
    unavailableReasonCode,
    videoAudioExtraction: {
      available: true,
      scope: 'vfs_resource',
      runtime: 'media_transcription_pipeline',
      containers: ['mp4', 'm4a', 'mov', 'mkv', 'webm', 'ogg', 'wav', 'mp3', 'flac', 'aac'],
      codecs: ['aac', 'alac', 'mp3', 'flac', 'vorbis', 'pcm', 'adpcm'],
      unsupportedCodecs: ['opus', 'ac3', 'eac3', 'dts', 'wma'],
      maxBytes: MAX_MEDIA_IMPORT_BYTES,
      resumable: true,
      reason: 'VFS 音视频资源由应用内解码（symphonia）+ 分段 ASR 转写；'
        + 'Opus/AC-3/WMA 音轨需先转为 MP4(AAC)/M4A/MP3',
    },
    configuration: {
      configured: available,
      requirement: 'ASR execution uses the voice-input ASR model assigned in Settings › Model Assignment '
        + '(any OpenAI-compatible provider), or the default SiliconFlow model when a SiliconFlow API key is configured',
    },
  };
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((byte, index) => bytes[index] === byte);
}

function equalRange(bytes: Uint8Array, start: number, end: number, expected: readonly number[]): boolean {
  if (bytes.length < end) return false;
  return expected.every((byte, index) => bytes[start + index] === byte);
}

/** 只接受已证明为纯音频的签名；视频容器与 WMA 明确 fail-closed。 */
export function mediaSignature(bytes: Uint8Array): string {
  if (startsWith(bytes, [0x49, 0x44, 0x33])
    || startsWith(bytes, [0xff, 0xfb])
    || startsWith(bytes, [0xff, 0xf3])
    || startsWith(bytes, [0xff, 0xf2])) {
    return 'audio/mpeg';
  }
  if (bytes.length >= 12 && equalRange(bytes, 0, 4, [0x52, 0x49, 0x46, 0x46])
    && equalRange(bytes, 8, 12, [0x57, 0x41, 0x56, 0x45])) {
    return 'audio/wav';
  }
  if (startsWith(bytes, [0x4f, 0x67, 0x67, 0x53])) return 'audio/ogg';
  if (startsWith(bytes, [0x66, 0x4c, 0x61, 0x43])) return 'audio/flac';
  if (bytes.length >= 12 && equalRange(bytes, 4, 8, [0x66, 0x74, 0x79, 0x70])) {
    const brand = bytes.subarray(8, 12);
    if (brand[0] === 0x4d && brand[1] === 0x34
      && (brand[2] === 0x41 || brand[2] === 0x42 || brand[2] === 0x50)) {
      return 'audio/mp4';
    }
    throw new Error('MEDIA_VIDEO_EXTRACTION_UNSUPPORTED: ISO BMFF containers other than M4A/M4B/M4P '
      + 'are rejected because no application-managed parser has proven they are audio-only');
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xf6) === 0xf0) {
    return 'audio/aac';
  }
  if (startsWith(bytes, [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11])) {
    throw new Error('MEDIA_UNSUPPORTED_FORMAT: WMA (ASF container) is not supported by the managed ASR '
      + 'runtime; convert to MP3/WAV/M4A first');
  }
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    throw new Error('MEDIA_VIDEO_EXTRACTION_UNSUPPORTED: EBML (WebM/MKV) containers are rejected because '
      + 'no application-managed parser has proven they are audio-only');
  }
  throw new Error('MEDIA_UNSUPPORTED_FORMAT: supported audio signatures are MP3, WAV, OGG, FLAC, '
    + 'M4A and ADTS AAC');
}
