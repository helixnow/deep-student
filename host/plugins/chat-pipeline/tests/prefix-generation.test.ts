/**
 * chat_v2/pipeline/prefix_generation_{fork,restore,fork_finale}_tests.rs —
 * tool-face prefix generation: variant-index convergence, metadata restore,
 * advance semantics, and steady-state timelines.
 */
import { describe, expect, it } from 'vitest';
import {
  advanceToolFacePrefixIntoMetadata, convergeToolFaceOrdersByVariantIndex,
  emptyToolFacePrefixSnapshot, FROZEN_TOOL_SCHEMA_ORDER_METADATA_KEY,
  freezeToolSchemaOrderForPromptCache, mergeFrozenToolSchemaOrderBaseline,
  refillToolFaceBaseline, TOOL_FACE_PREFIX_GENERATION_METADATA_KEY,
  TOOL_SCHEMA_DIGEST_METADATA_KEY, toolFacePrefixFromMetadata, toolSchemaSortKey,
  type ToolFacePrefixSnapshot,
} from '../src/tool-face.ts';

interface MetadataHolder { metadata: unknown }

function toolSchema(name: string, description: string): unknown {
  return {
    type: 'function',
    function: { name, description, parameters: { type: 'object', properties: {} } },
  };
}

function toolsBytes(tools: readonly unknown[]): Buffer {
  return Buffer.from(JSON.stringify(tools), 'utf8');
}

/** Established converged baseline B̂ = [read_file, search]. */
function establishedBaseline(): string[] {
  const baseline: string[] = [];
  const tools = [toolSchema('search', '检索'), toolSchema('read_file', '读文件')];
  freezeToolSchemaOrderForPromptCache(tools, baseline);
  expect(baseline).toEqual(['read_file', 'search']);
  return baseline;
}

function variantDiscloses(snapshotBaseline: readonly string[], disclosed: readonly string[]):
  { order: string[]; bytes: Buffer } {
  const localOrder = [...snapshotBaseline];
  const tools = [
    ...snapshotBaseline.map(name => toolSchema(name, '基线工具')),
    ...disclosed.map(name => toolSchema(name, '披露技能工具')),
  ];
  freezeToolSchemaOrderForPromptCache(tools, localOrder);
  expect(tools.map(tool => toolSchemaSortKey(tool))).toEqual(localOrder);
  return { order: localOrder, bytes: toolsBytes(tools) };
}

function converge(baselines: readonly (readonly string[])[]):
  { generationBump: number; order: string[] } {
  return convergeToolFaceOrdersByVariantIndex(baselines);
}

function advance(holder: MetadataHolder, snapshot: ToolFacePrefixSnapshot): boolean {
  const result = advanceToolFacePrefixIntoMetadata(holder.metadata, snapshot);
  holder.metadata = result.metadata;
  return result.wrote;
}

function forkRoundTConvergedAndPersisted():
  { converged: ToolFacePrefixSnapshot; holder: MetadataHolder } {
  const sessionBaseline = establishedBaseline();
  const variantA = variantDiscloses(sessionBaseline, ['quiz_gen']);
  const variantB = variantDiscloses(sessionBaseline, ['anki_export']);

  const { generationBump, order } = converge([variantA.order, variantB.order]);
  expect(generationBump).toBe(1);
  expect(order).toEqual(['read_file', 'search', 'quiz_gen', 'anki_export']);

  const converged: ToolFacePrefixSnapshot = {
    generation: generationBump, order, schemaDigest: 'digest_g1',
  };
  const holder: MetadataHolder = { metadata: { authorityMode: 'chat' } };
  expect(advance(holder, converged)).toBe(true);
  return { converged, holder };
}

describe('chat_v2/pipeline/prefix_generation_fork_tests.rs', () => {
  it('divergent_variant_tails_x_vs_y_converge_by_variant_index_and_bump_generation', () => {
    const generationBefore = 0;
    const sessionBaseline = establishedBaseline();

    const variantA = variantDiscloses(sessionBaseline, ['quiz_gen']);
    const variantB = variantDiscloses(sessionBaseline, ['anki_export']);
    expect(variantA.order).toEqual(['read_file', 'search', 'quiz_gen']);
    expect(variantB.order).toEqual(['read_file', 'search', 'anki_export']);

    // Counterexample: completion-race order is non-deterministic.
    const raceAFirst = [...sessionBaseline];
    mergeFrozenToolSchemaOrderBaseline(raceAFirst, variantA.order);
    mergeFrozenToolSchemaOrderBaseline(raceAFirst, variantB.order);
    const raceBFirst = [...sessionBaseline];
    mergeFrozenToolSchemaOrderBaseline(raceBFirst, variantB.order);
    mergeFrozenToolSchemaOrderBaseline(raceBFirst, variantA.order);
    expect(raceAFirst).toEqual(['read_file', 'search', 'quiz_gen', 'anki_export']);
    expect(raceBFirst).toEqual(['read_file', 'search', 'anki_export', 'quiz_gen']);
    expect(raceAFirst).not.toEqual(raceBFirst);

    const { generationBump, order } = converge([variantA.order, variantB.order]);
    expect(order).toEqual(['read_file', 'search', 'quiz_gen', 'anki_export']);
    expect(order).not.toEqual(['read_file', 'search', 'anki_export', 'quiz_gen']);
    expect(generationBump).toBe(1);
    expect(generationBefore + generationBump).toBe(1);
    expect(order.slice(0, sessionBaseline.length)).toEqual(sessionBaseline);

    const rerun = converge([order, order]);
    expect(rerun.generationBump).toBe(0);
    expect(rerun.order).toEqual(order);
  });

  it('single_variant_prefix_extension_does_not_bump_generation', () => {
    const generationBefore = 0;
    const sessionBaseline = establishedBaseline();
    const single = variantDiscloses(sessionBaseline, ['zip_export']);
    expect(single.order).toEqual(['read_file', 'search', 'zip_export']);

    const { generationBump, order } = converge([single.order]);
    expect(generationBump).toBe(0);
    expect(generationBefore + generationBump).toBe(0);
    expect(order).toEqual(single.order);
    expect(order.slice(0, sessionBaseline.length)).toEqual(sessionBaseline);
  });

  it('later_round_both_variants_see_xy_share_generation_1_order', () => {
    const generationT = 1;
    const convergedBaseline = ['read_file', 'search', 'quiz_gen', 'anki_export'];
    const variantA = variantDiscloses(convergedBaseline, []);
    const variantB = variantDiscloses(convergedBaseline, []);

    expect(variantA.order).toEqual(convergedBaseline);
    expect(variantB.order).toEqual(convergedBaseline);
    expect(variantA.bytes.equals(variantB.bytes)).toBe(true);

    const { generationBump, order } = converge([variantA.order, variantB.order]);
    expect(generationBump).toBe(0);
    expect(generationT + generationBump).toBe(1);
    expect(order).toEqual(convergedBaseline);
  });

  it('t_plus_2_steady_state_after_fork_both_variants_share_order_and_generation', () => {
    const generationT0 = 0;
    const sessionBaseline = establishedBaseline();
    const forkA = variantDiscloses(sessionBaseline, ['quiz_gen']);
    const forkB = variantDiscloses(sessionBaseline, ['anki_export']);
    const convergedT = converge([forkA.order, forkB.order]);
    const generationT = generationT0 + convergedT.generationBump;
    expect(generationT).toBe(1);
    expect(convergedT.order).toEqual(['read_file', 'search', 'quiz_gen', 'anki_export']);

    const t1A = variantDiscloses(convergedT.order, []);
    const t1B = variantDiscloses(convergedT.order, []);
    const convergedT1 = converge([t1A.order, t1B.order]);
    const generationT1 = generationT + convergedT1.generationBump;
    expect(convergedT1.generationBump).toBe(0);
    expect(convergedT1.order).toEqual(convergedT.order);
    expect(t1A.bytes.equals(t1B.bytes)).toBe(true);

    const t2A = variantDiscloses(convergedT1.order, []);
    const t2B = variantDiscloses(convergedT1.order, []);
    const convergedT2 = converge([t2A.order, t2B.order]);
    const generationT2 = generationT1 + convergedT2.generationBump;
    expect(convergedT2.generationBump).toBe(0);
    expect(generationT2).toBe(1);
    expect(generationT2).toBe(generationT1);
    expect(t2A.order).toEqual(t2B.order);
    expect(convergedT2.order).toEqual(convergedT.order);
    expect(t2A.bytes.equals(t2B.bytes)).toBe(true);
    expect(t1A.bytes.equals(t2A.bytes)).toBe(true);

    const rerun = converge([convergedT2.order, convergedT2.order]);
    expect(rerun.generationBump).toBe(0);
    expect(rerun.order).toEqual(convergedT2.order);
  });
});

describe('chat_v2/pipeline/prefix_generation_fork_finale_tests.rs', () => {
  it('after_fork_next_round_both_variants_see_x_and_y_with_stable_generation', () => {
    const { converged, holder } = forkRoundTConvergedAndPersisted();
    const metadataBytesAfterRoundT = JSON.stringify(holder.metadata);

    const snapshotT1 = toolFacePrefixFromMetadata(holder.metadata)!;
    expect(snapshotT1.generation).toBe(1);
    expect(snapshotT1.order).toEqual(converged.order);

    const variantA = variantDiscloses(snapshotT1.order, []);
    const variantB = variantDiscloses(snapshotT1.order, []);

    expect(variantA.order).toContain('anki_export');
    expect(variantB.order).toContain('quiz_gen');
    expect(variantA.order).toEqual(variantB.order);
    expect(variantA.order).toEqual(['read_file', 'search', 'quiz_gen', 'anki_export']);
    expect(variantA.bytes.equals(variantB.bytes)).toBe(true);

    const steady = converge([variantA.order, variantB.order]);
    expect(steady.generationBump).toBe(0);
    expect(converged.generation + steady.generationBump).toBe(1);
    expect(steady.order).toEqual(converged.order);

    const steadyWriteback: ToolFacePrefixSnapshot = {
      generation: converged.generation,
      order: steady.order,
      schemaDigest: converged.schemaDigest,
    };
    expect(advance(holder, steadyWriteback)).toBe(false);
    expect(JSON.stringify(holder.metadata)).toBe(metadataBytesAfterRoundT);
  });

  it('steady_state_survives_many_rounds_and_variant_index_shuffles', () => {
    const { converged } = forkRoundTConvergedAndPersisted();
    const baselineBytes = variantDiscloses(converged.order, []).bytes;

    let generation = converged.generation;
    let baseline = [...converged.order];

    for (let round = 1; round <= 4; round++) {
      const variantA = variantDiscloses(baseline, []);
      const variantB = variantDiscloses(baseline, []);
      expect(variantA.bytes.equals(baselineBytes)).toBe(true);
      expect(variantB.bytes.equals(baselineBytes)).toBe(true);

      const inputs = round % 2 === 0
        ? [variantA.order, variantB.order]
        : [variantB.order, variantA.order];
      const steady = converge(inputs);
      expect(steady.generationBump).toBe(0);
      generation += steady.generationBump;
      expect(steady.order).toEqual(baseline);
      baseline = steady.order;
    }

    expect(generation).toBe(1);
    expect(baseline).toEqual(['read_file', 'search', 'quiz_gen', 'anki_export']);
  });

  it('restart_between_fork_and_next_round_preserves_xy_visibility_and_generation', () => {
    const sessionId = 'sess_fork_finale_restart';
    const { converged, holder } = forkRoundTConvergedAndPersisted();
    const memoryMap = new Map<string, ToolFacePrefixSnapshot>([[sessionId, converged]]);
    memoryMap.clear();
    expect(memoryMap.size).toBe(0);

    const restored = toolFacePrefixFromMetadata(holder.metadata)!;
    expect(restored.generation).toBe(1);
    expect(restored.order).toEqual(converged.order);
    expect(restored.order).not.toEqual(['anki_export', 'quiz_gen', 'read_file', 'search']);
    memoryMap.set(sessionId, restored);

    const variantA = variantDiscloses(restored.order, []);
    const variantB = variantDiscloses(restored.order, []);
    expect(variantA.order).toContain('quiz_gen');
    expect(variantA.order).toContain('anki_export');
    expect(variantA.order).toEqual(variantB.order);
    expect(variantA.bytes.equals(variantB.bytes)).toBe(true);

    const steady = converge([variantA.order, variantB.order]);
    expect(steady.generationBump).toBe(0);
    expect(restored.generation + steady.generationBump).toBe(1);
    expect(steady.order).toEqual(converged.order);
  });

  it('stale_pre_fork_writeback_cannot_regress_steady_state', () => {
    const { converged, holder } = forkRoundTConvergedAndPersisted();
    const steadyBytes = JSON.stringify(holder.metadata);

    const stale: ToolFacePrefixSnapshot = {
      generation: 0,
      order: ['read_file', 'search', 'anki_export'],
      schemaDigest: null,
    };
    expect(converged.order.slice(0, stale.order.length)).not.toEqual(stale.order);
    expect(advance(holder, stale)).toBe(false);
    expect(JSON.stringify(holder.metadata)).toBe(steadyBytes);

    const after = toolFacePrefixFromMetadata(holder.metadata)!;
    expect(after.generation).toBe(1);
    expect(after.order).toEqual(['read_file', 'search', 'quiz_gen', 'anki_export']);

    const variantA = variantDiscloses(after.order, []);
    const variantB = variantDiscloses(after.order, []);
    expect(variantA.order).toEqual(variantB.order);
    expect(variantA.bytes.equals(variantB.bytes)).toBe(true);
    expect(converge([variantA.order, variantB.order]).generationBump).toBe(0);
  });
});

describe('chat_v2/pipeline/prefix_generation_restore_tests.rs', () => {
  it('cleared_memory_map_restores_same_generation_and_order_from_metadata', () => {
    const sessionId = 'sess_restore_after_restart';
    const before: ToolFacePrefixSnapshot = {
      generation: 3,
      order: ['zeta_tool', 'alpha_tool', 'beta_tool'],
      schemaDigest: 'digest_v3',
    };
    const memoryMap = new Map<string, ToolFacePrefixSnapshot>([[sessionId, before]]);

    const holder: MetadataHolder = { metadata: { authorityMode: 'plan', workspace_id: 'ws_1' } };
    expect(advance(holder, before)).toBe(true);

    memoryMap.clear();
    expect(memoryMap.size).toBe(0);

    const persisted = toolFacePrefixFromMetadata(holder.metadata)!;
    const restored = refillToolFaceBaseline(memoryMap, sessionId, persisted);
    expect(restored.generation).toBe(before.generation);
    expect(restored.order).toEqual(before.order);
    expect(restored).toEqual(before);
    expect(memoryMap.get(sessionId)).toEqual(before);
    expect(Buffer.from(JSON.stringify(restored.order)).equals(Buffer.from(JSON.stringify(before.order))))
      .toBe(true);

    const raw = JSON.stringify(before);
    expect(JSON.parse(raw)).toEqual(before);
    expect(raw).toContain('"schemaDigest"');

    const object = holder.metadata as Record<string, unknown>;
    expect(object[TOOL_FACE_PREFIX_GENERATION_METADATA_KEY]).toBe(3);
    expect(object[FROZEN_TOOL_SCHEMA_ORDER_METADATA_KEY]).toHaveLength(3);
    expect(object.authorityMode).toBe('plan');
    expect(object.workspace_id).toBe('ws_1');

    const legacy = toolFacePrefixFromMetadata({
      [FROZEN_TOOL_SCHEMA_ORDER_METADATA_KEY]: ['zeta_tool', 'alpha_tool'],
    })!;
    expect(legacy.generation).toBe(0);
    expect(legacy.order).toEqual(['zeta_tool', 'alpha_tool']);
    expect(toolFacePrefixFromMetadata({ authorityMode: 'chat' })).toBeNull();
  });

  it('concurrent_first_build_converges_to_single_generation_zero_baseline', () => {
    const simulate = (persisted: ToolFacePrefixSnapshot, firstWriterIsA: boolean) => {
      const sessionId = 'sess_concurrent_first_build';
      const map = new Map<string, ToolFacePrefixSnapshot>();
      expect(map.has(sessionId)).toBe(false);
      expect(map.has(sessionId)).toBe(false);
      const first = refillToolFaceBaseline(map, sessionId, persisted);
      const second = refillToolFaceBaseline(map, sessionId, persisted);
      const resultA = firstWriterIsA ? first : second;
      const resultB = firstWriterIsA ? second : first;
      return { map, resultA, resultB };
    };

    const freshPersisted = toolFacePrefixFromMetadata({ authorityMode: 'chat' })
      ?? emptyToolFacePrefixSnapshot();
    expect(freshPersisted.generation).toBe(0);
    expect(freshPersisted.order).toEqual([]);

    for (const firstWriterIsA of [true, false]) {
      const { map, resultA, resultB } = simulate(freshPersisted, firstWriterIsA);
      expect(map.size).toBe(1);
      const converged = [...map.values()][0]!;
      expect(converged.generation).toBe(0);
      expect(resultA).toEqual(resultB);
      expect(resultA).toEqual(converged);
    }

    const legacyPersisted = toolFacePrefixFromMetadata({
      [FROZEN_TOOL_SCHEMA_ORDER_METADATA_KEY]: ['zeta_tool', 'alpha_tool'],
    })!;
    expect(legacyPersisted.generation).toBe(0);

    const aFirst = simulate(legacyPersisted, true);
    const bFirst = simulate(legacyPersisted, false);
    const convergedAFirst = [...aFirst.map.values()][0]!;
    const convergedBFirst = [...bFirst.map.values()][0]!;
    expect(convergedAFirst).toEqual(convergedBFirst);
    expect(convergedAFirst.generation).toBe(0);
    expect(convergedAFirst.order).toEqual(['zeta_tool', 'alpha_tool']);
    expect(aFirst.resultA).toEqual(aFirst.resultB);
    expect(bFirst.resultA).toEqual(bFirst.resultB);
    expect(aFirst.resultA).toEqual(bFirst.resultA);
  });

  it('advance_skips_write_when_generation_order_digest_unchanged', () => {
    const persistedSnapshot: ToolFacePrefixSnapshot = {
      generation: 2,
      order: ['zeta_tool', 'alpha_tool'],
      schemaDigest: 'digest_v2',
    };
    const holder: MetadataHolder = {
      metadata: { authorityMode: 'plan', plan: { batchId: 'batch_1' } },
    };
    expect(advance(holder, persistedSnapshot)).toBe(true);
    const bytesAfterFirstWrite = JSON.stringify(holder.metadata);

    expect(advance(holder, persistedSnapshot)).toBe(false);
    expect(JSON.stringify(holder.metadata)).toBe(bytesAfterFirstWrite);
    expect(toolFacePrefixFromMetadata(holder.metadata)!.generation).toBe(2);

    const subset: ToolFacePrefixSnapshot = {
      generation: 2, order: ['zeta_tool'], schemaDigest: 'digest_v2',
    };
    expect(advance(holder, subset)).toBe(false);

    const digestless: ToolFacePrefixSnapshot = {
      generation: 2, order: ['zeta_tool', 'alpha_tool'], schemaDigest: null,
    };
    expect(advance(holder, digestless)).toBe(false);
    expect(toolFacePrefixFromMetadata(holder.metadata)!.schemaDigest).toBe('digest_v2');

    const extended: ToolFacePrefixSnapshot = {
      generation: 2,
      order: ['zeta_tool', 'alpha_tool', 'beta_tool'],
      schemaDigest: 'digest_v2',
    };
    expect(advance(holder, extended)).toBe(true);
    const afterExtend = toolFacePrefixFromMetadata(holder.metadata)!;
    expect(afterExtend.generation).toBe(2);
    expect(afterExtend.order).toEqual(['zeta_tool', 'alpha_tool', 'beta_tool']);

    const digestChanged: ToolFacePrefixSnapshot = {
      generation: 2, order: [...afterExtend.order], schemaDigest: 'digest_v3',
    };
    expect(advance(holder, digestChanged)).toBe(true);
    const afterDigest = toolFacePrefixFromMetadata(holder.metadata)!;
    expect(afterDigest.generation).toBe(2);
    expect(afterDigest.schemaDigest).toBe('digest_v3');

    const object = holder.metadata as Record<string, unknown>;
    expect(object.authorityMode).toBe('plan');
    expect((object.plan as Record<string, unknown>).batchId).toBe('batch_1');
    expect(TOOL_SCHEMA_DIGEST_METADATA_KEY).toBe('toolSchemaDigest');
  });
});
