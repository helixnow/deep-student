import { describe, expect, it } from 'vitest';
import type { InkViewport } from '../geometry';
import { collectPointerSamples, pointerSample } from '../input';

const viewport: InkViewport = { left: 10, top: 20, scale: 2, pan_x: 0, pan_y: 0 };
const pointer = (overrides: Record<string, unknown> = {}) => ({
  clientX: 30,
  clientY: 44,
  pressure: 0.8,
  timeStamp: 125,
  pointerType: 'pen',
  ...overrides,
});

describe('ink input', () => {
  it('maps pen coordinates, preserves pressure, and clamps elapsed time at zero', () => {
    expect(pointerSample(pointer(), viewport, 150, true)).toEqual({ x: 10, y: 12, pressure: 0.8, elapsed_ms: 0 });
  });

  it('uses midpoint pressure for mouse and when pressure input is disabled', () => {
    expect(pointerSample(pointer({ pointerType: 'mouse', pressure: 0 }), viewport, 100, true).pressure).toBe(0.5);
    expect(pointerSample(pointer({ pressure: 0.9 }), viewport, 100, false).pressure).toBe(0.5);
  });

  it('collects finite coalesced pen samples in order', () => {
    const original = pointer({
      getCoalescedEvents: () => [
        pointer({ clientX: 30, clientY: 44, timeStamp: 110 }),
        pointer({ clientX: Number.NaN, clientY: 40, timeStamp: 115 }),
        pointer({ clientX: 34, clientY: 48, timeStamp: 120 }),
      ],
    });

    expect(collectPointerSamples(original, viewport, 100, true)).toEqual([
      { x: 10, y: 12, pressure: 0.8, elapsed_ms: 10 },
      { x: 12, y: 14, pressure: 0.8, elapsed_ms: 20 },
    ]);
  });

  it('keeps a valid terminal pointerup sample', () => {
    expect(collectPointerSamples(pointer(), viewport, 100, true, { terminal: true })).toEqual([
      { x: 10, y: 12, pressure: 0.8, elapsed_ms: 25 },
    ]);
  });

  it('does not turn pointercancel coordinates into a new stroke sample', () => {
    expect(collectPointerSamples(pointer({ clientX: 0, clientY: 0 }), viewport, 100, true, {
      terminal: true, cancelled: true, pageBounds: { width: 100, height: 80 },
    })).toEqual([]);
  });

  it('does not collect cancellation coalesced events', () => {
    const getCoalescedEvents = () => [pointer({ clientX: 34, clientY: 48, timeStamp: 120 })];
    expect(collectPointerSamples(pointer({ getCoalescedEvents }), viewport, 100, true, { cancelled: true })).toEqual([]);
  });

  it('preserves intentional page-origin input and pointerup endpoints', () => {
    const origin = pointer({ clientX: viewport.left, clientY: viewport.top });
    expect(collectPointerSamples(origin, viewport, 100, true)).toEqual([
      { x: 0, y: 0, pressure: 0.8, elapsed_ms: 25 },
    ]);
    expect(collectPointerSamples(origin, viewport, 100, true, { terminal: true })).toEqual([
      { x: 0, y: 0, pressure: 0.8, elapsed_ms: 25 },
    ]);
  });
});
