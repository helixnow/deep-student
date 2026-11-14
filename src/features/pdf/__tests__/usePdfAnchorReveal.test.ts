import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnchorRegistry } from '@/ui-kernel/services/anchors';
import { usePdfAnchorReveal } from '../interop/usePdfAnchorReveal';

let registry: AnchorRegistry;
vi.mock('@/ui-kernel/bootstrap', () => ({ getAppKernel: () => ({ anchors: registry }) }));

function setup(resourceId = 'pdf_a', numPages = 300) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  return {
    documentKey: {} as unknown,
    resourceIds: [resourceId],
    containerRef: { current: root },
    viewportRef: { current: root },
    numPages,
    onNavigate: vi.fn(),
  };
}
function addPage(root: HTMLElement, page: number) {
  const el = document.createElement('div');
  el.dataset.pageNumber = String(page);
  el.getBoundingClientRect = () => ({ width: 600, height: 900 }) as DOMRect;
  root.appendChild(el);
  return el;
}

beforeEach(() => { registry = new AnchorRegistry(); });
afterEach(() => { cleanup(); document.body.replaceChildren(); vi.useRealTimers(); });

describe('PDF reveal lifecycle', () => {
  it('routes two PDFs and a media viewer independently and unregisters only the disposed viewer', async () => {
    const a = setup();
    const b = setup('pdf_b');
    const mediaSeek = vi.fn(() => true);
    const unregisterMedia = registry.registerAnchorRevealHandler('media', { canHandle: () => 'exact-mounted', reveal: mediaSeek });
    const first = renderHook(() => usePdfAnchorReveal(a));
    renderHook(() => usePdfAnchorReveal(b));
    await act(async () => { await registry.reveal({ kind: 'pdf', resourceId: 'pdf_a', page: 218 }, { pulse: false }); });
    expect(a.onNavigate).toHaveBeenCalledWith(218);
    expect(b.onNavigate).not.toHaveBeenCalled();
    first.unmount();
    await act(async () => { await registry.reveal({ kind: 'pdf', resourceId: 'pdf_b', page: 12 }, { pulse: false }); });
    expect(b.onNavigate).toHaveBeenCalledWith(12);
    await registry.reveal({ kind: 'media', resourceId: 'lecture', startMs: 5000 });
    expect(mediaSeek).toHaveBeenCalledTimes(1);
    unregisterMedia();
  });

  it('uses latest page count/navigation after zoom and cancels the old binary document registration', async () => {
    const a = setup();
    const view = renderHook((props) => usePdfAnchorReveal(props), { initialProps: a });
    const nextNavigate = vi.fn();
    view.rerender({ ...a, numPages: 12, onNavigate: nextNavigate });
    await act(async () => { await registry.reveal({ kind: 'pdf', resourceId: 'pdf_a', page: 218 }, { pulse: false }); });
    expect(nextNavigate).toHaveBeenCalledWith(12);
    expect(a.onNavigate).not.toHaveBeenCalled();
    view.rerender({ ...a, documentKey: {}, resourceIds: ['pdf_b'], onNavigate: nextNavigate });
    const result = await registry.reveal({ kind: 'pdf', resourceId: 'pdf_a', page: 2 }, { splitIfClosed: false });
    expect(result.ok).toBe(false);
    await act(async () => { await registry.reveal({ kind: 'pdf', resourceId: 'pdf_b', page: 3 }, { pulse: false }); });
    expect(nextNavigate).toHaveBeenLastCalledWith(3);
  });

  it('retains only the last pre-load reveal and navigates when the new PDF loads', async () => {
    const options = setup('pdf_a', 0);
    const view = renderHook((props) => usePdfAnchorReveal(props), { initialProps: options });
    await act(async () => {
      await registry.reveal({ kind: 'pdf', resourceId: 'pdf_a', page: 12 }, { pulse: false });
      await registry.reveal({ kind: 'pdf', resourceId: 'pdf_a', page: 218 }, { pulse: false });
    });
    expect(options.onNavigate).not.toHaveBeenCalled();
    // 异步 VFS 别名加入不能丢掉此前的跳页意图。
    view.rerender({ ...options, resourceIds: ['pdf_a', 'vfs_a'] });
    view.rerender({ ...options, resourceIds: ['pdf_a', 'vfs_a'], numPages: 250 });
    expect(options.onNavigate).toHaveBeenCalledExactlyOnceWith(218);
  });

  it('aborts pending page timers immediately on superseding reveal, document switch and unmount', async () => {
    vi.useFakeTimers();
    const options = setup();
    const view = renderHook((props) => usePdfAnchorReveal(props), { initialProps: options });
    await act(async () => {
      await registry.reveal({ kind: 'pdf', resourceId: 'pdf_a', page: 218, quote: 'pending text' });
      await registry.reveal({ kind: 'pdf', resourceId: 'pdf_a', page: 12, quote: 'new target' });
    });
    expect(vi.getTimerCount()).toBe(1);
    view.rerender({ ...options, documentKey: {}, resourceIds: ['pdf_b'] });
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { await registry.reveal({ kind: 'pdf', resourceId: 'pdf_b', page: 2, quote: 'waiting' }); });
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clips a pulse, cancels its RAF/timer and clears it when a pulse-free reveal supersedes it', async () => {
    vi.useFakeTimers();
    const options = setup();
    addPage(options.viewportRef.current, 3);
    const view = renderHook(() => usePdfAnchorReveal(options));
    await act(async () => {
      await registry.reveal({ kind: 'pdf', resourceId: 'pdf_a', page: 3, rect: { x: 0.1, y: 0.2, w: 0.4, h: 0.1 } });
    });
    expect(view.result.current?.page).toBe(3);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await act(async () => { await registry.reveal({ kind: 'pdf', resourceId: 'pdf_a', page: 4 }, { pulse: false }); });
    expect(view.result.current).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not cancel an active pulse when the same document gains its VFS alias', async () => {
    vi.useFakeTimers();
    const options = setup();
    addPage(options.viewportRef.current, 3);
    const view = renderHook((props) => usePdfAnchorReveal(props), { initialProps: options });
    await act(async () => {
      await registry.reveal({ kind: 'pdf', resourceId: 'pdf_a', page: 3, rect: { x: 0.1, y: 0.2, w: 0.4, h: 0.1 } });
    });
    view.rerender({ ...options, resourceIds: ['pdf_a', 'vfs_a'] });
    expect(view.result.current?.page).toBe(3);
    expect(options.onNavigate).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
