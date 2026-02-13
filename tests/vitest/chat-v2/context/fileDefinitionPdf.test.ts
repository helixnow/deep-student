/**
 * Chat V2 - fileDefinition PDF multimodal injection tests
 *
 * Covers the "PDF image inject mode" path which consumes `ResolvedResource.multimodalBlocks`.
 * Regression: MultimodalContentBlock shape is `{ mediaType, base64 }` (not `source.*`).
 */

import { describe, it, expect } from 'vitest';
import type { Resource } from '@/chat-v2/context';
import { fileDefinition, isImageContentBlock } from '@/chat-v2/context';

describe('fileDefinition (PDF multimodal)', () => {
  it('should convert multimodalBlocks image {mediaType, base64} into an image ContentBlock', () => {
    const resource: Resource = {
      id: 'res_test_pdf',
      hash: 'hash_pdf',
      type: 'file',
      data: '',
      refCount: 1,
      createdAt: Date.now(),
      _resolvedResources: [
        {
          sourceId: 'att_pdf_1',
          resourceHash: 'hash_pdf',
          type: 'file',
          name: 'test.pdf',
          path: '/tmp/test.pdf',
          content: 'ignored in image mode',
          found: true,
          metadata: { name: 'test.pdf', mimeType: 'application/pdf', size: 1234 },
          multimodalBlocks: [{ type: 'image', mediaType: 'image/png', base64: 'base64_png' }],
        },
      ],
    };

    const blocks = fileDefinition.formatToBlocks(
      resource,
      {
        isMultimodal: true,
        // fileDefinition currently reads injectModes even though it's not in FormatOptions.
        // We keep this test focused on runtime behavior.
        injectModes: { pdf: ['image'] },
      } as any
    );

    // fileDefinition 会附带 PDF 元信息块（引用格式/页码说明），因此不要求 blocks 长度为 1
    const imageBlocks = blocks.filter(isImageContentBlock);
    expect(imageBlocks).toHaveLength(1);
    expect((imageBlocks[0] as any).mediaType).toBe('image/png');
    expect((imageBlocks[0] as any).base64).toBe('base64_png');
  });
});

