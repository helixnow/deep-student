import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';
import type { FullDocumentApi } from '../fullDocument';
import { aiReviewSessionKey, storeAIReviewSession } from '../aiReviewModel';
import { getNoteAIEditControl } from '../aiEditControlRegistry';
import { useAIReview } from '../aiReview';
import { computeDiffLines, type AIEditState } from '../hooks/useAIEditState';
import type { AIEditCheckpoint } from '../hooks/useCanvasAIEditHandler';
import { AIDiffPanel } from '../AIDiffPanel';

const ipcMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  rows: new Map<string, any>(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: ipcMocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('@/utils/clipboardUtils', () => ({ copyTextToClipboard: vi.fn(async () => true) }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('@/features/generative-ui/components/GenerativeUIPanel', () => ({
  GenerativeUIPanel: () => null,
}));
vi.mock('@/components/custom-scroll-area', () => ({
  CustomScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const EMOJI_RE = /\p{Extended_Pictographic}/u;

describe('AIDiffPanel Hunk-level review & tweak flow (C4 §3.2.4)', () => {
  beforeAll(async () => {
    if (!i18next.isInitialized) {
      await i18next.init({ lng: 'zh-CN', resources: {} });
    }
  });

  beforeEach(() => {
    storeAIReviewSession(aiReviewSessionKey('note_01'), null);
    ipcMocks.rows.clear();
    ipcMocks.invoke.mockReset().mockImplementation(async (command: string, args: any) => {
      if (command === 'notes_history_list') {
        return { items: [{ version_id: 'ver_baseline_01', pinned: false }] };
      }
      if (command === 'notes_history_set_pinned') {
        return { version_id: args.versionId, pinned: args.pinned };
      }
      if (!command.startsWith('notes_state_')) return null;
      const r = args.request;
      if (command === 'notes_state_list') {
        return [...ipcMocks.rows.values()].filter((row) => row.note_id === r.note_id && !row.deleted);
      }
      const old = ipcMocks.rows.get(r.key);
      if (command === 'notes_state_get') return old ?? null;
      const row = { ...r, revision: (old?.revision ?? 0) + 1, deleted: command === 'notes_state_delete' };
      ipcMocks.rows.set(r.key, structuredClone(row));
      return row;
    });
  });

  afterEach(() => {
    cleanup();
  });

  function makeMultiHunkState(): AIEditState {
    const originalContent = [
      '# Chapter 3',
      'First original paragraph.',
      'Unchanged anchor A.',
      'Unchanged anchor B.',
      'Second original paragraph.',
      'Unchanged anchor C.',
      'Third original paragraph.',
    ].join('\n');

    const proposedContent = [
      '# Chapter 3',
      'First AI candidate paragraph.',
      'Unchanged anchor A.',
      'Unchanged anchor B.',
      'Second AI candidate paragraph.',
      'Unchanged anchor C.',
      'Third AI candidate paragraph.',
    ].join('\n');

    return {
      isActive: true,
      request: {
        requestId: 'req_hunk_1',
        noteId: 'note_01',
        operation: 'replace',
      },
      originalContent,
      proposedContent,
      diffLines: computeDiffLines(originalContent, proposedContent),
    };
  }

  it('renders font-mono tabular-nums hunk progress counter, 6px status dots, 1px border-border/35 dividers, and zero emojis', () => {
    const state = makeMultiHunkState();
    const { container } = render(
      <AIDiffPanel
        state={state}
        onAccept={vi.fn()}
        onReject={vi.fn()}
        onSuspend={vi.fn()}
        onApplyComposedContent={vi.fn()}
      />,
    );

    const counter = screen.getByTestId('ai-diff-hunk-counter');
    expect(counter.textContent).toBe('0 / 3');
    expect(counter.className).toContain('font-mono');
    expect(counter.className).toContain('tabular-nums');

    const card0 = screen.getByTestId('ai-diff-hunk-card-0');
    expect(card0.className).toContain('border-border/35');
    expect(within(card0).getByText('1 / 3').className).toContain('tabular-nums');

    const dots = container.querySelectorAll('.h-1\\.5.w-1\\.5.rounded-full');
    expect(dots.length).toBeGreaterThanOrEqual(4);

    expect(EMOJI_RE.test(container.textContent ?? '')).toBe(false);
  });

  it('keeps decisions across equivalent diff arrays but resets decisions and inline drafts for a new proposal', () => {
    const state = makeMultiHunkState();
    const props = { onAccept: vi.fn(), onReject: vi.fn(), onSuspend: vi.fn(), onApplyComposedContent: vi.fn() };
    const view = render(<AIDiffPanel state={state} {...props} />);
    fireEvent.click(within(screen.getByTestId('ai-diff-hunk-card-0')).getByRole('button', { name: '拒绝' }));
    view.rerender(<AIDiffPanel state={{ ...state, diffLines: [...state.diffLines] }} {...props} />);
    expect(screen.getByTestId('ai-diff-hunk-counter').textContent).toBe('1 / 3');
    fireEvent.click(within(screen.getByTestId('ai-diff-hunk-card-1')).getByRole('button', { name: '微调' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Stale draft' } });
    const proposedContent = state.proposedContent.replace('Second AI', 'Different AI');
    view.rerender(<AIDiffPanel state={{ ...state, proposedContent,
      diffLines: computeDiffLines(state.originalContent, proposedContent) }} {...props} />);
    expect(screen.getByTestId('ai-diff-hunk-counter').textContent).toBe('0 / 3');
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '全部采纳' }));
    expect(props.onApplyComposedContent).toHaveBeenCalledWith(proposedContent);
    view.rerender(<AIDiffPanel state={state} {...props} />);
    expect(screen.getByTestId('ai-diff-hunk-counter').textContent).toBe('0 / 3');
  });

  it('ignores IME accept/suspend shortcuts and does not confirm a tweak while composing', () => {
    const props = { onAccept: vi.fn(), onReject: vi.fn(), onSuspend: vi.fn(), onApplyComposedContent: vi.fn() };
    render(<AIDiffPanel state={makeMultiHunkState()} {...props} />);
    const card = screen.getByTestId('ai-diff-hunk-card-0');
    fireEvent.click(within(card).getByRole('button', { name: '微调' }));
    const textarea = screen.getByRole('textbox');
    fireEvent.compositionStart(textarea);
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true, isComposing: true });
    fireEvent.keyDown(textarea, { key: 'Escape', isComposing: true });
    fireEvent.click(within(card).getByRole('button', { name: '确认微调' }));
    expect(props.onApplyComposedContent).not.toHaveBeenCalled();
    expect(props.onSuspend).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox')).toBeTruthy();
    fireEvent.compositionEnd(textarea);
    fireEvent.click(within(card).getByRole('button', { name: '确认微调' }));
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('reports rejected asynchronous apply and rollback callbacks rather than leaking unhandled rejections', async () => {
    const error = new Error('save failed');
    const props = { onAccept: vi.fn(), onReject: vi.fn(), onSuspend: vi.fn(),
      onApplyComposedContent: vi.fn(async () => { throw error; }),
      onRollbackCheckpoint: vi.fn(async () => { throw error; }), onReviewError: vi.fn() };
    const state = makeMultiHunkState();
    const checkpoint: AIEditCheckpoint = { id: 'cp', noteId: 'note_01', originalContent: '', resultContent: '',
      appliedAt: 0, operation: 'set', diffLines: [] };
    render(<AIDiffPanel state={state} latestCheckpoint={checkpoint} {...props} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '全部采纳' })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '全部撤回' })); });
    expect(props.onReviewError).toHaveBeenCalledTimes(2);
  });

  it.each(['empty', 'error', 'closed', 'edited'])('does not pin an unavailable or obsolete baseline history (%s)', async (mode) => {
    let finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => { finish = resolve; });
    const implementation = ipcMocks.invoke.getMockImplementation()!;
    ipcMocks.invoke.mockImplementation((command, args) => command === 'notes_history_list'
      ? mode === 'error' ? Promise.reject(new Error('history failed')) : pending
      : implementation(command, args));
    let markdown = 'Old';
    const api = { getFullDocument: () => ({ markdown, revision: 1, noteId: 'note_01' }) } as FullDocumentApi;
    const hook = renderHook(() => useAIReview({ noteId: 'note_01', editorApi: api }));
    let receiving!: Promise<void>;
    act(() => { receiving = hook.result.current.submitReview({ requestId: `history-${mode}`, noteId: 'note_01', operation: 'set', content: 'New' }); });
    if (mode === 'closed') hook.unmount();
    if (mode === 'edited') markdown = 'User changed';
    await act(async () => { finish({ items: mode === 'empty' ? [] : [{ version_id: 'old-version' }] }); await receiving; });
    expect(ipcMocks.invoke.mock.calls.some(([command]) => command === 'notes_history_set_pinned')).toBe(false);
  });

  it('rechecks the baseline after persistence before applying a composed suggestion', async () => {
    const doc = { markdown: 'Old', revision: 1, noteId: 'note_01' };
    const api = { getFullDocument: () => ({ ...doc }), replaceFullDocument: vi.fn() } as unknown as FullDocumentApi;
    const hook = renderHook(() => useAIReview({ noteId: 'note_01', editorApi: api }));
    await act(async () => { await hook.result.current.submitReview({ requestId: 'race', noteId: 'note_01', operation: 'set', content: 'New' }); });
    const implementation = ipcMocks.invoke.getMockImplementation()!;
    ipcMocks.invoke.mockImplementation(async (command, args) => {
      if (command === 'notes_state_put') { doc.markdown = 'Newer user edit'; doc.revision++; }
      return implementation(command, args);
    });
    await act(async () => { await hook.result.current.applyComposedContent('New'); });
    expect(api.replaceFullDocument).not.toHaveBeenCalled();
    expect(doc.markdown).toBe('Newer user edit');
  });

  it('does not apply a pending persistence completion after its review window closes', async () => {
    const doc = { markdown: 'Old', revision: 1, noteId: 'note_01' };
    const api = { getFullDocument: () => ({ ...doc }), replaceFullDocument: vi.fn() } as unknown as FullDocumentApi;
    const hook = renderHook(() => useAIReview({ noteId: 'note_01', editorApi: api }));
    await act(async () => { await hook.result.current.submitReview({ requestId: 'close-race', noteId: 'note_01', operation: 'set', content: 'New' }); });
    const implementation = ipcMocks.invoke.getMockImplementation()!;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    ipcMocks.invoke.mockImplementation(async (command, args) => {
      if (command === 'notes_state_put') await waiting;
      return implementation(command, args);
    });
    let applying!: Promise<void>;
    act(() => { applying = hook.result.current.applyComposedContent('New'); });
    hook.unmount();
    await act(async () => { release(); await applying; });
    expect(api.replaceFullDocument).not.toHaveBeenCalled();
    expect(doc.markdown).toBe('Old');
  });

  it('refuses checkpoint rollback after a newer user edit and ignores rollback callbacks retained after unmount', async () => {
    const doc = { markdown: 'Old', revision: 1, noteId: 'note_01' };
    const api = { getFullDocument: () => ({ ...doc }),
      replaceFullDocument: vi.fn(async (markdown: string) => { doc.markdown = markdown; doc.revision++; return { ...doc }; }) } as unknown as FullDocumentApi;
    const hook = renderHook(() => useAIReview({ noteId: 'note_01', editorApi: api }));
    await act(async () => { await hook.result.current.submitReview({ requestId: 'rollback-race', noteId: 'note_01', operation: 'set', content: 'New' }); });
    await act(async () => { await hook.result.current.applyComposedContent('New'); });
    const rollback = hook.result.current.rollbackLatestCheckpoint;
    doc.markdown = 'Newer user edit'; doc.revision++;
    await act(async () => { await rollback(); });
    expect(api.replaceFullDocument).toHaveBeenCalledTimes(1);
    expect(hook.result.current.checkpoint?.stale).toBe(true);
    hook.unmount();
    await rollback();
    expect(doc.markdown).toBe('Newer user edit');
    expect(api.replaceFullDocument).toHaveBeenCalledTimes(1);
  });

  it('synchronously dismisses checkpoints before an external rollback can reuse the old ref', async () => {
    const doc = { markdown: 'Old', revision: 1, noteId: 'note_01' };
    const api = { getFullDocument: () => ({ ...doc }),
      replaceFullDocument: vi.fn(async (markdown: string) => { doc.markdown = markdown; doc.revision++; return { ...doc }; }) } as unknown as FullDocumentApi;
    const hook = renderHook(() => useAIReview({ noteId: 'note_01', editorApi: api }));
    await act(async () => { await hook.result.current.submitReview({ requestId: 'dismiss', noteId: 'note_01', operation: 'set', content: 'New' }); });
    await act(async () => { await hook.result.current.applyComposedContent('New'); });
    await act(async () => {
      hook.result.current.dismissCheckpoint();
      expect(await getNoteAIEditControl('note_01')!.rollbackLatestCheckpoint()).toBe(false);
    });
    expect(doc.markdown).toBe('New');
    expect(api.replaceFullDocument).toHaveBeenCalledTimes(1);
  });

  it('supports per-hunk [采纳] / [拒绝] / [微调] inline editing and composes exact Markdown on [全部采纳]', () => {
    const state = makeMultiHunkState();
    const onApplyComposedContent = vi.fn();
    const onAccept = vi.fn();
    const onReject = vi.fn();

    render(
      <AIDiffPanel
        state={state}
        onAccept={onAccept}
        onReject={onReject}
        onSuspend={vi.fn()}
        onApplyComposedContent={onApplyComposedContent}
      />,
    );

    const card0 = screen.getByTestId('ai-diff-hunk-card-0');
    const card1 = screen.getByTestId('ai-diff-hunk-card-1');
    const card2 = screen.getByTestId('ai-diff-hunk-card-2');

    // Hunk 1: Accept
    fireEvent.click(within(card0).getByRole('button', { name: '采纳' }));
    expect(screen.getByTestId('ai-diff-hunk-counter').textContent).toBe('1 / 3');

    // Hunk 2: Reject (keeps original)
    fireEvent.click(within(card1).getByRole('button', { name: '拒绝' }));
    expect(screen.getByTestId('ai-diff-hunk-counter').textContent).toBe('2 / 3');

    // Hunk 3: Inline Tweak
    fireEvent.click(within(card2).getByRole('button', { name: '微调' }));
    const textarea = within(card2).getByRole('textbox', { name: /微调变更块 3/ });
    fireEvent.change(textarea, {
      target: { value: 'Tweaked third paragraph\nWith user addendum' },
    });
    fireEvent.click(within(card2).getByRole('button', { name: '确认微调' }));
    expect(screen.getByTestId('ai-diff-hunk-counter').textContent).toBe('3 / 3');

    // Commit via top-bar [全部采纳]
    fireEvent.click(screen.getByRole('button', { name: '全部采纳' }));

    expect(onApplyComposedContent).toHaveBeenCalledTimes(1);
    expect(onAccept).not.toHaveBeenCalled();
    expect(onApplyComposedContent).toHaveBeenCalledWith(
      [
        '# Chapter 3',
        'First AI candidate paragraph.',
        'Unchanged anchor A.',
        'Unchanged anchor B.',
        'Second original paragraph.',
        'Unchanged anchor C.',
        'Tweaked third paragraph',
        'With user addendum',
      ].join('\n'),
    );
  });

  it('triggers onReject on [全部撤回] when pending, and rolls back latestCheckpoint when present', () => {
    const state = makeMultiHunkState();
    const onReject = vi.fn();
    const onRollbackCheckpoint = vi.fn();

    const { rerender } = render(
      <AIDiffPanel
        state={state}
        onAccept={vi.fn()}
        onReject={onReject}
        onSuspend={vi.fn()}
        latestCheckpoint={null}
        onRollbackCheckpoint={onRollbackCheckpoint}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '全部撤回' }));
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onRollbackCheckpoint).not.toHaveBeenCalled();

    const checkpoint: AIEditCheckpoint = {
      id: 'cp_1',
      noteId: 'note_01',
      originalContent: state.originalContent,
      resultContent: state.proposedContent,
      appliedAt: Date.now(),
      operation: 'replace',
      diffLines: state.diffLines,
    };

    rerender(
      <AIDiffPanel
        state={state}
        onAccept={vi.fn()}
        onReject={onReject}
        onSuspend={vi.fn()}
        latestCheckpoint={checkpoint}
        onRollbackCheckpoint={onRollbackCheckpoint}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '全部撤回' }));
    expect(onRollbackCheckpoint).toHaveBeenCalledTimes(1);
  });

  it('useAIReview pins baseline history revision on receive, commits composed content with checkpoint, and rolls back cleanly', async () => {
    const docState = { markdown: 'Intro\nOld A\nBridge\nOld B', revision: 1 };
    const snapshot = () => ({ markdown: docState.markdown, revision: docState.revision, noteId: 'note_01' });
    const api = {
      getFullDocument: snapshot,
      getFullMarkdown: () => docState.markdown,
      isReadonly: () => false,
      flushPendingSave: vi.fn(async () => {}),
      replaceFullDocument: vi.fn(async (next: string) => {
        docState.markdown = next;
        docState.revision += 1;
        return snapshot();
      }),
    } as unknown as FullDocumentApi;

    const hook = renderHook(() => useAIReview({ noteId: 'note_01', editorApi: api }));

    await act(async () => {
      await hook.result.current.submitReview({
        requestId: 'req_pin_1',
        noteId: 'note_01',
        operation: 'set',
        content: 'Intro\nNew A\nBridge\nNew B',
      });
    });

    expect(ipcMocks.invoke).toHaveBeenCalledWith('notes_history_list', {
      noteId: 'note_01',
      cursor: null,
      limit: 1,
      pinnedOnly: false,
    });
    expect(ipcMocks.invoke).toHaveBeenCalledWith('notes_history_set_pinned', {
      noteId: 'note_01',
      versionId: 'ver_baseline_01',
      pinned: true,
    });

    await act(async () => {
      await hook.result.current.applyComposedContent('Intro\nTweaked A\nBridge\nOld B');
    });

    expect(docState.markdown).toBe('Intro\nTweaked A\nBridge\nOld B');
    expect(hook.result.current.session).toBeNull();
    expect(hook.result.current.checkpoint?.resultContent).toBe('Intro\nTweaked A\nBridge\nOld B');

    await act(async () => {
      await hook.result.current.rollbackLatestCheckpoint();
    });
    expect(docState.markdown).toBe('Intro\nOld A\nBridge\nOld B');
  });
});
