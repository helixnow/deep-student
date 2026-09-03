/**
 * userPatch summarizer i18n — driver 摘要走 dstu:agent.user_patch.<key>
 *
 * mock @/i18n 为 key-echo，registerAllDrivers 后逐 typeId 断言 summarizeUserPatch
 * 返回对应 i18n key（含未知 typeId 的缺省 key）。userPatch 用真实实现。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));

const mocks = vi.hoisted(() => ({
  setupNoteBinding: vi.fn(),
  mindmap: vi.fn(),
  note: vi.fn(),
  todo: vi.fn(),
  finder: vi.fn(),
  fsrs: vi.fn(),
  qbank: vi.fn(),
  pomodoro: vi.fn(),
  sandbox: vi.fn(),
}));

vi.mock('../noteBinding', () => ({ setupNoteBinding: mocks.setupNoteBinding }));
vi.mock('../drivers/mindmapDriver', () => ({ registerMindmapDriver: mocks.mindmap }));
vi.mock('../drivers/noteDriver', () => ({ registerNoteDriver: mocks.note }));
vi.mock('../drivers/todoDriver', () => ({ registerTodoDriver: mocks.todo }));
vi.mock('../drivers/finderDriver', () => ({ registerFinderDriver: mocks.finder }));
vi.mock('../drivers/fsrsDriver', () => ({ registerFsrsDriver: mocks.fsrs }));
vi.mock('../drivers/qbankDriver', () => ({ registerQbankDriver: mocks.qbank }));
vi.mock('../drivers/pomodoroDriver', () => ({ registerPomodoroDriver: mocks.pomodoro }));
vi.mock('../drivers/sandboxDriver', () => ({ registerSandboxDriver: mocks.sandbox }));

import { disposeAllDrivers, registerAllDrivers } from '../drivers';
import { summarizeUserPatch } from '../userPatch';
import type { StageManagerApi } from '../types';

const stage = {} as StageManagerApi;

const EXPECTED_KEYS = [
  ['mindmap', 'dstu:agent.user_patch.mindmap'],
  ['note', 'dstu:agent.user_patch.note'],
  ['todo', 'dstu:agent.user_patch.todo'],
  ['files', 'dstu:agent.user_patch.files'],
  ['flashcards', 'dstu:agent.user_patch.flashcards'],
  ['exam', 'dstu:agent.user_patch.exam'],
  ['pomodoro', 'dstu:agent.user_patch.pomodoro'],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.setupNoteBinding.mockImplementation(() => vi.fn());
  for (const registration of [mocks.todo, mocks.finder, mocks.fsrs, mocks.qbank]) {
    registration.mockImplementation(() => vi.fn());
  }
  registerAllDrivers(stage);
});

afterEach(() => {
  disposeAllDrivers();
});

describe('userPatch summarizer i18n keys', () => {
  it.each(EXPECTED_KEYS)('%s → %s', (typeId, key) => {
    expect(summarizeUserPatch(typeId)).toBe(key);
  });

  it('未知 typeId 走缺省 key', () => {
    expect(summarizeUserPatch('unknown-type')).toBe('dstu:agent.user_patch.default');
  });
});
