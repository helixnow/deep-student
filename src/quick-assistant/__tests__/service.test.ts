import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  inferQuickActions,
  isCaptureLikeText,
  looksLikeSecret,
  QUICK_RUN_STOPPED,
  startQuickLearningAction,
} from '../service';

const { invokeMock, listeners } = vi.hoisted(() => ({ invokeMock: vi.fn(), listeners: new Map<string, (event: { payload: unknown }) => void>() }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return () => listeners.delete(name);
  }),
}));

beforeEach(() => {
  invokeMock.mockReset();
  listeners.clear();
});

describe('inferQuickActions', () => {
  it('prioritizes hints for exercise-like content', () => {
    expect(inferQuickActions('已知 x + 2 = 8，求 x')).toEqual(['hint', 'explain', 'ask']);
  });

  it('prioritizes translation for foreign language excerpts', () => {
    expect(inferQuickActions('Photosynthesis converts light energy into chemical energy.')[0]).toBe('translate');
  });

  it('prioritizes direct answers for questions', () => {
    expect(inferQuickActions('为什么天空是蓝色？')[0]).toBe('ask');
  });

  it('uses explanation as the neutral default', () => {
    expect(inferQuickActions('牛顿第二定律的基本内容')[0]).toBe('explain');
  });
});

describe('isCaptureLikeText', () => {
  it('treats multiline paste as capture material', () => {
    expect(isCaptureLikeText('第一行\n第二行')).toBe(true);
  });

  it('treats long paragraphs as capture material', () => {
    expect(isCaptureLikeText('这段话很长，'.repeat(20))).toBe(true);
  });

  it('keeps short single-line questions in the input box', () => {
    expect(isCaptureLikeText('什么是熵？')).toBe(false);
  });

  it('ignores whitespace-only paste', () => {
    expect(isCaptureLikeText('   \n  ')).toBe(false);
  });
});

describe('looksLikeSecret', () => {
  it('flags password-like single tokens', () => {
    expect(looksLikeSecret('Xk9#mQ2$vLp7wRt!')).toBe(true);
    expect(looksLikeSecret('sk-Ab3dEf9hIj2kLm5nOp8q')).toBe(true);
  });

  it('keeps study material and questions', () => {
    expect(looksLikeSecret('什么是熵？')).toBe(false);
    expect(looksLikeSecret('Photosynthesis converts light energy.')).toBe(false);
  });

  it('keeps math expressions and urls', () => {
    expect(looksLikeSecret('x^2+y_1=Z9(a-b)/2!')).toBe(false);
    expect(looksLikeSecret('https://example.com/A9_b?x=1')).toBe(false);
  });
});

describe('startQuickLearningAction token budget', () => {
  it('lets the backend use the selected model configuration instead of a hidden 1600-token cap', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'chat_v2_create_session') return { id: 'quick-session-1' };
      if (command === 'chat_v2_list_groups') {
        return [{ id: 'quick-group-1', name: '快速学习' }];
      }
      if (command === 'chat_v2_cancel_stream') {
        listeners.get('chat_v2_session_quick-session-1')?.({ payload: { eventType: 'stream_cancelled' } });
      }
      return null;
    });

    const handle = await startQuickLearningAction('解释熵', 'explain', vi.fn());
    const sendCall = invokeMock.mock.calls.find(([command]) => command === 'chat_v2_send_message');

    expect(sendCall).toBeDefined();
    expect(sendCall?.[1]?.request.options).toEqual({ enableThinking: false });
    expect(sendCall?.[1]?.request.options).not.toHaveProperty('maxTokens');

    handle.cancel();
    await expect(handle.completion).rejects.toMatchObject({ name: QUICK_RUN_STOPPED });
  });
});
