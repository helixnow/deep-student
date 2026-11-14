import { describe, expect, it } from 'vitest';
import {
  advanceMicrocompactAnchor, microcompactBatchEligibleTurns, microcompactOldToolOutputs,
  validateToolChain, type LegacyChatMessage, type MicrocompactAnchor,
} from '../src/microcompact.ts';

const bigOutput = 'tool output data '.repeat(200);

function message(role: string, content: string): LegacyChatMessage {
  return { role, content };
}

function toolRound(callId: string, userText: string): LegacyChatMessage[] {
  const call = message('assistant', '');
  call.tool_call = { id: callId, tool_name: 'web_search', args_json: { q: 'x' } };
  const result = message('tool', bigOutput);
  result.tool_result = { call_id: callId, ok: true, data_json: { data: bigOutput } };
  return [
    message('user', userText),
    call,
    result,
    message('assistant', 'answer'),
  ];
}

/** Byte fingerprint of role + content + tool_result.data_json. */
function historyFingerprint(history: readonly LegacyChatMessage[]): string[] {
  return history.map(entry => {
    const result = entry.tool_result;
    const data = result === undefined || result === null || result.data_json === undefined
      ? ''
      : JSON.stringify(result.data_json);
    return `${entry.role}|${entry.content}|${data}`;
  });
}

describe('chat_v2/pipeline/helpers.rs::tests', () => {
  it('test_microcompact_replaces_only_old_tool_outputs', () => {
    const history: LegacyChatMessage[] = [];
    for (let index = 0; index < 5; index++) {
      history.push(...toolRound(`call-${index}`, `turn ${index}`));
    }

    expect(microcompactBatchEligibleTurns(history)).toBe(2);
    expect(microcompactOldToolOutputs(history, 2)).toBe(2);

    const toolMessages = history.filter(entry => entry.tool_result !== undefined
      && entry.tool_result !== null);
    expect(toolMessages).toHaveLength(5);
    expect(toolMessages[0]!.content).toContain('旧工具输出已省略');
    expect(toolMessages[0]!.content).toContain('web_search');
    expect(toolMessages[1]!.content).toContain('旧工具输出已省略');
    for (const recent of toolMessages.slice(2)) {
      expect(recent.content).toBe(bigOutput);
    }
    expect(validateToolChain(history)).toBe(true);

    // Defensive clamp: an oversized anchor still preserves the recent K turns.
    const clamped: LegacyChatMessage[] = [];
    for (let index = 0; index < 5; index++) {
      clamped.push(...toolRound(`clamp-${index}`, `turn ${index}`));
    }
    expect(microcompactOldToolOutputs(clamped, Number.MAX_SAFE_INTEGER)).toBe(2);
  });

  it('test_microcompact_skips_pinned_and_small_outputs', () => {
    const smallResult = message('tool', 'tiny');
    smallResult.tool_result = { call_id: 'call-small', ok: true, data_json: 'tiny' };
    const summary = message('user', 'compacted summary');
    summary.metadata = { kind: 'compaction_summary' };

    const history: LegacyChatMessage[] = [
      summary,
      message('user', 'turn 0'),
      smallResult,
      message('user', 'turn 1'),
      message('user', 'turn 2'),
      message('user', 'turn 3'),
    ];

    expect(microcompactBatchEligibleTurns(history)).toBe(1);
    expect(microcompactOldToolOutputs(history, 1)).toBe(0);
    expect(history[0]!.content).toBe('compacted summary');
    expect(history[2]!.content).toBe('tiny');

    const shortHistory = [message('user', 'only turn'), message('assistant', 'reply')];
    expect(microcompactBatchEligibleTurns(shortHistory)).toBe(0);
    expect(microcompactOldToolOutputs(shortHistory, Number.MAX_SAFE_INTEGER)).toBe(0);
  });

  it('test_microcompact_anchor_freezes_history_bytes_between_compactions', () => {
    const turnN: LegacyChatMessage[] = [];
    for (let index = 0; index < 5; index++) turnN.push(...toolRound(`call-${index}`, `turn ${index}`));
    const [anchor, eligibleN] = advanceMicrocompactAnchor(null, null,
      microcompactBatchEligibleTurns(turnN));
    expect(eligibleN).toBe(2);
    microcompactOldToolOutputs(turnN, eligibleN);
    const snapshotN = historyFingerprint(turnN);

    const turnN1: LegacyChatMessage[] = [];
    for (let index = 0; index < 6; index++) turnN1.push(...toolRound(`call-${index}`, `turn ${index}`));
    const [anchorN1, eligibleN1] = advanceMicrocompactAnchor(anchor, null,
      microcompactBatchEligibleTurns(turnN1));
    expect(eligibleN1).toBe(2);
    expect(anchorN1).toEqual(anchor);
    microcompactOldToolOutputs(turnN1, eligibleN1);

    expect(historyFingerprint(turnN1.slice(0, 20))).toEqual(snapshotN);
    const turn2Tool = turnN1[10]!;
    expect(turn2Tool.tool_result).not.toBeNull();
    expect(turn2Tool.tool_result).not.toBeUndefined();
    expect(turn2Tool.content).not.toContain('旧工具输出已省略');
  });

  it('test_microcompact_anchor_advances_only_on_compaction_event', () => {
    const [anchor, eligible] = advanceMicrocompactAnchor(null, null, 2);
    expect(eligible).toBe(2);
    expect(anchor.lineage).toBeNull();

    const [frozen, frozenEligible] = advanceMicrocompactAnchor(anchor, null, 4);
    expect(frozenEligible).toBe(2);
    expect(frozen).toEqual(anchor);

    const [advanced, advancedEligible] = advanceMicrocompactAnchor(anchor, 'cmp_1', 4);
    expect(advancedEligible).toBe(4);
    expect(advanced.lineage).toBe('cmp_1');
    expect(advanced.eligible_user_turns).toBe(4);

    const [again, againEligible] = advanceMicrocompactAnchor(advanced, 'cmp_1', 6);
    expect(againEligible).toBe(4);
    expect(again).toEqual(advanced);

    const [, clampedEligible] = advanceMicrocompactAnchor(advanced, 'cmp_1', 1);
    expect(clampedEligible).toBe(1);
  });
});

describe('microcompact anchor type', () => {
  it('anchor is a plain structural value', () => {
    const anchor: MicrocompactAnchor = { lineage: null, eligible_user_turns: 0 };
    expect(anchor.eligible_user_turns).toBe(0);
  });
});
