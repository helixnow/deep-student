import type { ApiConfig } from '@/types';

export type KnowledgeModelCapability =
  | 'text_embedding'
  | 'multimodal_embedding'
  | 'text_reranker'
  | 'vl_reranker';

/**
 * 将知识库模型能力划分为互斥类别。
 * 同时标记 embedding 和 reranker 的配置视为歧义配置，不允许绑定。
 */
export function getKnowledgeModelCapability(
  model: Pick<ApiConfig, 'isEmbedding' | 'isReranker' | 'isMultimodal'>,
): KnowledgeModelCapability | null {
  const isEmbedding = model.isEmbedding === true;
  const isReranker = model.isReranker === true;
  if (isEmbedding === isReranker) return null;

  if (isEmbedding) {
    return model.isMultimodal ? 'multimodal_embedding' : 'text_embedding';
  }
  return model.isMultimodal ? 'vl_reranker' : 'text_reranker';
}

export function supportsKnowledgeModelCapability(
  model: Pick<ApiConfig, 'isEmbedding' | 'isReranker' | 'isMultimodal'>,
  capability: KnowledgeModelCapability,
): boolean {
  return getKnowledgeModelCapability(model) === capability;
}

export function embeddingCapabilityForModality(
  modality: string,
): 'text_embedding' | 'multimodal_embedding' {
  return modality === 'multimodal' ? 'multimodal_embedding' : 'text_embedding';
}
