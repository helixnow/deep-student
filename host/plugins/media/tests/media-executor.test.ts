import { expect, it } from 'vitest';
import {
  canHandle, capability, mediaSignature, sensitivityLevel, type VoiceInputAsrCapability,
} from '../src/media-executor.ts';

it('handles_media_contract_tools', () => {
  expect(canHandle('builtin-media_capabilities')).toBe(true);
  expect(canHandle('builtin-media_transcribe')).toBe(true);
});

it('video_capability_reports_in_app_pipeline', () => {
  const payload = capability(null) as {
    videoAudioExtraction: Record<string, unknown>;
  };
  expect(payload.videoAudioExtraction.available).toBe(true);
  expect(payload.videoAudioExtraction.runtime).toBe('media_transcription_pipeline');
  expect(payload.videoAudioExtraction.scope).toBe('vfs_resource');
});

it('transcription_is_medium_sensitivity', () => {
  expect(sensitivityLevel('builtin-media_transcribe')).toBe('medium');
  expect(sensitivityLevel('builtin-media_capabilities')).toBe('low');
});

it('only_proven_audio_signatures_are_accepted', () => {
  const bytes = (value: string): Uint8Array => Buffer.from(value, 'latin1');
  expect(mediaSignature(bytes('ID3audio'))).toBe('audio/mpeg');
  expect(mediaSignature(bytes('OggSaudio'))).toBe('audio/ogg');
  expect(() => mediaSignature(bytes('\x1a\x45\xdf\xa3webm')))
    .toThrow(/MEDIA_VIDEO_EXTRACTION_UNSUPPORTED/);
  // ★ M4A（MP4 audio 品牌）与 ADTS AAC 现在被接受
  expect(mediaSignature(bytes('\0\0\0\x18ftypM4A '))).toBe('audio/mp4');
  expect(mediaSignature(bytes('\xff\xf1\x50\x80aac-frame'))).toBe('audio/aac');
  // 非音频品牌的 MP4 容器仍 fail-closed
  expect(() => mediaSignature(bytes('\0\0\0\x18ftypmp42')))
    .toThrow(/MEDIA_VIDEO_EXTRACTION_UNSUPPORTED/);
  // WMA 返回明确的不支持原因
  expect(() => mediaSignature(bytes('\x30\x26\xb2\x75\x8e\x66\xcf\x11wma'))).toThrow(/WMA/);
});

it('unavailable_capability_is_not_advertised_as_ready', () => {
  const payload = capability(null) as Record<string, unknown>;
  expect(payload.available).toBe(false);
  expect(payload.unavailableReasonCode).toBe('APP_STATE_UNAVAILABLE');
  expect((payload.supportedAudio as unknown[]).length).toBe(6);
});

it('capability_reflects_resolved_asr_configuration', () => {
  const asr: VoiceInputAsrCapability = {
    providerId: 'siliconflow',
    providerName: 'SiliconFlow',
    model: 'Qwen/Qwen3-ASR-1.7B',
    configured: false,
  };
  const unavailable = capability(asr) as {
    available: boolean; unavailableReasonCode: unknown; provider: Record<string, unknown>;
  };
  expect(unavailable.available).toBe(false);
  expect(unavailable.unavailableReasonCode).toBe('ASR_NOT_CONFIGURED');
  expect(unavailable.provider.name).toBe('SiliconFlow');

  const available = capability({
    providerId: 'custom',
    providerName: '统一出口',
    model: 'qwen3-asr-flash',
    configured: true,
  }) as {
    available: boolean; unavailableReasonCode: unknown; provider: Record<string, unknown>;
    configuration: Record<string, unknown>;
  };
  expect(available.available).toBe(true);
  expect(available.provider.model).toBe('qwen3-asr-flash');
  expect(available.configuration.configured).toBe(true);
  expect(available.unavailableReasonCode).toBeNull();
});
