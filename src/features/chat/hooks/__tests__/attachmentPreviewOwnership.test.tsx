import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextSnapshot } from '../../context/types';

const { getResource, resolveRefs } = vi.hoisted(() => ({
  getResource: vi.fn(),
  resolveRefs: vi.fn(),
}));
vi.mock('../../resources', () => ({ resourceStoreApi: { get: getResource } }));
vi.mock('../../context/vfsRefApi', () => ({ resolveResourceRefsV2: resolveRefs }));
vi.mock('../../context/imagePreviewAssets', () => ({
  createImagePreviewAsset: async () => ({ mimeType: 'image/png', fullUrl: 'blob:old', thumbnailUrl: 'blob:thumb' }),
  revokeImagePreviewAsset: vi.fn(),
}));

import { useFilePreviewsFromRefs } from '../useFilePreviewsFromRefs';
import { __resetImagePreviewCacheForTests, useImagePreviewsFromRefs } from '../useImagePreviewsFromRefs';

function snapshot(typeId: string, id: string): ContextSnapshot {
  return { userRefs: [{ resourceId: id, hash: id, typeId }] } as ContextSnapshot;
}

beforeEach(() => {
  __resetImagePreviewCacheForTests();
  getResource.mockReset().mockImplementation(async (id: string) => ({
    data: JSON.stringify({ refs: [{ sourceId: id, type: id.startsWith('file') ? 'file' : 'image' }] }),
  }));
  resolveRefs.mockReset().mockImplementation(async (refs: Array<{ sourceId: string }>) => ({
    ok: true,
    value: refs.map(({ sourceId }) => ({ sourceId, found: true, content: 'payload', name: sourceId })),
  }));
});

describe('attachment preview snapshot ownership', () => {
  it('keeps file previews when only the snapshot path map changes', async () => {
    const context = snapshot('file', 'file-old');
    const { result, rerender } = renderHook(({ context }) => useFilePreviewsFromRefs(context), {
      initialProps: { context },
    });
    await waitFor(() => expect(result.current.filePreviews).toHaveLength(1));
    const previews = result.current.filePreviews;
    rerender({ context: { ...context, pathMap: { 'file-old': '/renamed.txt' } } });
    expect(result.current.filePreviews).toBe(previews);
    expect(result.current.isLoading).toBe(false);
    expect(resolveRefs).toHaveBeenCalledTimes(1);
  });

  it('hides the previous image immediately while replacement references resolve', async () => {
    const { result, rerender } = renderHook(({ context }) => useImagePreviewsFromRefs(context), {
      initialProps: { context: snapshot('image', 'image-old') },
    });
    await waitFor(() => expect(result.current.imagePreviews).toHaveLength(1));
    let finish: (value: unknown) => void = () => undefined;
    resolveRefs.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    rerender({ context: snapshot('image', 'image-new') });
    expect(result.current.isLoading).toBe(true);
    expect(result.current.imagePreviews).toEqual([]);
    await waitFor(() => expect(resolveRefs).toHaveBeenCalledTimes(2));
    await act(async () => finish({ ok: true, value: [{ sourceId: 'image-new', found: true, content: 'new', name: 'new' }] }));
    expect(result.current.imagePreviews.map((preview) => preview.id)).toEqual(['image-new']);
  });

  it('hides the previous file immediately while replacement references resolve', async () => {
    const { result, rerender } = renderHook(({ context }) => useFilePreviewsFromRefs(context), {
      initialProps: { context: snapshot('file', 'file-old') },
    });
    await waitFor(() => expect(result.current.filePreviews).toHaveLength(1));
    let finish: (value: unknown) => void = () => undefined;
    resolveRefs.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    rerender({ context: snapshot('file', 'file-new') });
    expect(result.current.isLoading).toBe(true);
    expect(result.current.filePreviews).toEqual([]);
    await waitFor(() => expect(resolveRefs).toHaveBeenCalledTimes(2));
    await act(async () => finish({ ok: true, value: [{ sourceId: 'file-new', found: true, content: 'new', name: 'new' }] }));
    expect(result.current.filePreviews.map((preview) => preview.id)).toEqual(['file-new']);
  });
});
