import { afterEach, describe, expect, it, vi } from 'vitest';
import { addTypedEventListener } from '@/events/registry';
import type { SemanticAnchor } from '../contracts/interop';
import { getAppKernel } from '../bootstrap';

vi.mock('../../shared/workbenchHost', () => ({ isWorkbenchHostEnabled: () => true }));
vi.mock('../../events/app', () => ({
  APP_EVENTS: { NAVIGATE_TO_VIEW: 'NAVIGATE_TO_VIEW', NAVIGATE_TO_EXAM_SHEET: 'navigateToExamSheet' },
  dispatchAppEvent: vi.fn(),
}));

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach((dispose) => dispose()); });

describe('bootstrap typed anchor host events', () => {
  it.each([
    [{ kind: 'pdf', resourceId: 'pdf', page: 3, quote: '摘录' }, 'DSTU_FOCUS_PDF', { sourceId: 'pdf', page: 3, quote: '摘录', splitIfClosed: true }],
    [{ kind: 'media', resourceId: 'video', startMs: 1250, endMs: 5000 }, 'DSTU_FOCUS_MEDIA', { resourceId: 'video', seconds: 1.25, startMs: 1250, endMs: 5000 }],
    [{ kind: 'note', resourceId: 'note', blockId: 'block' }, 'DSTU_OPEN_NOTE', { noteId: 'note', blockId: 'block' }],
    [{ kind: 'mindmap', resourceId: 'map', nodeId: 'node' }, 'DSTU_FOCUS_MINDMAP', { mindmapId: 'map', nodeId: 'node' }],
    [{ kind: 'qbank', resourceId: 'bank', questionId: 'question' }, 'DSTU_FOCUS_QBANK', { bankId: 'bank', questionId: 'question' }],
  ] as const)('preserves the %s anchor payload and event target', async (rawAnchor, eventName, expected) => {
    const anchor = rawAnchor as SemanticAnchor;
    const kernel = getAppKernel();
    const received = vi.fn();
    cleanups.push(addTypedEventListener(eventName, (detail) => {
      received(detail);
      cleanups.push(kernel.anchors.registerAnchorRevealHandler(anchor.kind, { canHandle: () => 'exact-mounted', reveal: () => true }));
    }));
    const documentEvent = vi.fn();
    if (anchor.kind === 'pdf' || anchor.kind === 'media') {
      cleanups.push(addTypedEventListener(anchor.kind === 'pdf' ? 'pdf-ref:open' : 'media-ref:open', documentEvent, undefined, 'document'));
    }
    expect(await kernel.anchors.reveal(anchor)).toMatchObject({ ok: true, outcome: 'opened-and-revealed' });
    expect(received).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(expected));
    if (anchor.kind === 'pdf' || anchor.kind === 'media') expect(documentEvent).toHaveBeenCalledTimes(1);
  });
});
