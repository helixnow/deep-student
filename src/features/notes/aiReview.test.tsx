import React from 'react';
import { act, fireEvent, render, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrepeEditorApi } from '@/components/crepe';
import { createFullDocumentApi } from './fullDocument';
import { aiReviewSessionKey, composeAIReview, createAIReviewSession, decideAIReviewGroup, readAIReviewSession, storeAIReviewSession } from './aiReviewModel';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(async () => null), copy: vi.fn(async () => true) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('@/i18n', async () => {
  const { default: notes } = await import('@/locales/zh-CN/notes.json');
  return { default: { t: (key: string, options?: { defaultValue?: string }) => {
    const value = key.replace(/^notes:/, '').split('.').reduce<unknown>((node, part) =>
      node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined, notes);
    return typeof value === 'string' ? value : options?.defaultValue ?? key;
  } } };
});
vi.mock('@/utils/clipboardUtils', () => ({ copyTextToClipboard: mocks.copy }));
vi.mock('@/features/generative-ui/components/GenerativeUIPanel', () => ({ GenerativeUIPanel: () => null }));
vi.mock('@/components/custom-scroll-area', () => ({ CustomScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import { projectAIReviewCandidate, useAIReview } from './aiReview';
import { AIDiffPanel } from './AIDiffPanel';

const original = 'one\r\n\r\nkeep  \r\n\r\ntwo\r\n\r\n';
const candidate = 'ONE\r\n\r\nkeep  \r\n\r\nTWO\r\n\r\n';
function editorFixture(initial = original, noteId = 'n1') {
  const state = { markdown: initial, revision: 1, current: true };
  const flush = vi.fn(async () => {});
  const replace = vi.fn(async (markdown: string) => { state.markdown = markdown; state.revision++; await flush(); return true; });
  const api = createFullDocumentApi({
    getMarkdown: () => state.markdown, getFullMarkdown: () => state.markdown,
    replaceFullMarkdown: replace, flushPendingSave: flush, isReadonly: () => false,
  } as unknown as CrepeEditorApi, {
    noteId, isCurrent: () => state.current, revision: () => state.revision, isWindowed: () => false, retainFailure: vi.fn(),
  });
  return { api, state, flush, replace };
}
const request = (content = candidate) => ({ requestId: 'r1', noteId: 'n1', operation: 'set' as const, content });
const send = (content = candidate) => act(() => {
  window.dispatchEvent(new CustomEvent('canvas:ai-edit-request', { detail: request(content) }));
});

beforeEach(() => {
  storeAIReviewSession(aiReviewSessionKey('n1'), null);
  storeAIReviewSession(aiReviewSessionKey('n2'), null);
  vi.clearAllMocks();
});

describe('AI grouped candidate content', () => {
  it('partially accepts exact raw chunks, including CRLF and trailing blank lines', () => {
    let session = createAIReviewSession(request(), { noteId: 'n1', revision: 1, markdown: original }, candidate);
    const changes = session.groups.filter((group) => group.changed);
    expect(changes).toHaveLength(2);
    session = decideAIReviewGroup(session, changes[0].id, 'accept');
    session = decideAIReviewGroup(session, changes[1].id, 'reject');
    expect(composeAIReview(session, true)).toBe(original.replace('one', 'ONE'));
  });

  it.each(['```js\nx\n```\n', '| a | b |\n|---|---|\n| x | y |\n', '- item\n', '$$\nx\n$$\n', '<div>html</div>', '[[Note]]'])('keeps complex nodes atomic: %s', (markdown) => {
    const session = createAIReviewSession(request(), { noteId: 'n1', revision: 1, markdown }, markdown + 'extra\n');
    expect(session.wholeDocument).toBe(true);
    expect(session.groups).toHaveLength(1);
    expect(composeAIReview(session)).toBe(markdown);
    expect(composeAIReview(session, true)).toBe(markdown + 'extra\n');
  });

  it('append preserves author whitespace and retains the entire oversized proposal', () => {
    expect(projectAIReviewCandidate({ ...request('next'), operation: 'append' }, 'text  \n\n\n').content).toBe('text  \n\n\nnext');
    const content = '中'.repeat(350000);
    const projection = projectAIReviewCandidate(request(content), 'before');
    expect(projection.error).toContain('UTF-8');
    expect(projection.content).toBe(content);
  });
});

describe('AI review product controller', () => {
  it('persists only selected groups and checkpoints the actual result', async () => {
    const { api, state } = editorFixture();
    const { result } = renderHook(() => useAIReview({ noteId: 'n1', editorApi: api }));
    send();
    const first = result.current.session!.groups.find((group) => group.changed)!;
    act(() => result.current.decideGroup(first.id, 'accept'));
    await act(async () => result.current.handleAccept(false));
    expect(state.markdown).toBe(original.replace('one', 'ONE'));
    expect(result.current.checkpoint?.resultContent).toBe(state.markdown);
    expect(result.current.session).toBeNull();
    await act(async () => result.current.rollbackCheckpoint());
    expect(state.markdown).toBe(original);
  });

  it('collapse + unmount + reopen retains candidate and group decisions without rejection', () => {
    const { api } = editorFixture();
    const first = renderHook(() => useAIReview({ noteId: 'n1', editorApi: api }));
    send();
    const change = first.result.current.session!.groups.find((group) => group.changed)!;
    act(() => { first.result.current.decideGroup(change.id, 'reject'); first.result.current.setCollapsed(true); });
    first.unmount();
    expect(mocks.invoke.mock.calls.some(([name]) => name === 'chat_v2_canvas_edit_result')).toBe(false);
    const second = renderHook(() => useAIReview({ noteId: 'n1', editorApi: api }));
    expect(second.result.current.session?.collapsed).toBe(true);
    expect(second.result.current.session?.groups.find((group) => group.id === change.id)?.decision).toBe('reject');
    act(() => second.result.current.setCollapsed(false));
    expect(second.result.current.session?.candidate).toBe(candidate);
  });

  it('blocks old baseline and preserves the new user edit, with candidate available for copy', async () => {
    const { api, state, replace } = editorFixture();
    const { result } = renderHook(() => useAIReview({ noteId: 'n1', editorApi: api }));
    send();
    state.markdown = 'new user edit'; state.revision++;
    await act(async () => result.current.handleAccept());
    expect(replace).not.toHaveBeenCalled();
    expect(state.markdown).toBe('new user edit');
    expect(result.current.session?.error).toContain('笔记已变化');
    await act(async () => result.current.copyCandidate());
    expect(mocks.copy).toHaveBeenCalledWith(candidate);
  });

  it('does not apply an old suggestion into a different note', async () => {
    const first = editorFixture();
    const second = editorFixture('second', 'n2');
    const { result, rerender } = renderHook(({ noteId, api }) => useAIReview({ noteId, editorApi: api }), { initialProps: { noteId: 'n1', api: first.api } });
    send();
    rerender({ noteId: 'n2', api: second.api });
    await act(async () => result.current.handleAccept());
    expect(second.state.markdown).toBe('second');
    expect(readAIReviewSession(aiReviewSessionKey('n1'))?.candidate).toBe(candidate);
  });

  it('failed partial save retains candidate and retries persistence without applying twice', async () => {
    const { api, flush, replace, state } = editorFixture();
    flush.mockRejectedValueOnce(new Error('disk unavailable'));
    const { result } = renderHook(() => useAIReview({ noteId: 'n1', editorApi: api }));
    send();
    act(() => result.current.decideGroup(result.current.session!.groups.find((group) => group.changed)!.id, 'accept'));
    await act(async () => result.current.handleAccept(false));
    expect(result.current.session?.error).toBe('disk unavailable');
    expect(result.current.session?.retryBaseline?.markdown).toBe(original.replace('one', 'ONE'));
    await act(async () => result.current.handleAccept());
    expect(replace).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledTimes(2);
    expect(state.markdown).toBe(original.replace('one', 'ONE'));
    expect(result.current.session).toBeNull();
  });

  it('a save finishing after navigation cannot settle the new note or erase the old candidate', async () => {
    const first = editorFixture();
    const second = editorFixture('second', 'n2');
    let finish!: () => void;
    first.flush.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { result, rerender } = renderHook(({ noteId, api }) => useAIReview({ noteId, editorApi: api }), { initialProps: { noteId: 'n1', api: first.api } });
    send();
    let saving!: Promise<void>;
    act(() => { saving = result.current.handleAccept(); });
    first.state.current = false;
    rerender({ noteId: 'n2', api: second.api });
    await act(async () => { finish(); await saving; });
    expect(second.state.markdown).toBe('second');
    expect(result.current.session).toBeNull();
    expect(readAIReviewSession(aiReviewSessionKey('n1'))?.candidate).toBe(candidate);
    expect(mocks.invoke.mock.calls.some(([name, payload]) => name === 'chat_v2_canvas_edit_result' && (payload as any).result.success)).toBe(false);
  });

  it('oversized AI output remains copyable without mutating the note', async () => {
    const { api, state, replace } = editorFixture();
    const { result } = renderHook(() => useAIReview({ noteId: 'n1', editorApi: api }));
    const large = '中'.repeat(350000);
    send(large);
    await act(async () => result.current.handleAccept());
    expect(replace).not.toHaveBeenCalled();
    expect(state.markdown).toBe(original);
    expect(result.current.session?.candidate).toBe(large);
    await act(async () => result.current.copyCandidate());
    expect(mocks.copy).toHaveBeenCalledWith(large);
  });
});

describe('AI panel Escape semantics', () => {
  it('Escape suspends, explicit discard rejects, and IME shortcuts do nothing', () => {
    const onAccept = vi.fn(), onReject = vi.fn(), onSuspend = vi.fn();
    const view = render(<AIDiffPanel state={{ isActive: true, request: request(), originalContent: original, proposedContent: candidate, diffLines: [] }}
      onAccept={onAccept} onReject={onReject} onSuspend={onSuspend} />);
    fireEvent.keyDown(window, { key: 'Escape', isComposing: true });
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true, keyCode: 229 });
    expect(onSuspend).not.toHaveBeenCalled(); expect(onAccept).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onSuspend).toHaveBeenCalledOnce(); expect(onReject).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole('button', { name: '丢弃建议' }));
    expect(onReject).toHaveBeenCalledOnce();
  });
});
