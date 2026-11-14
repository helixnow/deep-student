import { expect, it } from 'vitest';
import { asrProtocolForModel, asrProviderSupported, isAsrModel, isAsrModelName } from '../src/asr-models.ts';

it('asr_names_cover_suffix_style_and_exclude_tts', () => {
  for (const name of [
    'Qwen/Qwen3-ASR-1.7B', 'qwen3-asr-flash', 'XingChenAGI/XingChenASR-V3.2-Ultra',
    'XingChenAGI/XingChenASR-Diarize-V3.0', 'TeleAI/TeleSpeechASR', 'FunAudioLLM/SenseVoiceSmall',
    'whisper-large-v3-turbo', 'gpt-4o-mini-transcribe', 'paraformer-v2', 'elevenlabs/scribe_v1', 'google/stt-v2', 'fun-asr',
  ]) expect(isAsrModelName(name), name).toBe(true);
  for (const name of ['FunAudioLLM/CosyVoice2-0.5B', 'qwen3-tts-flash', 'gpt-4o-mini-tts',
    'Qwen/Qwen3-Omni-30B-A3B-Captioner', 'deepseek-v4-pro', 'image-describe-v1', '']) {
    expect(isAsrModelName(name), name).toBe(false);
  }
  expect(isAsrModel('relay-gw_qwen3-asr-flash', '')).toBe(true);
  expect(isAsrModel('asr-gateway_gpt-5.6', 'GPT 5.6')).toBe(false);
});

it('protocol_follows_model_family', () => {
  expect(asrProtocolForModel('qwen3-asr-flash')).toBe('chat_input_audio');
  expect(asrProtocolForModel('aliyun/qwen3-asr-flash-2026-02-10')).toBe('chat_input_audio');
  expect(asrProtocolForModel('Qwen/Qwen3-ASR-1.7B')).toBe('transcriptions');
  expect(asrProtocolForModel('whisper-1')).toBe('transcriptions');
  for (const model of ['qwen3-asr-flash-realtime', 'qwen3-asr-flash-filetrans', 'qwen-audio-3.1-asr-flash-streaming']) {
    expect(() => asrProtocolForModel(model)).toThrow();
  }
});

it('provider_support_excludes_non_openai_protocols', () => {
  expect(asrProviderSupported('siliconflow', null)).toBe(true);
  expect(asrProviderSupported('custom', 'openai_chat_completions')).toBe(true);
  expect(asrProviderSupported('openai', 'openai_responses')).toBe(true);
  expect(asrProviderSupported(null, null)).toBe(true);
  expect(asrProviderSupported('anthropic', null)).toBe(false);
  expect(asrProviderSupported('openai_codex', null)).toBe(false);
  expect(asrProviderSupported('custom', 'google_generate_content')).toBe(false);
});
