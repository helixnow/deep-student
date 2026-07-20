import type { ApiConfig } from '@/types';

export type KnowledgeModelCapability =
  | 'text_embedding'
  | 'multimodal_embedding'
  | 'text_reranker'
  | 'vl_reranker';

/**
 * 将知识库模型能力划分为互斥类别。
 *
 * 返回 null 的两种情况（均视为不可绑定到知识库槽位）：
 * - 歧义配置：同时标记 isEmbedding 和 isReranker，无法判断真实用途；
 * - 生成式模型：两者都未标记（普通对话/多模态模型）。
 * 该"embedding 与 reranker 同时标记 → 禁绑"逻辑是有意为之，请勿放宽。
 */
export function getKnowledgeModelCapability(
  model: Pick<ApiConfig, 'isEmbedding' | 'isReranker' | 'isMultimodal'>,
): KnowledgeModelCapability | null {
  const isEmbedding = model.isEmbedding === true;
  const isReranker = model.isReranker === true;
  // 同真（歧义）与同假（生成式）都落在这里
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

/**
 * 将维度模态映射到所需的嵌入能力。
 *
 * 完备性说明：后端维度注册表只会产出 'text' | 'multimodal' 两种模态
 * （见 vfsUnifiedIndexApi.listDimensions / VfsEmbeddingDimension.modality）。
 * 为保证对未知/异常输入的鲁棒性，任何非 'multimodal' 的取值（含空串、
 * 未来新增模态）均保守回退到 text_embedding，避免把文本维度错绑到
 * 多模态嵌入模型上；若后端新增模态，需在此处同步扩展分支。
 */
export function embeddingCapabilityForModality(
  modality: string,
): 'text_embedding' | 'multimodal_embedding' {
  return modality === 'multimodal' ? 'multimodal_embedding' : 'text_embedding';
}
