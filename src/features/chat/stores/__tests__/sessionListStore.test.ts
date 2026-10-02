import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSession } from '../../types/session';
import type { SessionGroup } from '../../types/group';
import * as api from '../sessionListStore';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

const releases: Array<() => void> = [];

function session(id: string, overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id, mode: 'chat', title: id, persistStatus: 'active',
    createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z',
    ...overrides,
  };
}
function group(overrides: Partial<SessionGroup> = {}): SessionGroup {
  return {
    id: 'group-1', name: 'Topic', defaultSkillIds: [], pinnedResourceIds: [],
    sortOrder: 0, persistStatus: 'active',
    createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z',
    ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}
function sessionCalls() {
  return invokeMock.mock.calls.filter(([command]) => command === 'chat_v2_list_sessions');
}
function retain() {
  const release = api.retainSessionListStore();
  releases.push(release);
  return release;
}
function respond(sessions: ChatSession[], groups: SessionGroup[] = []) {
  invokeMock.mockImplementation((command: string, args: { groupId?: string; offset?: number; limit?: number }) => {
    if (command === 'chat_v2_list_groups') return Promise.resolve(structuredClone(groups));
    const partition = sessions.filter((row) => args.groupId === '*' ? !!row.groupId : !row.groupId);
    return Promise.resolve(structuredClone(partition.slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 50))));
  });
}

beforeEach(() => {
  api.__resetSessionListStoreForTests();
  invokeMock.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-27T00:00:00Z'));
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});
afterEach(() => {
  releases.splice(0).forEach((release) => release());
  vi.useRealTimers();
});

describe('shared session list', () => {
  it('deduplicates ordinary consumers and remounts instead of queuing another request', async () => {
    const grouped = deferred<ChatSession[]>();
    const ungrouped = deferred<ChatSession[]>();
    invokeMock.mockImplementation((command: string, args: { groupId?: string }) => command === 'chat_v2_list_groups'
      ? Promise.resolve([]) : args.groupId === '*' ? grouped.promise : ungrouped.promise);
    retain();
    const first = api.useSessionListStore.getState().refresh();
    const second = api.useSessionListStore.getState().refresh();
    const page = api.useSessionListStore.getState().ensureLoaded();
    expect(second).toBe(first);
    expect(page).toBe(first);
    expect(sessionCalls()).toHaveLength(2);
    grouped.resolve([session('grouped', { groupId: 'group-1' })]);
    ungrouped.resolve([session('ungrouped')]);
    await Promise.all([first, second, page]);
    retain();
    await api.useSessionListStore.getState().ensureLoaded();
    expect(sessionCalls()).toHaveLength(2);
    expect(api.useSessionListStore.getState().sessions).toHaveLength(2);
  });

  it('coalesces mutation events during a request into one follow-up and fences the stale response', async () => {
    const old = session('old');
    api.useSessionListStore.getState().setSnapshot([old]);
    retain();
    const firstRows = deferred<ChatSession[]>();
    const secondRows = deferred<ChatSession[]>();
    let rounds = 0;
    invokeMock.mockImplementation((command: string, args: { groupId?: string }) => {
      if (command === 'chat_v2_list_groups') return Promise.resolve([]);
      if (args.groupId === '*') return Promise.resolve([]);
      rounds += 1;
      return rounds === 1 ? firstRows.promise : secondRows.promise;
    });
    const request = api.useSessionListStore.getState().refresh();
    for (let index = 0; index < 12; index += 1) window.dispatchEvent(new Event('chat-v2:sessions-updated'));
    firstRows.resolve([session('stale')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(rounds).toBe(2);
    expect(api.useSessionListStore.getState().sessions).toEqual([old]);
    secondRows.resolve([session('fresh')]);
    await request;
    await vi.advanceTimersByTimeAsync(500);
    expect(rounds).toBe(2);
    expect(api.useSessionListStore.getState().sessions[0].id).toBe('fresh');
  });

  it('refreshes on visible only after 30 seconds and never on window focus', async () => {
    respond([session('one')]);
    retain();
    await api.useSessionListStore.getState().ensureLoaded();
    await vi.advanceTimersByTimeAsync(29_999);
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(sessionCalls()).toHaveLength(2);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await vi.advanceTimersByTimeAsync(1);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sessionCalls()).toHaveLength(2);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    document.dispatchEvent(new Event('visibilitychange'));
    await api.useSessionListStore.getState().ensureLoaded();
    expect(sessionCalls()).toHaveLength(4);
  });

  it('preserves all loaded pages on refresh and shares concurrent pagination', async () => {
    const rows = Array.from({ length: 100 }, (_, index) => session(`session-${index}`));
    respond([session('grouped', { groupId: 'group-1' }), ...rows]);
    await api.useSessionListStore.getState().refresh();
    expect(api.useSessionListStore.getState().sessions).toHaveLength(51);
    const first = api.useSessionListStore.getState().loadMoreUngrouped();
    expect(api.useSessionListStore.getState().loadMoreUngrouped()).toBe(first);
    await first;
    const loaded = api.useSessionListStore.getState().sessions;
    expect(loaded).toHaveLength(101);
    await api.useSessionListStore.getState().refresh();
    expect(api.useSessionListStore.getState().sessions).toBe(loaded);
    expect(sessionCalls().at(-1)?.[1]).toMatchObject({ groupId: '', offset: 0, limit: 100 });
    expect(sessionCalls().filter(([, args]) => args.offset === 50)).toHaveLength(1);
  });

  it('waits for a pending page before refreshing the full loaded window', async () => {
    const rows = Array.from({ length: 100 }, (_, index) => session(`session-${index}`));
    respond(rows);
    await api.useSessionListStore.getState().refresh();
    const page = deferred<ChatSession[]>();
    invokeMock.mockImplementation((command: string, args: { groupId?: string; offset?: number; limit?: number }) => {
      if (command === 'chat_v2_list_groups' || args.groupId === '*') return Promise.resolve([]);
      if (args.offset === 50) return page.promise;
      return Promise.resolve(rows.slice(0, args.limit));
    });
    const pagination = api.useSessionListStore.getState().loadMoreUngrouped();
    const refresh = api.useSessionListStore.getState().refresh();
    expect(sessionCalls()).toHaveLength(3);
    page.resolve(rows.slice(50));
    await Promise.all([pagination, refresh]);
    expect(api.useSessionListStore.getState().sessions).toHaveLength(100);
    expect(sessionCalls().at(-1)?.[1]).toMatchObject({ groupId: '', limit: 100, offset: 0 });
  });

  it('retains failed partitions, groups and pagination availability', async () => {
    const grouped = session('grouped', { groupId: 'group-1' });
    const ungrouped = session('ungrouped');
    const cachedGroup = group();
    api.useSessionListStore.getState().setSnapshot([grouped, ungrouped], true);
    api.useSessionListStore.getState().setGroups([cachedGroup]);
    invokeMock.mockImplementation((command: string, args: { groupId?: string }) => {
      if (command === 'chat_v2_list_groups' || args.groupId === '') return Promise.reject(new Error('offline'));
      return Promise.resolve([{ ...grouped, title: 'Changed group session' }]);
    });
    await api.useSessionListStore.getState().refresh();
    expect(api.useSessionListStore.getState().sessions[1]).toBe(ungrouped);
    expect(api.useSessionListStore.getState().groups[0]).toBe(cachedGroup);
    expect(api.useSessionListStore.getState().hasMoreUngrouped).toBe(true);
    const loaded = api.useSessionListStore.getState().sessions;
    invokeMock.mockRejectedValue(new Error('offline'));
    await expect(api.useSessionListStore.getState().refresh()).rejects.toThrow('Failed to load');
    expect(api.useSessionListStore.getState().sessions).toBe(loaded);
    await expect(api.useSessionListStore.getState().loadMoreUngrouped()).rejects.toThrow('offline');
    expect(api.useSessionListStore.getState().sessions).toBe(loaded);
    expect(api.useSessionListStore.getState().hasMoreUngrouped).toBe(true);
    expect(api.useSessionListStore.getState().isLoadingMore).toBe(false);
  });

  it('does not notify consumers for identical JSON and retains unchanged row references', async () => {
    const rows = [session('one', { metadata: { pinned: false, branchedFrom: { sessionId: 'source' } } }), session('two')];
    const topic = { ...group(), metadata: { pinned: false } };
    respond(rows, [topic]);
    await api.useSessionListStore.getState().refresh();
    const before = api.useSessionListStore.getState();
    const notify = vi.fn();
    const unsubscribe = api.useSessionListStore.subscribe(notify);
    await api.useSessionListStore.getState().refresh();
    expect(notify).not.toHaveBeenCalled();
    expect(api.useSessionListStore.getState().sessions).toBe(before.sessions);
    rows[0] = { ...rows[0], description: 'Updated summary', metadata: { pinned: false, branchedFrom: { sessionId: 'new-source' } } };
    topic.metadata.pinned = true;
    respond(rows, [topic]);
    await api.useSessionListStore.getState().refresh();
    expect(api.useSessionListStore.getState().sessions[1]).toBe(before.sessions[1]);
    expect(api.useSessionListStore.getState().sessions[0]).not.toBe(before.sessions[0]);
    expect(api.useSessionListStore.getState().sessions[0].metadata?.branchedFrom).toEqual({ sessionId: 'new-source' });
    expect(api.useSessionListStore.getState().groups[0]).not.toBe(before.groups[0]);
    unsubscribe();
  });

  it('never overwrites a newer snapshot or optimistic rename with an older request', async () => {
    const oldResponse = deferred<ChatSession[]>();
    invokeMock.mockImplementation((command: string, args: { groupId?: string }) => command === 'chat_v2_list_groups' || args.groupId === '*'
      ? Promise.resolve([]) : oldResponse.promise);
    const pending = api.useSessionListStore.getState().refresh();
    api.useSessionListStore.getState().setSnapshot([session('one', { title: 'Snapshot' })], true);
    api.useSessionListStore.getState().setSessions((rows) => rows.map((row) => ({
      ...row, title: 'Renamed', titleLocked: true, metadata: { workspaceId: 'new-workspace' },
    })));
    const current = api.useSessionListStore.getState().sessions;
    oldResponse.resolve([session('one', { title: 'Old response' })]);
    await pending;
    expect(api.useSessionListStore.getState().sessions).toBe(current);
    expect(api.useSessionListStore.getState().hasMoreUngrouped).toBe(true);
  });

  it('keeps an initial total failure retryable and exposes the error to the page', async () => {
    invokeMock.mockRejectedValue(new Error('offline'));
    retain();
    await expect(api.useSessionListStore.getState().ensureLoaded()).rejects.toThrow('Failed to load');
    expect(api.useSessionListStore.getState().isLoaded).toBe(false);
    expect(api.useSessionListStore.getState().sessions).toEqual([]);
    respond([session('recovered')]);
    await api.useSessionListStore.getState().ensureLoaded();
    expect(api.useSessionListStore.getState().isLoaded).toBe(true);
    expect(api.useSessionListStore.getState().sessions[0].id).toBe('recovered');
    expect(sessionCalls()).toHaveLength(4);
  });

  it('refreshes cascaded sessions when a group mutation is broadcast', async () => {
    respond([session('one', { groupId: 'group-1' })], [group()]);
    retain();
    await api.useSessionListStore.getState().ensureLoaded();
    respond([], []);
    window.dispatchEvent(new Event('chat-v2:groups-updated'));
    await vi.advanceTimersByTimeAsync(120);
    expect(api.useSessionListStore.getState().sessions).toEqual([]);
    expect(api.useSessionListStore.getState().groups).toEqual([]);
    expect(sessionCalls()).toHaveLength(4);
  });
});
