import { describe, expect, it } from 'vitest';
import {
  embeddingCapabilityForModality,
  getKnowledgeModelCapability,
  supportsKnowledgeModelCapability,
} from '../knowledgeModelCapabilities';

describe('knowledge model capability routing', () => {
  it.each([
    [{ isEmbedding: true, isReranker: false, isMultimodal: false }, 'text_embedding'],
    [{ isEmbedding: true, isReranker: false, isMultimodal: true }, 'multimodal_embedding'],
    [{ isEmbedding: false, isReranker: true, isMultimodal: false }, 'text_reranker'],
    [{ isEmbedding: false, isReranker: true, isMultimodal: true }, 'vl_reranker'],
  ] as const)('classifies %o as %s', (model, capability) => {
    expect(getKnowledgeModelCapability(model)).toBe(capability);
    expect(supportsKnowledgeModelCapability(model, capability)).toBe(true);
  });

  it('rejects ambiguous and generative-only models', () => {
    expect(getKnowledgeModelCapability({
      isEmbedding: true,
      isReranker: true,
      isMultimodal: true,
    })).toBeNull();
    expect(getKnowledgeModelCapability({
      isEmbedding: false,
      isReranker: false,
      isMultimodal: true,
    })).toBeNull();
  });

  it('maps dimension modality to an exact embedding capability', () => {
    expect(embeddingCapabilityForModality('text')).toBe('text_embedding');
    expect(embeddingCapabilityForModality('multimodal')).toBe('multimodal_embedding');
  });
});
