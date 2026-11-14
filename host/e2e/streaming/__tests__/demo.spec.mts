import { afterEach, describe, expect, it, vi } from 'vitest';
const sample = vi.hoisted(() => ({ emitted: [] as Array<{ channel: string; payload: any }> }));
vi.mock('@tauri-apps/api/event', () => ({ emit: async (channel: string, payload: unknown) => {
  sample.emitted.push({ channel, payload: JSON.parse(JSON.stringify(payload)) });
} }));
vi.mock('../../../../src/demo/playedHistory', () => ({ capturePlayedSnapshot: vi.fn(async () => {}) }));
import { abortScript, playNextReplyInstantly, playReplyScript } from '../../../../src/demo/scriptPlayer';

afterEach(() => { sample.emitted.length = 0; vi.useRealTimers(); });

describe('real demo scriptPlayer as an additional sample, not a Rust oracle', () => {
  it('emits the same two channels and start/chunk/end ordering for thinking, answer and retrieval', async () => {
    vi.useFakeTimers();
    playNextReplyInstantly('sess_demo_x5');
    const playing = playReplyScript({ sessionId: 'sess_demo_x5', assistantMessageId: 'msg_demo_x5', blocks: [
      { type: 'thinking', streaming: true, content: '分析' },
      { type: 'content', streaming: true, content: '回答' },
      { type: 'web_search', toolOutput: { sources: [], count: 0, durationMs: 0 } },
    ] });
    await vi.runAllTimersAsync(); await playing;
    expect(sample.emitted.map(e => e.payload.eventType ?? `${e.payload.type}:${e.payload.phase}`))
      .toEqual(['stream_start', 'thinking:start', 'thinking:chunk', 'thinking:end',
        'content:start', 'content:chunk', 'content:end', 'web_search:start', 'web_search:end', 'stream_complete']);
    const blocks = sample.emitted.filter(e => !e.payload.eventType);
    expect(blocks.map(e => e.payload.sequenceId)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(blocks.every(e => e.channel === 'chat_v2_event_sess_demo_x5')).toBe(true);
    expect(sample.emitted[0]?.channel).toBe('chat_v2_session_sess_demo_x5');
    expect(sample.emitted.at(-1)?.channel).toBe('chat_v2_session_sess_demo_x5');
    // Deliberate demo simplifications: no generation/session sequence, no authoritative content end.
    expect(sample.emitted[0]?.payload).not.toHaveProperty('streamGeneration');
    expect(sample.emitted[0]?.payload).not.toHaveProperty('sequenceId');
    expect(blocks[5]?.payload).not.toHaveProperty('result');
  });

  it('abortScript does not itself emit stream_cancelled (the demo mock cancel command must do that)', async () => {
    vi.useFakeTimers();
    const playing = playReplyScript({ sessionId: 'sess_demo_abort', assistantMessageId: 'msg_demo_x5',
      blocks: [{ type: 'content', streaming: true, content: '不会发出' }] });
    // Let the initial emit resolve so the player's abort-aware pause is installed.
    await Promise.resolve();
    expect(abortScript('sess_demo_abort')).toBe(true);
    await playing;
    expect(sample.emitted.map(e => e.payload.eventType)).toEqual(['stream_start']);
  });
});
