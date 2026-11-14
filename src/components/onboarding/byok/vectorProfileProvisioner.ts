import {
  assignDimensionModel,
  createDimension,
  getDefaultEmbeddingDimension,
  listDimensions,
  setDefaultEmbeddingDimension,
} from '@/api/vfsUnifiedIndexApi';
import type {
  EmbeddingDimensionProbeResult,
  VectorProfileProvisionResult,
} from './types';

export interface ProvisionVectorProfileInput {
  embeddingResult: EmbeddingDimensionProbeResult | null;
  embeddingConfigId: string | null;
}

export async function provisionByokVectorProfile(
  input: ProvisionVectorProfileInput,
): Promise<VectorProfileProvisionResult> {
  const { embeddingResult, embeddingConfigId } = input;

  if (!embeddingResult || embeddingResult.dimension <= 0 || !embeddingConfigId) {
    return {
      status: 'partial_chat_only',
      dimension: null,
      setAsDefault: false,
      keptExistingDefaultDimension: null,
    };
  }

  const { dimension, embeddingModelId } = embeddingResult;
  // Failed reads are not an empty configuration: never provision over unknown state.
  const [existingDimensions, currentDefault] = await Promise.all([
    listDimensions(),
    getDefaultEmbeddingDimension('text'),
  ]);

  const existingTextDim = existingDimensions.find(
    (item) => item.dimension === dimension && item.modality === 'text',
  );

  if (existingTextDim) {
    // Equal dimensions do not imply compatible vector spaces. Preserve a
    // configured table's model, especially when it already contains records.
    if (!existingTextDim.modelConfigId && (existingTextDim.recordCount ?? 0) === 0) {
      await assignDimensionModel(dimension, 'text', embeddingConfigId, embeddingModelId);
    }
  } else {
    await createDimension(dimension, 'text', embeddingConfigId, embeddingModelId);
  }

  if (!currentDefault) {
    await setDefaultEmbeddingDimension(dimension, 'text');
    return {
      status: 'completed',
      dimension,
      setAsDefault: true,
      keptExistingDefaultDimension: null,
    };
  }

  return {
    status: 'completed',
    dimension,
    setAsDefault: false,
    keptExistingDefaultDimension: currentDefault.dimension === dimension ? null : currentDefault.dimension,
  };
}
