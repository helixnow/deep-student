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

/**
 * 视口底缘的可见下界（P0-3）：
 * 移动端底部工具条（position:fixed，键盘弹出时 transform 抬升）与软键盘都会
 * 遮住滚动容器的下部。caret reveal 若只看容器 rect，光标会被顶进遮挡区。
 * 取「容器底边 / 工具条上边 / visualViewport 底边」三者最小值。
 */
function resolveVisibleBottom(boundsTop: number, boundsBottom: number): number {
  let bottom = boundsBottom;

  if (typeof document !== 'undefined') {
    const toolbar = document.querySelector<HTMLElement>('.mobile-editor-toolbar');
    if (toolbar) {
      const rect = toolbar.getBoundingClientRect();
      if (rect.height > 0 && rect.top < bottom) {
        bottom = rect.top;
      }
    }
  }

  if (typeof window !== 'undefined' && window.visualViewport) {
    const vv = window.visualViewport;
    const vvBottom = vv.offsetTop + vv.height;
    if (vvBottom < bottom) {
      bottom = vvBottom;
    }
  }

  // 遮挡极端大时保证仍有一行可见空间，避免除零式的反复滚动
  return Math.max(bottom, boundsTop + CARET_MARGIN * 2);
}

/** Keep ProseMirror caret reveal inside its real editor viewport. */
export function scrollSelectionIntoEditorViewport(view: EditorViewLike): boolean {
  const viewport = view.dom.closest<HTMLElement>(EDITOR_VIEWPORT_SELECTOR);
  if (!viewport) return false;

  const caret = view.coordsAtPos(view.state.selection.head, 1);
  const bounds = viewport.getBoundingClientRect();
  const visibleBottom = resolveVisibleBottom(bounds.top, bounds.bottom);
  let deltaY = 0;

  if (caret.top < bounds.top + CARET_MARGIN) {
    deltaY = caret.top - bounds.top - CARET_MARGIN;
  } else if (caret.bottom > visibleBottom - CARET_MARGIN) {
    deltaY = caret.bottom - visibleBottom + CARET_MARGIN;
  }

  if (deltaY !== 0) {
    const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    viewport.scrollTop = Math.max(0, Math.min(viewport.scrollTop + deltaY, maxScrollTop));
  }

  // A viewport was found, so ProseMirror must not continue through hidden OS-window ancestors.
  return true;
}
