import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  setInputValue: vi.fn(),
  setState: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../core/session/createSessionWithDefaults', () => ({ createSessionWithDefaults: vi.fn() }));
vi.mock('../core/session/sessionManager', () => ({
  sessionManager: {
    getOrCreate: () => ({ getState: () => ({ setInputValue: mocks.setInputValue }), setState: mocks.setState }),
  },
}));
vi.mock('../navigation/pendingChatNavigation', () => ({ requestChatSessionNavigation: vi.fn() }));

import { workshopSessions } from '../workshop';
import { sessionTitleFromText } from '../utils/sessionTitleFromText';

describe('workshop starter conversation title', () => {
  it('derives the title like the host fallback (whitespace, punctuation, 20 chars)', () => {
    expect(sessionTitleFromText('  做一个划词翻译插件：选中文字就弹出译文。 ')).toBe('做一个划词翻译插件：选中文字就弹出译文');
    expect(sessionTitleFromText('「帮我做一个番茄钟应用，带白噪音和统计面板，还要能导出数据」')).toBe('帮我做一个番茄钟应用，带白噪音和统计面板');
    expect(sessionTitleFromText(' ... ')).toBeNull();
  });

  it('prefills the composer and names the conversation after the starter', async () => {
    mocks.invoke.mockResolvedValue(undefined);
    await workshopSessions.prefill('s1', '做一个划词翻译插件');
    expect(mocks.setInputValue).toHaveBeenCalledWith('做一个划词翻译插件');
    expect(mocks.invoke).toHaveBeenCalledWith('chat_v2_update_session_settings', {
      sessionId: 's1',
      settings: { title: '做一个划词翻译插件' },
    });
    expect(mocks.setState).toHaveBeenCalledWith({ title: '做一个划词翻译插件' });
  });
});
