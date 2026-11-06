import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  INK_DIAGNOSTICS_CAPACITY,
  INK_DIAGNOSTICS_SCHEMA,
  captureInkPointerEvent,
  clearInkDiagnostics,
  getInkDiagnosticsSnapshot,
  isInkDiagnosticsEnabled,
  recordInkDiagnostic,
  setInkDiagnosticsEnabled,
  subscribeInkDiagnostics,
} from '../inkDiagnostics';

function pointerEvent(overrides: Record<string, unknown> = {}): PointerEvent {
  return {
    type: 'pointermove',
    timeStamp: 125.5,
    pointerId: 7,
    pointerType: 'pen',
    buttons: 1,
    button: 0,
    isPrimary: true,
    isTrusted: true,
    cancelable: true,
    defaultPrevented: false,
    clientX: 120,
    clientY: 240,
    pressure: 0.62,
    tiltX: 4,
    tiltY: -3,
    twist: 12,
    width: 2.5,
    height: 3.5,
    currentTarget: null,
    target: null,
    ...overrides,
  } as unknown as PointerEvent;
}

function recordData(index = 0): Record<string, unknown> {
  return { index, stage: 'unit' };
}

beforeEach(() => {
  setInkDiagnosticsEnabled(false);
  clearInkDiagnostics();
});

afterEach(() => {
  setInkDiagnosticsEnabled(false);
  clearInkDiagnostics();
});

describe('inkDiagnostics', () => {
  it('is disabled by default and does not touch pointer coalescing while off', () => {
    const getCoalescedEvents = vi.fn(() => []);
    const event = pointerEvent({ getCoalescedEvents });

    expect(isInkDiagnosticsEnabled()).toBe(false);
    expect(() => {
      recordInkDiagnostic('ignored', recordData(1));
      captureInkPointerEvent(event, { method: 'onPointerMove' });
    }).not.toThrow();

    const snapshot = getInkDiagnosticsSnapshot();
    expect(snapshot.enabled).toBe(false);
    expect(snapshot.records).toEqual([]);
    expect(getCoalescedEvents).not.toHaveBeenCalled();
  });

  it('toggles collection and preserves existing records when disabled', () => {
    const getCoalescedEvents = vi.fn(() => []);
    setInkDiagnosticsEnabled(true);
    recordInkDiagnostic('enabled-record', recordData(1));
    captureInkPointerEvent(pointerEvent({ getCoalescedEvents }), { method: 'onPointerMove' });

    expect(getCoalescedEvents).toHaveBeenCalledOnce();
    expect(getInkDiagnosticsSnapshot().records).toHaveLength(2);

    setInkDiagnosticsEnabled(false);
    recordInkDiagnostic('disabled-record', recordData(2));

    const snapshot = getInkDiagnosticsSnapshot();
    expect(snapshot.enabled).toBe(false);
    expect(snapshot.records).toHaveLength(2);
    expect(snapshot.records.map((record) => record.event)).toEqual(['enabled-record', 'pointer']);
  });

  it('keeps a bounded ring buffer with ordered sequences and explicit drops', () => {
    setInkDiagnosticsEnabled(true);
    for (let index = 0; index < INK_DIAGNOSTICS_CAPACITY + 3; index += 1) {
      recordInkDiagnostic('capacity-record', { index });
    }

    const snapshot = getInkDiagnosticsSnapshot();
    expect(snapshot.capacity).toBe(INK_DIAGNOSTICS_CAPACITY);
    expect(snapshot.retainedCount).toBe(INK_DIAGNOSTICS_CAPACITY);
    expect(snapshot.records).toHaveLength(INK_DIAGNOSTICS_CAPACITY);
    expect(snapshot.dropped).toBe(3);
    expect(snapshot.firstSequence).toBe((snapshot.lastSequence ?? 0) - INK_DIAGNOSTICS_CAPACITY + 1);
    expect(snapshot.records[0]?.data?.index).toBe(3);
    expect(snapshot.records[snapshot.records.length - 1]?.data?.index).toBe(INK_DIAGNOSTICS_CAPACITY + 2);

    for (let index = 1; index < snapshot.records.length; index += 1) {
      expect(snapshot.records[index].seq).toBe(snapshot.records[index - 1].seq + 1);
    }

    clearInkDiagnostics();
    const cleared = getInkDiagnosticsSnapshot();
    expect(cleared.records).toEqual([]);
    expect(cleared.dropped).toBe(0);
  });

  it('captures all supported pointer phases and bounded pointer fields', () => {
    setInkDiagnosticsEnabled(true);
    const target = { hasPointerCapture: vi.fn(() => true) };
    const phases = [
      'pointerdown',
      'pointermove',
      'pointerup',
      'pointercancel',
      'gotpointercapture',
      'lostpointercapture',
    ];

    for (const type of phases) {
      captureInkPointerEvent(pointerEvent({ type, currentTarget: target }), {
        method: 'onPointer',
        strokeId: 'stroke-1',
      });
    }

    const snapshot = getInkDiagnosticsSnapshot();
    expect(snapshot.records.map((record) => record.data?.phase)).toEqual([
      'down',
      'move',
      'up',
      'cancel',
      'gotcapture',
      'lostcapture',
    ]);
    const data = snapshot.records[1].data;
    expect(data).toMatchObject({
      type: 'pointermove',
      timeStamp: 125.5,
      pointerId: 7,
      pointerType: 'pen',
      buttons: 1,
      button: 0,
      isPrimary: true,
      isTrusted: true,
      cancelable: true,
      defaultPrevented: false,
      clientX: 120,
      clientY: 240,
      pressure: 0.62,
      tiltX: 4,
      tiltY: -3,
      twist: 12,
      width: 2.5,
      height: 3.5,
      hasPointerCapture: true,
      coalescedCount: 0,
      coalescedSamples: [],
      coalescedTruncated: false,
      coalescedCountCapped: false,
    });
    expect(data?.context).toEqual({ method: 'onPointer', strokeId: 'stroke-1' });
    expect(target.hasPointerCapture).toHaveBeenCalledWith(7);
  });

  it('bounds coalesced samples and reports truncation', () => {
    setInkDiagnosticsEnabled(true);
    const coalesced = Array.from({ length: 80 }, (_, index) => ({
      timeStamp: 100 + index,
      pointerId: 9,
      pointerType: 'pen',
      buttons: 1,
      button: 0,
      clientX: 40 + index,
      clientY: 50 + index,
      pressure: 0.5,
      tiltX: 1,
      tiltY: 2,
      twist: 3,
      width: 1,
      height: 1,
      isPrimary: true,
    }));

    captureInkPointerEvent(pointerEvent({ getCoalescedEvents: () => coalesced }), {});

    const data = getInkDiagnosticsSnapshot().records[0]?.data;
    const samples = data?.coalescedSamples as Array<Record<string, unknown>> | undefined;
    expect(data?.coalescedCount).toBe(80);
    expect(samples).toHaveLength(24);
    expect(data?.coalescedTruncated).toBe(true);
    expect(data?.coalescedCountCapped).toBe(false);
    expect(samples?.[23]).toMatchObject({ timeStamp: 123, clientX: 63 });
  });

  it('skips coalesced reads when includeCoalesced is false', () => {
    setInkDiagnosticsEnabled(true);
    const event = pointerEvent();
    Object.defineProperty(event, 'getCoalescedEvents', {
      configurable: true,
      get() {
        throw new Error('coalesced-getter-secret');
      },
    });

    expect(() => captureInkPointerEvent(
      event,
      { docId: 'document-1', pageId: 'page-1', active: true },
      { includeCoalesced: false },
    )).not.toThrow();

    const snapshot = getInkDiagnosticsSnapshot();
    expect(snapshot.records).toHaveLength(1);
    const data = snapshot.records[0]?.data;
    expect(data).toMatchObject({
      phase: 'move',
      pointerId: 7,
      coalescedStrategy: 'skipped',
      coalescedSkipped: true,
      context: {
        docId: 'document-1',
        pageId: 'page-1',
        active: true,
      },
    });
    expect(data?.coalescedCount).toBeUndefined();
    expect(data?.coalescedSamples).toBeUndefined();
    expect(data?.coalescedTruncated).toBeUndefined();
    expect(data?.coalescedCountCapped).toBeUndefined();
    expect(data?.coalescedFailed).toBeUndefined();
    expect(JSON.stringify(snapshot)).not.toContain('coalesced-getter-secret');
  });

  it('keeps the event when a diagnostic payload cannot be inspected', () => {
    setInkDiagnosticsEnabled(true);
    const hostilePayload = new Proxy({}, {
      getPrototypeOf: () => Object.prototype,
      ownKeys: () => {
        throw new Error('payload-secret');
      },
      get: () => {
        throw new Error('payload-get-secret');
      },
    });

    expect(() => recordInkDiagnostic('hostile-payload', hostilePayload)).not.toThrow();

    const snapshot = getInkDiagnosticsSnapshot();
    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.records[0].event).toBe('hostile-payload');
    expect(snapshot.records[0].data).toEqual({});
    expect(JSON.stringify(snapshot)).not.toContain('payload-secret');
  });

  it('keeps recording when individual event/context reads fail', () => {
    setInkDiagnosticsEnabled(true);
    const hostile = {
      get type() {
        return 'pointerdown';
      },
      get clientX(): number {
        throw new Error('client-x-secret');
      },
      get getCoalescedEvents(): never {
        throw new Error('coalesced-access-secret');
      },
    } as unknown as PointerEvent;
    const context = {};
    Object.defineProperty(context, 'method', {
      enumerable: true,
      get() {
        throw new Error('context-secret');
      },
    });

    expect(() => captureInkPointerEvent(hostile, context)).not.toThrow();

    const snapshot = getInkDiagnosticsSnapshot();
    expect(snapshot.records).toHaveLength(1);
    const data = snapshot.records[0].data;
    expect(data?.phase).toBe('down');
    expect(data?.clientX).toBeUndefined();
    expect(data?.coalescedFailed).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('secret');
  });

  it('keeps a pointer record when getCoalescedEvents throws', () => {
    setInkDiagnosticsEnabled(true);
    const event = pointerEvent({
      getCoalescedEvents: () => {
        throw new Error('coalesced-secret-message');
      },
    });

    expect(() => captureInkPointerEvent(event, { method: 'onPointerMove' })).not.toThrow();

    const snapshot = getInkDiagnosticsSnapshot();
    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.records[0].data).toMatchObject({
      phase: 'move',
      pointerId: 7,
      coalescedCount: 0,
      coalescedFailed: true,
    });
    expect(JSON.stringify(snapshot)).not.toContain('coalesced-secret-message');
  });

  it('sanitizes cycles, errors, DOM nodes, and unbounded strings', () => {
    setInkDiagnosticsEnabled(true);
    const circular: Record<string, unknown> = { stage: 'cycle' };
    circular.self = circular;
    const error = Object.assign(new Error('error-secret-message'), {
      code: 'E_INK_TEST',
      stack: 'error-secret-stack',
      pageText: 'error-secret-page-text',
    });

    expect(() => recordInkDiagnostic('complex', {
      circular,
      error,
      lastError: 'TypeError: raw-error-secret',
      errorCode: 'E_VISIBLE_METADATA',
      text: 'secret-document-text',
      html: '<html>secret-page</html>',
      huge: 'x'.repeat(10_000),
      node: document.body,
    })).not.toThrow();

    const snapshot = getInkDiagnosticsSnapshot();
    const serialized = JSON.stringify(snapshot);
    expect(() => JSON.parse(serialized)).not.toThrow();
    expect(serialized).not.toContain('error-secret-message');
    expect(serialized).not.toContain('error-secret-stack');
    expect(serialized).not.toContain('error-secret-page-text');
    expect(serialized).not.toContain('raw-error-secret');
    expect(serialized).not.toContain('secret-document-text');
    expect(serialized).not.toContain('secret-page');

    const data = snapshot.records[0]?.data;
    expect(data?.circular).toEqual({ stage: 'cycle', self: '[circular]' });
    expect(data?.error).toEqual({ name: 'Error', code: 'E_INK_TEST' });
    expect(data?.lastError).toBeUndefined();
    expect(data?.errorCode).toBe('E_VISIBLE_METADATA');
    expect(data?.text).toBeUndefined();
    expect(data?.html).toBeUndefined();
    expect(data?.node).toBe('[dom-node]');
    expect(typeof data?.huge).toBe('string');
    expect((data?.huge as string).length).toBeLessThanOrEqual(160);
  });

  it('bounds scanning of long whitespace-only diagnostic strings', () => {
    setInkDiagnosticsEnabled(true);
    recordInkDiagnostic('whitespace', { stage: ' '.repeat(10_000) + 'outside-budget' });
    expect(getInkDiagnosticsSnapshot().records[0]?.data?.stage).toBe('');
  });

  it('returns a deeply frozen, isolated JSON snapshot', () => {
    setInkDiagnosticsEnabled(true);
    recordInkDiagnostic('immutable', {
      nested: { count: 1, values: [1, 2, 3] },
    });

    const snapshot = getInkDiagnosticsSnapshot();
    const before = JSON.stringify(snapshot);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.records)).toBe(true);
    expect(Object.isFrozen(snapshot.records[0])).toBe(true);
    expect(Object.isFrozen(snapshot.records[0].data)).toBe(true);
    expect(Object.isFrozen(snapshot.records[0].data?.nested)).toBe(true);

    expect(() => (snapshot.records as unknown as unknown[]).push({})).toThrow();
    expect(() => {
      (snapshot.records[0].data as Record<string, unknown>).tampered = true;
    }).toThrow();
    expect(JSON.stringify(snapshot)).toBe(before);

    recordInkDiagnostic('immutable', { nested: { count: 2 } });
    const fresh = getInkDiagnosticsSnapshot();
    expect(fresh.records).toHaveLength(2);
    expect(fresh.records[0].data?.nested).toEqual({ count: 1, values: [1, 2, 3] });
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  it('isolates throwing listeners and does not notify for individual records', () => {
    const throwingListener = vi.fn(() => {
      throw new Error('listener-failure');
    });
    const healthyListener = vi.fn();
    const unsubscribeThrowing = subscribeInkDiagnostics(throwingListener);
    const unsubscribeHealthy = subscribeInkDiagnostics(healthyListener);

    expect(throwingListener).not.toHaveBeenCalled();
    expect(() => setInkDiagnosticsEnabled(true)).not.toThrow();
    expect(throwingListener).toHaveBeenCalledOnce();
    expect(healthyListener).toHaveBeenCalledOnce();

    for (let index = 0; index < 25; index += 1) {
      recordInkDiagnostic('listener-record', { index });
      captureInkPointerEvent(pointerEvent(), { method: 'onPointerMove' });
    }
    expect(throwingListener).toHaveBeenCalledOnce();
    expect(healthyListener).toHaveBeenCalledOnce();

    expect(() => setInkDiagnosticsEnabled(false)).not.toThrow();
    expect(throwingListener).toHaveBeenCalledTimes(2);
    expect(healthyListener).toHaveBeenCalledTimes(2);

    unsubscribeThrowing();
    unsubscribeThrowing();
    unsubscribeHealthy();
  });

  it('notifies once for clear, even while disabled, and unsubscribes idempotently', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeInkDiagnostics(listener);

    clearInkDiagnostics();
    expect(listener).toHaveBeenCalledOnce();

    unsubscribe();
    clearInkDiagnostics();
    expect(listener).toHaveBeenCalledOnce();
  });

  it('keeps document/page/canvas/selection metadata without document content', () => {
    setInkDiagnosticsEnabled(true);
    recordInkDiagnostic('page.render.start', {
      documentId: 'document-1',
      docId: 'document-1',
      pageId: 'page-1',
      canvasWidth: 1024,
      canvasHeight: 768,
      selectionMode: 'lasso',
      documentText: 'secret-document-body',
      documentBody: 'secret-document-body',
      selectionText: 'secret-selection-text',
      stack: 'secret-stack-trace',
    });

    const snapshot = getInkDiagnosticsSnapshot();
    const data = snapshot.records[0]?.data;
    expect(data).toMatchObject({
      documentId: 'document-1',
      docId: 'document-1',
      pageId: 'page-1',
      canvasWidth: 1024,
      canvasHeight: 768,
      selectionMode: 'lasso',
    });
    expect(data?.documentText).toBeUndefined();
    expect(data?.documentBody).toBeUndefined();
    expect(data?.selectionText).toBeUndefined();
    expect(data?.stack).toBeUndefined();
    expect(JSON.stringify(snapshot)).not.toContain('secret');
  });

  it('keeps critical pointer context fields beyond the 32-key cap', () => {
    setInkDiagnosticsEnabled(true);
    const context: Record<string, unknown> = {};
    for (let index = 0; index < 40; index += 1) context[`filler${index}`] = index;
    context.docId = 'document-1';
    context.documentId = 'document-1';
    context.pageId = 'page-1';
    context.active = true;
    context.canvasWidth = 1024;
    context.canvasHeight = 768;
    context.selectionMode = 'lasso';

    captureInkPointerEvent(pointerEvent(), context);

    const storedContext = getInkDiagnosticsSnapshot().records[0]?.data?.context as
      | Record<string, unknown>
      | undefined;
    expect(storedContext).toMatchObject({
      docId: 'document-1',
      documentId: 'document-1',
      pageId: 'page-1',
      active: true,
      canvasWidth: 1024,
      canvasHeight: 768,
      selectionMode: 'lasso',
    });
    expect(Object.keys(storedContext ?? {}).length).toBeLessThanOrEqual(32);
  });

  it('keeps pointer context ahead of a crowded top-level payload', () => {
    setInkDiagnosticsEnabled(true);
    const data: Record<string, unknown> = {};
    for (let index = 0; index < 40; index += 1) data[`filler${index}`] = index;
    data.context = { docId: 'document-1', pageId: 'page-1', active: true };

    recordInkDiagnostic('pointer', data);

    expect(getInkDiagnosticsSnapshot().records[0]?.data?.context).toMatchObject({
      docId: 'document-1',
      pageId: 'page-1',
      active: true,
    });
  });

  it('exposes schema, capacity, sequence timing, and environment metadata', () => {
    setInkDiagnosticsEnabled(true);
    recordInkDiagnostic('meta', { index: 1 });
    recordInkDiagnostic('meta', { index: 2 });

    const snapshot = getInkDiagnosticsSnapshot();
    expect(snapshot.schema).toBe(INK_DIAGNOSTICS_SCHEMA);
    expect(snapshot.capacity).toBe(INK_DIAGNOSTICS_CAPACITY);
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.userAgent).toBeTypeOf('string');
    expect(snapshot.pixelRatio).toBeTypeOf('number');
    expect(snapshot.environment.language).toBeTypeOf('string');
    expect(snapshot.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(snapshot.records[0].wallTimeMs).toBeTypeOf('number');
    expect(snapshot.records[0].monotonicMs).toBeTypeOf('number');
    expect(snapshot.records[1].seq).toBe(snapshot.records[0].seq + 1);
    expect(snapshot.records[1].monotonicMs).toBeGreaterThanOrEqual(snapshot.records[0].monotonicMs);
  });
});
