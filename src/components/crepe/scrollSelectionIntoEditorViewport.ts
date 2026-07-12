const EDITOR_VIEWPORT_SELECTOR = '[data-overlayscrollbars-viewport], .scroll-area--native';
const CARET_MARGIN = 12;

type EditorViewLike = {
  dom: HTMLElement;
  state: { selection: { head: number } };
  coordsAtPos: (pos: number, side?: number) => {
    left: number;
    right: number;
    top: number;
    bottom: number;
  };
};

/** Keep ProseMirror caret reveal inside its real editor viewport. */
export function scrollSelectionIntoEditorViewport(view: EditorViewLike): boolean {
  const viewport = view.dom.closest<HTMLElement>(EDITOR_VIEWPORT_SELECTOR);
  if (!viewport) return false;

  const caret = view.coordsAtPos(view.state.selection.head, 1);
  const bounds = viewport.getBoundingClientRect();
  let deltaY = 0;

  if (caret.top < bounds.top + CARET_MARGIN) {
    deltaY = caret.top - bounds.top - CARET_MARGIN;
  } else if (caret.bottom > bounds.bottom - CARET_MARGIN) {
    deltaY = caret.bottom - bounds.bottom + CARET_MARGIN;
  }

  if (deltaY !== 0) {
    const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    viewport.scrollTop = Math.max(0, Math.min(viewport.scrollTop + deltaY, maxScrollTop));
  }

  // A viewport was found, so ProseMirror must not continue through hidden OS-window ancestors.
  return true;
}
