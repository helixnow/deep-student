/**
 * pipeline/context_compiler.rs — immutable per-generation model execution
 * snapshot and its message-metadata wire codec.
 *
 * The snapshot is captured before generation starts and persisted in
 * `MessageMeta.executionSnapshot`, so later turns can replay the exact model,
 * capability and route facts instead of recomputing them.
 */
import type {
  ChatGenerationPlan, GenerationPlan, GenerationRoute, ModelExecutionSnapshot,
} from '../../../../contracts/ipc/generated/L04-chat-session.ts';
import type {
  CapabilitySnapshot, CapabilityState,
} from '../../../../contracts/ipc/generated/_shared.ts';

export type {
  ChatGenerationPlan, GenerationPlan, GenerationRoute, ModelExecutionSnapshot,
};

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isCapabilityState(value: unknown): value is CapabilityState {
  const record = recordOf(value);
  if (record === null) return false;
  if (typeof record.configured !== 'boolean') return false;
  if (typeof record.healthy !== 'boolean') return false;
  if (typeof record.circuitOpen !== 'boolean') return false;
  if (typeof record.protocolCompatible !== 'boolean') return false;
  if (typeof record.indexCompatible !== 'boolean') return false;
  const reason = record.reason;
  return reason === undefined || reason === null || typeof reason === 'string';
}

/** serde `#[derive(Deserialize)]` requires every non-optional field. */
function isCapabilitySnapshot(value: unknown): value is CapabilitySnapshot {
  const record = recordOf(value);
  if (record === null) return false;
  return isCapabilityState(record.textEmbedding)
    && isCapabilityState(record.multimodalEmbedding)
    && isCapabilityState(record.textModel)
    && isCapabilityState(record.multimodalModel)
    && isCapabilityState(record.ocr);
}

const GENERATION_ROUTES: readonly GenerationRoute[] = [
  'text_model_direct', 'multimodal_model_direct', 'multimodal_observation_then_text_model',
  'ocr_then_text_model', 'text_model_without_image', 'unavailable',
];

function isGenerationRoute(value: unknown): value is GenerationRoute {
  return typeof value === 'string'
    && (GENERATION_ROUTES as readonly string[]).includes(value);
}

function isActiveGenerationModel(value: unknown): boolean {
  return value === undefined || value === null || value === 'text' || value === 'multimodal';
}

function isGenerationPlan(value: unknown): value is GenerationPlan {
  const record = recordOf(value);
  if (record === null) return false;
  return isGenerationRoute(record.route)
    && isActiveGenerationModel(record.activeModel)
    && isActiveGenerationModel(record.fallbackFrom)
    && typeof record.sendsOriginalImages === 'boolean'
    && typeof record.usesOcr === 'boolean'
    && typeof record.degraded === 'boolean';
}

function isChatGenerationPlan(value: unknown): value is ChatGenerationPlan {
  const record = recordOf(value);
  if (record === null) return false;
  const auxiliary = record.auxiliaryMultimodalConfigId;
  return isGenerationPlan(record.planner)
    && (auxiliary === undefined || auxiliary === null || typeof auxiliary === 'string')
    && Number.isInteger(record.imageBudget)
    && (record.imageBudget as number) >= 0
    && (record.imageBudget as number) < 2 ** 64
    && Number.isInteger(record.historyImageBudget)
    && (record.historyImageBudget as number) >= 0
    && (record.historyImageBudget as number) < 2 ** 64;
}

/**
 * Strict serde-shaped decode: a snapshot missing a required field is rejected
 * wholesale, so callers fall back to legacy history reconstruction.
 */
export function parseModelExecutionSnapshot(value: unknown): ModelExecutionSnapshot | null {
  const record = recordOf(value);
  if (record === null) return null;
  const resolvedModelId = record.resolvedModelId;
  const resolvedModelName = record.resolvedModelName;
  const resolvedModelIsMultimodal = record.resolvedModelIsMultimodal;
  const frozenAt = record.frozenAt;
  if (typeof resolvedModelId !== 'string') return null;
  if (typeof resolvedModelName !== 'string') return null;
  if (typeof resolvedModelIsMultimodal !== 'boolean') return null;
  if (typeof frozenAt !== 'number' || !Number.isInteger(frozenAt)) return null;
  if (!isCapabilitySnapshot(record.capabilitySnapshot)) return null;
  if (!isChatGenerationPlan(record.generationPlan)) return null;

  const requestedModelId = record.requestedModelId;
  if (requestedModelId !== undefined && requestedModelId !== null
    && typeof requestedModelId !== 'string') return null;
  const executionRoute = record.executionRoute;
  if (executionRoute !== undefined && executionRoute !== null
    && !isGenerationRoute(executionRoute)) return null;

  const plan = record.generationPlan;
  const auxiliary = plan.auxiliaryMultimodalConfigId;
  return {
    ...(typeof requestedModelId === 'string' ? { requestedModelId } : {}),
    resolvedModelId,
    resolvedModelName,
    resolvedModelIsMultimodal,
    capabilitySnapshot: structuredClone(record.capabilitySnapshot),
    generationPlan: {
      planner: { ...plan.planner,
        activeModel: plan.planner.activeModel ?? null,
        fallbackFrom: plan.planner.fallbackFrom ?? null },
      ...(auxiliary === undefined || auxiliary === null
        ? {}
        : { auxiliaryMultimodalConfigId: auxiliary }),
      imageBudget: plan.imageBudget,
      historyImageBudget: plan.historyImageBudget,
    },
    ...(isGenerationRoute(executionRoute) ? { executionRoute } : {}),
    frozenAt,
  };
}

/** `MessageMeta.executionSnapshot`; absent on legacy metadata. */
export function executionSnapshotFromMessageMetadata(
  metadata: unknown): ModelExecutionSnapshot | null {
  const record = recordOf(metadata);
  if (record === null) return null;
  return parseModelExecutionSnapshot(record.executionSnapshot);
}

function serializeCapabilityState(state: CapabilityState): Record<string, unknown> {
  return {
    configured: state.configured,
    healthy: state.healthy,
    circuitOpen: state.circuitOpen,
    protocolCompatible: state.protocolCompatible,
    indexCompatible: state.indexCompatible,
    ...(state.reason === undefined || state.reason === null ? {} : { reason: state.reason }),
  };
}

/**
 * serde-shaped encode: camelCase keys and `skip_serializing_if` omissions, so a
 * round trip through JSON is byte-stable and legacy readers keep working.
 */
export function serializeModelExecutionSnapshot(
  snapshot: ModelExecutionSnapshot): Record<string, unknown> {
  return {
    ...(snapshot.requestedModelId === undefined || snapshot.requestedModelId === null
      ? {}
      : { requestedModelId: snapshot.requestedModelId }),
    resolvedModelId: snapshot.resolvedModelId,
    resolvedModelName: snapshot.resolvedModelName,
    resolvedModelIsMultimodal: snapshot.resolvedModelIsMultimodal,
    capabilitySnapshot: {
      textEmbedding: serializeCapabilityState(snapshot.capabilitySnapshot.textEmbedding),
      multimodalEmbedding:
        serializeCapabilityState(snapshot.capabilitySnapshot.multimodalEmbedding),
      textModel: serializeCapabilityState(snapshot.capabilitySnapshot.textModel),
      multimodalModel: serializeCapabilityState(snapshot.capabilitySnapshot.multimodalModel),
      ocr: serializeCapabilityState(snapshot.capabilitySnapshot.ocr),
    },
    generationPlan: {
      planner: {
        route: snapshot.generationPlan.planner.route,
        activeModel: snapshot.generationPlan.planner.activeModel,
        fallbackFrom: snapshot.generationPlan.planner.fallbackFrom,
        sendsOriginalImages: snapshot.generationPlan.planner.sendsOriginalImages,
        usesOcr: snapshot.generationPlan.planner.usesOcr,
        degraded: snapshot.generationPlan.planner.degraded,
      },
      ...(snapshot.generationPlan.auxiliaryMultimodalConfigId === undefined
        || snapshot.generationPlan.auxiliaryMultimodalConfigId === null
        ? {}
        : {
          auxiliaryMultimodalConfigId:
            snapshot.generationPlan.auxiliaryMultimodalConfigId,
        }),
      imageBudget: snapshot.generationPlan.imageBudget,
      historyImageBudget: snapshot.generationPlan.historyImageBudget,
    },
    ...(snapshot.executionRoute === undefined || snapshot.executionRoute === null
      ? {}
      : { executionRoute: snapshot.executionRoute }),
    frozenAt: snapshot.frozenAt,
  };
}
