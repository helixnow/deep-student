import React, { StrictMode } from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InkBackgroundLease } from '../background';
import type { InkManifest, InkPage, InkPageRef } from '../types';

const documentId = 'ink-background-document';

const mocks = vi.hoisted(() => ({
  docState: { current: undefined as unknown },
  loadInkBackground: vi.fn(),
  getFrozenInkRenderInputs: vi.fn(),
  composeSourceHighlights: vi.fn(),
  renders: [] as Array<{ background: unknown; pageId: string; closed: boolean }>,
}));

vi.mock('../useInkDocument', () => ({
  useInkDocument: () => mocks.docState.current,
}));

vi.mock('../background', () => ({
  loadInkBackground: mocks.loadInkBackground,
}));

vi.mock('../renderBridge', () => ({
  getFrozenInkRenderInputs: mocks.getFrozenInkRenderInputs,
}));

vi.mock('../sourceHighlights', () => ({
  composeSourceHighlights: mocks.composeSourceHighlights,
}));

vi.mock('../InkToolbar', () => ({ InkToolbar: () => null }));

vi.mock('../editorSession', () => ({
  flushInkEditor: vi.fn(async () => ({ ok: true })),
  registerInkEditorSession: vi.fn(() => () => undefined),
}));

function isClosedBackground(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { __closed?: boolean; width?: number; height?: number };
  return candidate.__closed === true || (candidate.width === 0 && candidate.height === 0);
}

vi.mock('../InkPageView', async () => {
  const ReactModule = await import('react');
  const MockInkPageView = ReactModule.forwardRef(function MockInkPageView(props: any, ref: any) {
    mocks.renders.push({
      background: props.background,
      pageId: props.pageRef.page_id,
      closed: isClosedBackground(props.background),
    });
    ReactModule.useImperativeHandle(ref, () => ({
      finishStroke: async () => undefined,
      eraseAt: async () => undefined,
      getViewportCenter: () => ({ x: 0, y: 0 }),
    }), []);
    return ReactModule.createElement('div', {
      'data-testid': 'ink-page-surface-mock',
      'data-page-id': props.pageRef.page_id,
    });
  });
  return { InkPageView: MockInkPageView };
});

import { InkEditor } from '../InkEditor';

interface TestLease extends InkBackgroundLease {
  background: { label: string; __closed: boolean };
  dispose: ReturnType<typeof vi.fn>;
}

function makeLease(label: string): TestLease {
  const background = { label, __closed: false };
  return {
    background,
    dispose: vi.fn(() => {
      background.__closed = true;
    }),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function blankPageRef(pageId = 'page-1'): InkPageRef {
  return {
    page_id: pageId,
    width: 200,
    height: 300,
    background: { kind: 'blank', ruling: 'blank' },
    page_blob_hash: `page-blob-${pageId}`,
  };
}

function pdfPageRef(pageId = 'page-1'): InkPageRef {
  return {
    page_id: pageId,
    width: 200,
    height: 300,
    background: { kind: 'pdf_page', blob_hash: 'pdf-blob-1', source_page_index: 0 },
    page_blob_hash: `page-blob-${pageId}`,
  };
}

const resourceSource: InkManifest['source'] = {
  kind: 'resource',
  resource_id: 'resource-1',
  source_hash: 'a'.repeat(64),
  conversion_revision: 'conversion-1',
};

function pageFor(pageRef: InkPageRef): InkPage {
  return { schema_version: 1, page_id: pageRef.page_id, objects: [] };
}

function manifestFor(
  pages: InkPageRef[],
  revision = 'revision-1',
  source: InkManifest['source'] = { kind: 'blank' },
  manifestDocumentId = documentId,
): InkManifest {
  return {
    schema_version: 1,
    document_id: manifestDocumentId,
    revision,
    title: 'Background fixture',
    source,
    pages,
  };
}

function docStateFor(manifest: InkManifest, pageRef: InkPageRef, page = pageFor(pageRef)) {
  return {
    status: 'ready' as const,
    saveStatus: 'saved' as const,
    manifest,
    pageRef,
    page,
    remoteReloadSequence: 0,
    savePage: vi.fn(async () => undefined),
    selectPage: vi.fn(async () => undefined),
    appendPage: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
    reloadRemote: vi.fn(async () => undefined),
    retrySave: vi.fn(async () => undefined),
    retryDraftStorage: vi.fn(async () => undefined),
    persistDraft: vi.fn(async () => undefined),
    flush: vi.fn(async () => undefined),
    setActiveStroke: vi.fn(),
  };
}

function renderedBackgrounds(): unknown[] {
  return mocks.renders.map((render) => render.background).filter((background) => background !== undefined);
}

function lastBackground(): any {
  return mocks.renders[mocks.renders.length - 1]?.background;
}

async function rerenderWithState(
  view: ReturnType<typeof render>,
  nextState: ReturnType<typeof docStateFor>,
) {
  await act(async () => {
    mocks.docState.current = nextState;
    view.rerender(<InkEditor documentId={documentId} />);
  });
}

beforeEach(() => {
  mocks.docState.current = undefined;
  mocks.loadInkBackground.mockReset();
  mocks.getFrozenInkRenderInputs.mockReset();
  mocks.composeSourceHighlights.mockReset();
  mocks.renders.length = 0;
  mocks.composeSourceHighlights.mockImplementation((base: any, _pageRef: InkPageRef, highlights: unknown[]) => (
    highlights.length > 0
      ? { label: `composed:${String(base?.label ?? 'none')}`, width: 10, height: 10 }
      : undefined
  ));
});

afterEach(() => {
  // No test may ever hand a disposed bitmap to InkPageView.
  expect(mocks.renders.every((render) => !render.closed)).toBe(true);
  vi.clearAllMocks();
});

describe('InkEditor background lease ownership', () => {
  it('reuses the committed lease when a save changes revision but not the raster identity', async () => {
    const pageRef = blankPageRef();
    const lease = makeLease('lease-1');
    mocks.loadInkBackground.mockResolvedValueOnce(lease);
    mocks.docState.current = docStateFor(manifestFor([pageRef]), pageRef);

    const view = render(<InkEditor documentId={documentId} />);
    await waitFor(() => expect(mocks.loadInkBackground).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(lastBackground()).toBe(lease.background));

    const savedPageRef = blankPageRef();
    await rerenderWithState(view, docStateFor(manifestFor([savedPageRef], 'revision-2'), savedPageRef));

    expect(mocks.loadInkBackground).toHaveBeenCalledTimes(1);
    expect(lease.dispose).not.toHaveBeenCalled();
    expect(lastBackground()).toBe(lease.background);
    expect(mocks.renders.every((render) => !render.closed)).toBe(true);

    view.unmount();
    expect(lease.dispose).toHaveBeenCalledTimes(1);
  });

  it('reloads and recomposes exactly once when source highlights really change', async () => {
    const pageRef = pdfPageRef();
    const lease1 = makeLease('lease-1');
    const lease2 = makeLease('lease-2');
    mocks.loadInkBackground.mockResolvedValueOnce(lease1).mockResolvedValueOnce(lease2);
    mocks.getFrozenInkRenderInputs
      .mockResolvedValueOnce({
        revision: 'revision-1',
        source: resourceSource,
        page_ref: pageRef,
        page: pageFor(pageRef),
        highlights: [{ id: 'highlight-1', pageIndex: 0, rects: [] }],
      })
      .mockResolvedValueOnce({
        revision: 'revision-2',
        source: resourceSource,
        page_ref: pageRef,
        page: pageFor(pageRef),
        highlights: [{ id: 'highlight-2', pageIndex: 0, rects: [] }],
      });
    mocks.docState.current = docStateFor(manifestFor([pageRef], 'revision-1', resourceSource), pageRef);

    const view = render(<InkEditor documentId={documentId} />);
    await waitFor(() => expect(lastBackground()?.label).toBe('composed:lease-1'));

    const refreshedPageRef = pdfPageRef();
    await rerenderWithState(
      view,
      docStateFor(manifestFor([refreshedPageRef], 'revision-2', resourceSource), refreshedPageRef),
    );

    await waitFor(() => expect(lastBackground()?.label).toBe('composed:lease-2'));
    expect(mocks.loadInkBackground).toHaveBeenCalledTimes(2);
    expect(lease1.dispose).toHaveBeenCalledTimes(1);
    expect(lease2.dispose).not.toHaveBeenCalled();
    expect(mocks.composeSourceHighlights).toHaveBeenLastCalledWith(
      lease2.background,
      refreshedPageRef,
      [{ id: 'highlight-2', pageIndex: 0, rects: [] }],
    );
    expect(mocks.renders.every((render) => !render.closed)).toBe(true);

    view.unmount();
    expect(lease2.dispose).toHaveBeenCalledTimes(1);
  });

  it('reloads when the highlight set is deleted and publishes the fresh base bitmap', async () => {
    const pageRef = pdfPageRef();
    const lease1 = makeLease('lease-1');
    const lease2 = makeLease('lease-2');
    mocks.loadInkBackground.mockResolvedValueOnce(lease1).mockResolvedValueOnce(lease2);
    mocks.getFrozenInkRenderInputs
      .mockResolvedValueOnce({
        revision: 'revision-1',
        source: resourceSource,
        page_ref: pageRef,
        page: pageFor(pageRef),
        highlights: [{ id: 'highlight-1', pageIndex: 0, rects: [] }],
      })
      .mockResolvedValueOnce({
        revision: 'revision-2',
        source: resourceSource,
        page_ref: pageRef,
        page: pageFor(pageRef),
        highlights: [],
      });
    mocks.docState.current = docStateFor(manifestFor([pageRef], 'revision-1', resourceSource), pageRef);

    const view = render(<InkEditor documentId={documentId} />);
    await waitFor(() => expect(lastBackground()?.label).toBe('composed:lease-1'));

    const refreshedPageRef = pdfPageRef();
    await rerenderWithState(
      view,
      docStateFor(manifestFor([refreshedPageRef], 'revision-2', resourceSource), refreshedPageRef),
    );

    await waitFor(() => expect(lastBackground()).toBe(lease2.background));
    expect(mocks.loadInkBackground).toHaveBeenCalledTimes(2);
    expect(mocks.composeSourceHighlights).toHaveBeenLastCalledWith(lease2.background, refreshedPageRef, []);
    expect(lease1.dispose).toHaveBeenCalledTimes(1);
    expect(lease2.dispose).not.toHaveBeenCalled();

    view.unmount();
    expect(lease2.dispose).toHaveBeenCalledTimes(1);
  });

  it('keeps the previous bitmap visible and disposes it only after a failed refresh recovers', async () => {
    const pageRef = pdfPageRef();
    const lease1 = makeLease('lease-1');
    const lease2 = makeLease('lease-2');
    mocks.loadInkBackground
      .mockResolvedValueOnce(lease1)
      .mockRejectedValueOnce(new Error('background decode failed'))
      .mockResolvedValueOnce(lease2);
    const frozenInputs = (revision: string, highlightId: string) => ({
      revision,
      source: resourceSource,
      page_ref: pageRef,
      page: pageFor(pageRef),
      highlights: [{ id: highlightId, pageIndex: 0, rects: [] }],
    });
    mocks.getFrozenInkRenderInputs
      .mockResolvedValueOnce(frozenInputs('revision-1', 'highlight-1'))
      .mockResolvedValueOnce(frozenInputs('revision-2', 'highlight-2'))
      .mockResolvedValueOnce(frozenInputs('revision-3', 'highlight-3'));
    mocks.docState.current = docStateFor(manifestFor([pageRef], 'revision-1', resourceSource), pageRef);

    const view = render(<InkEditor documentId={documentId} />);
    await waitFor(() => expect(lastBackground()?.label).toBe('composed:lease-1'));

    const failedPageRef = pdfPageRef();
    await rerenderWithState(
      view,
      docStateFor(manifestFor([failedPageRef], 'revision-2', resourceSource), failedPageRef),
    );

    expect(mocks.loadInkBackground).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(view.getByRole('alert')).toBeInTheDocument());
    expect(lastBackground()?.label).toBe('composed:lease-1');
    expect(lease1.dispose).not.toHaveBeenCalled();
    expect(mocks.renders.every((render) => !render.closed)).toBe(true);

    const recoveredPageRef = pdfPageRef();
    await rerenderWithState(
      view,
      docStateFor(manifestFor([recoveredPageRef], 'revision-3', resourceSource), recoveredPageRef),
    );

    await waitFor(() => expect(lastBackground()?.label).toBe('composed:lease-2'));
    expect(view.queryByRole('alert')).not.toBeInTheDocument();
    expect(lease1.dispose).toHaveBeenCalledTimes(1);
    expect(lease2.dispose).not.toHaveBeenCalled();

    view.unmount();
    expect(lease2.dispose).toHaveBeenCalledTimes(1);
  });

  it('publishes exactly one lease under StrictMode and disposes the discarded run', async () => {
    const pageRef = blankPageRef();
    const first = makeLease('strict-1');
    const second = makeLease('strict-2');
    mocks.loadInkBackground
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    mocks.docState.current = docStateFor(manifestFor([pageRef]), pageRef);

    const view = render(
      <StrictMode>
        <InkEditor documentId={documentId} />
      </StrictMode>,
    );

    await waitFor(() => expect(lastBackground()).toBe(second.background));
    expect(mocks.loadInkBackground).toHaveBeenCalledTimes(2);
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(second.dispose).not.toHaveBeenCalled();
    expect(mocks.renders.every((render) => !render.closed)).toBe(true);

    view.unmount();
    expect(second.dispose).toHaveBeenCalledTimes(1);
    expect(first.dispose).toHaveBeenCalledTimes(1);
  });

  it('cancels and disposes stale A/B loads when pages are replaced quickly A -> B -> C', async () => {
    const pageA = blankPageRef('page-a');
    const pageB = blankPageRef('page-b');
    const pageC = blankPageRef('page-c');
    const loadA = deferred<InkBackgroundLease>();
    const loadB = deferred<InkBackgroundLease>();
    const loadC = deferred<InkBackgroundLease>();
    const leaseA = makeLease('lease-a');
    const leaseB = makeLease('lease-b');
    const leaseC = makeLease('lease-c');
    mocks.loadInkBackground
      .mockReturnValueOnce(loadA.promise)
      .mockReturnValueOnce(loadB.promise)
      .mockReturnValueOnce(loadC.promise);
    mocks.docState.current = docStateFor(manifestFor([pageA, pageB, pageC]), pageA);

    const view = render(<InkEditor documentId={documentId} />);
    await waitFor(() => expect(mocks.loadInkBackground).toHaveBeenCalledTimes(1));

    await rerenderWithState(view, docStateFor(manifestFor([pageA, pageB, pageC]), pageB));
    await waitFor(() => expect(mocks.loadInkBackground).toHaveBeenCalledTimes(2));

    await rerenderWithState(view, docStateFor(manifestFor([pageA, pageB, pageC]), pageC));
    await waitFor(() => expect(mocks.loadInkBackground).toHaveBeenCalledTimes(3));

    await act(async () => {
      loadA.resolve(leaseA);
      loadB.resolve(leaseB);
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(leaseA.dispose).toHaveBeenCalledTimes(1);
      expect(leaseB.dispose).toHaveBeenCalledTimes(1);
    });
    expect(lastBackground()).toBeUndefined();

    await act(async () => {
      loadC.resolve(leaseC);
      await Promise.resolve();
    });
    await waitFor(() => expect(lastBackground()).toBe(leaseC.background));
    expect(leaseC.dispose).not.toHaveBeenCalled();
    expect(mocks.renders.every((render) => !render.closed)).toBe(true);

    view.unmount();
    expect(leaseC.dispose).toHaveBeenCalledTimes(1);
  });

  it('gates the old page bitmap during a page switch and releases it only after the new one commits', async () => {
    const pageA = blankPageRef('page-a');
    const pageB = blankPageRef('page-b');
    const leaseA = makeLease('lease-a');
    const loadB = deferred<InkBackgroundLease>();
    const leaseB = makeLease('lease-b');
    mocks.loadInkBackground
      .mockResolvedValueOnce(leaseA)
      .mockReturnValueOnce(loadB.promise);
    mocks.docState.current = docStateFor(manifestFor([pageA, pageB]), pageA);

    const view = render(<InkEditor documentId={documentId} />);
    await waitFor(() => expect(lastBackground()).toBe(leaseA.background));

    await rerenderWithState(view, docStateFor(manifestFor([pageA, pageB]), pageB));
    expect(lastBackground()).toBeUndefined();
    expect(leaseA.dispose).not.toHaveBeenCalled();

    await act(async () => {
      loadB.resolve(leaseB);
      await Promise.resolve();
    });
    await waitFor(() => expect(lastBackground()).toBe(leaseB.background));
    expect(leaseA.dispose).toHaveBeenCalledTimes(1);
    expect(leaseB.dispose).not.toHaveBeenCalled();
    expect(mocks.renders.every((render) => !render.closed)).toBe(true);

    view.unmount();
    expect(leaseB.dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes a pending load when the editor unmounts before it resolves', async () => {
    const pageRef = blankPageRef();
    const load = deferred<InkBackgroundLease>();
    const lease = makeLease('lease-1');
    mocks.loadInkBackground.mockReturnValueOnce(load.promise);
    mocks.docState.current = docStateFor(manifestFor([pageRef]), pageRef);

    const view = render(<InkEditor documentId={documentId} />);
    await waitFor(() => expect(mocks.loadInkBackground).toHaveBeenCalledTimes(1));
    expect(renderedBackgrounds()).toEqual([]);

    view.unmount();
    await act(async () => {
      load.resolve(lease);
      await Promise.resolve();
    });

    expect(lease.dispose).toHaveBeenCalledTimes(1);
    expect(renderedBackgrounds()).toEqual([]);
  });

  it('does not load against a manifest from another document and recovers on the matching state', async () => {
    const pageRef = blankPageRef();
    const lease = makeLease('lease-1');
    mocks.loadInkBackground.mockResolvedValueOnce(lease);
    mocks.docState.current = docStateFor(
      manifestFor([pageRef], 'revision-1', { kind: 'blank' }, 'other-document'),
      pageRef,
    );

    const view = render(<InkEditor documentId={documentId} />);
    await act(async () => { await Promise.resolve(); });
    expect(mocks.loadInkBackground).not.toHaveBeenCalled();

    mocks.loadInkBackground.mockResolvedValueOnce(lease);
    await rerenderWithState(view, docStateFor(manifestFor([pageRef], 'revision-1'), pageRef));
    await waitFor(() => expect(lastBackground()).toBe(lease.background));
    expect(view.queryByRole('alert')).not.toBeInTheDocument();

    view.unmount();
    expect(lease.dispose).toHaveBeenCalledTimes(1);
  });

  it('fails closed when frozen inputs no longer match the open source', async () => {
    const pageRef = pdfPageRef();
    const lease = makeLease('lease-1');
    mocks.loadInkBackground.mockResolvedValueOnce(lease);
    mocks.getFrozenInkRenderInputs.mockResolvedValueOnce({
      revision: 'revision-1',
      source: resourceSource,
      page_ref: pageRef,
      page: pageFor(pageRef),
      highlights: [],
    });
    mocks.docState.current = docStateFor(manifestFor([pageRef], 'revision-1', resourceSource), pageRef);

    const view = render(<InkEditor documentId={documentId} />);
    await waitFor(() => expect(lastBackground()).toBe(lease.background));

    const changedSource: InkManifest['source'] = { ...resourceSource, source_hash: 'b'.repeat(64) };
    const changedPageRef = pdfPageRef();
    await rerenderWithState(
      view,
      docStateFor(manifestFor([changedPageRef], 'revision-2', changedSource), changedPageRef),
    );

    await waitFor(() => expect(view.getByRole('alert')).toBeInTheDocument());
    expect(lastBackground()).toBeUndefined();
    expect(lease.dispose).not.toHaveBeenCalled();
    expect(mocks.loadInkBackground).toHaveBeenCalledTimes(1);

    view.unmount();
    expect(lease.dispose).toHaveBeenCalledTimes(1);
  });
});
