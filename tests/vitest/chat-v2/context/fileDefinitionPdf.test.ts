/**
 * Chat V2 - fileDefinition PDF multimodal injection tests
 *
 * Covers the "PDF image inject mode" path which consumes `ResolvedResource.multimodalBlocks`.
 * Regression: MultimodalContentBlock shape is `{ mediaType, base64 }` (not `source.*`).
 */

import { describe, it, expect } from 'vitest';
import type { Resource } from '@/features/chat/context';
import { fileDefinition, isImageContentBlock, isTextContentBlock } from '@/features/chat/context';

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

  it('keeps native text and page images for TM while leaving OCR opt-in', () => {
    const resource: Resource = {
      id: 'res_test_pdf_tm',
      hash: 'hash_pdf_tm',
      type: 'file',
      data: '',
      refCount: 1,
      createdAt: Date.now(),
      _resolvedResources: [{
        sourceId: 'att_pdf_tm',
        resourceHash: 'hash_pdf_tm',
        type: 'file',
        name: 'tm.pdf',
        path: '/tmp/tm.pdf',
        content: 'native extracted text',
        found: true,
        metadata: { name: 'tm.pdf', mimeType: 'application/pdf', size: 1234 },
        multimodalBlocks: [
          { type: 'image', mediaType: 'image/png', base64: 'page_image' },
          { type: 'text', text: '<ocr_page page="1">OCR duplicate</ocr_page>' },
        ],
      }],
    };

    const blocks = fileDefinition.formatToBlocks(resource, { isMultimodal: false } as any);
    expect(blocks.filter(isImageContentBlock)).toHaveLength(1);
    const text = blocks.filter(isTextContentBlock).map((block: any) => block.text).join('\n');
    expect(text).toContain('native extracted text');
    expect(text).not.toContain('<pdf_ocr');
  });
});
