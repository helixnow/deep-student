import { describe, expect, it, vi } from 'vitest';
import { ArtifactReferenceDeduplicator, ResponseTimeline, rejectTruncatedToolBatch } from '../src/response-timeline.ts';
import { ExtractiveTurnCompactor, buildConversationTurnUnits,
  type CompactionBatch, type CompactionMessage } from '../src/extractive-compaction.ts';

describe('append-only response timeline', () => {
  it('keeps immutable UTF-16 anchors while text, reasoning and tools interleave', () => {
    const timeline = new ResponseTimeline('task', () => 123);
    timeline.appendReasoning('想🧠');
    timeline.appendText('正文😀');
    const first = timeline.segments[0];
    timeline.appendReasoning('再想');
    timeline.appendTool({ id: 'model-duplicate' }, 0);
    timeline.appendText('继续');
    timeline.appendTool({ id: 'model-duplicate' }, 1);
    timeline.appendTool({ id: 'model-duplicate' }, 1);
    expect(timeline.segments).toEqual([
      { textOffset: 0, reasoningOffset: 0, toolOffset: 0, startedAt: 123 },
      { textOffset: 4, reasoningOffset: 3, toolOffset: 0, startedAt: 123 },
      { textOffset: 6, reasoningOffset: 5, toolOffset: 1, startedAt: 123 },
    ]);
    expect(timeline.segments[0]).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(timeline.tools.map(tool => tool.id)).toEqual(['task:0:0', 'task:1:0', 'task:1:1']);
    expect(timeline.text).toBe('正文😀继续');
  });

  it.each(['wbw-widget', 'wbw-whiteboard', 'wbw-canvas'])('deduplicates split %s fences without offset drift', kind => {
    const fence = `\`\`\`${kind}\nref😀\n\`\`\``;
    const timeline = new ResponseTimeline('task');
    const source = `${fence}\n正文\n${fence}\n之后`;
    for (const unit of source.split('')) timeline.appendText(unit);
    timeline.finishText();
    const blank = fence.replace(/[^\r\n]/g, ' ');
    expect(timeline.text).toBe(`${fence}\n正文\n${blank}\n之后`);
    expect(timeline.text.length).toBe(source.length);
    timeline.appendReasoning('下一段');
    expect(timeline.segments.at(-1)?.textOffset).toBe(source.length);
  });

  it('does not deduplicate references embedded in ordinary code fences', () => {
    const dedupe = new ArtifactReferenceDeduplicator();
    const source = '````markdown\n```wbw-widget\nref\n```\n````\n';
    expect(dedupe.append(source + source, true)).toBe(source + source);
    expect(dedupe.append('```unfinished', true)).toBe('```unfinished');
  });

  it.each(['length', 'max_tokens'])('rejects a whole truncated batch even with valid JSON: %s', reason => {
    const calls = [{ id: 'first', arguments: '{}' }, { id: 'second', arguments: '{"valid":true}' }];
    expect(rejectTruncatedToolBatch(reason, calls)).toEqual({
      interrupted: true, resumable: true, reason: 'truncated_tool_batch', toolCalls: [],
    });
    expect(rejectTruncatedToolBatch('tool_calls', calls)).toEqual({ interrupted: false, toolCalls: calls });
  });
});

function history(count: number, content = 'answer'): CompactionMessage[] {
  return Array.from({ length: count }, (_, index) => [
    { id: `u${index}`, role: 'user', content: `question ${index}` },
    { id: `a${index}`, role: 'assistant', content },
  ]).flat();
}
const omitAll = async (batch: CompactionBatch) => batch.turns.map(turn => ({ turnId: turn.id, omitProbability: 0.99 }));

describe('extractive whole-turn compaction', () => {
  it('groups complete tool chains and protects recent, checkpoint, interrupted and tool turns', async () => {
    const messages = history(8);
    messages.splice(2, 0, { role: 'assistant', content: 'more', tool_calls: [{ id: 'x' }] },
      { role: 'tool', content: 'result' });
    messages.find(message => message.id === 'a1')!.checkpoint = { status: 'pending' };
    messages.find(message => message.id === 'a2')!.interrupted = true;
    const units = buildConversationTurnUnits(messages);
    expect(units[0]!.messages).toHaveLength(4);
    const original = JSON.stringify(messages);
    const plan = await new ExtractiveTurnCompactor(omitAll).compact(messages, { conversationId: 'chat' });
    expect(plan.omittedTurnIds).toEqual(['u3', 'u4', 'u5']);
    expect(JSON.stringify(messages)).toBe(original);
    expect(plan.messages.every(message => messages.includes(message))).toBe(true);
    expect(plan.messages).toContain(messages.find(message => message.role === 'tool'));
  });

  it('requires a valid probability of at least .95 for the entire turn', async () => {
    const compactor = new ExtractiveTurnCompactor(async batch => batch.turns.map((turn, index) => ({
      turnId: turn.id, omitProbability: [0.949, 0.95, NaN, 1.1][index]!,
    })));
    expect((await compactor.compact(history(6), { conversationId: 'chat' })).omittedTurnIds).toEqual(['u1']);
  });

  it('reuses results, invalidates edits, and isolates conversation caches', async () => {
    const decide = vi.fn(omitAll);
    const compactor = new ExtractiveTurnCompactor(decide);
    const messages = history(4);
    await compactor.compact(messages, { conversationId: 'a' });
    await compactor.compact(messages, { conversationId: 'a' });
    expect(decide).toHaveBeenCalledTimes(1);
    messages[1]!.content = 'edited fact';
    await compactor.compact(messages, { conversationId: 'a' });
    expect(decide.mock.calls[1]![0].turns.map(turn => turn.id)).toEqual(['u0']);
    await compactor.compact(messages, { conversationId: 'b' });
    expect(decide).toHaveBeenCalledTimes(3);
  });

  it('evaluates at most the most recent 32 old turns', async () => {
    const decide = vi.fn(omitAll);
    const plan = await new ExtractiveTurnCompactor(decide).compact(history(40), { conversationId: 'a' });
    expect(plan.omittedTurnIds).toHaveLength(32);
    expect(plan.omittedTurnIds[0]).toBe('u6');
  });

  it('bounds complete UTF-8 JSON batches and skips oversized turns without truncating', async () => {
    const messages = history(12, '汉'.repeat(3500));
    messages[1]!.content = '汉'.repeat(11000);
    // Protected context is also part of each batch, so keep it small here.
    for (const message of messages.slice(-4)) message.content = 'recent';
    const batches: CompactionBatch[] = [];
    let active = 0;
    let peak = 0;
    const compactor = new ExtractiveTurnCompactor(async batch => {
      batches.push(batch);
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      return omitAll(batch);
    });
    const plan = await compactor.compact(messages, { conversationId: 'a' });
    expect(batches).toHaveLength(4);
    expect(peak).toBe(4);
    expect(batches.every(batch => new TextEncoder().encode(JSON.stringify(batch)).length <= 30_000)).toBe(true);
    expect(batches.flatMap(batch => batch.turns).some(turn => turn.id === 'u0')).toBe(false);
    expect(batches.flatMap(batch => batch.turns).every(turn => turn.messages[1]!.content.length === 3500)).toBe(true);
    expect(plan.omittedTurnIds).toHaveLength(8);
  });

  it('retains all original messages when the decider fails or context alone exceeds the cap', async () => {
    const messages = [{ role: 'system', content: 'system' }, ...history(4)];
    const failed = new ExtractiveTurnCompactor(async () => { throw new Error('offline'); });
    expect((await failed.compact(messages, { conversationId: 'a' })).messages).toEqual(messages);
    const decide = vi.fn(omitAll);
    messages.at(-1)!.content = '汉'.repeat(11000);
    const plan = await new ExtractiveTurnCompactor(decide).compact(messages, { conversationId: 'a' });
    expect(plan.messages).toEqual(messages);
    expect(decide).not.toHaveBeenCalled();
  });
});
