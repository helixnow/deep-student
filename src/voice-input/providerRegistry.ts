import { invoke } from '@tauri-apps/api/core';

import { blobToBase64 } from './audio';
import type {
  VoiceInputProvider,
  VoiceInputTranscriptionResult,
  VoiceInputTranscriptRequest,
} from './types';

class VoiceInputProviderRegistry {
  private readonly providers = new Map<string, VoiceInputProvider>();

  register(provider: VoiceInputProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(providerId: string): VoiceInputProvider | null {
    return this.providers.get(providerId) ?? null;
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

export const voiceInputProviderRegistry = new VoiceInputProviderRegistry();

voiceInputProviderRegistry.register({
  id: 'siliconflow',
  transcribeOnce: transcribeViaTauri,
});
