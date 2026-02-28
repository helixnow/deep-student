import { describe, it, expect } from 'vitest';
import { imageDefinition, isImageContentBlock, isTextContentBlock, type Resource } from '@/chat-v2/context';

function makeImageResource(content: string, mimeType = 'image/png'): Resource {
  return {
    id: 'res_img_test',
    hash: 'hash_img_test',
    type: 'image',
    data: '',
    refCount: 1,
    createdAt: Date.now(),
    _resolvedResources: [
      {
        sourceId: 'img_test_1',
        resourceHash: 'hash_img_test',
        type: 'image',
        name: 'img-test.png',
        path: '/tmp/img-test.png',
        content,
        found: true,
        metadata: { mimeType },
      },
    ],
  };
}

describe('imageDefinition payload integrity', () => {
  it('keeps image+ocr mixed payload available for context injection', () => {
    const resource = makeImageResource(
      'data:image/png;base64,aGVsbG8=<image_ocr>OCR内容</image_ocr>'
    );

    const blocks = imageDefinition.formatToBlocks(resource);
    const imageBlock = blocks.find(isImageContentBlock);
    const textBlocks = blocks.filter(isTextContentBlock);

    expect(imageBlock).toBeDefined();
    expect((imageBlock as any).mediaType).toBe('image/png');
    expect((imageBlock as any).base64).toBe('aGVsbG8=');
    expect(textBlocks.some((b) => (b as any).text.includes('<image_ocr'))).toBe(true);
  });

  it('returns a single image block in image-only mode for clean data URL', () => {
    const resource = makeImageResource('data:image/jpeg;base64,/9j/4AAQSkZJRg==', 'image/jpeg');
    const blocks = imageDefinition.formatToBlocks(resource, {
      isMultimodal: true,
      injectModes: { image: ['image'] },
    } as any);

    expect(blocks).toHaveLength(1);
    expect(isImageContentBlock(blocks[0])).toBe(true);
    expect((blocks[0] as any).mediaType).toBe('image/jpeg');
  });

  it('returns invalid placeholder in image-only mode when payload is not image base64', () => {
    const resource = makeImageResource('<image_ocr>only text</image_ocr>');
    const blocks = imageDefinition.formatToBlocks(resource, {
      isMultimodal: true,
      injectModes: { image: ['image'] },
    } as any);

    expect(blocks).toHaveLength(1);
    expect(isTextContentBlock(blocks[0])).toBe(true);
    expect((blocks[0] as any).text).toContain('[图片内容无效]');
  });
});
