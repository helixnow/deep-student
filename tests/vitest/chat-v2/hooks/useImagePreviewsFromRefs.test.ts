import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ContextSnapshot } from '@/chat-v2/context/types';
import { useImagePreviewsFromRefs } from '@/chat-v2/hooks/useImagePreviewsFromRefs';

vi.mock('@/chat-v2/resources', () => ({
  resourceStoreApi: {
    get: vi.fn(),
  },
}));

vi.mock('@/chat-v2/context/vfsRefApi', () => ({
  resolveResourceRefsV2: vi.fn(),
}));

import { resourceStoreApi } from '@/chat-v2/resources';
import { resolveResourceRefsV2 } from '@/chat-v2/context/vfsRefApi';

const mockGetResource = vi.mocked(resourceStoreApi.get);
const mockResolveResourceRefsV2 = vi.mocked(resolveResourceRefsV2);

const contextSnapshot: ContextSnapshot = {
  userRefs: [
    {
      resourceId: 'res_img_1',
      hash: 'hash_res_1',
      typeId: 'image',
    },
  ],
  retrievalRefs: [],
};

describe('useImagePreviewsFromRefs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forces image-only inject mode when resolving preview refs', async () => {
    mockGetResource.mockResolvedValue({
      id: 'res_img_1',
      hash: 'hash_res_1',
      type: 'image',
      data: JSON.stringify({
        refs: [
          {
            sourceId: 'img_1',
            resourceHash: 'hash_img_1',
            type: 'image',
            name: 'img.png',
          },
        ],
        totalCount: 1,
        truncated: false,
      }),
      refCount: 1,
      createdAt: Date.now(),
    } as any);

    mockResolveResourceRefsV2.mockResolvedValue({
      ok: true,
      value: [
        {
          sourceId: 'img_1',
          resourceHash: 'hash_img_1',
          type: 'image',
          name: 'img.png',
          path: '/tmp/img.png',
          content: 'iVBORw0KGgoAAAANSUhEUgAAAAUA',
          found: true,
          metadata: { mimeType: 'image/png' },
        },
      ],
    } as any);

    const { result } = renderHook(() => useImagePreviewsFromRefs(contextSnapshot));

    await waitFor(() => {
      expect(result.current.imagePreviews).toHaveLength(1);
    });

    expect(mockResolveResourceRefsV2).toHaveBeenCalledTimes(1);
    const refsArg = mockResolveResourceRefsV2.mock.calls[0][0];
    expect(refsArg).toHaveLength(1);
    expect(refsArg[0].injectModes).toEqual({ image: ['image'] });
  });

  it('sanitizes mixed image payload by dropping trailing <image_ocr> before building data URL', async () => {
    mockGetResource.mockResolvedValue({
      id: 'res_img_1',
      hash: 'hash_res_1',
      type: 'image',
      data: JSON.stringify({
        refs: [
          {
            sourceId: 'img_1',
            resourceHash: 'hash_img_1',
            type: 'image',
            name: 'img.png',
          },
        ],
        totalCount: 1,
        truncated: false,
      }),
      refCount: 1,
      createdAt: Date.now(),
    } as any);

    mockResolveResourceRefsV2.mockResolvedValue({
      ok: true,
      value: [
        {
          sourceId: 'img_1',
          resourceHash: 'hash_img_1',
          type: 'image',
          name: 'img.png',
          path: '/tmp/img.png',
          content: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA<image_ocr>题目图片文本</image_ocr>',
          found: true,
          metadata: { mimeType: 'image/png' },
        },
      ],
    } as any);

    const { result } = renderHook(() => useImagePreviewsFromRefs(contextSnapshot));

    await waitFor(() => {
      expect(result.current.imagePreviews).toHaveLength(1);
    });

    const previewUrl = result.current.imagePreviews[0]?.previewUrl ?? '';
    expect(previewUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(previewUrl.includes('<image_ocr')).toBe(false);
  });

  it('skips preview when resolved image content has OCR text only and no image payload', async () => {
    mockGetResource.mockResolvedValue({
      id: 'res_img_1',
      hash: 'hash_res_1',
      type: 'image',
      data: JSON.stringify({
        refs: [
          {
            sourceId: 'img_1',
            resourceHash: 'hash_img_1',
            type: 'image',
            name: 'img.png',
          },
        ],
        totalCount: 1,
        truncated: false,
      }),
      refCount: 1,
      createdAt: Date.now(),
    } as any);

    mockResolveResourceRefsV2.mockResolvedValue({
      ok: true,
      value: [
        {
          sourceId: 'img_1',
          resourceHash: 'hash_img_1',
          type: 'image',
          name: 'img.png',
          path: '/tmp/img.png',
          content: '<image_ocr>仅有OCR文本</image_ocr>',
          found: true,
          metadata: { mimeType: 'image/png' },
        },
      ],
    } as any);

    const { result } = renderHook(() => useImagePreviewsFromRefs(contextSnapshot));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.imagePreviews).toHaveLength(0);
  });
});
