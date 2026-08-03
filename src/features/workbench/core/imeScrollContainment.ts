type ScrollSnapshot = {
  element: HTMLElement;
  lockX: boolean;
  lockY: boolean;
  left: number;
  top: number;
};

const STRUCTURAL_BOUNDARY_SELECTOR = [
  '[data-wb-window-layer]',
  '.wb-window',
  '[data-wb-window-content]',
  '.notes-workspace',
].join(',');

function clippedAxes(element: HTMLElement): { x: boolean; y: boolean } {
  const style = getComputedStyle(element);
  const clips = (value: string) => value === 'hidden' || value === 'clip';
  return {
    x: clips(style.overflowX || style.overflow),
    y: clips(style.overflowY || style.overflow),
  };
}

function captureStructuralScroll(target: EventTarget | null, root: HTMLElement): ScrollSnapshot[] {
  if (!(target instanceof Node) || !root.contains(target)) return [];

  const snapshots: ScrollSnapshot[] = [];
  let element = target instanceof HTMLElement ? target : target.parentElement;
  while (element) {
    const axes = clippedAxes(element);
    if (axes.x || axes.y) {
      snapshots.push({
        element,
        lockX: axes.x,
        lockY: axes.y,
        left: element.scrollLeft,
        top: element.scrollTop,
      });
    }
    element = element.parentElement;
  }
  return snapshots;
}

function restoreStructuralScroll(snapshots: ScrollSnapshot[]): void {
  for (const snapshot of snapshots) {
    if (!snapshot.element.isConnected) continue;
    if (snapshot.lockX && snapshot.element.scrollLeft !== snapshot.left) {
      snapshot.element.scrollLeft = snapshot.left;
    }
    if (snapshot.lockY && snapshot.element.scrollTop !== snapshot.top) {
      snapshot.element.scrollTop = snapshot.top;
    }
  }
}

function repairLeakedStructuralScroll(root: HTMLElement): void {
  const elements = [
    root,
    ...root.querySelectorAll<HTMLElement>(STRUCTURAL_BOUNDARY_SELECTOR),
  ];
  for (const element of elements) {
    const axes = clippedAxes(element);
    if (axes.x && element.scrollLeft !== 0) element.scrollLeft = 0;
    if (axes.y && element.scrollTop !== 0) element.scrollTop = 0;
  }
}

/**
 * WebKit may scroll overflow:hidden ancestors while positioning an IME candidate
 * window. In OS mode those ancestors are window structure, not scroll viewports.
 */
export function installImeScrollContainment(root: HTMLElement): () => void {
  let snapshots: ScrollSnapshot[] = [];
  let viewportPosition: { x: number; y: number } | null = null;
  let releaseRaf = 0;
  let releaseTimer = 0;

  repairLeakedStructuralScroll(root);

  const cancelPendingRelease = () => {
    if (releaseRaf) cancelAnimationFrame(releaseRaf);
    if (releaseTimer) window.clearTimeout(releaseTimer);
    releaseRaf = 0;
    releaseTimer = 0;
  };

  const restore = () => {
    restoreStructuralScroll(snapshots);
    if (
      viewportPosition &&
      (window.scrollX !== viewportPosition.x || window.scrollY !== viewportPosition.y)
    ) {
      window.scrollTo(viewportPosition.x, viewportPosition.y);
    }
  };
  const handleCompositionStart = (event: Event) => {
    cancelPendingRelease();
    viewportPosition = { x: window.scrollX, y: window.scrollY };
    snapshots = captureStructuralScroll(event.target, root);
    restore();
  };
  const handleCompositionUpdate = () => restore();
  const handleScroll = (event: Event) => {
    if (snapshots.length === 0) return;
    if (snapshots.some((snapshot) => snapshot.element === event.target)) restore();
  };
  const handleCompositionEnd = () => {
    restore();
    // WebKit can perform its final candidate/caret reveal after compositionend.
    releaseRaf = requestAnimationFrame(() => {
      restore();
      releaseRaf = 0;
      releaseTimer = window.setTimeout(() => {
        restore();
        snapshots = [];
        viewportPosition = null;
        releaseTimer = 0;
      }, 0);
    });
  };

  root.addEventListener('compositionstart', handleCompositionStart, true);
  root.addEventListener('compositionupdate', handleCompositionUpdate, true);
  root.addEventListener('compositionend', handleCompositionEnd, true);
  root.addEventListener('scroll', handleScroll, true);
  // Centralized OS-mode boundary: window scroll is outside the React event tree.
  // eslint-disable-next-line no-restricted-syntax
  window.addEventListener('scroll', restore, true);

  return () => {
    cancelPendingRelease();
    snapshots = [];
    viewportPosition = null;
    root.removeEventListener('compositionstart', handleCompositionStart, true);
    root.removeEventListener('compositionupdate', handleCompositionUpdate, true);
    root.removeEventListener('compositionend', handleCompositionEnd, true);
    root.removeEventListener('scroll', handleScroll, true);
    window.removeEventListener('scroll', restore, true);
  };
}
