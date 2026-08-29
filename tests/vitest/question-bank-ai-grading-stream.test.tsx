/**
 * #56 回归：题库 AI 批改/解析流式完成后文本不消失
 *
 * 场景：DMXapi Gemini-3-flash 等网关在 complete 终态事件中可能不带全文
 * （feedback 为空串）。此前 hook 的 state 用 prev 兜底，但 onComplete 却把
 * 空串透传给父组件——QuestionBankEditor 的解析缓存（aiFeedbackCacheRef）
 * 因空串守卫永远写不进终态文本，切题回来后已渲染的解析整段消失。
 *
 * 契约：complete 时终态文本 = 非空 payload.feedback，否则用已累积的流式
 * 文本；state 与 onComplete 必须拿到同一份非空终态文本。
 */
import { renderHook, act, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockListen = vi.fn();
const mockInvoke = vi.fn();

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

import { useQbankAiGrading } from '@/hooks/useQbankAiGrading';

type StreamHandler = (event: { payload: Record<string, unknown> }) => void;

describe('useQbankAiGrading complete 终态文本（#56）', () => {
  let streamHandler: StreamHandler | null;

  beforeEach(() => {
    vi.clearAllMocks();
    streamHandler = null;

    mockListen.mockImplementation(async (_event: string, handler: StreamHandler) => {
      streamHandler = handler;
      return () => undefined;
    });
    mockInvoke.mockResolvedValue(undefined);
  });

  async function startAndStream(
    onComplete: (verdict?: string, score?: number, feedback?: string) => void,
  ) {
    const { result } = renderHook(() => useQbankAiGrading());

    let settled: Promise<'completed' | 'cancelled'>;
    act(() => {
      settled = result.current.startGrading('q1', 'sub1', 'analyze', undefined, onComplete);
      // 失败时避免 unhandled rejection 干扰断言输出
      settled.catch(() => undefined);
    });

    await waitFor(() => {
      expect(streamHandler).not.toBeNull();
    });

    act(() => {
      streamHandler?.({ payload: { type: 'data', chunk: '解题', accumulated: '解题' } });
      streamHandler?.({
        payload: { type: 'data', chunk: '思路：先看题干', accumulated: '解题思路：先看题干' },
      });
    });

    expect(result.current.state.feedback).toBe('解题思路：先看题干');

    return { result, settled: settled! };
  }

  it('complete 的 feedback 为空串时，state 保留累积文本且 onComplete 不传空串', async () => {
    const onComplete = vi.fn();
    const { result, settled } = await startAndStream(onComplete);

    act(() => {
      streamHandler?.({
        payload: {
          type: 'complete',
          submission_id: 'sub1',
          verdict: null,
          score: null,
          feedback: '',
        },
      });
    });

    await expect(settled).resolves.toBe('completed');

    // 已流式渲染的文本不能在 complete 后消失
    expect(result.current.state.isGrading).toBe(false);
    expect(result.current.state.feedback).toBe('解题思路：先看题干');

    // onComplete 必须拿到同一份终态文本，而不是空串——
    // 否则父组件解析缓存写不进去，切题回来解析整段消失
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][2]).toBe('解题思路：先看题干');
  });

  it('complete 带非空 feedback 时，state 与 onComplete 都以 payload.feedback 为准', async () => {
    const onComplete = vi.fn();
    const { result, settled } = await startAndStream(onComplete);

    act(() => {
      streamHandler?.({
        payload: {
          type: 'complete',
          submission_id: 'sub1',
          verdict: null,
          score: null,
          feedback: '解题思路：先看题干（终态全文）',
        },
      });
    });

    await expect(settled).resolves.toBe('completed');

    expect(result.current.state.feedback).toBe('解题思路：先看题干（终态全文）');
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][2]).toBe('解题思路：先看题干（终态全文）');
  });
});
