import { inferApiCapabilities } from './apiCapabilityEngine';

export interface ChatModelEligibilityInput {
  model?: string | null;
  enabled?: boolean;
  isEmbedding?: boolean;
  is_embedding?: boolean;
  isReranker?: boolean;
  is_reranker?: boolean;
  isImageGeneration?: boolean;
  is_image_generation?: boolean;
  isAudioTranscription?: boolean;
  is_audio_transcription?: boolean;
}

/** Eligibility for ordinary text or multimodal chat generation. */
export function isChatGenerationModel(config: ChatModelEligibilityInput): boolean {
  if (
    config.isEmbedding === true || config.is_embedding === true ||
    config.isReranker === true || config.is_reranker === true ||
    config.isImageGeneration === true || config.is_image_generation === true ||
    config.isAudioTranscription === true || config.is_audio_transcription === true
  ) return false;

  const model = (config.model ?? '').trim();
  const lower = model.toLowerCase();
  if (lower === 'system' || (lower.includes('deepseek') && lower.includes('ocr')) || lower.includes('paddleocr')) {
    return false;
  }

  const inferred = inferApiCapabilities({ id: model });
  return !inferred.embedding && !inferred.rerank && !inferred.imageModel && !inferred.audioTranscription;
}

export function isAvailableChatModel(config: ChatModelEligibilityInput): boolean {
  return config.enabled !== false && isChatGenerationModel(config);
}
