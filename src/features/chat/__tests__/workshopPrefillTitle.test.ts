import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  setInputValue: vi.fn(),
  setState: vi.fn(),
  getAdapter: vi.fn(),
  waitForListenersReady: vi.fn(),
  release: vi.fn(),
  saveSession: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../core/session/createSessionWithDefaults', () => ({ createSessionWithDefaults: vi.fn() }));
vi.mock('../core/session/sessionManager', () => ({
  sessionManager: {
    getOrCreate: () => ({ getState: () => ({ setInputValue: mocks.setInputValue, saveSession: mocks.saveSession }), setState: mocks.setState }),
  },
}));
vi.mock('../adapters/AdapterManager', () => ({ adapterManager: {
  getOrCreate: mocks.getAdapter, waitForListenersReady: mocks.waitForListenersReady, release: mocks.release,
} }));
vi.mock('../navigation/pendingChatNavigation', () => ({ requestChatSessionNavigation: vi.fn() }));

import { workshopSessions } from '../workshop';
import { sessionTitleFromText } from '../utils/sessionTitleFromText';

const lease = { sessionId: 's1', generation: 1 };
const readyAdapter = { entry: { isReady: true, error: null }, lease };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.getAdapter.mockResolvedValue(readyAdapter);
  mocks.waitForListenersReady.mockResolvedValue(undefined);
  mocks.invoke.mockResolvedValue(undefined);
});

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
    expect(mocks.release).toHaveBeenCalledExactlyOnceWith('s1', lease);
  });
});


it('keeps the modification draft after a cold adapter restores an empty backend composer', async () => {
  let inputValue = '';
  let finishLoad!: () => void;
  const loading = new Promise<void>(resolve => { finishLoad = resolve; });
  mocks.setInputValue.mockImplementation((text: string) => { inputValue = text; });
  mocks.getAdapter.mockImplementation(async () => {
    await loading;
    // The existing adapter restore replaces the input with its persisted value before becoming ready.
    inputValue = '';
    return readyAdapter;
  });
  const pending = workshopSessions.prefill('s1', '把『公式表』改成：');
  expect(mocks.setInputValue).not.toHaveBeenCalled();
  expect(mocks.invoke).not.toHaveBeenCalled();
  finishLoad();
  await pending;
  expect(inputValue).toBe('把『公式表』改成：');
  expect(mocks.waitForListenersReady).toHaveBeenCalledExactlyOnceWith('s1');
  expect(mocks.release).toHaveBeenCalledExactlyOnceWith('s1', lease);
  expect(mocks.saveSession).not.toHaveBeenCalled();
});

it('releases the adapter and leaves the input intact when the connection is not ready', async () => {
  mocks.getAdapter.mockResolvedValue({ entry: { isReady: false, error: 'History could not load' }, lease });
  await expect(workshopSessions.prefill('s1', '把『公式表』改成：')).rejects.toThrow('History could not load');
  expect(mocks.setInputValue).not.toHaveBeenCalled();
  expect(mocks.invoke).not.toHaveBeenCalled();
  expect(mocks.release).toHaveBeenCalledExactlyOnceWith('s1', lease);
});
