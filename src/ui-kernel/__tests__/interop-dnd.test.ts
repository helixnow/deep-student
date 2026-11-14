import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineUiPlugin, UiKernel } from '../kernel';
import { clearActiveExcerptDrag, ExcerptDndHub } from '../services/excerpt-dnd';
import {
  DS_EXCERPT_MIME,
  hasExcerptMime,
  readExcerptDrag,
  sanitizeExcerptDragPayload,
  startExcerptDrag,
  type ExcerptDragPayload,
} from '../../ui-sdk';

const WB_RESOURCE_MIME = 'application/x-deepstudent-resource';

interface MockDataTransfer {
  data: Map<string, string>;
  types: string[];
  effectAllowed: DataTransfer['effectAllowed'];
  dropEffect: DataTransfer['dropEffect'];
  setData: (format: string, value: string) => void;
  getData: (format: string) => string;
}

function createMockDataTransfer(options?: { hideGetData?: boolean; presetTypes?: string[] }): MockDataTransfer {
  const data = new Map<string, string>();
  const types = options?.presetTypes ? [...options.presetTypes] : [];
  return {
    data,
    types,
    effectAllowed: 'uninitialized',
    dropEffect: 'none',
    setData(format: string, value: string) {
      data.set(format, value);
      if (!types.includes(format)) types.push(format);
    },
    getData(format: string) {
      if (options?.hideGetData) return '';
      return data.get(format) ?? '';
    },
  };
}

function createDragEvent(type: string, dataTransfer?: MockDataTransfer): DragEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
  if (dataTransfer) {
    Object.defineProperty(event, 'dataTransfer', {
      value: dataTransfer,
      configurable: true,
    });
  }
  return event;
}

let kernel: UiKernel | undefined;

afterEach(async () => {
  clearActiveExcerptDrag();
  await kernel?.dispose();
  kernel = undefined;
});

describe('Cross-Plugin Interop Protocol v1 - ExcerptDndHub & Auto-Excerpt Bus', () => {
  it('isolates rejected async subscribers and drop handlers', async () => {
    const onError = vi.fn();
    const hub = new ExcerptDndHub({ onError });
    const input = { excerptKind: 'text' as const, text: '摘录', anchor: { kind: 'pdf' as const, resourceId: 'file_async', page: 1 } };
    const healthy = vi.fn();
    hub.subscribeAutoExcerpt(async () => { throw new Error('async subscriber'); });
    hub.subscribeAutoExcerpt(healthy);
    expect(hub.emitAutoExcerpt(input)).not.toBeNull();
    await Promise.resolve();
    expect(healthy).toHaveBeenCalledTimes(1);
    const element = document.createElement('div');
    hub.registerExcerptDropTarget(element, async () => { throw new Error('async drop'); });
    const dt = createMockDataTransfer();
    hub.startExcerptDrag({ dataTransfer: dt as unknown as DataTransfer }, input);
    element.dispatchEvent(createDragEvent('drop', dt));
    await Promise.resolve();
    expect(onError).toHaveBeenCalledTimes(2);
    hub.dispose();
  });
  it('writes DS_EXCERPT_MIME, text/uri-list, and cited text/plain without touching WB_RESOURCE_MIME', () => {
    kernel = new UiKernel();
    const dt = createMockDataTransfer();
    const dragStartEvent = createDragEvent('dragstart', dt);

    const payload = kernel.dnd.startExcerptDrag(dragStartEvent, {
      excerptKind: 'text',
      text: '矩阵的特征值在相似变换下保持不变',
      anchor: {
        kind: 'pdf',
        resourceId: 'tb_linalg',
        page: 12,
        rect: { x: 0.1, y: 0.2, w: 0.5, h: 0.08 },
      },
      sourceTitle: '线性代数讲义',
      createdAt: 1700000000000,
    });

    expect(payload).not.toBeNull();
    expect(dt.types).toEqual([DS_EXCERPT_MIME, 'text/uri-list', 'text/plain']);
    expect(dt.data.has(WB_RESOURCE_MIME)).toBe(false);
    expect(dt.effectAllowed).toBe('copyLink');

    expect(dt.getData('text/uri-list')).toBe(payload!.anchorUri);
    expect(dt.getData('text/plain')).toBe(
      `> 矩阵的特征值在相似变换下保持不变\n> \u2014 [线性代数讲义 \u00b7 p.12](${payload!.anchorUri})`,
    );

    const parsedBack = readExcerptDrag(dragStartEvent);
    expect(parsedBack).toEqual(payload);

    // Chromium dragover restriction simulation: types contains DS_EXCERPT_MIME, getData returns ""
    const dragOverDt = createMockDataTransfer({
      hideGetData: true,
      presetTypes: [DS_EXCERPT_MIME, 'text/plain'],
    });
    const dragOverEvent = createDragEvent('dragover', dragOverDt);
    expect(hasExcerptMime(dragOverEvent)).toBe(true);
    expect(readExcerptDrag(dragOverEvent)).toEqual(payload);
  });

  it('rejects untrusted or tampered ExcerptDragPayload inputs', () => {
    expect(
      sanitizeExcerptDragPayload({
        excerptKind: 'text',
        text: 'bad anchor',
        anchor: { kind: 'pdf', resourceId: 'doc', page: 0 },
      }),
    ).toBeNull();

    expect(
      sanitizeExcerptDragPayload({
        excerptKind: 'region-image',
        text: 'xss image',
        imageDataUrl: 'javascript:alert(1)',
        anchor: { kind: 'pdf', resourceId: 'doc', page: 2 },
      }),
    ).toBeNull();

    expect(
      sanitizeExcerptDragPayload({
        version: 2,
        excerptKind: 'text',
        text: 'wrong version',
        anchor: { kind: 'pdf', resourceId: 'doc', page: 2 },
      }),
    ).toBeNull();
  });

  it('tracks nested dragenter/dragleave depth, ignores Files and WB_RESOURCE_MIME, delivers payload on drop, and cleans up on plugin disposal', async () => {
    kernel = new UiKernel();
    const hostEl = document.createElement('div');
    const childEl = document.createElement('span');
    hostEl.appendChild(childEl);
    document.body.appendChild(hostEl);

    const dropped: ExcerptDragPayload[] = [];

    try {
      await kernel.install(
        defineUiPlugin({
          meta: { id: 'community.drop-consumer' },
          apply(ctx) {
            ctx.ui.dnd.registerExcerptDropTarget(hostEl, (payload) => {
              dropped.push(payload);
            });
          },
        }),
      );

      expect(hostEl.dataset.dsExcerptDrop).toBe('idle');

      // Start an excerpt drag session first to ensure activeDragSession does NOT hijack non-excerpt drags!
      const excerptDt = createMockDataTransfer();
      startExcerptDrag(createDragEvent('dragstart', excerptDt), {
        excerptKind: 'transcript-cue',
        text: '卷积定理推导',
        anchor: { kind: 'media', resourceId: 'vid_01', startMs: 862_000 },
        sourceTitle: '信号与系统',
      });

      // 1. Native OS Files drag MUST pass through untouched (no preventDefault, no stopPropagation, stays idle).
      const filesDt = createMockDataTransfer({ presetTypes: ['Files'] });
      const filesEnter = createDragEvent('dragenter', filesDt);
      let bubbledToBody = false;
      const onBodyEnter = () => {
        bubbledToBody = true;
      };
      document.body.addEventListener('dragenter', onBodyEnter);
      hostEl.dispatchEvent(filesEnter);
      document.body.removeEventListener('dragenter', onBodyEnter);

      expect(filesEnter.defaultPrevented).toBe(false);
      expect(bubbledToBody).toBe(true);
      expect(hostEl.dataset.dsExcerptDrop).toBe('idle');

      // 2. Workbench resource drag (WB_RESOURCE_MIME) MUST pass through untouched.
      const wbDt = createMockDataTransfer({ presetTypes: [WB_RESOURCE_MIME, 'text/plain'] });
      const wbOver = createDragEvent('dragover', wbDt);
      hostEl.dispatchEvent(wbOver);
      expect(wbOver.defaultPrevented).toBe(false);
      expect(hostEl.dataset.dsExcerptDrop).toBe('idle');

      // 3. Nested dragenter (host -> child) and dragleave (host -> out) depth tracking.
      const enterParent = createDragEvent('dragenter', excerptDt);
      hostEl.dispatchEvent(enterParent);
      expect(enterParent.defaultPrevented).toBe(true);
      expect(hostEl.dataset.dsExcerptDrop).toBe('over');

      const enterChild = createDragEvent('dragenter', excerptDt);
      childEl.dispatchEvent(enterChild);
      expect(hostEl.dataset.dsExcerptDrop).toBe('over');

      // Leaving parent into child reduces depth 2 -> 1 (remains 'over').
      hostEl.dispatchEvent(createDragEvent('dragleave', excerptDt));
      expect(hostEl.dataset.dsExcerptDrop).toBe('over');

      // Leaving child out of container reduces depth 1 -> 0 (returns to 'idle').
      childEl.dispatchEvent(createDragEvent('dragleave', excerptDt));
      expect(hostEl.dataset.dsExcerptDrop).toBe('idle');

      // 4. Re-enter and drop delivers sanitized payload and resets state to 'idle'.
      hostEl.dispatchEvent(createDragEvent('dragenter', excerptDt));
      expect(hostEl.dataset.dsExcerptDrop).toBe('over');

      const dropEvent = createDragEvent('drop', excerptDt);
      hostEl.dispatchEvent(dropEvent);
      expect(dropEvent.defaultPrevented).toBe(true);
      expect(hostEl.dataset.dsExcerptDrop).toBe('idle');
      expect(dropped).toHaveLength(1);
      expect(dropped[0].text).toBe('卷积定理推导');
      expect(dropped[0].anchor).toEqual({
        kind: 'media',
        resourceId: 'vid_01',
        startMs: 862_000,
      });

      // 5. Unloading the plugin resets state to 'idle' and detaches listeners.
      startExcerptDrag(createDragEvent('dragstart', excerptDt), {
        excerptKind: 'text',
        text: '第二条摘录',
        anchor: { kind: 'pdf', resourceId: 'doc_2', page: 3 },
      });
      hostEl.dispatchEvent(createDragEvent('dragenter', excerptDt));
      expect(hostEl.dataset.dsExcerptDrop).toBe('over');

      await kernel.unload('community.drop-consumer');
      expect(hostEl.dataset.dsExcerptDrop).toBe('idle');

      hostEl.dispatchEvent(createDragEvent('drop', excerptDt));
      expect(dropped).toHaveLength(1);
    } finally {
      hostEl.remove();
    }
  });

  it('fans out emitAutoExcerpt across subscribers, isolates subscriber errors, and unsubscribes on plugin unload', async () => {
    const errors: unknown[] = [];
    kernel = new UiKernel();

    const receivedA: string[] = [];
    const receivedB: string[] = [];

    await kernel.install(
      defineUiPlugin({
        meta: { id: 'community.auto-faulty' },
        apply(ctx) {
          ctx.ui.dnd.subscribeAutoExcerpt((payload) => {
            receivedA.push(payload.text);
            throw new Error('faulty consumer');
          });
        },
      }),
    );

    await kernel.install(
      defineUiPlugin({
        meta: { id: 'community.auto-healthy' },
        apply(ctx) {
          ctx.ui.dnd.subscribeAutoExcerpt((payload) => {
            receivedB.push(`${payload.text}@${payload.anchorUri}`);
          });
        },
      }),
    );

    const emitted = kernel.dnd.emitAutoExcerpt({
      excerptKind: 'text',
      text: '拉格朗日中值定理',
      anchor: { kind: 'pdf', resourceId: 'tb_calc', page: 88 },
    });

    expect(emitted).not.toBeNull();
    expect(receivedA).toEqual(['拉格朗日中值定理']);
    expect(receivedB).toEqual(['拉格朗日中值定理@ds-anchor://v1/pdf/tb_calc?page=88']);
    expect(errors).toEqual([]);

    // Unload healthy plugin; subsequent emissions no longer reach it.
    await kernel.unload('community.auto-healthy');
    const second = vi.fn();
    const offManual = kernel.dnd.subscribeAutoExcerpt((p) => second(p.text));

    kernel.dnd.emitAutoExcerpt({
      excerptKind: 'text',
      text: '柯西中值定理',
      anchor: { kind: 'pdf', resourceId: 'tb_calc', page: 89 },
    });

    expect(receivedB).toHaveLength(1);
    expect(second).toHaveBeenCalledWith('柯西中值定理');
    offManual();
  });
});
