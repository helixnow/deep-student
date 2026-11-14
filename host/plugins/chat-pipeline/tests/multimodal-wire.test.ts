import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPipelineHost } from './chat-host.ts';
import { imagePart, textPart, type LegacyChatMessage } from '../api.ts';
import type { Model2HistoryMessage } from '../../llm/api.ts';

let host: Awaited<ReturnType<typeof createPipelineHost>>;
beforeAll(async () => { host = await createPipelineHost(); }, 60_000);
afterAll(async () => { await host?.dispose(); });

describe('X7-L03-MULTIMODAL-TEXT-TAG / X7-L03-MULTIMODAL-IMAGE-TAG', () => {
  it('models.rs:108–137 public constructors emit only the Rust internally tagged fields', () => {
    const text = textPart('正文<&');
    const image = imagePart('image/png', 'cGl4ZWxz');
    const parts: NonNullable<Model2HistoryMessage['multimodal_content']> = [text, image];
    expect(parts).toEqual([{ type: 'text', text: '正文<&' }, { type: 'image_url', mediaType: 'image/png', base64: 'cGl4ZWxz' }]);
    expect(Object.keys(text)).toEqual(['type', 'text']);
    expect(Object.keys(image)).toEqual(['type', 'mediaType', 'base64']);
    expect(JSON.parse(JSON.stringify(parts))).toEqual(parts);
  });
  it('canonical image override, budget pruning and text fallback consume the same wire union', () => {
    const pipeline = host.ctx.chatPipeline;
    const message: LegacyChatMessage = { role: 'user', content: '', multimodal_content: [
      textPart('before'), imagePart('image/jpeg', 'preview'), textPart('after'), imagePart('image/png', 'second'),
    ] };
    expect(pipeline.countRequestImages([message])).toBe(2);
    expect(pipeline.collectRuntimeImages([message], 0, []).map(image => image.base64)).toEqual(['preview', 'second']);
    pipeline.overrideMessageImagesWithCanonical(message, [{ mimeType: 'image/webp', base64: 'canonical' }, null]);
    expect(message.multimodal_content?.[1]).toEqual({ type: 'image_url', mediaType: 'image/webp', base64: 'canonical' });
    pipeline.retainSelectedImagesForMultimodal([message], new Set(['0:0']));
    expect(pipeline.countRequestImages([message])).toBe(1);
    expect(message.multimodal_content).toEqual([textPart('before'), imagePart('image/webp', 'canonical'), textPart('after'),
      textPart('[1 张较早图片因上下文图片预算未重复发送，原始引用仍保留。]')]);
    pipeline.stripAllImages([message], new Set(['0:0']), false);
    expect(message.multimodal_content).toBeNull();
    expect(message.content).toBe('before\nafter\n[1 张较早图片因上下文图片预算未重复发送，原始引用仍保留。]');
  });
  it('retrieval page-image assembly is directly assignable to the L02 multimodal request contract', () => {
    const pipeline = host.ctx.chatPipeline;
    const message = pipeline.buildRetrievalPageImageMessage([[{
      toolCallId: 'c', blobHash: 'hash', citationTag: '[知识库-1]', title: '页', pageIndex: 0, resourceId: null, sourceId: null,
    }, { mimeType: 'image/png', base64: 'cGFnZQ==' }]])!;
    const parts: NonNullable<Model2HistoryMessage['multimodal_content']> = message.multimodal_content!;
    expect(parts).toHaveLength(3);
    expect(parts[0]).toMatchObject({ type: 'text', text: expect.stringContaining('<retrieval_page_images>') });
    expect(parts[1]).toEqual({ type: 'text', text: '[知识库-1] 页（第 1 页 / page 1）' });
    expect(parts[2]).toEqual({ type: 'image_url', mediaType: 'image/png', base64: 'cGFnZQ==' });
    expect(pipeline.countRequestImages([message])).toBe(1);
  });
});
