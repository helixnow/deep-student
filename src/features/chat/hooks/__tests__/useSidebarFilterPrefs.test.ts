import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SIDEBAR_FILTER_PREFS,
  filterSidebarSessions,
  isSidebarFilterModified,
  useSidebarFilterPrefs,
} from '../useSidebarFilterPrefs';
import type { ChatSession } from '../../types/session';

function makeSession(overrides: Partial<ChatSession>): ChatSession {
  return {
    id: 'sess_normal',
    mode: 'chat',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const NORMAL_SESSION = makeSession({ id: 'sess_normal' });
const SUBAGENT_BY_ID = makeSession({ id: 'subagent_worker_01' });
const SUBAGENT_BY_LEGACY_ID = makeSession({ id: 'agent_worker_1' });
const SUBAGENT_BY_MODE = makeSession({ id: 'sess_x1', mode: 'subagent' });
const SUBAGENT_BY_METADATA = makeSession({
  id: 'sess_x2',
  metadata: { is_subagent: true },
});

describe('filterSidebarSessions', () => {
  it('默认隐藏所有形态的子代理会话', () => {
    const all = [
      NORMAL_SESSION,
      SUBAGENT_BY_ID,
      SUBAGENT_BY_LEGACY_ID,
      SUBAGENT_BY_MODE,
      SUBAGENT_BY_METADATA,
    ];
    const result = filterSidebarSessions(all, DEFAULT_SIDEBAR_FILTER_PREFS);
    expect(result).toEqual([NORMAL_SESSION]);
  });

  it('开启 showSubagentSessions 后原样返回（保持引用，不额外分配）', () => {
    const all = [NORMAL_SESSION, SUBAGENT_BY_ID];
    const result = filterSidebarSessions(all, { showSubagentSessions: true });
    expect(result).toBe(all);
  });

  it('空列表与全子代理列表返回空数组', () => {
    expect(filterSidebarSessions([], DEFAULT_SIDEBAR_FILTER_PREFS)).toEqual([]);
    expect(filterSidebarSessions([SUBAGENT_BY_ID], DEFAULT_SIDEBAR_FILTER_PREFS)).toEqual([]);
  });
});

describe('isSidebarFilterModified', () => {
  it('默认配置不算修改', () => {
    expect(isSidebarFilterModified(DEFAULT_SIDEBAR_FILTER_PREFS)).toBe(false);
  });

  it('显示子代理会话视为偏离默认', () => {
    expect(isSidebarFilterModified({ showSubagentSessions: true })).toBe(true);
  });
});

describe('useSidebarFilterPrefs store', () => {
  beforeEach(() => {
    useSidebarFilterPrefs.setState({ ...DEFAULT_SIDEBAR_FILTER_PREFS });
    window.localStorage.clear();
  });

  it('默认隐藏子代理会话', () => {
    expect(useSidebarFilterPrefs.getState().showSubagentSessions).toBe(false);
  });

  it('setShowSubagentSessions 更新状态并持久化到 localStorage', () => {
    useSidebarFilterPrefs.getState().setShowSubagentSessions(true);
    expect(useSidebarFilterPrefs.getState().showSubagentSessions).toBe(true);

    const raw = window.localStorage.getItem('chat-v2-sidebar-filter-prefs');
    expect(raw).toBeTruthy();
    const persisted = JSON.parse(raw as string);
    expect(persisted.state.showSubagentSessions).toBe(true);
    expect(persisted.version).toBe(1);
  });
});
