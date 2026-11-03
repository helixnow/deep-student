import type { InkSample } from './types';
import { screenToPage, type InkViewport } from './geometry';

export interface PointerEventLike {
  clientX: number;
  clientY: number;
  pressure?: number;
  timeStamp: number;
  pointerType?: string;
  getCoalescedEvents?: () => PointerEventLike[];
}

export interface CollectPointerSampleOptions {
  terminal?: boolean;
  cancelled?: boolean;
  pageBounds?: { width: number; height: number };
}

function isFiniteEvent(eventLike: PointerEventLike): boolean {
  return Number.isFinite(eventLike.clientX) && Number.isFinite(eventLike.clientY) && Number.isFinite(eventLike.timeStamp);
}

function pressureFor(eventLike: PointerEventLike, pressureEnabled: boolean): number {
  if (!pressureEnabled || eventLike.pointerType !== 'pen' || !Number.isFinite(eventLike.pressure)) return 0.5;
  return Math.max(0, Math.min(1, eventLike.pressure as number));
}

export function pointerSample(
  eventLike: PointerEventLike,
  viewport: InkViewport,
  startedAt: number,
  pressureEnabled: boolean,
): InkSample {
  const point = screenToPage({ x: eventLike.clientX, y: eventLike.clientY }, viewport);
  const elapsed = eventLike.timeStamp - startedAt;
  return {
    x: point.x,
    y: point.y,
    pressure: pressureFor(eventLike, pressureEnabled),
    elapsed_ms: Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0,
  };
}

export function collectPointerSamples(
  eventLike: PointerEventLike,
  viewport: InkViewport,
  startedAt: number,
  pressureEnabled: boolean,
  options: CollectPointerSampleOptions = {},
): InkSample[] {
  const bounds = options.pageBounds;
  if (bounds && (!Number.isFinite(bounds.width) || !Number.isFinite(bounds.height) || bounds.width <= 0 || bounds.height <= 0)) {
    throw new RangeError('Page bounds must be finite and positive');
  }
  let events = eventLike.getCoalescedEvents?.();
  if (!events?.length) events = [eventLike];

  const samples: InkSample[] = [];
  const append = (event: PointerEventLike) => {
    if (!isFiniteEvent(event)) return;
    const sample = pointerSample(event, viewport, startedAt, pressureEnabled);
    if (bounds) {
      sample.x = Math.max(0, Math.min(bounds.width, sample.x));
      sample.y = Math.max(0, Math.min(bounds.height, sample.y));
    }
    samples.push(sample);
  };

  for (const event of events) append(event);
  if ((options.terminal || options.cancelled) && events !== undefined && events[events.length - 1] !== eventLike) {
    const lastEvent = events[events.length - 1];
    const terminalIsDifferent = !isFiniteEvent(lastEvent)
      || lastEvent.clientX !== eventLike.clientX
      || lastEvent.clientY !== eventLike.clientY
      || lastEvent.timeStamp !== eventLike.timeStamp;
    if (terminalIsDifferent) append(eventLike);
  }
  return samples;
}
