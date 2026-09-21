import * as React from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FullDocumentApi } from './fullDocument';

const native = vi.hoisted(() => ({
  values: new Map<string, string>(), invoke: vi.fn(), notify: vi.fn(), copy: vi.fn(async () => true),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: native.notify }));
vi.mock('@/utils/clipboardUtils', () => ({ copyTextToClipboard: native.copy }));
vi.mock('@/i18n', () => ({ default: { t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key } }));

const original = 'one\r\n\r\nkeep  \r\n\r\ntwo\r\n\r\n';
const candidate = original.replace('one', 'ONE').replace('two', 'TWO');
const request = (requestId = 'old-request', noteId = 'n1') => ({ requestId, noteId, operation: 'set' as const, content: candidate, targetWindowId: 'old-window' });
function editor(markdown = original, noteId = 'n1') {
  const state = { markdown, revision: 100 };
  const api = {
    getFullDocument: () => ({ noteId, revision: state.revision, markdown: state.markdown }),
    getFullMarkdown: () => state.markdown, getMarkdown: () => state.markdown,
    isReadonly: () => false, flushPendingSave: vi.fn(async () => {}),
    replaceFullDocument: vi.fn(async (content, baseline) => {
      expect(baseline).toEqual({ noteId, revision: state.revision, markdown: state.markdown });
      state.markdown = content; state.revision++; return { noteId, revision: state.revision, markdown: state.markdown };
    }),
  } as unknown as FullDocumentApi;
  return { api, state };
}
const storage = async (command: string, args: { key?: string; value?: string }) => {
  if (command === 'get_setting') return native.values.get(args.key!) ?? null;
  if (command === 'save_setting') { native.values.set(args.key!, args.value!); return; }
  if (command === 'delete_setting') return native.values.delete(args.key!);
  return null;
};
async function modules() {
  return {
    model: await import('./aiReviewModel'),
    persistence: await import('./aiReviewPersistence'),
    hook: await import('./aiReview'),
  };
}
async function restart() {
  vi.resetModules(); // native.values is the real mock database, outside the module cache
  return modules();
}
async function seed(windowId = 'old-window', noteId = 'n1') {
  const { model, persistence } = await modules();
  let session = model.createAIReviewSession(request(`old-${windowId}`, noteId), { noteId, revision: 7, markdown: original }, candidate);
  session.persistenceId = persistence.newAIReviewPersistenceId();
  const changed = session.groups.filter((group) => group.changed);
  session = model.decideAIReviewGroup(session, changed[0].id, 'accept');
  session = model.decideAIReviewGroup(session, changed[1].id, 'reject');
  session.collapsed = true;
  await persistence.persistAIReviewSession(session, windowId);
  return session;
}
const writes = (suffix: string) => native.invoke.mock.calls.filter(([command, args]) => command === 'save_setting' && args.key.endsWith(suffix));

beforeEach(() => {
  cleanup(); vi.resetModules();
  // Hook modules and the already-imported renderer must share the same React dispatcher.
  vi.doMock('react', () => React);
  native.values.clear(); native.invoke.mockReset(); native.invoke.mockImplementation(storage);
  native.notify.mockClear(); native.copy.mockClear();
});
afterEach(cleanup);

describe('AI review settings persistence and restart', () => {
  it('restores baseline/decisions/collapse into a changed window id and never replays old RPCs', async () => {
    const saved = await seed();
    const bodyRaw = [...native.values].find(([key]) => key.endsWith('.body'))![1];
    expect(bodyRaw).not.toContain('targetWindowId');
    const { hook } = await restart();
    native.invoke.mockClear();
    const { api, state } = editor();
    const { result } = renderHook(() => hook.useAIReview({ noteId: 'n1', windowId: 'new-window', editorApi: api }));
    await waitFor(() => expect(result.current.persistenceStatus).toBe('saved'));
    expect(result.current.session?.restored).toBe(true);
    expect(result.current.session?.persistenceId).toBe(saved.persistenceId);
    expect(result.current.session?.collapsed).toBe(true);
    expect(result.current.session?.baseline.revision).toBe(100);
    expect(result.current.session?.groups.filter((group) => group.changed).map((group) => group.decision)).toEqual(['accept', 'reject']);
    expect(writes('.body')).toHaveLength(0);
    await act(async () => result.current.handleAccept());
    expect(state.markdown).toBe(original.replace('one', 'ONE'));
    expect(result.current.session).toBeNull();
    expect(native.invoke.mock.calls.some(([command]) => command.startsWith('chat_v2_canvas'))).toBe(false);
    const next = await restart();
    expect((await next.persistence.loadPersistedAIReview('n1', 'another-window')).session).toBeNull();
  });

  it('serializes an allowlisted request without callbacks, even when runtime request objects contain them', async () => {
    const { model, persistence } = await modules();
    const onSettled = vi.fn(), onLocalDisposition = vi.fn();
    const session = model.createAIReviewSession({ ...request(), onSettled, onLocalDisposition } as any,
      { noteId: 'n1', revision: 1, markdown: original }, candidate);
    session.persistenceId = persistence.newAIReviewPersistenceId();
    await persistence.persistAIReviewSession(session, 'old-window');
    const stored = JSON.parse([...native.values].find(([key]) => key.endsWith('.body'))![1]);
    expect(Object.keys(stored.request).sort()).toEqual(['content', 'noteId', 'operation', 'requestId']);
    const next = await restart();
    const recovered = await next.persistence.loadPersistedAIReview('n1', 'new-window');
    expect((recovered.session?.request as any).onSettled).toBeUndefined();
    expect(onSettled).not.toHaveBeenCalled(); expect(onLocalDisposition).not.toHaveBeenCalled();
  });

  it('marks a changed baseline as a conflict, preserves decisions, and refuses application', async () => {
    await seed();
    const { hook } = await restart();
    const { api, state } = editor('edited after restart');
    const { result } = renderHook(() => hook.useAIReview({ noteId: 'n1', windowId: 'new-window', editorApi: api }));
    await waitFor(() => expect(result.current.persistenceStatus).toBe('saved'));
    expect(result.current.session?.conflict).toBe(true);
    expect(result.current.session?.collapsed).toBe(false);
    expect(result.current.session?.error).toContain('笔记版本已变化');
    await act(async () => result.current.handleAccept());
    expect(api.replaceFullDocument).not.toHaveBeenCalled();
    expect(state.markdown).toBe('edited after restart');
    await act(async () => result.current.copyCandidate());
    expect(native.copy).toHaveBeenCalledWith(candidate);
  });

  it('does not let slow hydration replace a newly arrived request or its persisted candidate', async () => {
    await seed();
    const { hook } = await restart();
    let release!: () => void;
    let blocked = false;
    native.invoke.mockImplementation(async (command, args) => {
      if (!blocked && command === 'get_setting' && args.key.endsWith('.index')) {
        blocked = true;
        const snapshot = native.values.get(args.key) ?? null;
        await new Promise<void>((resolve) => { release = resolve; });
        return snapshot;
      }
      return storage(command, args);
    });
    const { api } = editor();
    const { result } = renderHook(() => hook.useAIReview({ noteId: 'n1', windowId: 'new-window', editorApi: api }));
    await waitFor(() => expect(blocked).toBe(true));
    act(() => window.dispatchEvent(new CustomEvent('canvas:ai-edit-request', { detail: {
      ...request('live-request'), targetWindowId: 'new-window', content: 'fresh candidate',
    } })));
    expect(result.current.session?.request.requestId).toBe('live-request');
    await act(async () => release());
    await waitFor(() => expect(result.current.persistenceStatus).toBe('saved'));
    expect(result.current.session?.candidate).toBe('fresh candidate');
    expect(result.current.session?.restored).not.toBe(true);
    expect([...native.values].filter(([key]) => key.endsWith('.body'))).toHaveLength(2);
  });

  it('requires an explicit choice for multiple old window candidates and claims only one', async () => {
    const first = await seed('window-one');
    await seed('window-two');
    const { hook } = await restart();
    const { api } = editor();
    const { result } = renderHook(() => hook.useAIReview({ noteId: 'n1', windowId: 'new-window', editorApi: api }));
    await waitFor(() => expect(result.current.recoveryOptions).toHaveLength(2));
    expect(result.current.session).toBeNull();
    expect(result.current.persistenceError).toContain('多个旧窗口');
    await act(async () => result.current.restoreCandidate(first.persistenceId));
    expect(result.current.session?.persistenceId).toBe(first.persistenceId);
    expect(result.current.persistenceStatus).toBe('saved');
  });

  it('does not hydrate an old record after a new request has already been explicitly discarded', async () => {
    await seed();
    const { hook } = await restart();
    let release!: () => void;
    let blocked = false;
    native.invoke.mockImplementation(async (command, args) => {
      if (!blocked && command === 'get_setting' && args.key.endsWith('.index')) {
        blocked = true;
        await new Promise<void>((resolve) => { release = resolve; });
      }
      return storage(command, args);
    });
    const { api } = editor();
    const view = renderHook(() => hook.useAIReview({ noteId: 'n1', windowId: 'new-window', editorApi: api }));
    await waitFor(() => expect(blocked).toBe(true));
    act(() => window.dispatchEvent(new CustomEvent('canvas:ai-edit-request', { detail: { ...request('live'), targetWindowId: 'new-window' } })));
    let discarded!: Promise<void>;
    act(() => { discarded = view.result.current.handleReject(); });
    await act(async () => { release(); await discarded; });
    expect(view.result.current.session).toBeNull();
    expect(native.invoke.mock.calls.filter(([command]) => command === 'chat_v2_canvas_edit_result')).toHaveLength(1);
    // The ignored recovery record was not silently deleted when the new request settled.
    expect([...native.values.keys()].filter((key) => key.endsWith('.body'))).toHaveLength(1);
  });

  it('does not recover an active same-process candidate into a different scope or different note', async () => {
    await seed('active-window');
    const { persistence } = await modules();
    expect((await persistence.loadPersistedAIReview('n1', 'other-window')).session).toBeNull();
    expect((await persistence.loadPersistedAIReview('n2', 'active-window')).session).toBeNull();
  });

  it('surfaces failed writes and reads, and only reports saved after a successful retry', async () => {
    const { hook } = await modules();
    native.invoke.mockImplementation(async (command, args) => {
      if (command === 'save_setting') throw new Error('disk unavailable');
      return storage(command, args);
    });
    const { api } = editor();
    const { result, unmount } = renderHook(() => hook.useAIReview({ noteId: 'n1', windowId: 'old-window', editorApi: api }));
    act(() => window.dispatchEvent(new CustomEvent('canvas:ai-edit-request', { detail: request() })));
    await waitFor(() => expect(result.current.persistenceStatus).toBe('error'));
    expect(result.current.session?.error).toContain('尚未持久化');
    expect(native.values.size).toBe(0);
    native.invoke.mockImplementation(storage);
    await act(async () => result.current.retryPersistence());
    expect(result.current.persistenceStatus).toBe('saved');
    unmount();
    const restarted = await restart();
    const storedBefore = new Map(native.values);
    native.invoke.mockImplementation(async () => { throw new Error('IPC unavailable'); });
    const next = renderHook(() => restarted.hook.useAIReview({ noteId: 'n1', windowId: 'new-window', editorApi: api }));
    await waitFor(() => expect(next.result.current.persistenceStatus).toBe('error'));
    expect(next.result.current.session).toBeNull();
    expect(native.notify).toHaveBeenCalledWith('error', expect.stringContaining('无法读取'));
    expect(native.values).toEqual(storedBefore);
    native.invoke.mockImplementation(storage);
    await act(async () => next.result.current.retryPersistence());
    expect(next.result.current.session?.candidate).toBe(candidate);
  });

  it('does not rewrite bodies for typing, collapse no-ops or repeated identical decisions', async () => {
    const { hook } = await modules();
    const { api, state } = editor();
    const view = renderHook(() => hook.useAIReview({ noteId: 'n1', windowId: 'old-window', editorApi: api }));
    act(() => window.dispatchEvent(new CustomEvent('canvas:ai-edit-request', { detail: request() })));
    await waitFor(() => expect(view.result.current.persistenceStatus).toBe('saved'));
    expect(writes('.body')).toHaveLength(1);
    expect(writes('.state')).toHaveLength(1);
    for (let i = 0; i < 5; i++) { state.markdown += 'a'; state.revision++; view.rerender(); }
    expect(writes('.state')).toHaveLength(1);
    act(() => { view.result.current.setCollapsed(true); view.result.current.setCollapsed(true); });
    await waitFor(() => expect(view.result.current.persistenceStatus).toBe('saved'));
    const group = view.result.current.session!.groups.find((entry) => entry.changed)!;
    act(() => { view.result.current.decideGroup(group.id, 'reject'); view.result.current.decideGroup(group.id, 'reject'); });
    await waitFor(() => expect(view.result.current.persistenceStatus).toBe('saved'));
    expect(writes('.state')).toHaveLength(3);
    expect(writes('.body')).toHaveLength(1);
    expect(writes('.index')).toHaveLength(1);
  });

  it('retries an interrupted registration without rewriting the candidate body', async () => {
    const { hook } = await modules();
    native.invoke.mockImplementation(async (command, args) => {
      if (command === 'save_setting' && args.key.endsWith('.index')) throw new Error('index locked');
      return storage(command, args);
    });
    const { api } = editor();
    const view = renderHook(() => hook.useAIReview({ noteId: 'n1', windowId: 'old-window', editorApi: api }));
    act(() => window.dispatchEvent(new CustomEvent('canvas:ai-edit-request', { detail: request() })));
    await waitFor(() => expect(view.result.current.persistenceStatus).toBe('error'));
    expect(writes('.body')).toHaveLength(1);
    view.unmount();
    native.invoke.mockImplementation(storage);
    const remount = renderHook(() => hook.useAIReview({ noteId: 'n1', windowId: 'old-window', editorApi: api }));
    await waitFor(() => expect(remount.result.current.persistenceStatus).toBe('saved'));
    expect(writes('.body')).toHaveLength(1);
    const next = await restart();
    expect((await next.persistence.loadPersistedAIReview('n1', 'new-window')).session?.candidate).toBe(candidate);
  });

  it('leaves corrupt or wrong-note records untouched and surfaces the read failure', async () => {
    await seed();
    const [key, value] = [...native.values].find(([entry]) => entry.endsWith('.body'))!;
    const body = JSON.parse(value); body.baseline.noteId = 'different-note';
    native.values.set(key, JSON.stringify(body));
    const before = new Map(native.values);
    const { hook } = await restart();
    native.invoke.mockClear();
    const { api } = editor();
    const view = renderHook(() => hook.useAIReview({ noteId: 'n1', windowId: 'new-window', editorApi: api }));
    await waitFor(() => expect(view.result.current.persistenceStatus).toBe('error'));
    expect(view.result.current.session).toBeNull();
    expect(view.result.current.persistenceError).toContain('原数据未改动');
    expect(native.values).toEqual(before);
    expect(native.invoke.mock.calls.some(([command]) => command === 'save_setting')).toBe(false);
  });

  it('a failed terminal cleanup remains retryable and cannot resurrect after a restart', async () => {
    await seed();
    const { hook } = await restart();
    const { api } = editor();
    const view = renderHook(() => hook.useAIReview({ noteId: 'n1', windowId: 'new-window', editorApi: api }));
    await waitFor(() => expect(view.result.current.persistenceStatus).toBe('saved'));
    native.invoke.mockImplementation(async (command, args) => {
      if (command === 'save_setting' && args.key.endsWith('.index')) throw new Error('index locked');
      return storage(command, args);
    });
    await act(async () => view.result.current.handleReject());
    expect(view.result.current.persistenceStatus).toBe('error');
    expect(view.result.current.session?.resolution).toBe('discarded');
    view.unmount();
    native.invoke.mockImplementation(storage);
    const next = await restart();
    const recovered = await next.persistence.loadPersistedAIReview('n1', 'another-window');
    expect(recovered.session).toBeNull();
    expect(recovered.options).toEqual([]);
  });

  it('serializes choices per note but lets a different note persist during a blocked write', async () => {
    const { persistence, model } = await modules();
    const make = (noteId: string) => ({ ...model.createAIReviewSession(request(noteId, noteId), { noteId, revision: 1, markdown: original }, candidate), persistenceId: persistence.newAIReviewPersistenceId() });
    const one = make('n1'), two = make('n2');
    let release!: () => void;
    native.invoke.mockImplementation(async (command, args) => {
      if (command === 'save_setting' && args.key.includes('.n1.') && args.key.endsWith('.body')) await new Promise<void>((resolve) => { release = resolve; });
      return storage(command, args);
    });
    const first = persistence.persistAIReviewSession(one, 'w1');
    const second = persistence.persistAIReviewSession({ ...one, collapsed: true }, 'w1');
    await persistence.persistAIReviewSession(two, 'w2');
    expect([...native.values.keys()].some((key) => key.includes('.n2.') && key.endsWith('.index'))).toBe(true);
    release(); await Promise.all([first, second]);
    const result = await persistence.loadPersistedAIReview('n1', 'w1');
    expect(result.session?.collapsed).toBe(true);
    expect(writes('.body')).toHaveLength(2);
  });
});
