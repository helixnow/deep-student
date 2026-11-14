import { describe, expect, it } from 'vitest';
import {
  orderToolCallsForExecution, type ExecutableToolCall,
} from '../src/tool-order.ts';
import {
  insertSkillMessagesAfterToolResult, insertTransientSkillMessages,
} from '../src/skill-injection.ts';
import {
  isTransientSkillMessage, makeTransientSkillMessage,
  type LegacyChatMessage,
} from '../src/microcompact.ts';

function toolCall(id: string, name: string): ExecutableToolCall {
  return { id, name, arguments: {} };
}

function emptyMessage(role: string, content: string): LegacyChatMessage {
  return { role, content };
}

function orderedIds(calls: readonly ExecutableToolCall[]): string[] {
  return orderToolCallsForExecution(calls).map(call => call.id);
}

describe('chat_v2/pipeline/tool_loop.rs::tests', () => {
  it('chatanki_card_mutations_keep_explicit_read_write_read_order', () => {
    const calls = [
      toolCall('get-before', 'builtin-chatanki_get_cards'),
      toolCall('update', 'builtin-chatanki_update_card'),
      toolCall('get-after', 'builtin-chatanki_get_cards'),
    ];
    // Same priority keeps the model's explicit read → write → read order.
    expect(orderedIds(calls)).toEqual(['get-before', 'update', 'get-after']);
  });

  it('chatanki_export_still_runs_after_card_mutations', () => {
    const calls = [
      toolCall('export', 'builtin-chatanki_export'),
      toolCall('delete', 'builtin-chatanki_delete_card'),
      toolCall('add', 'builtin-chatanki_add_cards'),
    ];
    expect(orderedIds(calls)).toEqual(['delete', 'add', 'export']);
  });

  it('chatanki_enqueue_runs_after_card_work_and_before_external_outputs', () => {
    const calls = [
      toolCall('sync', 'builtin-chatanki_sync'),
      toolCall('enqueue', 'builtin-chatanki_enqueue_review'),
      toolCall('delete', 'builtin-chatanki_delete_card'),
      toolCall('export', 'builtin-chatanki_export'),
      toolCall('get', 'builtin-chatanki_get_cards'),
      toolCall('add', 'builtin-chatanki_add_cards'),
      toolCall('update', 'builtin-chatanki_update_card'),
    ];
    expect(orderedIds(calls))
      .toEqual(['delete', 'get', 'add', 'update', 'enqueue', 'sync', 'export']);
  });

  it('chatanki_retemplate_keeps_get_write_get_before_enqueue_and_export', () => {
    const calls = [
      toolCall('export', 'builtin-chatanki_export'),
      toolCall('get-before', 'builtin-chatanki_get_cards'),
      toolCall('retemplate', 'builtin-chatanki_retemplate'),
      toolCall('enqueue', 'builtin-chatanki_enqueue_review'),
      toolCall('get-after', 'builtin-chatanki_get_cards'),
    ];
    expect(orderedIds(calls))
      .toEqual(['get-before', 'retemplate', 'get-after', 'enqueue', 'export']);
  });

  it('in_loop_load_skills_keeps_memory_prefix_byte_stable_within_turn', () => {
    const history = [
      emptyMessage('user', 'turn 0 user'),
      emptyMessage('assistant', 'turn 0 reply'),
    ];
    const turnSkills = [makeTransientSkillMessage('skill-turn', 'turn skill body')];
    const currentUser = emptyMessage('user', 'turn 1 user');

    const buildRound = (toolMessages: readonly LegacyChatMessage[],
      inLoopBatches: ReadonlyArray<readonly [string, string | null,
        readonly LegacyChatMessage[]]>): LegacyChatMessage[] => {
      const messages = [...history];
      insertTransientSkillMessages(messages, messages.length, turnSkills);
      messages.push(currentUser);
      messages.push(...toolMessages);
      for (const [anchorCallId, roundLastCallId, batch] of inLoopBatches) {
        insertSkillMessagesAfterToolResult(messages, anchorCallId, roundLastCallId, batch);
      }
      return messages;
    };
    const serialize = (messages: readonly LegacyChatMessage[]): string[] =>
      messages.map(message => JSON.stringify(message));

    // Round 0: no tool results yet.
    const round0 = buildRound([], []);
    const round0Bytes = serialize(round0);
    const userIndex = round0.length - 1;
    expect(round0[userIndex]!.content).toBe('turn 1 user');

    // Round 1: load_skills completed; the lazy batch anchors after its result.
    const loadCall = emptyMessage('assistant', '');
    loadCall.tool_call = {
      id: 'call-load', tool_name: 'builtin-load_skills',
      args_json: { skill_ids: ['skill-lazy'] },
    };
    const loadResult = emptyMessage('tool', 'loaded');
    loadResult.tool_result = {
      call_id: 'call-load', ok: true, data_json: { loaded_skill_ids: ['skill-lazy'] },
    };
    const toolRound1 = [loadCall, loadResult];
    const batches = [[
      'call-load', 'call-load',
      [makeTransientSkillMessage('skill-lazy', 'lazy skill body')],
    ] as const];

    const round1 = buildRound(toolRound1, batches);
    const round1Bytes = serialize(round1);

    // 1) Nothing before the current user changed on the same turn.
    for (let index = 0; index <= userIndex; index++) {
      expect(round1Bytes[index]).toBe(round0Bytes[index]);
    }
    // 2) Round 0 stays a strict byte prefix of round 1.
    expect(round1Bytes.slice(0, round0Bytes.length)).toEqual(round0Bytes);
    // The new batch lands after the load_skills result, i.e. at the tail.
    expect(isTransientSkillMessage(round1[round1.length - 1]!)).toBe(true);

    // Round 2: more tool results arrive; the in-loop batch must not drift.
    const nextCall = emptyMessage('assistant', '');
    nextCall.tool_call = {
      id: 'call-next', tool_name: 'builtin-web_search', args_json: { q: 'x' },
    };
    const nextResult = emptyMessage('tool', 'ok');
    nextResult.tool_result = { call_id: 'call-next', ok: true, data_json: { ok: true } };
    const toolRound2 = [loadCall, loadResult, nextCall, nextResult];
    const round2 = buildRound(toolRound2, batches);
    const round2Bytes = serialize(round2);
    expect(round2Bytes.slice(0, round1Bytes.length)).toEqual(round1Bytes);
    expect(round2).toHaveLength(round1.length + 2);
  });
});
