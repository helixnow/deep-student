import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { EditorState, TextSelection, type Transaction } from '@milkdown/prose/state';
import { EditorView } from '@milkdown/prose/view';
import { history, undo, undoDepth } from '@milkdown/prose/history';
import type { CrepeEditorApi } from '@/components/crepe';
import { doc, p, textPos, wrap } from '@/components/crepe/__tests__/blockCommandFixtures';
import { buildMobileEditorCommands, openSlashMenu } from './mobileEditorCommands';
import { MobileEditorToolbar } from './components/MobileEditorToolbar';

vi.mock('@/components/crepe/features/imageUpload', () => ({
  createImageUploader: vi.fn(), validateImageFile: vi.fn(), pickImageWithTauriDialog: vi.fn(),
}));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('./generateCardsFromNote', () => ({ generateCardsFromNote: vi.fn() }));

const views: EditorView[] = [];
function editorFixture() {
  const original = doc(wrap('callout', p('keep'), p('target')), p('outside'));
  const element = document.createElement('div');
  document.body.appendChild(element);
  const view = new EditorView(element, {
    state: EditorState.create({ doc: original,
      selection: TextSelection.create(original, textPos(original, 'target') + 2), plugins: [history()] }),
    dispatchTransaction(tr: Transaction) { view.updateState(view.state.apply(tr)); },
    handleScrollToSelection: () => true,
  });
  vi.spyOn(view, 'coordsAtPos').mockReturnValue({ left: 20, right: 20, top: 20, bottom: 40 });
  const dispatch = vi.spyOn(view, 'dispatch');
  views.push(view);
  const crepe = { editor: { action: (fn: (ctx: unknown) => void) => fn({ get: () => view }) } };
  const api = { getCrepe: () => crepe, insertAtCursor: vi.fn(), focus: vi.fn(), openBlockMenuAtSelection: vi.fn() } as unknown as CrepeEditorApi;
  return { api, view, dispatch, original, element };
}

async function showMenu(open: () => void) {
  await act(async () => { open(); await new Promise((resolve) => setTimeout(resolve, 25)); });
  return document.querySelector<HTMLElement>('.crepe-block-menu')!;
}

afterEach(() => {
  fireEvent.keyDown(document, { key: 'Escape' });
  cleanup();
  views.splice(0).forEach((view) => { if (!view.isDestroyed) view.destroy(); });
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('mobile block menu with the real pinned SlashProvider', () => {
  it('open and Escape preserve text, selection identity and undo history; no slash insertion', async () => {
    const { api, view, dispatch, original } = editorFixture();
    const selection = view.state.selection;
    const menu = await showMenu(() => openSlashMenu(api));
    expect(menu?.hidden).toBe(false);
    expect(menu.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(5);
    expect(api.insertAtCursor).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.querySelector('.crepe-block-menu')).toBeNull();
    expect(view.state.doc).toBe(original);
    expect(view.state.selection).toBe(selection);
    expect(undoDepth(view.state)).toBe(0);
    expect(undo(view.state)).toBe(false);
  });

  it('cancelling with outside press or Tab is also transaction-free', async () => {
    const { api, view, dispatch } = editorFixture();
    await showMenu(() => openSlashMenu(api));
    fireEvent.pointerDown(document.body);
    expect(document.querySelector('.crepe-block-menu')).toBeNull();
    await showMenu(() => openSlashMenu(api));
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.querySelector('.crepe-block-menu')).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
    expect(undoDepth(view.state)).toBe(0);
  });

  it('menu selection preserves existing text and commits one undoable conversion', async () => {
    const { api, view, dispatch, original } = editorFixture();
    const menu = await showMenu(() => openSlashMenu(api));
    fireEvent.click(menu.querySelector('[data-command="heading-2"]')!);
    expect(view.state.doc.textContent).toBe(original.textContent);
    expect(view.state.doc.firstChild!.child(0).eq(p('keep'))).toBe(true);
    expect(view.state.doc.firstChild!.child(1).type.name).toBe('heading');
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(undoDepth(view.state)).toBe(1);
    undo(view.state, view.dispatch);
    expect(view.state.doc.eq(original)).toBe(true);
  });

  it('mobile block actions consume the captured nested target instead of the legacy top-level host', async () => {
    const { api, view, dispatch } = editorFixture();
    const commands = buildMobileEditorCommands(api);
    const menu = await showMenu(() => commands.openBlockActions!());
    fireEvent.click(menu.querySelector('[data-command="delete"]')!);
    expect(view.state.doc.eq(doc(wrap('callout', p('keep')), p('outside')))).toBe(true);
    expect(api.openBlockMenuAtSelection).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('stale menu buttons cannot change a newer document even before observer cleanup', async () => {
    const { api, view, dispatch } = editorFixture();
    const menu = await showMenu(() => buildMobileEditorCommands(api).openBlockActions!());
    view.dispatch(view.state.tr.insertText('edited'));
    const edited = view.state.doc;
    dispatch.mockClear();
    fireEvent.click(menu.querySelector('[data-command="delete"]')!);
    expect(view.state.doc).toBe(edited);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('read-only and composing editors do not open a menu', async () => {
    const { api, view, dispatch } = editorFixture();
    view.setProps({ editable: () => false });
    expect(await showMenu(() => openSlashMenu(api))).toBeNull();
    view.setProps({ editable: () => true });
    vi.spyOn(view, 'composing', 'get').mockReturnValue(true);
    expect(await showMenu(() => openSlashMenu(api))).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('toolbar insert open/cancel and more-menu open/cancel produce no transactions', async () => {
    const { api, view, dispatch } = editorFixture();
    render(<MobileEditorToolbar commands={buildMobileEditorCommands(api)} visible />);
    const toggle = document.querySelector('[data-action="insert-toggle"]')!;
    fireEvent.click(toggle);
    expect(document.querySelector('[data-testid="mobile-editor-toolbar-insert-row"]')).not.toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.querySelector('[data-testid="mobile-editor-toolbar-insert-row"]')).toBeNull();
    fireEvent.click(toggle);
    const menu = await showMenu(() => fireEvent.click(document.querySelector('[data-action="slash"]')!));
    expect(menu.hidden).toBe(false);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(dispatch).not.toHaveBeenCalled();
    expect(undoDepth(view.state)).toBe(0);
  });

  it('disconnecting the editor disposes the open menu', async () => {
    const { api, view, element } = editorFixture();
    await showMenu(() => openSlashMenu(api));
    view.destroy();
    element.remove();
    await act(async () => { await Promise.resolve(); });
    expect(document.querySelector('.crepe-block-menu')).toBeNull();
  });
});
