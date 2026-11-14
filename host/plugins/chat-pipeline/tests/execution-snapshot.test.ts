import { describe, expect, it } from 'vitest';
import {
  executionSnapshotFromMessageMetadata, parseModelExecutionSnapshot,
  serializeModelExecutionSnapshot, type ModelExecutionSnapshot,
} from '../src/execution-snapshot.ts';
import type { CapabilityState } from '../../../../contracts/ipc/generated/_shared.ts';

const unavailable = (): CapabilityState => ({
  configured: false,
  healthy: false,
  circuitOpen: false,
  protocolCompatible: true,
  indexCompatible: true,
});

const available = (): CapabilityState => ({
  configured: true,
  healthy: true,
  circuitOpen: false,
  protocolCompatible: true,
  indexCompatible: true,
});

describe('chat_v2/pipeline/context_compiler.rs::tests', () => {
  it('execution_snapshot_round_trips_and_old_meta_remains_compatible', () => {
    const snapshot: ModelExecutionSnapshot = {
      requestedModelId: 'tm',
      resolvedModelId: 'mm',
      resolvedModelName: 'Vision',
      resolvedModelIsMultimodal: true,
      capabilitySnapshot: {
        textEmbedding: unavailable(),
        multimodalEmbedding: unavailable(),
        textModel: unavailable(),
        multimodalModel: available(),
        ocr: unavailable(),
      },
      generationPlan: {
        planner: {
          route: 'multimodal_model_direct',
          activeModel: 'multimodal',
          fallbackFrom: null,
          sendsOriginalImages: true,
          usesOcr: false,
          degraded: false,
        },
        imageBudget: 8,
        historyImageBudget: 4,
      },
      executionRoute: 'multimodal_model_direct',
      frozenAt: 42,
    };

    const json = serializeModelExecutionSnapshot(snapshot);
    expect(parseModelExecutionSnapshot(json)).toEqual(snapshot);
    // serde `skip_serializing_if = "Option::is_none"` keeps optional keys out.
    expect(json).not.toHaveProperty('auxiliaryMultimodalConfigId');

    // Legacy metadata without the snapshot field stays valid.
    expect(executionSnapshotFromMessageMetadata({ modelId: 'legacy' })).toBeNull();
    expect(executionSnapshotFromMessageMetadata(null)).toBeNull();
    expect(executionSnapshotFromMessageMetadata({ executionSnapshot: json }))
      .toEqual(snapshot);

    // A required field missing rejects the whole snapshot, never a partial one.
    const { frozenAt: _frozenAt, ...withoutFrozenAt } = json;
    expect(parseModelExecutionSnapshot(withoutFrozenAt)).toBeNull();

    for (const invalid of [-1, 1.5, 1e21]) {
      expect(parseModelExecutionSnapshot({ ...snapshot, generationPlan: {
        ...snapshot.generationPlan, imageBudget: invalid,
      } })).toBeNull();
      expect(parseModelExecutionSnapshot({ ...snapshot, generationPlan: {
        ...snapshot.generationPlan, historyImageBudget: invalid,
      } })).toBeNull();
    }
    const { activeModel: _active, fallbackFrom: _fallback, ...planner } = snapshot.generationPlan.planner;
    expect(parseModelExecutionSnapshot({ ...snapshot, generationPlan: {
      ...snapshot.generationPlan, planner,
    } })?.generationPlan.planner).toEqual({ ...planner, activeModel: null, fallbackFrom: null });

    const owned = parseModelExecutionSnapshot(snapshot)!;
    snapshot.capabilitySnapshot.multimodalModel.healthy = false;
    snapshot.generationPlan.planner.degraded = true;
    expect(owned.capabilitySnapshot.multimodalModel.healthy).toBe(true);
    expect(owned.generationPlan.planner.degraded).toBe(false);
  });
});
