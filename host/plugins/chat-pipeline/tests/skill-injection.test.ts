import { describe, expect, it } from 'vitest';
import {
  anchoredSkillIdsInHistory, buildInLoopSkillMessages, buildTransientSkillMessagesWithAudit,
  insertSkillMessagesAfterToolResult, insertTransientSkillMessages,
  rebuildAnchoredSkillMessages, rebuildAnchoredSkillMessagesGated, skillBodyDigest,
  transientSkillMessageSkillId, type SessionSkillState, type SkillInjectionAnchors,
} from '../src/skill-injection.ts';
import {
  isTransientLlmOnlyMessage, isTransientSkillMessage, makeTransientSkillMessage,
  type LegacyChatMessage,
} from '../src/microcompact.ts';

function skillState(overrides: Partial<SessionSkillState> = {}): SessionSkillState {
  return {
    manualPinnedSkillIds: [],
    modeRequiredBundleIds: [],
    agenticSessionSkillIds: [],
    branchLocalSkillIds: [],
    version: 0,
    ...overrides,
  };
}

describe('chat_v2/pipeline/helpers.rs::tests', () => {
  it('test_build_transient_skill_messages_orders_dependencies_before_parents', () => {
    const state = skillState({
      manualPinnedSkillIds: ['manual-a'],
      agenticSessionSkillIds: ['agentic-a'],
      branchLocalSkillIds: ['branch-a'],
      version: 7,
    });
    const contents = new Map<string, string>([
      ['dep-a', 'dependency-a'],
      ['manual-a', 'manual-body'],
      ['agentic-a', 'agentic-body'],
      ['dep-b', 'dependency-b'],
      ['branch-a', 'branch-body'],
    ]);
    const dependencies = new Map<string, readonly string[]>([
      ['manual-a', ['dep-a']],
      ['branch-a', ['dep-b']],
    ]);

    const injected = buildTransientSkillMessagesWithAudit(state, contents, dependencies, null);

    expect(injected.audit.injectedSkillIds).toEqual([
      'dep-a', 'manual-a', 'agentic-a', 'dep-b', 'branch-a',
    ]);
    expect(injected.audit.skillStateVersion).toBe(7);
    expect(injected.messages).toHaveLength(5);
    expect(injected.messages.every(isTransientSkillMessage)).toBe(true);
  });

  it('test_insert_transient_skill_messages_keeps_skill_instruction_off_first_position', () => {
    const messages: LegacyChatMessage[] = [];
    insertTransientSkillMessages(messages, 0,
      [makeTransientSkillMessage('skill-a', 'private body')]);

    expect(messages).toHaveLength(2);
    expect(isTransientLlmOnlyMessage(messages[0]!)).toBe(true);
    expect(isTransientSkillMessage(messages[0]!)).toBe(false);
    expect(isTransientSkillMessage(messages[1]!)).toBe(true);
  });
});

describe('chat_v2/pipeline/helpers.rs::tests (P1-8)', () => {
  function emptyMessage(role: string, content: string): LegacyChatMessage {
    return { role, content };
  }

  function toolPair(callId: string, toolName: string): [LegacyChatMessage, LegacyChatMessage] {
    const call = emptyMessage('assistant', '');
    call.tool_call = { id: callId, tool_name: toolName, args_json: {} };
    const result = emptyMessage('tool', 'ok');
    result.tool_result = { call_id: callId, ok: true, data_json: { ok: true } };
    return [call, result];
  }

  it('test_p1_8_cross_turn_injection_point_bytes_live_eq_replay', () => {
    const state = skillState({
      manualPinnedSkillIds: ['skill-a', 'skill-b'],
      version: 3,
    });
    const contents = new Map<string, string>([
      ['skill-a', 'skill body A'],
      ['skill-b', 'skill body B'],
    ]);

    const historyPrefix = (): LegacyChatMessage[] => [
      emptyMessage('user', 'user turn 1'),
      emptyMessage('assistant', 'assistant turn 1'),
    ];
    const built = buildTransientSkillMessagesWithAudit(state, contents, null, null, new Set());
    const anchorIds = [...built.audit.injectedSkillIds];
    expect(anchorIds).toEqual(['skill-a', 'skill-b']);

    const live = historyPrefix();
    live.push(...built.messages);
    live.push(emptyMessage('user', 'user turn 2'));

    // Round 2 replay rebuilds anchored skills at the same position.
    const replay = historyPrefix();
    replay.push(...rebuildAnchoredSkillMessages(anchorIds, contents));
    replay.push(emptyMessage('user', 'user turn 2'));

    expect(live).toHaveLength(replay.length);
    for (let index = 0; index < live.length; index++) {
      expect(live[index]!.role).toBe(replay[index]!.role);
      expect(live[index]!.content).toBe(replay[index]!.content);
      expect(live[index]!.metadata).toEqual(replay[index]!.metadata);
    }

    // Round 2 injection: anchored skills are excluded, so the diff is empty.
    const anchored = anchoredSkillIdsInHistory(replay);
    expect(anchored).toEqual(new Set(['skill-a', 'skill-b']));
    const second = buildTransientSkillMessagesWithAudit(state, contents, null, null, anchored);
    expect(second.messages).toEqual([]);
    expect(second.audit.injectedSkillIds).toEqual([]);

    // The exclusion set also covers the dependency closure.
    const deps = new Map<string, readonly string[]>([['skill-a', ['skill-b']]]);
    const withDeps = buildTransientSkillMessagesWithAudit(state, contents, deps, null, anchored);
    expect(withDeps.messages).toEqual([]);
  });

  it('test_p1_8_in_loop_skills_do_not_touch_prefix_before_current_user', () => {
    const contents = new Map<string, string>([
      ['skill-a', 'skill body A'],
      ['skill-new', 'loaded in loop'],
    ]);

    const [toolCallMessage, toolResultMessage] = (() => {
      const call = emptyMessage('assistant', '');
      call.tool_call = {
        id: 'call-load-skills', tool_name: 'load_skills',
        args_json: { skill_ids: ['skill-new'] },
      };
      const result = emptyMessage('tool', 'loaded');
      result.tool_result = {
        call_id: 'call-load-skills', ok: true, data_json: { loaded: ['skill-new'] },
      };
      return [call, result];
    })();
    const messages: LegacyChatMessage[] = [
      emptyMessage('user', 'user turn 1'),
      makeTransientSkillMessage('skill-a', 'skill body A'),
      emptyMessage('user', 'current user turn'),
      toolCallMessage,
      toolResultMessage,
    ];

    const prefixSnapshot = messages.slice(0, 3)
      .map(message => [message.role, message.content]);

    const injected = anchoredSkillIdsInHistory(messages);
    expect(injected.has('skill-a')).toBe(true);
    const batch = buildInLoopSkillMessages(['skill-new', 'skill-a'], contents, null, null,
      injected, 4);
    expect(batch.audit.injectedSkillIds).toEqual(['skill-new']);
    for (const skillId of batch.audit.injectedSkillIds) injected.add(skillId);

    insertSkillMessagesAfterToolResult(messages, 'call-load-skills', null, batch.messages);

    expect(messages).toHaveLength(6);
    expect(messages[4]!.tool_result).toBeDefined();
    expect(isTransientSkillMessage(messages[5]!)).toBe(true);
    expect(transientSkillMessageSkillId(messages[5]!)).toBe('skill-new');
    expect(messages.slice(0, 3).map(message => [message.role, message.content]))
      .toEqual(prefixSnapshot);

    // Fallback: an unmatched tool_call_id appends to the tail, prefix untouched.
    const orphan = buildInLoopSkillMessages(['skill-a'], contents, null, null, new Set(), 4);
    insertSkillMessagesAfterToolResult(messages, 'call-missing', null, orphan.messages);
    expect(messages).toHaveLength(7);
    expect(isTransientSkillMessage(messages[6]!)).toBe(true);
    expect(messages.slice(0, 3).map(message => [message.role, message.content]))
      .toEqual(prefixSnapshot);
  });

  it('test_p1_8_in_loop_skills_insert_after_round_last_tool_result', () => {
    const [call1, result1] = toolPair('call-load-skills', 'load_skills');
    const [call2, result2] = toolPair('call-shell', 'local_shell_execute');
    let messages = [call1, result1, call2, result2];

    const batch = [makeTransientSkillMessage('skill-x', 'round skill body')];
    insertSkillMessagesAfterToolResult(messages, 'call-load-skills', 'call-shell', batch);
    // Skill message goes after the round's last tool result, not between results.
    expect(messages).toHaveLength(5);
    expect(messages[3]!.tool_result!.call_id).toBe('call-shell');
    expect(isTransientSkillMessage(messages[4]!)).toBe(true);

    // Fallback: a missing round tail falls back to the triggering result position.
    const [callA, resultA] = toolPair('call-load-skills', 'load_skills');
    messages = [callA, resultA];
    insertSkillMessagesAfterToolResult(messages, 'call-load-skills', 'call-gone', batch);
    expect(messages).toHaveLength(3);
    expect(isTransientSkillMessage(messages[2]!)).toBe(true);

    // Multiple batches in one round append after the tail in batch order.
    const [callA2, resultA2] = toolPair('call-load-a', 'load_skills');
    const [callB2, resultB2] = toolPair('call-load-b', 'load_skills');
    const [callC2, resultC2] = toolPair('call-shell', 'local_shell_execute');
    messages = [callA2, resultA2, callB2, resultB2, callC2, resultC2];
    insertSkillMessagesAfterToolResult(messages, 'call-load-a', 'call-shell',
      [makeTransientSkillMessage('skill-a', 'batch A')]);
    insertSkillMessagesAfterToolResult(messages, 'call-load-b', 'call-shell',
      [makeTransientSkillMessage('skill-b', 'batch B')]);
    expect(messages).toHaveLength(8);
    expect(transientSkillMessageSkillId(messages[6]!)).toBe('skill-a');
    expect(transientSkillMessageSkillId(messages[7]!)).toBe('skill-b');
  });
});

describe('chat_v2/pipeline/history.rs::skill_replay_gate_tests', () => {
  function anchorsWithDigests(entries: Array<[string, string]>): SkillInjectionAnchors {
    return {
      turnSkillIds: [],
      beforeTurnUser: false,
      toolAnchored: [],
      skillContentDigests: new Map(entries.map(([id, body]) => [id, skillBodyDigest(id, body)])),
    };
  }

  it('gate_skips_mismatch_and_rebuilds_match_in_anchor_order', () => {
    const anchors = anchorsWithDigests([
      ['skill-a', '正文 A（未改）'],
      ['skill-b', '正文 B v1'],
    ]);
    const ids = ['skill-a', 'skill-b'];
    // The current request carries an edited skill-b body (v2).
    const contents = new Map<string, string>([
      ['skill-a', '正文 A（未改）'],
      ['skill-b', '正文 B v2'],
    ]);

    const restored = rebuildAnchoredSkillMessagesGated(ids, contents, anchors);
    expect(restored).toHaveLength(1);
    const live = makeTransientSkillMessage('skill-a', '正文 A（未改）');
    expect(restored[0]!.role).toBe(live.role);
    expect(restored[0]!.content).toBe(live.content);
    expect(restored[0]!.metadata).toEqual(live.metadata);
  });

  it('legacy_anchor_without_digest_keeps_old_rebuild_behavior', () => {
    const ids = ['skill-old', 'skill-ghost'];
    const contents = new Map<string, string>([['skill-old', '旧锚点正文']]);

    // Anchors deserialized from legacy JSON carry an empty digest map.
    const legacyAnchors = anchorsWithDigests([]);
    const gated = rebuildAnchoredSkillMessagesGated(ids, contents, legacyAnchors);
    expect(gated).toHaveLength(1);
    expect(gated[0]!.content)
      .toBe(makeTransientSkillMessage('skill-old', '旧锚点正文').content);

    const ungated = rebuildAnchoredSkillMessages(ids, contents);
    expect(ungated).toHaveLength(gated.length);
    expect(ungated[0]!.content).toBe(gated[0]!.content);

    // The missing body is skipped on both paths and never blocks replay.
    expect(rebuildAnchoredSkillMessagesGated(ids, null, legacyAnchors)).toEqual([]);
  });

  it('gate_signal_collects_only_digest_mismatches_deduped', () => {
    const anchors = anchorsWithDigests([
      ['skill-ok', '正文未改'],
      ['skill-drift', '正文 v1'],
    ]);
    const ids = ['skill-ok', 'skill-drift', 'skill-missing'];
    const contents = new Map<string, string>([
      ['skill-ok', '正文未改'],
      ['skill-drift', '正文 v2'],
    ]);

    const signal: string[] = [];
    const restored = rebuildAnchoredSkillMessagesGated(ids, contents, anchors, signal);
    expect(restored).toHaveLength(1);
    expect(restored[0]!.content)
      .toBe(makeTransientSkillMessage('skill-ok', '正文未改').content);
    expect(signal).toEqual(['skill-drift']);

    // A repeated mismatch across anchors is deduped without changing rebuilds.
    const repeated: string[] = [];
    const twice = rebuildAnchoredSkillMessagesGated(
      ['skill-drift', 'skill-drift'], contents, anchors, repeated);
    expect(twice).toEqual([]);
    expect(repeated).toEqual(['skill-drift']);
  });
});
