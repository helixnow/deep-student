import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';
import type { FullDocumentApi } from './fullDocument';
import { FullDocumentSaveError } from './fullDocument';
import { aiReviewSessionKey, createAIReviewSession, readAIReviewSession, storeAIReviewSession } from './aiReviewModel';
import { createOfficialDiffAdapter } from '@/components/crepe/officialDiffAdapter';
import { scopeAIReviewCandidate, type AIReviewRequest } from './officialDiffContract';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), copy: vi.fn(async () => true), rows: new Map<string, any>() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('@/utils/clipboardUtils', () => ({ copyTextToClipboard: mocks.copy }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('@/features/generative-ui/components/GenerativeUIPanel', () => ({ GenerativeUIPanel: () => null }));
vi.mock('@/components/custom-scroll-area', () => ({ CustomScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
import { projectAIReviewCandidate, useAIReview } from './aiReview';
import { AIDiffPanel } from './AIDiffPanel';

const original = 'Old.\n\nAnchor.\n\nCold.\n';
const candidate = 'New.\n\nAnchor.\n\nWarm.\n';
const request = (content = candidate): AIReviewRequest => ({ requestId: 'r1', noteId: 'n1', operation: 'set', content });
const disposers: Array<() => Promise<void>> = [];
beforeAll(async () => { await i18next.init({ lng: 'zh-CN', resources: {} }); });
beforeEach(() => {
  storeAIReviewSession(aiReviewSessionKey('n1'), null); storeAIReviewSession(aiReviewSessionKey('n2'), null);
  mocks.rows.clear(); mocks.invoke.mockReset().mockImplementation(async (command, args) => {
    if (!command.startsWith('notes_state_')) return null;
    const r = args.request;
    if (command === 'notes_state_list') return [...mocks.rows.values()].filter(row => row.note_id === r.note_id && !row.deleted);
    const old = mocks.rows.get(r.key);
    if (command === 'notes_state_get') return old ?? null;
    if (r.expected_revision !== (old?.revision ?? null)) throw new Error('notes.state_conflict');
    const row = { ...r, revision: (old?.revision ?? 0) + 1, deleted: command === 'notes_state_delete' };
    mocks.rows.set(r.key, structuredClone(row)); return row;
  });
});
afterEach(async () => { cleanup(); for (const dispose of disposers.splice(0)) await dispose(); });
function editor(markdown = original, noteId = 'n1') {
  const state = { markdown, revision: 1, readonly: false };
  const snapshot = () => ({ markdown: state.markdown, revision: state.revision, noteId });
  const flush = vi.fn(async () => {});
  const replace = vi.fn(async (text: string, baseline: ReturnType<typeof snapshot>) => {
    expect(snapshot()).toEqual(baseline);
    if (state.readonly) throw new Error('readonly');
    state.markdown = text; state.revision++;
    try { await flush(); } catch (error) { throw new FullDocumentSaveError(error, snapshot()); }
    return snapshot();
  });
  const api = { getFullDocument: snapshot, getFullMarkdown: () => state.markdown, isReadonly: () => state.readonly,
    replaceFullDocument: replace, flushPendingSave: flush } as unknown as FullDocumentApi;
  return { state, api, replace, flush };
}
async function setup(host?: Parameters<typeof useAIReview>[0]['host']) {
  const body = editor();
  const hook = renderHook(() => useAIReview({ noteId: 'n1', editorApi: body.api, host }));
  await act(async () => { await hook.result.current.submitReview(request()); });
  const root = document.createElement('div'); document.body.append(root);
  let adapter!: Awaited<ReturnType<typeof createOfficialDiffAdapter>>;
  await act(async () => {
    adapter = await createOfficialDiffAdapter({ root, baseline: original, target: candidate,
      onDecision: d => hook.result.current.officialReviewProps.onReviewDecision(d),
      onError: error => hook.result.current.officialReviewProps.onReviewError(error),
    });
    hook.result.current.officialReviewProps.onReviewReady(adapter);
  });
  disposers.push(async () => { await adapter.destroy(); root.remove(); });
  const click = async (action: 'accept' | 'reject', index = 0) => {
    let failure: unknown;
    await act(async () => {
      root.querySelectorAll<HTMLButtonElement>(`.milkdown-diff-${action}`)[index].click();
      try { await adapter.whenIdle(); } catch (error) { failure = error; }
    });
    if (failure) throw failure;
  };
  return { ...body, ...hook, adapter, click };
}
describe('official per-group host commit', () => {
  it('uses the coordinated host commit for accepted groups and keeps decisions pending on lease failure', async () => {
    // The host receives applyDocument before the hook result exists, so the
    // implementation is wired through a holder once `f` is available.
    const commitRef: { current?: (text: string) => ReturnType<FullDocumentApi['getFullDocument']> } = {};
    const applyDocument = vi.fn(async (text: string) => commitRef.current!(text));
    const f = await setup({ applyDocument });
    commitRef.current = text => { f.state.markdown = text; f.state.revision++; return f.api.getFullDocument(); };
    applyDocument.mockRejectedValueOnce(new Error('remote draft conflict'));
    await expect(f.click('accept')).rejects.toThrow('remote draft conflict');
    expect(f.state.markdown).toBe(original);
    await f.click('accept');
    expect(f.state.markdown).toBe(original.replace('Old.', 'New.'));
    expect(f.replace).not.toHaveBeenCalled();
    expect(f.result.current.checkpoint?.resultContent).toBe(f.state.markdown);
  });
  it('accept immediately saves real full content with a checkpoint, retaining pending candidate and decisions', async () => {
    const f = await setup(); await f.click('accept');
    expect(f.state.markdown).toBe(original.replace('Old.', 'New.'));
    expect(f.replace).toHaveBeenCalledOnce();
    expect(f.result.current.checkpoint?.resultContent).toBe(f.state.markdown);
    expect(f.result.current.session?.candidate).toBe(candidate);
    expect(f.result.current.session?.accepted).toHaveLength(1);
    expect(f.result.current.session?.decisions).toHaveLength(1);
    expect(f.adapter.pending()).toHaveLength(1);
    await f.click('reject'); expect(f.result.current.session).toBeNull();
    await act(async () => f.result.current.rollbackCheckpoint()); expect(f.state.markdown).toBe(original);
  });
  it('rejects a group without changing the body and accept-all respects that rejection', async () => {
    const f = await setup(); await f.click('reject'); expect(f.replace).not.toHaveBeenCalled();
    await act(async () => f.result.current.handleAccept());
    expect(f.state.markdown).toBe(original.replace('Cold.', 'Warm.'));
    expect(f.result.current.session).toBeNull();
  });
  it('blocks external updates using full revision/content, keeps candidate copyable', async () => {
    const f = await setup(); f.state.markdown = 'External.'; f.state.revision++;
    await expect(f.click('accept')).rejects.toThrow();
    expect(f.replace).not.toHaveBeenCalled(); expect(f.state.markdown).toBe('External.');
    expect(f.result.current.session?.candidate).toBe(candidate);
    await act(async () => f.result.current.copyCandidate()); expect(mocks.copy).toHaveBeenCalledWith(candidate);
  });
  it('failed group persistence retries the same body save without applying twice or accepting the rest', async () => {
    const f = await setup(); f.flush.mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(f.click('accept')).rejects.toThrow('disk unavailable');
    await waitFor(() => expect(f.result.current.session?.retryBaseline).toBeDefined());
    expect(f.result.current.session?.accepted).toHaveLength(0);
    await act(async () => f.result.current.handleAccept());
    expect(f.replace).toHaveBeenCalledTimes(1); expect(f.flush).toHaveBeenCalledTimes(2);
    expect(f.result.current.session?.accepted).toHaveLength(1);
    expect(f.result.current.session?.target).toContain('Warm.');
    expect(f.state.markdown).toBe(original.replace('Old.', 'New.'));
  });
  it('suspend releases the lease; edits while suspended become explicit conflicts on reopen', async () => {
    const release = vi.fn(), acquire = vi.fn(() => release);
    const f = await setup({ acquireReviewLease: acquire });
    expect(acquire).toHaveBeenCalledOnce();
    act(() => f.result.current.setCollapsed(true)); expect(release).toHaveBeenCalledOnce();
    f.state.markdown = 'Typing after suspend.'; f.state.revision++;
    act(() => f.result.current.setCollapsed(false));
    expect(f.result.current.session?.conflict).toBe(true);
    expect(f.result.current.session?.candidate).toBe(candidate);
    expect(f.replace).not.toHaveBeenCalled();
  });
  it('unmount releases lease without discarding decisions; remount refreshes the complete baseline', async () => {
    const release = vi.fn(); const f = await setup({ acquireReviewLease: () => release });
    await f.click('reject'); f.unmount(); expect(release).toHaveBeenCalledOnce();
    const next = renderHook(() => useAIReview({ noteId: 'n1', editorApi: f.api }));
    expect(next.result.current.session?.decisions[0].action).toBe('reject');
    expect(next.result.current.session?.target).not.toContain('New.');
  });
  it('does not let candidate state IO failure reach the live body', async () => {
    const f = await setup(); mocks.invoke.mockRejectedValueOnce(new Error('state disk unavailable'));
    await expect(f.click('accept')).rejects.toThrow('尚未保存');
    expect(f.replace).not.toHaveBeenCalled(); expect(f.state.markdown).toBe(original);
  });
  it('advances the confirmed group even if final state persistence fails, then retries state without replaying the body', async () => {
    const f = await setup();
    const storage = mocks.invoke.getMockImplementation()!;
    let failed = false;
    mocks.invoke.mockImplementation(async (command, args) => {
      if (!failed && command === 'notes_state_put' && args.request.value.session.decisions.length === 1
        && !args.request.value.session.retryDecision) { failed = true; throw new Error('state confirm IO'); }
      return storage(command, args);
    });
    await f.click('accept');
    expect(f.state.markdown).toBe(original.replace('Old.', 'New.'));
    expect(f.adapter.pending()).toHaveLength(1);
    expect(f.result.current.persistenceStatus).toBe('error');
    await act(async () => f.result.current.retryPersistence());
    expect(f.replace).toHaveBeenCalledTimes(1);
    await f.click('accept'); expect(f.state.markdown).toBe(candidate);
  });
  it('rolls back an accepted checkpoint while retaining the other pending review', async () => {
    const f = await setup(); await f.click('accept');
    await act(async () => f.result.current.rollbackCheckpoint());
    expect(f.state.markdown).toBe(original);
    expect(f.result.current.session?.baseline.markdown).toBe(original);
    expect(f.result.current.session?.accepted).toHaveLength(0);
    expect(f.result.current.session?.generation).toBe(1);
    expect(f.result.current.session?.target).toBe(candidate);
  });
  it('hydrates accepted checkpoints and rejections from the table when the renderer memory is gone', async () => {
    const f = await setup(); await f.click('accept');
    const id = f.result.current.session!.persistenceId;
    f.unmount(); storeAIReviewSession(aiReviewSessionKey('n1'), null);
    const next = renderHook(() => useAIReview({ noteId: 'n1', editorApi: f.api }));
    await waitFor(() => expect(next.result.current.persistenceStatus).toBe('saved'));
    expect(next.result.current.session?.restored).toBe(true);
    expect(next.result.current.session?.persistenceId).toBe(id);
    expect(next.result.current.session?.decisions).toHaveLength(1);
    expect(next.result.current.checkpoint?.resultContent).toBe(f.state.markdown);
    expect(next.result.current.session?.conflict).not.toBe(true);
  });
  it('restores an interrupted applied intent after restart without repeating the body write', async () => {
    const f = editor(original.replace('Old.', 'New.'));
    const s = createAIReviewSession(request(), { noteId: 'n1', revision: 0, markdown: original }, candidate);
    s.retryDecision = { action: 'accept', before: original, after: f.state.markdown, target: candidate, remaining: 1 };
    storeAIReviewSession(aiReviewSessionKey('n1'), s);
    const hook = renderHook(() => useAIReview({ noteId: 'n1', editorApi: f.api }));
    expect(hook.result.current.session?.retryBaseline?.markdown).toBe(f.state.markdown);
    await act(async () => hook.result.current.handleAccept());
    expect(f.replace).not.toHaveBeenCalled(); expect(f.flush).toHaveBeenCalledOnce();
    expect(hook.result.current.session?.accepted).toHaveLength(1);
  });
  it('the mounted panel keeps the correct remaining official controls across save, suspend, and reopen', async () => {
    const f = editor(); const release = vi.fn(); let controller!: ReturnType<typeof useAIReview>;
    function Host() {
      controller = useAIReview({ noteId: 'n1', editorApi: f.api, host: { acquireReviewLease: () => release } });
      return controller.session && !controller.session.collapsed ? <AIDiffPanel state={controller.aiEditState}
        review={controller.session} onAccept={controller.handleAccept} onReject={controller.handleReject}
        onSuspend={() => controller.setCollapsed(true)} {...controller.officialReviewProps} /> : null;
    }
    const page = render(<Host />);
    await act(async () => controller.submitReview(request()));
    await waitFor(() => expect(page.container.querySelectorAll('.milkdown-diff-accept')).toHaveLength(2));
    fireEvent.click(page.container.querySelector<HTMLButtonElement>('.milkdown-diff-accept')!);
    await waitFor(() => expect(controller.session?.accepted).toHaveLength(1));
    await waitFor(() => expect(page.container.querySelectorAll('.milkdown-diff-accept')).toHaveLength(1));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(controller.session?.collapsed).toBe(true); expect(release).toHaveBeenCalledOnce();
    await act(async () => controller.setCollapsed(false));
    await waitFor(() => expect(page.container.querySelectorAll('.milkdown-diff-reject')).toHaveLength(1));
    fireEvent.click(page.container.querySelector<HTMLButtonElement>('.milkdown-diff-reject')!);
    await waitFor(() => expect(controller.session).toBeNull());
    expect(f.state.markdown).toBe(original.replace('Old.', 'New.'));
  });
});
describe('real range and result placement contracts', () => {
  it.each(['selection', 'block', 'section', 'page'] as const)('projects %s against exact full markdown offsets', kind => {
    const markdown = 'Prefix\n\nOld\n\nSuffix'; const baseline = { noteId: 'n1', revision: 7, markdown };
    const from = kind === 'page' ? 0 : 8, to = kind === 'page' ? markdown.length : 11;
    const req = { ...request('New'), scope: { kind, from, to, baseline } };
    expect(scopeAIReviewCandidate(req, baseline, projectAIReviewCandidate).content).toBe(kind === 'page' ? 'New' : 'Prefix\n\nNew\n\nSuffix');
    expect(scopeAIReviewCandidate({ ...req, landing: 'insert-below' }, baseline, projectAIReviewCandidate).content)
      .toBe(markdown.slice(0, to) + '\n\nNew' + markdown.slice(to));
    expect(scopeAIReviewCandidate({ ...req, landing: 'save-as' }, baseline, projectAIReviewCandidate).content).toBe('New');
    expect(() => scopeAIReviewCandidate(req, { ...baseline, revision: 8 }, projectAIReviewCandidate)).toThrow('范围已过期');
  });
  it('save-as calls the durable host destination without replacing the source', async () => {
    const saveAs = vi.fn(async () => ({ noteId: 'saved-note', revision: 1, markdown: 'Result.\n' })); const f = editor();
    const hook = renderHook(() => useAIReview({ noteId: 'n1', editorApi: f.api, host: { saveAs } }));
    await act(async () => hook.result.current.submitReview({ ...request('Result.'), landing: 'save-as' }));
    await act(async () => hook.result.current.officialReviewProps.onReviewDecision({ action: 'accept', before: '', after: 'Result.\n', target: 'Result.\n', remaining: 0 }));
    expect(saveAs).toHaveBeenCalledWith('Result.\n', expect.any(String), undefined); expect(f.replace).not.toHaveBeenCalled();
    expect(hook.result.current.session).toBeNull();
  });
  it('append preserves author whitespace and oversized candidates remain recoverable', () => {
    expect(projectAIReviewCandidate({ ...request('next'), operation: 'append' }, 'text  \n\n\n').content).toBe('text  \n\n\nnext');
    const content = '中'.repeat(350000); const projected = projectAIReviewCandidate(request(content), original);
    expect(projected.error).toBeTruthy(); expect(projected.content).toBe(content);
  });
  it('Escape suspends, explicit discard rejects, and IME shortcuts do nothing', () => {
    const onAccept = vi.fn(), onReject = vi.fn(), onSuspend = vi.fn();
    const view = render(<AIDiffPanel state={{ isActive: true, request: request(), originalContent: original, proposedContent: candidate, diffLines: [] }}
      onAccept={onAccept} onReject={onReject} onSuspend={onSuspend} />);
    fireEvent.keyDown(window, { key: 'Escape', isComposing: true });
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true, keyCode: 229 });
    expect(onSuspend).not.toHaveBeenCalled(); expect(onAccept).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' }); expect(onSuspend).toHaveBeenCalledOnce(); expect(onReject).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole('button', { name: '丢弃建议' })); expect(onReject).toHaveBeenCalledOnce();
  });
});
