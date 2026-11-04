import React, { useEffect } from 'react';
import { act, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadInkBackground } from '../background';
import { getFrozenInkRenderInputs } from '../renderBridge';
import { composeSourceHighlights } from '../sourceHighlights';
import type { InkManifest, InkPage, InkPageRef } from '../types';
import {
  inkBackgroundBaseKey,
  inkHighlightSignature,
  useInkBackground,
  type InkBackgroundInput,
} from '../useInkBackground';

vi.mock('../background', () => ({ loadInkBackground: vi.fn() }));
vi.mock('../renderBridge', () => ({ getFrozenInkRenderInputs: vi.fn() }));
vi.mock('../sourceHighlights', () => ({ composeSourceHighlights: vi.fn() }));

const loadMock = vi.mocked(loadInkBackground);
const inputsMock = vi.mocked(getFrozenInkRenderInputs);
const composeMock = vi.mocked(composeSourceHighlights);

type CloseableBitmap = ImageBitmap & { close: ReturnType<typeof vi.fn> };

function bitmap(width = 800, height = 600): CloseableBitmap {
  return { width, height, close: vi.fn() } as unknown as CloseableBitmap;
}

function lease(background: CanvasImageSource) {
  return { background, dispose: vi.fn() };
}

function imagePage(overrides: Partial<InkPageRef> = {}): InkPageRef {
  return {
    page_id: 'page-1',
    width: 800,
    height: 600,
    page_blob_hash: 'page-hash-1',
    background: { kind: 'image', blob_hash: 'blob-1' },
    ...overrides,
  };
}

function pdfPage(overrides: Partial<InkPageRef> = {}): InkPageRef {
  return {
    page_id: 'page-1',
    width: 800,
    height: 600,
    page_blob_hash: 'page-hash-1',
    background: { kind: 'pdf_page', blob_hash: 'blob-pdf', source_page_index: 0 },
    ...overrides,
  };
}

function manifest(revision: string, overrides: Partial<InkManifest> = {}): InkManifest {
  return {
    schema_version: 1,
    document_id: 'doc-1',
    revision,
    title: 'Ink',
    source: { kind: 'blank' },
    pages: [],
    ...overrides,
  };
}

function resourceManifest(revision: string): InkManifest {
  return manifest(revision, {
    source: {
      kind: 'resource',
      resource_id: 'res-1',
      source_hash: 'a'.repeat(64),
      conversion_revision: 'v1',
    },
  });
}

const page: InkPage = { schema_version: 1, page_id: 'page-1', objects: [] };

function frozenInputs(revision: string, pageRef: InkPageRef, highlights: Array<Record<string, unknown>>) {
  return {
    revision,
    source: resourceManifest(revision).source,
    page_ref: pageRef,
    page,
    highlights,
  };
}

function input(overrides: Partial<InkBackgroundInput> = {}): InkBackgroundInput {
  return {
    documentId: 'doc-1',
    status: 'ready',
    manifest: manifest('r1'),
    pageRef: imagePage(),
    ...overrides,
  };
}

function fakeCanvas(tag: string): HTMLCanvasElement {
  return { width: 800, height: 600, tag } as unknown as HTMLCanvasElement;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface BackgroundObservation {
  pageId?: string;
  background?: CanvasImageSource;
}

/** Child passive effects run before the hook's parent effect; this mirrors InkPageView. */
function BackgroundConsumer({
  pageId,
  background,
  onObserve,
}: BackgroundObservation & { onObserve(observation: BackgroundObservation): void }) {
  useEffect(() => {
    onObserve({ pageId, background });
  }, [pageId, background, onObserve]);
  return null;
}

function BackgroundProbe({
  input: backgroundInput,
  onObserve,
}: {
  input: InkBackgroundInput;
  onObserve(observation: BackgroundObservation): void;
}) {
  const view = useInkBackground(backgroundInput);
  return (
    <BackgroundConsumer
      pageId={backgroundInput.pageRef?.page_id}
      background={view.background}
      onObserve={onObserve}
    />
  );
}

const highlight = (id: string, x = 0.1) => ({
  id,
  pageIndex: 0,
  rects: [{ x, y: 0.1, width: 0.2, height: 0.2 }],
});

beforeEach(() => {
  loadMock.mockReset();
  inputsMock.mockReset();
  composeMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useInkBackground identity', () => {
  it('keys the decoded layer by the frozen blob, not by the manifest page hash', () => {
    expect(inkBackgroundBaseKey('doc-1', imagePage({ page_blob_hash: 'saved-r2' })))
      .toBe(inkBackgroundBaseKey('doc-1', imagePage({ page_blob_hash: 'saved-r9' })));
    expect(inkBackgroundBaseKey('doc-1', imagePage({ background: { kind: 'image', blob_hash: 'other' } })))
      .not.toBe(inkBackgroundBaseKey('doc-1', imagePage()));
  });

  it('treats reordered highlight objects as the same signature', () => {
    const first = [{ b: 2, a: { d: 4, c: 3 } }];
    const second = [{ a: { c: 3, d: 4 }, b: 2 }];
    expect(inkHighlightSignature(first)).toBe(inkHighlightSignature(second));
  });
});

describe('useInkBackground lifecycle', () => {
  it('reuses the decoded bitmap across save and rename manifest/pageRef churn without clearing it', async () => {
    const base = bitmap();
    const baseLease = lease(base);
    loadMock.mockResolvedValue(baseLease);

    const seen: Array<CanvasImageSource | undefined> = [];
    const { result, rerender, unmount } = renderHook(
      (props: InkBackgroundInput) => {
        const view = useInkBackground(props);
        seen.push(view.background);
        return view;
      },
      { initialProps: input() },
    );

    await waitFor(() => expect(result.current.background).toBe(base));
    const settledAt = seen.length;

    rerender(input({ manifest: manifest('r2'), pageRef: imagePage({ page_blob_hash: 'saved-r2' }) }));
    rerender(input({ manifest: manifest('r3', { title: 'Renamed' }), pageRef: imagePage({ page_blob_hash: 'saved-r3' }) }));
    await act(async () => { await Promise.resolve(); });

    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(result.current.background).toBe(base);
    expect(seen.slice(settledAt).every((value) => value === base)).toBe(true);
    expect(baseLease.dispose).not.toHaveBeenCalled();

    unmount();
    expect(baseLease.dispose).toHaveBeenCalledTimes(1);
  });

  it('refetches highlights for each revision but keeps the composed background when they are unchanged', async () => {
    const pageRef = pdfPage();
    const base = bitmap();
    const baseLease = lease(base);
    loadMock.mockResolvedValue(baseLease);
    const composed = fakeCanvas('h1');
    composeMock.mockReturnValue(composed);
    const highlights = [highlight('h1')];
    inputsMock.mockImplementation(async (_documentId, revision, pageId) => (
      frozenInputs(revision, { ...pageRef, page_id: pageId }, structuredClone(highlights))
    ));

    const seen: Array<CanvasImageSource | undefined> = [];
    const { result, rerender, unmount } = renderHook(
      (props: InkBackgroundInput) => {
        const view = useInkBackground(props);
        seen.push(view.background);
        return view;
      },
      { initialProps: input({ manifest: resourceManifest('r1'), pageRef }) },
    );

    await waitFor(() => expect(result.current.background).toBe(composed));
    expect(inputsMock).toHaveBeenLastCalledWith('doc-1', 'r1', 'page-1');
    const settledAt = seen.length;

    rerender(input({ manifest: resourceManifest('r2'), pageRef: pdfPage() }));
    await waitFor(() => expect(inputsMock).toHaveBeenCalledTimes(2));
    await act(async () => { await Promise.resolve(); });

    expect(inputsMock).toHaveBeenLastCalledWith('doc-1', 'r2', 'page-1');
    expect(result.current.background).toBe(composed);
    expect(seen.slice(settledAt).every((value) => value === composed)).toBe(true);
    expect(composeMock).toHaveBeenCalledTimes(1);
    expect(composed.width).toBe(800);
    expect(baseLease.dispose).not.toHaveBeenCalled();

    unmount();
    expect(composed.width).toBe(0);
    expect(baseLease.dispose).toHaveBeenCalledTimes(1);
  });

  it('republishes composed highlights and disposes the old canvas only after replacement', async () => {
    const pageRef = pdfPage();
    const base = bitmap();
    const baseLease = lease(base);
    loadMock.mockResolvedValue(baseLease);
    let highlights: Array<Record<string, unknown>> = [];
    const canvases = new Map<string, HTMLCanvasElement>();
    composeMock.mockImplementation((_background, _pageRef, next) => {
      if (!next.length) return undefined;
      const canvas = fakeCanvas(String(next[0].id));
      canvases.set(String(next[0].id), canvas);
      return canvas;
    });
    inputsMock.mockImplementation(async (_documentId, revision, pageId) => (
      frozenInputs(revision, { ...pageRef, page_id: pageId }, structuredClone(highlights))
    ));

    const { result, rerender, unmount } = renderHook(
      (props: InkBackgroundInput) => useInkBackground(props),
      { initialProps: input({ manifest: resourceManifest('r1'), pageRef }) },
    );

    await waitFor(() => expect(result.current.background).toBe(base));

    highlights = [highlight('h2')];
    rerender(input({ manifest: resourceManifest('r2'), pageRef: pdfPage() }));
    await waitFor(() => expect(canvases.get('h2')).toBeDefined());
    const first = canvases.get('h2');
    await waitFor(() => expect(result.current.background).toBe(first));
    expect(first?.width).toBe(800);
    expect(baseLease.dispose).not.toHaveBeenCalled();

    highlights = [highlight('h3')];
    rerender(input({ manifest: resourceManifest('r3'), pageRef: pdfPage() }));
    await waitFor(() => expect(canvases.get('h3')).toBeDefined());
    const second = canvases.get('h3');
    await waitFor(() => expect(result.current.background).toBe(second));
    await waitFor(() => expect(first?.width).toBe(0));
    expect(baseLease.dispose).not.toHaveBeenCalled();

    unmount();
    expect(second?.width).toBe(0);
    expect(baseLease.dispose).toHaveBeenCalledTimes(1);
  });

  it('ignores a stale highlight refetch that resolves after a newer revision', async () => {
    const pageRef = pdfPage();
    const base = bitmap();
    loadMock.mockResolvedValue(lease(base));
    const canvases = new Map<string, HTMLCanvasElement>();
    composeMock.mockImplementation((_background, _pageRef, highlights) => {
      const canvas = fakeCanvas(String(highlights[0]?.id));
      canvases.set(String(highlights[0]?.id), canvas);
      return canvas;
    });
    const pending = new Map<string, ReturnType<typeof deferred<ReturnType<typeof frozenInputs>>>>();
    inputsMock.mockImplementation((_documentId, revision) => {
      const next = deferred<ReturnType<typeof frozenInputs>>();
      pending.set(revision, next);
      return next.promise;
    });

    const { result, rerender } = renderHook(
      (props: InkBackgroundInput) => useInkBackground(props),
      { initialProps: input({ manifest: resourceManifest('r1'), pageRef }) },
    );

    await act(async () => {
      pending.get('r1')?.resolve(frozenInputs('r1', pageRef, [highlight('h1')]));
    });
    await waitFor(() => expect(result.current.background).toBe(canvases.get('h1')));

    rerender(input({ manifest: resourceManifest('r2'), pageRef: pdfPage() }));
    rerender(input({ manifest: resourceManifest('r3'), pageRef: pdfPage() }));

    await act(async () => {
      pending.get('r3')?.resolve(frozenInputs('r3', pdfPage(), [highlight('h3')]));
    });
    await waitFor(() => expect(result.current.background).toBe(canvases.get('h3')));

    await act(async () => {
      pending.get('r2')?.resolve(frozenInputs('r2', pdfPage(), [highlight('h2')]));
      await Promise.resolve();
    });
    expect(result.current.background).toBe(canvases.get('h3'));
    expect(canvases.has('h2')).toBe(false);
  });

  it('clears the old page image, never publishes a late load, and disposes every bitmap', async () => {
    const first = bitmap();
    const firstLease = lease(first);
    const second = bitmap();
    const secondLease = lease(second);
    const third = bitmap();
    const thirdLease = lease(third);
    const loadSecond = deferred<ReturnType<typeof lease>>();
    const loadThird = deferred<ReturnType<typeof lease>>();
    loadMock.mockImplementation((pageRef) => {
      if (pageRef.page_id === 'page-1') return Promise.resolve(firstLease);
      if (pageRef.page_id === 'page-2') return loadSecond.promise;
      return loadThird.promise;
    });

    const { result, rerender, unmount } = renderHook(
      (props: InkBackgroundInput) => useInkBackground(props),
      { initialProps: input() },
    );
    await waitFor(() => expect(result.current.background).toBe(first));

    rerender(input({ pageRef: imagePage({ page_id: 'page-2' }) }));
    expect(result.current.background).toBeUndefined();

    rerender(input({ pageRef: imagePage({ page_id: 'page-3' }) }));
    expect(result.current.background).toBeUndefined();

    await act(async () => { loadThird.resolve(thirdLease); });
    await waitFor(() => expect(result.current.background).toBe(third));

    await act(async () => { loadSecond.resolve(secondLease); });
    expect(result.current.background).toBe(third);
    expect(secondLease.dispose).toHaveBeenCalledTimes(1);

    unmount();
    expect(firstLease.dispose).toHaveBeenCalledTimes(1);
    expect(thirdLease.dispose).toHaveBeenCalledTimes(1);
  });

  it('retries a failed base load on the next revision and clears the error on success', async () => {
    const base = bitmap();
    const baseLease = lease(base);
    loadMock.mockRejectedValueOnce(new Error('decode failed')).mockResolvedValueOnce(baseLease);

    const { result, rerender } = renderHook(
      (props: InkBackgroundInput) => useInkBackground(props),
      { initialProps: input() },
    );

    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.background).toBeUndefined();

    rerender(input({ manifest: manifest('r2'), pageRef: imagePage({ page_blob_hash: 'saved-r2' }) }));
    await waitFor(() => expect(result.current.background).toBe(base));
    expect(result.current.error).toBe(false);
    expect(loadMock).toHaveBeenCalledTimes(2);
  });
});

describe('useInkBackground visibility and replacement edges', () => {
  it('never exposes the previous page bitmap to a child effect during a page switch', async () => {
    const first = bitmap();
    const firstLease = lease(first);
    const second = bitmap();
    const secondLease = lease(second);
    const loadSecond = deferred<InkBackgroundLease>();
    loadMock.mockImplementation((pageRef) => (
      pageRef.page_id === 'page-1' ? Promise.resolve(firstLease) : loadSecond.promise
    ));

    const observations: BackgroundObservation[] = [];
    const observe = (observation: BackgroundObservation) => { observations.push(observation); };
    const { rerender } = render(<BackgroundProbe input={input()} onObserve={observe} />);

    await waitFor(() => expect(observations.some((entry) => (
      entry.pageId === 'page-1' && entry.background === first
    ))).toBe(true));
    const beforeSwitch = observations.length;

    rerender(<BackgroundProbe input={input({ pageRef: imagePage({ page_id: 'page-2' }) })} onObserve={observe} />);
    const afterSwitch = observations.slice(beforeSwitch);
    const pageTwo = afterSwitch.filter((entry) => entry.pageId === 'page-2');
    expect(pageTwo.length).toBeGreaterThan(0);
    expect(pageTwo[0]?.pageId).toBe('page-2');
    expect(pageTwo[0]?.background).toBeUndefined();
    expect(pageTwo.every((entry) => entry.background === undefined)).toBe(true);

    await act(async () => { loadSecond.resolve(secondLease); });
    await waitFor(() => expect(observations.some((entry) => (
      entry.pageId === 'page-2' && entry.background === second
    ))).toBe(true));
  });

  it('keeps the last image while a same-page blob replacement is pending, then swaps and releases it', async () => {
    const first = bitmap();
    const firstLease = lease(first);
    const second = bitmap();
    const secondLease = lease(second);
    const loadSecond = deferred<InkBackgroundLease>();
    loadMock.mockImplementation((pageRef) => (
      pageRef.background.kind === 'image' && pageRef.background.blob_hash === 'blob-1'
        ? Promise.resolve(firstLease)
        : loadSecond.promise
    ));

    const { result, rerender, unmount } = renderHook(
      (props: InkBackgroundInput) => useInkBackground(props),
      { initialProps: input() },
    );
    await waitFor(() => expect(result.current.background).toBe(first));

    rerender(input({ manifest: manifest('r2'), pageRef: imagePage({ background: { kind: 'image', blob_hash: 'blob-2' } }) }));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.background).toBe(first);
    expect(firstLease.dispose).not.toHaveBeenCalled();

    await act(async () => { loadSecond.resolve(secondLease); });
    await waitFor(() => expect(result.current.background).toBe(second));
    await waitFor(() => expect(firstLease.dispose).toHaveBeenCalledTimes(1));
    expect(secondLease.dispose).not.toHaveBeenCalled();

    unmount();
    expect(secondLease.dispose).toHaveBeenCalledTimes(1);
  });

  it('keeps the last valid image when a same-page blob replacement fails and retries it', async () => {
    const first = bitmap();
    const firstLease = lease(first);
    const second = bitmap();
    const secondLease = lease(second);
    let replacementAttempts = 0;
    loadMock.mockImplementation((pageRef) => {
      if (pageRef.background.kind === 'image' && pageRef.background.blob_hash === 'blob-1') {
        return Promise.resolve(firstLease);
      }
      replacementAttempts += 1;
      return replacementAttempts === 1
        ? Promise.reject(new Error('decode failed'))
        : Promise.resolve(secondLease);
    });
    const failedPage = imagePage({ background: { kind: 'image', blob_hash: 'blob-2' } });

    const { result, rerender, unmount } = renderHook(
      (props: InkBackgroundInput) => useInkBackground(props),
      { initialProps: input() },
    );
    await waitFor(() => expect(result.current.background).toBe(first));

    rerender(input({ manifest: manifest('r2'), pageRef: failedPage }));
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.background).toBe(first);
    expect(firstLease.dispose).not.toHaveBeenCalled();

    rerender(input({ manifest: manifest('r3'), pageRef: failedPage }));
    await waitFor(() => expect(result.current.background).toBe(second));
    expect(result.current.error).toBe(false);
    expect(firstLease.dispose).toHaveBeenCalledTimes(1);

    unmount();
    expect(secondLease.dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes a base load that resolves after unmount', async () => {
    const pending = deferred<InkBackgroundLease>();
    loadMock.mockReturnValue(pending.promise);
    const { unmount } = renderHook(() => useInkBackground(input()));

    await waitFor(() => expect(loadMock).toHaveBeenCalledTimes(1));
    unmount();

    const late = lease(bitmap());
    await act(async () => { pending.resolve(late); });
    expect(late.dispose).toHaveBeenCalledTimes(1);
  });

  it('ignores pending resource highlights after unmount: one dispose, no compose, no publish', async () => {
    const pageRef = pdfPage();
    const base = bitmap();
    const baseLease = lease(base);
    loadMock.mockResolvedValue(baseLease);
    const pendingInputs = deferred<ReturnType<typeof frozenInputs>>();
    inputsMock.mockReturnValue(pendingInputs.promise);

    const { result, unmount } = renderHook(
      (props: InkBackgroundInput) => useInkBackground(props),
      { initialProps: input({ manifest: resourceManifest('r1'), pageRef }) },
    );

    await waitFor(() => expect(inputsMock).toHaveBeenCalledTimes(1));
    expect(result.current.background).toBeUndefined();
    unmount();

    await act(async () => {
      pendingInputs.resolve(frozenInputs('r1', pageRef, [highlight('h1')]));
      await Promise.resolve();
    });

    expect(composeMock).not.toHaveBeenCalled();
    expect(baseLease.dispose).toHaveBeenCalledTimes(1);
  });

  it('does not leak or double-close bitmaps when StrictMode replays mount effects', async () => {
    const created: Array<ReturnType<typeof lease>> = [];
    loadMock.mockImplementation(() => {
      const next = lease(bitmap());
      created.push(next);
      return Promise.resolve(next);
    });
    const strictInput = input();
    const { result, unmount } = renderHook(
      () => useInkBackground(strictInput),
      { wrapper: React.StrictMode },
    );

    await waitFor(() => expect(result.current.background).toBeDefined());
    const visible = result.current.background;
    expect(created.some((entry) => entry.background === visible)).toBe(true);
    unmount();

    expect(created.length).toBeGreaterThanOrEqual(1);
    for (const entry of created) expect(entry.dispose).toHaveBeenCalledTimes(1);
  });
});
