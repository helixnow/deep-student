/**
 * #23: where keyboard focus lands when a note opens in a tab with `focusOnActive` (the workbench notes app).
 * The real NoteContentView → NotesCrepeEditor → NotesEditorHeader chain; only the Crepe editor is a stand-in, and it
 * reports ready from an async step after mount like the real one, so the host's ready focus and the header's title
 * focus are queued in the order the production bundle queues them.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DstuNode } from '@/dstu';

const mocks = vi.hoisted(() => ({
  content: '',
  focusLog: [] as string[],
  node: (path: string): DstuNode => ({
    id: path.replace(/^\//, ''), path, type: 'note', name: '', createdAt: 1000, updatedAt: 1000, metadata: { props: {}, tags: [] },
  }),
}));

vi.mock('@/dstu', () => ({
  dstu: {
    get: vi.fn(async (path: string) => ({ ok: true, value: mocks.node(path) })),
    getContent: vi.fn(async () => ({ ok: true, value: mocks.content })),
    setMetadata: vi.fn(async () => ({ ok: true, value: undefined })),
    update: vi.fn(async (path: string) => ({ ok: true, value: mocks.node(path) })),
    watch: () => () => {},
  },
  updatedAtToVersionToken: (ms: number) => (Number.isFinite(ms) ? new Date(ms).toISOString() : undefined),
}));
vi.mock('@/features/notes/markdownWindowSettings', () => ({ loadInitialLineWindowSetting: async () => 100 }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('@/stores/systemStatusStore', () => ({
  useSystemStatusStore: Object.assign(
    (selector: (state: { maintenanceMode: boolean }) => unknown) => selector({ maintenanceMode: false }),
    { getState: () => ({ maintenanceMode: false }) },
  ),
}));
vi.mock('@/features/notes/noteRelations', () => ({
  NOTE_RELATIONS_CHANGED: 'notes:relations-changed',
  isNoteRelationUsable: () => true,
  noteRelationsService: { list: async () => [], put: vi.fn(), delete: vi.fn(), referenceStatus: vi.fn() },
}));
vi.mock('@/hooks/useBreakpoint', () => ({ useIsMobile: () => false }));
vi.mock('@/components/layout', () => ({ useMobileSubviewChrome: () => false }));
vi.mock('@/features/notes/NotesContextPanel', () => ({ NotesContextPanel: () => null }));
vi.mock('@/features/notes/NotesContext', () => ({ useNotesOptional: () => undefined }));
vi.mock('@/hooks/useTauriDragAndDrop', () => ({ useTauriDragAndDrop: () => ({ isDragging: false }) }));
vi.mock('@/features/notes/components/MobileEditorToolbar', () => ({ MobileEditorToolbar: () => null }));
vi.mock('@/features/generative-ui/components/GenerativeUIPanel', () => ({ GenerativeUIPanel: () => null }));
vi.mock('@/components/custom-scroll-area', () => ({
  CustomScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args?: { noteId?: string }) => {
    if (command === 'notes_get_format') {
      return { note_id: args?.noteId, content_format: 'markdown-legacy', format_version: 1, serializer_version: 'markdown-v1', required_capabilities: [] };
    }
    return command === 'notes_history_list' ? { items: [], next_cursor: null } : null;
  }),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('@/i18n', async () => ({ default: (await import('../../../../../tests/ct/mocks/react-i18next')).i18n }));
// The real CrepeEditor reports ready from an async init (after `await crepe.create()`), never during render.
vi.mock('@/components/crepe', () => ({
  CrepeEditor: ({ defaultValue, onReady }: { defaultValue?: string; onReady?: (api: unknown) => void }) => {
    const body = React.useRef<HTMLDivElement>(null);
    React.useEffect(() => {
      let live = true;
      void Promise.resolve().then(() => {
        if (!live) return;
        onReady?.({
          getMarkdown: () => body.current?.textContent ?? '',
          setMarkdown: () => true,
          isReadonly: () => false,
          getCrepe: () => null,
          focus: () => body.current?.focus(),
        });
      });
      return () => { live = false; };
    }, [onReady]);
    return (
      <div className="milkdown">
        <div ref={body} className="ProseMirror" contentEditable suppressContentEditableWarning tabIndex={0} role="textbox" aria-label="note body">
          {defaultValue}
        </div>
      </div>
    );
  },
}));

import NoteContentView from '@/features/learning-hub/apps/views/NoteContentView';

const describeFocus = (el: Element | null) => {
  if (!el || el === document.body) return 'body';
  const label = el.getAttribute('aria-label');
  return `${el.tagName}.${String(el.className).split(' ')[0]}${label ? `[${label}]` : ''}`;
};
const onFocusIn = (event: FocusEvent) => mocks.focusLog.push(describeFocus(event.target as Element));

beforeEach(() => {
  mocks.content = '';
  mocks.focusLog = [];
  document.addEventListener('focusin', onFocusIn);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
});
afterEach(() => {
  document.removeEventListener('focusin', onFocusIn);
  vi.unstubAllGlobals();
});

const nextFrames = (count: number) => new Promise<void>((resolve) => {
  const step = (left: number) => (left === 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
  step(count);
});

const renderTab = (path: string, strict: boolean) => {
  const view = <NoteContentView node={mocks.node(path)} isActive focusOnActive />;
  render(strict ? <React.StrictMode>{view}</React.StrictMode> : view);
};

describe('RF-W09-new-note-title-focus (#23): a note opened in a focus-on-active notes tab', () => {
  // The ready handler yields to the title for an empty writable note (RF-W09-new-note-title-focus-yield).
  it.each([['production', false], ['StrictMode', true]])('%s: a new empty note gets keyboard focus in its title, never in the body', async (_mode, strict) => {
    renderTab('/note_new', strict);
    const title = await screen.findByRole('textbox', { name: /笔记标题|Note title/ });
    await screen.findByRole('textbox', { name: 'note body' });
    await nextFrames(4);
    await waitFor(() => expect(document.activeElement).toBe(title), { timeout: 500 });
    expect(mocks.focusLog).toEqual([describeFocus(title)]);
  });

  // Keep the rendering/single-focus invariant separate from the exact focus target above.
  it.each([['production', false], ['StrictMode', true]])('%s: a new empty note renders its title and body and moves focus exactly once, into one of them', async (_mode, strict) => {
    renderTab('/note_new', strict);
    const title = await screen.findByRole('textbox', { name: /笔记标题|Note title/ });
    const body = await screen.findByRole('textbox', { name: 'note body' });
    await nextFrames(4);
    expect([title, body]).toContain(document.activeElement);
    expect(mocks.focusLog).toEqual([describeFocus(document.activeElement as Element)]);
  });

  it.each([['production', false], ['StrictMode', true]])('%s: a note with content still gets keyboard focus in its body', async (_mode, strict) => {
    mocks.content = 'Existing body';
    renderTab('/note_old', strict);
    const body = await screen.findByRole('textbox', { name: 'note body' });
    await nextFrames(4);
    await waitFor(() => expect(document.activeElement).toBe(body), { timeout: 500 });
    expect(mocks.focusLog).toEqual([describeFocus(body)]);
  });
});
