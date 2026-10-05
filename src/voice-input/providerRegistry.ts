import { invoke } from '@tauri-apps/api/core';

import { blobToBase64 } from './audio';
import type {
  VoiceInputProvider,
  VoiceInputTranscriptionResult,
  VoiceInputTranscriptRequest,
} from './types';

class VoiceInputProviderRegistry {
  private readonly providers = new Map<string, VoiceInputProvider>();

  constructor(private readonly fallback: VoiceInputProvider) {}

  register(provider: VoiceInputProvider): void {
    this.providers.set(provider.id, provider);
  }

  /** 没有专用实现的供应商走后端受管转写（后端按 configId 取该模型配置的 base_url / key） */
  get(providerId: string): VoiceInputProvider | null {
    return this.providers.get(providerId) ?? this.fallback;
  }
}

async function transcribeViaTauri(
  request: VoiceInputTranscriptRequest
): Promise<VoiceInputTranscriptionResult> {
  const audioBase64 = await blobToBase64(request.blob);
  return invoke<VoiceInputTranscriptionResult>('voice_input_transcribe', {
    request: {
      audioBase64,
      mimeType: request.mimeType,
      providerId: request.providerId,
      model: request.model,
      configId: request.configId ?? null,
      language: request.language ?? null,
      prompt: request.prompt ?? null,
      durationMs: request.durationMs ?? null,
    },
  });
}

export const voiceInputProviderRegistry = new VoiceInputProviderRegistry({
  id: 'managed',
  transcribeOnce: transcribeViaTauri,
});
