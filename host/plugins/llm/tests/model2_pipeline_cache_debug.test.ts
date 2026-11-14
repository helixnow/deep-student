import { describe, expect, it } from 'vitest';
import {
  CHAT_V2_STREAM_GENERATION_MARKER, chatV2SessionScopeAndGeneration, chatV2StreamIdentity,
} from '../src/stream_scope.ts';
import {
  cacheDebugFirstDivergentSegment, cacheDebugHash16, cacheDebugHistoryDivergence,
  cacheDebugSegmentFingerprints, cacheDebugSplitBodySegments, cacheDebugToolFaceDelta,
  cacheDebugToolNames, type CacheDebugHistoryItem,
} from '../src/cache_debug.ts';
import type { JsonValue } from '../../../platform/errors/api.ts';

describe('llm_manager/model2_pipeline.rs', () => {
  it('chat_v2_run_scope_recovers_session_and_generation', () => {
    const event = `chat_v2_event_sess_123_var_variant_456_run_deadbeef${CHAT_V2_STREAM_GENERATION_MARKER}73`;
    expect(chatV2SessionScopeAndGeneration(event)).toEqual(['sess_123', 73]);
    expect(chatV2SessionScopeAndGeneration('chat_v2_event_legacy_session'))
      .toEqual(['legacy_session', null]);
    expect(chatV2SessionScopeAndGeneration('other_event')).toBeNull();
  });

  it('chat_v2_stream_identity_splits_session_variant_run', () => {
    const event = `chat_v2_event_sess_123_var_variant_456_run_deadbeef${CHAT_V2_STREAM_GENERATION_MARKER}73`;
    expect(chatV2StreamIdentity(event)).toEqual({
      sessionId: 'sess_123', variantId: 'variant_456', runId: 'deadbeef',
    });
    expect(chatV2StreamIdentity('chat_v2_event_sess_1_var_scope_a_run_r9')).toEqual({
      sessionId: 'sess_1', variantId: 'scope_a', runId: 'r9',
    });
    expect(chatV2StreamIdentity('chat_v2_event_sess_1_var_scope_a')).toEqual({
      sessionId: 'sess_1', variantId: 'scope_a', runId: null,
    });
    expect(chatV2StreamIdentity('chat_v2_event_legacy_session')).toEqual({
      sessionId: 'legacy_session', variantId: null, runId: null,
    });
    expect(chatV2StreamIdentity('review_analysis_stream_42')).toBeNull();
    const bad = `chat_v2_event_s_var_v_run_r${CHAT_V2_STREAM_GENERATION_MARKER}not_a_number`;
    expect(chatV2StreamIdentity(bad)).toBeNull();
  });

  it('cache_debug_segments_split_openai_chat_body', () => {
    const body = {
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'you are helpful' },
        { role: 'user', content: 'turn 1' },
        { role: 'assistant', content: 'answer 1' },
        { role: 'user', content: 'turn 2' },
      ],
      tools: [{ type: 'function', function: { name: 'f' } }],
    };
    const [system, tools, history, currentUser] = cacheDebugSplitBodySegments(body);
    expect(Array.isArray(system) ? system.length : null).toBe(1);
    expect(Array.isArray(tools)).toBe(true);
    expect(Array.isArray(history) ? history.length : null).toBe(2);
    expect((currentUser as { content: string }).content).toBe('turn 2');
  });

  it('cache_debug_segments_split_responses_and_anthropic_bodies', () => {
    const responsesBody = {
      model: 'gpt-5.6',
      instructions: 'sys',
      input: [
        { role: 'user', content: 'turn 1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'turn 2' },
      ],
    };
    const [system, tools, history, currentUser] = cacheDebugSplitBodySegments(responsesBody);
    expect(Array.isArray(system) ? system.length : null).toBe(1);
    expect(tools).toBeNull();
    expect(Array.isArray(history) ? history.length : null).toBe(2);
    expect((currentUser as { content: string }).content).toBe('turn 2');

    const anthropicBody = {
      model: 'claude-sonnet',
      system: [{ type: 'text', text: 'sys' }],
      messages: [{ role: 'user', content: 'only turn' }],
    };
    const [anthropicSystem, , anthropicHistory, anthropicCurrent] =
      cacheDebugSplitBodySegments(anthropicBody);
    expect(Array.isArray(anthropicSystem) ? anthropicSystem.length : null).toBe(1);
    expect(Array.isArray(anthropicHistory) ? anthropicHistory.length : null).toBe(0);
    expect((anthropicCurrent as { content: string }).content).toBe('only turn');
  });

  it('cache_debug_tool_face_delta_tracks_append_only_prefix', () => {
    const base = ['a', 'b', 'c'];
    expect(cacheDebugToolFaceDelta(base, ['a', 'b', 'c', 'd'])).toEqual([3, ['d']]);
    expect(cacheDebugToolFaceDelta(base, ['a', 'x', 'b', 'c'])).toEqual([1, ['x']]);
    expect(cacheDebugToolFaceDelta(base, ['a', 'b'])).toEqual([2, []]);
    expect(cacheDebugToolFaceDelta(base, ['b', 'a', 'c'])).toEqual([0, []]);
  });

  it('cache_debug_tool_names_prefers_function_name', () => {
    const body = {
      tools: [
        { type: 'function', function: { name: 'alpha' } },
        { name: 'beta' },
      ],
    };
    expect(cacheDebugToolNames(body)).toEqual(['alpha', 'beta']);
    expect(cacheDebugToolNames({})).toEqual([]);
  });

  it('cache_debug_history_divergence_locates_first_differing_message', () => {
    const item = (id: string, text: string): CacheDebugHistoryItem => ({
      id,
      hash: cacheDebugHash16({ role: 'user', content: text }),
    });
    const base = [item('m1', 'a'), item('m2', 'b'), item('m3', 'c')];
    const appended = [...base, item('m4', 'd')];
    expect(cacheDebugHistoryDivergence(base, appended)).toEqual([3, null, 'm4']);
    const rewritten = [item('m1', 'a2'), item('m2', 'b'), item('m3', 'c')];
    expect(cacheDebugHistoryDivergence(base, rewritten)).toEqual([0, 'm1', 'm1']);
    const inserted = [item('m1', 'a'), item('mx', 'x'), item('m2', 'b'), item('m3', 'c')];
    expect(cacheDebugHistoryDivergence(base, inserted)).toEqual([1, 'm2', 'mx']);
    expect(cacheDebugHistoryDivergence(base, base)).toBeNull();
  });

  it('cache_debug_first_divergent_segment_orders_by_prefix', () => {
    const base: JsonValue = {
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'turn 1' },
      ],
      tools: [{ name: 'f' }],
    };
    const baseFp = cacheDebugSegmentFingerprints(base);
    expect(cacheDebugFirstDivergentSegment(baseFp, baseFp)).toBeNull();

    const newTurn: JsonValue = {
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'turn 2' },
      ],
      tools: [{ name: 'f' }],
    };
    expect(cacheDebugFirstDivergentSegment(
      baseFp, cacheDebugSegmentFingerprints(newTurn),
    )).toBe('current_user');

    const systemChanged: JsonValue = {
      messages: [
        { role: 'system', content: 'sys CHANGED' },
        { role: 'user', content: 'turn 2' },
      ],
      tools: [{ name: 'f' }],
    };
    expect(cacheDebugFirstDivergentSegment(
      baseFp, cacheDebugSegmentFingerprints(systemChanged),
    )).toBe('system');

    const toolsChanged: JsonValue = {
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'turn 2' },
      ],
      tools: [{ name: 'g' }],
    };
    expect(cacheDebugFirstDivergentSegment(
      baseFp, cacheDebugSegmentFingerprints(toolsChanged),
    )).toBe('tools');
  });
});
