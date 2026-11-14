import { describe, expect, it } from 'vitest';
import type { ChatMessage, MessageBlock, MessageRole } from '../../../../contracts/ipc/generated/L04-chat-session.ts';
import { HEAD_USER_TURNS } from '../src/compaction-budget.ts';
import {
  selectManualTail, selectTail, splitIntoTurns, splitSummaryRanges, turnHasLiveSignature,
} from '../src/segmentation.ts';

function makeMsg(id: string, role: MessageRole, timestamp = 0): ChatMessage {
  return { id, sessionId: 's1', role, blockIds: [], timestamp };
}
function makeTextBlock(id: string, messageId: string, content: string): MessageBlock {
  return { id, messageId, type: 'content', status: 'success', content };
}
function makeToolBlock(id: string, messageId: string, name: string,
  input: unknown, output: unknown): MessageBlock {
  return { id, messageId, type: 'mcp_tool', status: 'success', toolName: name, toolInput: input, toolOutput: output };
}

describe('compaction/segmentation.rs::tests', () => {
  it('split_into_turns_basic', () => {
    const messages = [
      makeMsg('m1', 'user'),
      makeMsg('m2', 'assistant'),
      makeMsg('m3', 'assistant'),
      makeMsg('m4', 'user'),
      makeMsg('m5', 'assistant'),
    ];
    const turns = splitIntoTurns(messages);
    expect(turns).toHaveLength(2);
    expect([turns[0]!.start, turns[0]!.end]).toEqual([0, 3]);
    expect([turns[1]!.start, turns[1]!.end]).toEqual([3, 5]);
  });

  it('manual_tail_keeps_latest_turn_and_summarizes_earlier_short_conversations', () => {
    const messages = [
      makeMsg('u1', 'user'),
      makeMsg('a1', 'assistant'),
      makeMsg('u2', 'user'),
      makeMsg('a2', 'assistant'),
    ];
    const blocks = new Map<string, MessageBlock[]>();
    for (const message of messages) {
      blocks.set(message.id, [makeTextBlock('block', message.id, 'some conversation text')]);
    }
    const turns = splitIntoTurns(messages);
    const tail = selectManualTail(messages, turns, 1, blocks)!;
    expect(tail.tailStartIdx).toBe(2);
    expect(tail.tailTokens).toBeGreaterThan(1);
  });

  it('select_tail_aborts_when_last_turn_too_large', () => {
    const messages = [
      makeMsg('u1', 'user', 100),
      makeMsg('a1', 'assistant', 101),
      makeMsg('u2', 'user', 200),
      makeMsg('a2', 'assistant', 201),
      makeMsg('u3', 'user', 300),
      makeMsg('a3', 'assistant', 301),
    ];
    const turns = splitIntoTurns(messages);
    expect(turns).toHaveLength(3);

    const blocks = new Map<string, MessageBlock[]>();
    const medium = 'word '.repeat(2000);
    blocks.set('a3', [makeToolBlock('b1', 'a3', 'w', {}, { data: medium })]);
    for (const id of ['u1', 'a1', 'u2', 'a2', 'u3']) {
      blocks.set(id, [makeTextBlock('b', id, 'hi')]);
    }

    expect(selectTail(messages, turns, 500, blocks)).toBeNull();
  });

  it('select_tail_cuts_inside_oversized_last_turn', () => {
    const messages = [
      makeMsg('u1', 'user', 100),
      makeMsg('a1', 'assistant', 101),
      makeMsg('u2', 'user', 200),
      makeMsg('a2', 'assistant', 201),
      makeMsg('u3', 'user', 300),
      makeMsg('a3', 'assistant', 301),
      makeMsg('u4', 'user', 400),
      makeMsg('a4', 'assistant', 401),
      makeMsg('a5', 'assistant', 402),
      makeMsg('a6', 'assistant', 403),
      makeMsg('a7', 'assistant', 404),
    ];
    const turns = splitIntoTurns(messages);
    expect(turns).toHaveLength(4);
    expect(turns[3]!.start).toBe(6);

    const blocks = new Map<string, MessageBlock[]>();
    for (const message of messages) blocks.set(message.id, [makeTextBlock('b', message.id, 'hi')]);
    const big = 'word '.repeat(1600);
    const small = 'word '.repeat(80);
    blocks.set('a4', [makeTextBlock('b4', 'a4', big)]);
    blocks.set('a5', [makeTextBlock('b5', 'a5', big)]);
    blocks.set('a6', [makeTextBlock('b6', 'a6', small)]);
    blocks.set('a7', [makeTextBlock('b7', 'a7', small)]);

    const selected = selectTail(messages, turns, 500, blocks)!;
    const a6Index = messages.findIndex(message => message.id === 'a6');
    expect(selected.tailStartIdx).toBe(a6Index);
    expect(selected.tailTokens).toBeLessThanOrEqual(1000);
    expect(selected.tailStartIdx).toBeGreaterThanOrEqual(turns[HEAD_USER_TURNS - 1]!.end);
  });

  it('split_summary_ranges_clamps_straddling_turn', () => {
    const messages = [
      makeMsg('u1', 'user', 100),
      makeMsg('a1', 'assistant', 101),
      makeMsg('u2', 'user', 200),
      makeMsg('a2', 'assistant', 201),
      makeMsg('a3', 'assistant', 202),
      makeMsg('a4', 'assistant', 203),
    ];
    const turns = splitIntoTurns(messages);
    expect(turns).toHaveLength(2);
    const blocks = new Map<string, MessageBlock[]>();
    for (const message of messages) blocks.set(message.id, [makeTextBlock('b', message.id, 'hi')]);

    expect(splitSummaryRanges(messages, turns, blocks, 0, 4, 100_000, 8_000)).toEqual([[0, 4]]);

    const tight = splitSummaryRanges(messages, turns, blocks, 0, 4, 1, 8_000);
    expect(tight.every(([s, e]) => s < e && e <= 4)).toBe(true);
    expect(tight[tight.length - 1]?.[1]).toBe(4);

    expect(splitSummaryRanges(messages, turns, blocks, 0, 2, 100_000, 8_000)).toEqual([[0, 2]]);
  });

  it('select_tail_clamps_into_head_instead_of_giving_up', () => {
    const messages = [
      makeMsg('u1', 'user', 100),
      makeMsg('a1', 'assistant', 101),
      makeMsg('u2', 'user', 200),
      makeMsg('a2', 'assistant', 201),
      makeMsg('u3', 'user', 300),
      makeMsg('a3', 'assistant', 301),
      makeMsg('u4', 'user', 400),
      makeMsg('a4', 'assistant', 401),
    ];
    const turns = splitIntoTurns(messages);
    const blocks = new Map<string, MessageBlock[]>();
    for (const message of messages) blocks.set(message.id, [makeTextBlock('b', message.id, 'x')]);

    const selected = selectTail(messages, turns, 1_000_000, blocks)!;
    expect(selected.tailStartIdx).toBe(turns[HEAD_USER_TURNS]!.start);
  });

  it('thinking_without_signature_does_not_pin_turn', () => {
    const messages = [makeMsg('u1', 'user'), makeMsg('a1', 'assistant')];
    const turns = splitIntoTurns(messages);
    const blocks = new Map<string, MessageBlock[]>();
    blocks.set('a1', [{ id: 'b', messageId: 'a1', type: 'thinking', status: 'success',
      content: 'let me think...' }]);
    expect(turnHasLiveSignature(messages, turns[0]!, blocks)).toBe(false);
  });

  it('gemini_thought_signature_pins_turn', () => {
    const assistant: ChatMessage = {
      ...makeMsg('a1', 'assistant'),
      _meta: {
        toolResults: [{
          toolCallId: 'tc1', blockId: null, toolName: 'weather', input: {}, output: {},
          success: true, error: null, durationMs: null, reasoningContent: null,
          thoughtSignature: 'sig_abc_xyz',
        }],
      },
    };
    const messages = [makeMsg('u1', 'user'), assistant];
    const turns = splitIntoTurns(messages);
    expect(turnHasLiveSignature(messages, turns[0]!, new Map())).toBe(true);
  });

  it('empty_tail_inputs_return_null_and_no_ranges', () => {
    expect(selectTail([], [], 100, new Map())).toBeNull();
    expect(selectManualTail([], [], 100, new Map())).toBeNull();
    expect(splitSummaryRanges([], [], new Map(), 0, 10, 100, 100)).toEqual([]);
  });
});
