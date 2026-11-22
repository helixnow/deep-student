import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DstuNode } from '@/dstu';

const mocks = vi.hoisted(() => ({ content: '', editorProps: null as any }));
vi.mock('@/dstu', () => ({
  dstu: {
    get: vi.fn(async (path: string) => ({ ok: true, value: node(path) })),
    getContent: vi.fn(async () => ({ ok: true, value: mocks.content })),
    setMetadata: vi.fn(), update: vi.fn(), watch: () => () => {},
  },
  updatedAtToVersionToken: (ms: number | null | undefined) => typeof ms === 'number' ? new Date(ms).toISOString() : undefined,
}));
vi.mock('@/features/notes/markdownWindowSettings', () => ({ loadInitialLineWindowSetting: async () => 100 }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('@/stores/systemStatusStore', () => ({ useSystemStatusStore: Object.assign(
  (selector: (state: { maintenanceMode: boolean }) => unknown) => selector({ maintenanceMode: false }),
  { getState: () => ({ maintenanceMode: false }) },
) }));
vi.mock('@/hooks/useBreakpoint', () => ({ useIsMobile: () => false }));
vi.mock('@/components/layout', () => ({ useMobileSubviewChrome: () => false }));
vi.mock('@/features/notes/NotesCrepeEditor', () => ({
  NotesCrepeEditor: (props: any) => {
    mocks.editorProps = props;
    return (
      <div data-testid="editor">
        {props.headerActions}
        <input data-testid="mock-title-input" />
      </div>
    );
  },
}));
vi.mock('@/features/notes/NotesContextPanel', () => ({ NotesContextPanel: () => null }));
import NoteContentView from '@/features/learning-hub/apps/views/NoteContentView';

function node(path = '/note_new'): DstuNode {
  return { id: path.slice(1), path, type: 'note', name: '', createdAt: 1000, updatedAt: 1000, metadata: { tags: [] } };
}

beforeEach(() => {
  mocks.editorProps = null;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => { cb(0); return 0; });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function openAndReady(content: string, props: { readOnly?: boolean } = {}) {
  mocks.content = content;
  const view = render(<NoteContentView node={node()} isActive focusOnActive {...props} />);
  await screen.findByTestId('editor');
  const api = { focus: vi.fn() };
  act(() => mocks.editorProps.onEditorReady(api));
  return { api, view };
}

describe('NoteContentView focusOnActive vs the new-note title autofocus', () => {
  it('RF-W09-new-note-title-focus-yield: a writable empty note leaves focus to the title when the body editor becomes ready', async () => {
    const { api } = await openAndReady('');
    expect(api.focus).not.toHaveBeenCalled();
  });

  it('a note with content still focuses the body when it becomes ready', async () => {
    const { api } = await openAndReady('# existing\n');
    expect(api.focus).toHaveBeenCalledTimes(1);
  });

  it('a read-only empty note (no title autofocus) still focuses the body', async () => {
    const { api } = await openAndReady('', { readOnly: true });
    expect(api.focus).toHaveBeenCalledTimes(1);
  });

  it('re-activating the tab of an empty note focuses the body as before', async () => {
    const { api, view } = await openAndReady('');
    view.rerender(<NoteContentView node={node()} isActive={false} focusOnActive />);
    view.rerender(<NoteContentView node={node()} isActive focusOnActive />);
    expect(api.focus).toHaveBeenCalledTimes(1);
  });

  it('does not steal focus when document.activeElement is already inside the note pane host (split-pane click on title/input)', async () => {
    const { api, view } = await openAndReady('# Split content\n');
    expect(api.focus).toHaveBeenCalledTimes(1);

    view.rerender(<NoteContentView node={node()} isActive={false} focusOnActive />);
    const titleInput = screen.getByTestId('mock-title-input');
    titleInput.focus();
    expect(document.activeElement).toBe(titleInput);

    view.rerender(<NoteContentView node={node()} isActive focusOnActive />);
    expect(api.focus).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(titleInput);
  });

  it('collapses the standalone properties sidebar during focus mode and restores it on exit', async () => {
    mocks.content = '# Note\n';
    const { container } = render(
      <NoteContentView node={node()} isActive focusOnActive hostWindowId="win-focus-1" />,
    );
    await screen.findByTestId('editor');

    // Open the right properties panel via headerActions toggle button
    const toggleBtn = container.querySelector('button[aria-expanded]') as HTMLButtonElement;
    expect(toggleBtn).toBeTruthy();
    act(() => {
      toggleBtn.click();
    });
    expect(container.querySelector('aside.notes-properties-panel')).toBeInTheDocument();

    // Enter focus mode for this hostWindowId
    act(() => {
      window.dispatchEvent(
        new CustomEvent('notes:focus-mode-changed', {
          detail: { ownerId: 'owner-1', scopeId: 'win-focus-1', enabled: true },
        }),
      );
    });
    expect(container.querySelector('aside.notes-properties-panel')).toBeNull();

    // Exit focus mode restores sidebar
    act(() => {
      window.dispatchEvent(
        new CustomEvent('notes:focus-mode-changed', {
          detail: { ownerId: 'owner-1', scopeId: 'win-focus-1', enabled: false },
        }),
      );
    });
    expect(container.querySelector('aside.notes-properties-panel')).toBeInTheDocument();
  });
});
