import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotesTemplatePanelProps } from './components/NotesTemplatePanel';
import type { CrepeEditorApi } from '@/components/crepe';

type NotesEditorHeaderProps = React.ComponentProps<typeof import('./components/NotesEditorHeader').NotesEditorHeader>;

const state = vi.hoisted(() => ({
  selectionVisible: false,
  readonly: false,
  templateProps: null as NotesTemplatePanelProps | null,
  aiReviewOverrides: {} as Partial<ReturnType<typeof import('./aiReview').useAIReview>>,
}));
vi.mock('@/features/notes/NotesContext', () => ({ useNotesOptional: () => undefined }));
vi.mock('@/hooks/useTauriDragAndDrop', () => ({ useTauriDragAndDrop: () => ({ isDragging: false }) }));
vi.mock('@/features/notes/components/NotesEditorHeader', () => ({
  NotesEditorHeader: ({ onOpenHistory }: NotesEditorHeaderProps) => (
    <button disabled={!onOpenHistory} onClick={onOpenHistory}>Open note history</button>
  ),
}));
vi.mock('@/features/notes/components/NotesTemplatePanel', () => ({
  NotesTemplatePanel: (props: NotesTemplatePanelProps) => {
    state.templateProps = props;
    return null;
  },
}));
vi.mock('./aiReview', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./aiReview')>();
  return {
    ...actual,
    useAIReview: vi.fn((...args: Parameters<typeof actual.useAIReview>) => ({
      ...actual.useAIReview(...args),
      ...state.aiReviewOverrides,
    })),
  };
});
vi.mock('@/features/notes/components/NotesEditorToolbar', () => ({ NotesEditorToolbar: () => null }));
vi.mock('@/features/notes/components/MobileEditorToolbar', () => ({ MobileEditorToolbar: () => null }));
vi.mock('@/features/generative-ui/components/GenerativeUIPanel', () => ({ GenerativeUIPanel: () => null }));
vi.mock('@/components/custom-scroll-area', () => ({ CustomScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/shared/selection', () => ({
  useTextSelection: () => ({ selectedText: 'selected', selectionRect: null, isVisible: true, clear: vi.fn() }),
  SelectionToolbar: ({ isVisible, onAddAsContext }: { isVisible: boolean; onAddAsContext?: unknown }) => {
    state.selectionVisible = isVisible && !!onAddAsContext;
    return null;
  },
}));
vi.mock('@/components/crepe', () => ({
  CrepeEditor: ({ defaultValue, onReady, onChange, onDocumentChange, readonly }: any) => {
    const content = React.useRef(defaultValue);
    const latest = React.useRef({ onChange, onDocumentChange, readonly });
    latest.current = { onChange, onDocumentChange, readonly };
    state.readonly = readonly;
    React.useEffect(() => {
      onReady({
        getMarkdown: () => content.current,
        setMarkdown: (markdown: string) => {
          content.current = markdown;
          latest.current.onDocumentChange(); latest.current.onChange(markdown);
          return true;
        },
        isReadonly: () => latest.current.readonly,
        getCrepe: () => null, focus: vi.fn(),
      });
    }, [onReady]);
    return <textarea aria-label="test note editor" readOnly={readonly} defaultValue={defaultValue}
      onChange={(event) => {
        content.current = event.target.value;
        latest.current.onDocumentChange();
        latest.current.onChange(content.current);
      }} />;
  },
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string) => command === 'notes_history_list' ? { items: [], next_cursor: null } : null),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
// Share the configured react-i18next mock's locale, namespace lookup and interpolation.
// Keep t stable: a new function per render recreates the host editor API.
vi.mock('@/i18n', async () => ({ default: (await import('../../../tests/ct/mocks/react-i18next')).i18n }));

import { invoke } from '@tauri-apps/api/core';
import i18n from '@/i18n';
import { NotesCrepeEditor } from './NotesCrepeEditor';
import { useAIReview } from './aiReview';
import { aiReviewSessionKey, storeAIReviewSession } from './aiReviewModel';
import { fullDocumentRecoveryStore } from './fullDocument';

beforeEach(() => {
  vi.clearAllMocks();
  state.selectionVisible = false;
  state.readonly = false;
  state.templateProps = null;
  state.aiReviewOverrides = {};
  storeAIReviewSession(aiReviewSessionKey('host-note'), null);
  fullDocumentRecoveryStore().clear();
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
  vi.mocked(window.matchMedia).mockImplementation((query: string) => ({
    matches: /min-width|prefers-reduced-motion/.test(query), media: query, onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  }));
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, width: 1024, height: 768, right: 1024, bottom: 768, toJSON: () => ({}),
  });
});

describe('notes host reliability wiring', () => {
  it('keeps citation selection available in read-only mode', async () => {
    render(<NotesCrepeEditor noteId="host-note" initialContent="original" readOnly />);
    await waitFor(() => expect(state.selectionVisible).toBe(true));
    expect(state.readonly).toBe(true);
    expect(state.templateProps).toBeNull();
  });

  it('first Escape collapses AI review without leaving focus; IME Escape does neither', async () => {
    const { container } = render(<NotesCrepeEditor noteId="host-note" initialContent="original" onSave={async () => {}} />);
    const editor = screen.getByRole('textbox', { name: 'test note editor' });
    act(() => editor.focus());
    fireEvent.keyDown(editor, { key: 'u', ctrlKey: true, shiftKey: true });
    const shell = container.querySelector('.notes-crepe-shell')!;
    expect(shell.getAttribute('data-focus-mode')).toBe('true');
    act(() => window.dispatchEvent(new CustomEvent('canvas:ai-edit-request', { detail: {
      requestId: 'host-request', noteId: 'host-note', operation: 'set', content: 'candidate',
    } })));
    await screen.findByRole('button', { name: '丢弃建议' });
    fireEvent.compositionStart(editor);
    // Some WebViews omit isComposing on Escape: the host composition ref must also block it.
    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(screen.queryByRole('button', { name: '继续审阅' })).toBeNull();
    expect(shell.getAttribute('data-focus-mode')).toBe('true');
    fireEvent.compositionEnd(editor);
    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(screen.getByRole('button', { name: '继续审阅' })).toBeTruthy();
    expect(shell.getAttribute('data-focus-mode')).toBe('true');
    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(shell.getAttribute('data-focus-mode')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: '继续审阅' }));
    expect(screen.getByRole('button', { name: '丢弃建议' })).toBeTruthy();
  });

  it('opens the real history panel through header props and consumes Escape before focus mode', async () => {
    const { container } = render(<NotesCrepeEditor noteId="host-note" initialContent="original" />);
    const editor = screen.getByRole('textbox', { name: 'test note editor' });
    act(() => editor.focus());
    fireEvent.keyDown(editor, { key: 'u', ctrlKey: true, shiftKey: true });
    const shell = container.querySelector('.notes-crepe-shell')!;
    expect(shell).toHaveAttribute('data-focus-mode', 'true');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open note history' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('notes_history_list', {
      noteId: 'host-note', cursor: null, limit: 30, pinnedOnly: false,
    }));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(shell).toHaveAttribute('data-focus-mode', 'true');

    act(() => editor.focus());
    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(shell).toHaveAttribute('data-focus-mode', 'false');
  });

  it('passes the complete unsaved draft and revision from the template panel through the full-document save path', async () => {
    let hiddenTail = '\n\n## Hidden tail\nDo not truncate this section.\n';
    const onSave = vi.fn(async (_markdown: string) => {});
    const replaceFullMarkdown = vi.fn<NonNullable<CrepeEditorApi['replaceFullMarkdown']>>();
    const extendEditorApi = (api: CrepeEditorApi): CrepeEditorApi => {
      replaceFullMarkdown.mockImplementation(async (markdown) => {
        hiddenTail = '';
        api.setMarkdown(markdown);
        await api.flushPendingSave!();
        return true;
      });
      return { ...api, getFullMarkdown: () => api.getMarkdown() + hiddenTail, replaceFullMarkdown };
    };
    render(<NotesCrepeEditor noteId="host-note" initialTitle="Full draft title" initialContent="Loaded prefix"
      onSave={onSave} extendEditorApi={extendEditorApi}
      windowingState={{ enabled: true, loadedLineCount: 1, totalLineCount: 5, hasMore: true }} />);
    await waitFor(() => expect(state.templateProps?.documentHost).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: i18n.t('notes:toolbar.note_templates', 'Note templates') }));
    expect(state.templateProps?.open).toBe(true);
    expect(state.templateProps?.disabled).toBe(false);
    const host = state.templateProps!.documentHost!;
    expect(host.variables).toEqual({ title: 'Full draft title', locale: 'zh-CN' });
    const initial = host.getDocument();
    expect(initial.markdown).toBe('Loaded prefix' + hiddenTail);

    fireEvent.change(screen.getByRole('textbox', { name: 'test note editor' }), { target: { value: 'Unsaved prefix' } });
    const draft = host.getDocument();
    expect(draft).toEqual({ noteId: 'host-note', revision: expect.any(Number), markdown: 'Unsaved prefix' + hiddenTail });
    expect(draft.revision).toBeGreaterThan(initial.revision);
    expect(onSave).not.toHaveBeenCalled();

    // Same bytes with an obsolete revision must still fail, before the owning view writes.
    await act(async () => {
      await expect(host.replaceDocument('Stale template', { ...draft, revision: initial.revision }))
        .rejects.toThrow(i18n.t('notes:fullDocument.errors.baseline_changed'));
    });
    expect(replaceFullMarkdown).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();

    const replacement = draft.markdown + '\n## Applied template\n';
    await act(async () => { await expect(host.replaceDocument(replacement, draft)).resolves.toMatchObject({ noteId: draft.noteId, markdown: replacement }); });
    expect(replaceFullMarkdown).toHaveBeenCalledExactlyOnceWith(replacement, { expectedMarkdown: draft.markdown, baseline: draft });
    expect(onSave).toHaveBeenCalledExactlyOnceWith(replacement);
    const saved = host.getDocument();
    expect(saved.markdown).toBe(replacement);
    expect(saved.revision).toBeGreaterThan(draft.revision);
  });

  it('removes template replacement in reading mode and rejects a previously captured documentHost', async () => {
    const onSave = vi.fn(async () => {});
    render(<NotesCrepeEditor noteId="host-note" initialContent="original" onSave={onSave} />);
    await waitFor(() => expect(state.templateProps?.documentHost).toBeDefined());
    const host = state.templateProps!.documentHost!;
    const baseline = host.getDocument();
    fireEvent.click(screen.getByRole('button', { name: i18n.t('notes:toolbar.reading_mode') }));
    expect(state.readonly).toBe(true);
    expect(state.templateProps?.disabled).toBe(true);
    expect(state.templateProps?.documentHost).toBeUndefined();
    expect(state.templateProps?.open).toBe(false);

    await act(async () => {
      await expect(host.replaceDocument('Forbidden replacement', baseline))
        .rejects.toThrow(i18n.t('notes:fullDocument.errors.read_only'));
    });
    expect(host.getDocument()).toEqual(baseline);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('routes each recovery choice and persistence retry to useAIReview with the owning note and window', async () => {
    const restoreCandidate = vi.fn(async (_id?: string) => {});
    const retryPersistence = vi.fn(async () => {});
    const options = [
      { id: 'candidate-a', windowId: 'old-window-a', createdAt: Date.UTC(2026, 8, 20, 9) },
      { id: 'candidate-b', windowId: 'old-window-b', createdAt: Date.UTC(2026, 8, 21, 10) },
    ];
    state.aiReviewOverrides = { recoveryOptions: options, persistenceStatus: 'error', persistenceError: 'Persistence failed', restoreCandidate, retryPersistence };
    const props = { noteId: 'host-note', initialContent: 'original', acrWindowId: 'host-window' };
    const { rerender } = render(<NotesCrepeEditor {...props} />);
    await waitFor(() => expect(useAIReview).toHaveBeenLastCalledWith({
      noteId: 'host-note', windowId: 'host-window', enabled: true,
      editorApi: expect.objectContaining({ getFullDocument: expect.any(Function), replaceFullDocument: expect.any(Function) }),
    }));
    expect(screen.getByRole('alert')).toHaveTextContent('Persistence failed');
    const recoveryButton = (index: number) => screen.getByRole('button', {
      name: i18n.t('notes:aiReview.restore_candidate', { index: index + 1, date: new Date(options[index].createdAt).toLocaleString() }),
    });
    fireEvent.click(recoveryButton(1));
    fireEvent.click(recoveryButton(0));
    expect(restoreCandidate.mock.calls).toEqual([['candidate-b'], ['candidate-a']]);
    fireEvent.click(screen.getByRole('button', { name: i18n.t('common:retry') }));
    expect(retryPersistence).toHaveBeenCalledExactlyOnceWith();

    state.aiReviewOverrides.persistenceStatus = 'loading';
    rerender(<NotesCrepeEditor {...props} />);
    expect(recoveryButton(0)).toBeDisabled();
    expect(recoveryButton(1)).toBeDisabled();
    const retry = screen.getByRole('button', { name: i18n.t('common:retry') });
    expect(retry).toBeDisabled();
    fireEvent.click(recoveryButton(0));
    fireEvent.click(retry);
    expect(restoreCandidate).toHaveBeenCalledTimes(2);
    expect(retryPersistence).toHaveBeenCalledTimes(1);

    const choices = [recoveryButton(0), recoveryButton(1)];
    state.aiReviewOverrides = { ...state.aiReviewOverrides, persistenceStatus: 'saving', recoveryOptions: [] };
    rerender(<NotesCrepeEditor {...props} />);
    choices.forEach((choice) => expect(choice).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: i18n.t('common:retry') })).toBeDisabled();

    state.aiReviewOverrides = { ...state.aiReviewOverrides, persistenceStatus: 'saved', persistenceError: undefined };
    rerender(<NotesCrepeEditor {...props} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: i18n.t('common:retry') })).not.toBeInTheDocument();
  });
});
