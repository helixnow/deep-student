import { describe, expect, it, vi } from 'vitest';
import { AnchorRegistry } from '../services/anchors';

const anchor = { kind: 'pdf', resourceId: 'file_cold', page: 218 } as const;

describe('anchor reveal lifecycle', () => {
  it('does not open a cold pane after immediate caller cancellation', async () => {
    const openAnchor = vi.fn(() => true);
    const registry = new AnchorRegistry({ openAnchor });
    const controller = new AbortController();
    const result = registry.reveal(anchor, { signal: controller.signal });
    controller.abort();
    expect(await result).toMatchObject({ ok: false, outcome: 'unhandled' });
    expect(openAnchor).not.toHaveBeenCalled();
    registry.dispose();
  });
  it('waits for a cold viewer mounted 80ms after the host opens its tab', async () => {
    const reveal = vi.fn(() => true);
    const registry = new AnchorRegistry({ pendingRevealTimeoutMs: 250, openAnchor: () => {
      setTimeout(() => registry.registerAnchorRevealHandler('pdf', { canHandle: () => 'exact-mounted', reveal }), 80);
      return true;
    } });
    expect(await registry.reveal(anchor)).toMatchObject({ ok: true, outcome: 'opened-and-revealed' });
    expect(reveal).toHaveBeenCalledWith(anchor, expect.objectContaining({ pulse: true }));
    registry.dispose();
  });

  it('retries a viewer registered before its document becomes ready', async () => {
    let ready = false;
    const reveal = vi.fn(() => ready);
    const registry = new AnchorRegistry({ pendingRevealTimeoutMs: 200, openAnchor: () => {
      registry.registerAnchorRevealHandler('pdf', { canHandle: () => 'exact-mounted', reveal });
      setTimeout(() => { ready = true; }, 60);
      return true;
    } });
    expect(await registry.reveal(anchor)).toMatchObject({ ok: true, outcome: 'opened-and-revealed' });
    expect(reveal.mock.calls.length).toBeGreaterThan(1);
    registry.dispose();
  });

  it('does not invoke an unmounted handler queued during registration', async () => {
    const stale = vi.fn(() => true);
    const replacement = vi.fn(() => true);
    const registry = new AnchorRegistry({ pendingRevealTimeoutMs: 200, openAnchor: () => {
      const dispose = registry.registerAnchorRevealHandler('pdf', { canHandle: () => 'exact-mounted', reveal: stale });
      dispose();
      registry.registerAnchorRevealHandler('pdf', { canHandle: () => 'exact-mounted', reveal: replacement });
      return true;
    } });
    expect(await registry.reveal(anchor)).toMatchObject({ ok: true, outcome: 'opened-and-revealed' });
    expect(stale).not.toHaveBeenCalled();
    expect(replacement).toHaveBeenCalledTimes(1);
    registry.dispose();
  });

  it('falls back to another mounted handler when the preferred one throws', async () => {
    const onError = vi.fn();
    const registry = new AnchorRegistry({ onError });
    const healthy = vi.fn(() => true);
    registry.registerAnchorRevealHandler('pdf', { canHandle: () => 'exact-mounted', reveal: healthy });
    registry.registerAnchorRevealHandler('pdf', { canHandle: () => 'exact-focused', reveal: () => { throw new Error('unmounted'); } });
    expect(await registry.reveal(anchor)).toMatchObject({ ok: true, outcome: 'revealed-in-open-pane' });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledTimes(1);
    registry.dispose();
  });

  it('waits for a replacement after a cold handler throws', async () => {
    const onError = vi.fn();
    const registry = new AnchorRegistry({ pendingRevealTimeoutMs: 200, onError, openAnchor: () => {
      registry.registerAnchorRevealHandler('pdf', { canHandle: () => 'exact-mounted', reveal: () => { throw new Error('failed viewer'); } });
      setTimeout(() => registry.registerAnchorRevealHandler('pdf', { canHandle: () => 'exact-mounted', reveal: () => true }), 50);
      return true;
    } });
    expect(await registry.reveal(anchor)).toMatchObject({ ok: true, outcome: 'opened-and-revealed' });
    expect(onError).toHaveBeenCalledTimes(1);
    registry.dispose();
  });

  it('bounds a hung host opener by the pending reveal timeout', async () => {
    const registry = new AnchorRegistry({ pendingRevealTimeoutMs: 30, openAnchor: () => new Promise<boolean>(() => {}) });
    expect(await registry.reveal(anchor)).toMatchObject({ ok: false, outcome: 'unhandled' });
    registry.dispose();
  });

  it('ignores already-aborted calls without opening or revealing anything', async () => {
    const openAnchor = vi.fn(() => true);
    const reveal = vi.fn(() => true);
    const registry = new AnchorRegistry({ openAnchor });
    registry.registerAnchorRevealHandler('pdf', { canHandle: () => 'exact-mounted', reveal });
    const controller = new AbortController();
    controller.abort();
    expect(await registry.reveal(anchor, { signal: controller.signal })).toMatchObject({ ok: false });
    expect(openAnchor).not.toHaveBeenCalled();
    expect(reveal).not.toHaveBeenCalled();
    registry.dispose();
  });

  it('cancels a fast-path handler on unmount and retries via the host', async () => {
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    let receivedSignal: AbortSignal | undefined;
    const registry = new AnchorRegistry({ pendingRevealTimeoutMs: 200, openAnchor: () => {
      registry.registerAnchorRevealHandler('pdf', { canHandle: () => 'exact-mounted', reveal: () => true });
      return true;
    } });
    const dispose = registry.registerAnchorRevealHandler('pdf', { canHandle: () => 'exact-mounted', reveal: (_anchor, ctx) => {
      receivedSignal = ctx.signal;
      started();
      return new Promise<boolean>(() => {});
    } });
    const result = registry.reveal(anchor);
    await ready;
    dispose();
    expect(await result).toMatchObject({ ok: true, outcome: 'opened-and-revealed' });
    expect(receivedSignal?.aborted).toBe(true);
    registry.dispose();
  });

  it('cancels claimed waiters when the registry is disposed', async () => {
    let claimed!: () => void;
    const started = new Promise<void>(resolve => { claimed = resolve; });
    const registry = new AnchorRegistry({ pendingRevealTimeoutMs: 10_000, openAnchor: () => {
      registry.registerAnchorRevealHandler('pdf', { canHandle: () => 'exact-mounted', reveal: () => {
        claimed();
        return new Promise<boolean>(() => {});
      } });
      return true;
    } });
    const pending = registry.reveal(anchor);
    await started;
    registry.dispose();
    expect(await pending).toMatchObject({ ok: false, outcome: 'unhandled' });
  });
});
