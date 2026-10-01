import React, { useState } from 'react';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextSnapshot } from '../../context/types';

const { getResource, resolveRefs } = vi.hoisted(() => ({
  getResource: vi.fn(),
  resolveRefs: vi.fn(),
}));
vi.mock('../../resources', () => ({ resourceStoreApi: { get: getResource } }));
vi.mock('../../context/vfsRefApi', () => ({ resolveResourceRefsV2: resolveRefs }));
vi.mock('../../context', () => ({ contextTypeRegistry: { getLabel: () => 'Image' } }));
vi.mock('../../components/InlineImageViewer', () => ({
  InlineImageViewer: ({ images, isOpen }: { images: string[]; isOpen: boolean }) =>
    isOpen ? <div data-testid="image-viewer">{images.length}</div> : null,
}));
vi.mock('../../components/InlineDocumentViewer', () => ({ InlineDocumentViewer: () => null }));

import { useImagePreviewsFromRefs } from '../useImagePreviewsFromRefs';
import { ContextRefsDisplay, CONTEXT_REFS_VISIBLE_COUNT } from '../../components/ContextRefsDisplay';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6lDkAAAAASUVORK5CYII=';
function snapshot(count: number, prefix = 'image'): ContextSnapshot {
  return {
    userRefs: Array.from({ length: count }, (_, i) => ({
      resourceId: `${prefix}-${i}`, hash: `${prefix}-hash-${i}`, typeId: 'image',
    })),
  } as ContextSnapshot;
}

function AttachmentRow({ context }: { context: ContextSnapshot }) {
  const [limit, setLimit] = useState(CONTEXT_REFS_VISIBLE_COUNT);
  const { imagePreviews, isLoading, unloadedImageCount } = useImagePreviewsFromRefs(context, limit);
  return <ContextRefsDisplay
    contextSnapshot={context}
    imagePreviews={imagePreviews}
    isLoadingImages={isLoading}
    unloadedImageCount={unloadedImageCount}
    onRequestAllImages={() => setLimit(Infinity)}
  />;
}

beforeEach(() => {
  getResource.mockReset().mockImplementation(async (sourceId: string) => ({
    data: JSON.stringify({ refs: [{ type: 'image', sourceId }] }),
  }));
  resolveRefs.mockReset().mockImplementation(async (refs: Array<{ sourceId: string }>) => ({
    ok: true,
    value: refs.map(({ sourceId }) => ({
      sourceId, found: true, content: PNG, name: sourceId, metadata: { mimeType: 'image/png' },
    })),
  }));
});

describe('visible image preview loading', () => {
  it('loads deferred attachments through the real expand control', async () => {
    render(<AttachmentRow context={snapshot(10)} />);
    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(8));
    expect(getResource).toHaveBeenCalledTimes(8);
    fireEvent.click(screen.getByRole('button', { name: '+2 更多' }));
    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(10));
    expect(getResource).toHaveBeenCalledTimes(10);
  });

  it('keeps the expand control when every initially requested image is missing', async () => {
    for (let index = 0; index < CONTEXT_REFS_VISIBLE_COUNT; index += 1) {
      getResource.mockResolvedValueOnce(null);
    }
    const { container } = render(<AttachmentRow context={snapshot(10)} />);
    await waitFor(() => expect(getResource).toHaveBeenCalledTimes(8));
    await waitFor(() => expect(container.querySelector('.animate-spin')).toBeNull());
    expect(screen.queryAllByRole('img')).toHaveLength(0);
    expect(resolveRefs).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '+2 更多' }));
    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(2));
    expect(getResource).toHaveBeenCalledTimes(10);
    expect(resolveRefs.mock.calls[0][0].map((ref: { sourceId: string }) => ref.sourceId)).toEqual(['image-8', 'image-9']);
    expect(screen.getByRole('button', { name: 'image-8' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'image-9' })).toBeInTheDocument();
  });

  it('loads the remaining images before opening the full gallery', async () => {
    render(<AttachmentRow context={snapshot(10)} />);
    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(8));
    fireEvent.click(screen.getByRole('button', { name: 'image-0' }));
    expect(screen.queryByTestId('image-viewer')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('image-viewer')).toHaveTextContent('10'));
    expect(getResource).toHaveBeenCalledTimes(10);
  });

  it('defers hidden metadata and payloads, then reuses the visible previews on expansion', async () => {
    const context = snapshot(10);
    const { result, rerender } = renderHook(({ limit }) => useImagePreviewsFromRefs(context, limit), {
      initialProps: { limit: 8 },
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.imagePreviews).toHaveLength(8);
    expect(result.current.unloadedImageCount).toBe(2);
    expect(getResource).toHaveBeenCalledTimes(8);
    expect(resolveRefs.mock.calls[0][0]).toHaveLength(8);
    expect(resolveRefs.mock.calls[0][0][0].injectModes).toEqual({ image: ['image'] });
    const firstPreview = result.current.imagePreviews[0];

    rerender({ limit: Infinity });
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.imagePreviews).toHaveLength(10));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.unloadedImageCount).toBe(0);
    expect(getResource).toHaveBeenCalledTimes(10);
    expect(resolveRefs.mock.calls[1][0].map((ref: { sourceId: string }) => ref.sourceId)).toEqual(['image-8', 'image-9']);
    expect(result.current.imagePreviews[0]).toBe(firstPreview);
  });

  it('does not reload previews for unrelated snapshot fields, but replaces them for new refs', async () => {
    const context = snapshot(2);
    const { result, rerender } = renderHook(({ value }) => useImagePreviewsFromRefs(value, 8), {
      initialProps: { value: context },
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    rerender({ value: { ...context, pathMap: { 'image-0': '/updated/path.png' } } });
    expect(getResource).toHaveBeenCalledTimes(2);
    rerender({ value: snapshot(1, 'replacement') });
    await waitFor(() => expect(result.current.imagePreviews[0]?.id).toBe('replacement-0'));
    expect(result.current.imagePreviews).toHaveLength(1);
    expect(getResource).toHaveBeenCalledTimes(3);
  });

  it('ignores an in-flight result after the message snapshot changes', async () => {
    let finishOld: (value: unknown) => void = () => undefined;
    resolveRefs.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
    const { result, rerender } = renderHook(({ value }) => useImagePreviewsFromRefs(value, 8), {
      initialProps: { value: snapshot(1, 'old') },
    });
    await waitFor(() => expect(resolveRefs).toHaveBeenCalledTimes(1));
    rerender({ value: snapshot(1, 'new') });
    await waitFor(() => expect(result.current.imagePreviews[0]?.id).toBe('new-0'));
    await act(async () => finishOld({ ok: true, value: [{
      sourceId: 'old-0', found: true, name: 'old-0', content: PNG,
    }] }));
    expect(result.current.imagePreviews.map((preview) => preview.id)).toEqual(['new-0']);
    expect(result.current.isLoading).toBe(false);
  });
});
