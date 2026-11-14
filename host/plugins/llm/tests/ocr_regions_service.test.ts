import { describe, expect, it } from 'vitest';
import { createTestHost } from './host.ts';
import plugin from '../index.ts';
import { createOcrRegionsService } from '../src/ocr_regions_service.ts';
import { OcrAdapterFactory, OcrError } from '../../llm-providers/api.ts';

describe('exam_engine.rs::parse_ocr_regions_internal', () => {
  it('assembles adapter regions via the published service and emits original debug payloads', async () => {
    const host = await createTestHost({ plugins: [plugin], provide: { settings: {}, secrets: {},
      nativeImage: { dimensions: async () => ({ width: 999, height: 999 }) },
    } });
    try {
      const cards = await host.ctx.llmOcrRegions.parse('<|ref|>标题<|/ref|><|det|>[[100,200,300,400]]<|/det|>正文',
        new Uint8Array(), 'page.png', 3, 'deepseek_ocr');
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({ question_label: '标题', ocr_text: '正文', card_id: 'ocr_p3_r0',
        extra_metadata: { engine: 'deepseek_ocr', source: 'ocr_adapter' }, tags: [] });
      expect(cards[0]?.bbox.width).toBe(Math.fround(200 / 999));
      expect(host.eventsNamed('deepseek_ocr_log').at(-1)).toEqual({ level: 'info', stage: 'parse',
        page_index: 3, message: '适配器解析成功 (deepseek_ocr): 1 个区域', data: null });
    } finally { await host.dispose(); }
  });

  it('only falls back to the legacy parser when the external adapter fails', async () => {
    const events: unknown[] = [];
    const adapter = OcrAdapterFactory.create('deepseek_ocr');
    adapter.parseResponse = () => { throw OcrError.parse('provider parse failure'); };
    const service = createOcrRegionsService({ dimensions: async () => ({ width: 999, height: 999 }) },
      { getOcrEngineType: async () => 'deepseek_ocr' }, (_name, payload) => { events.push(payload); }, () => adapter);
    const cards = await service.parse('<|ref|>区域<|/ref|><|det|>[[100,200,300,400]]<|/det|>文字', new Uint8Array(), 'page.png', 2, null);
    expect(cards).toEqual([{ question_label: '区域', bbox: { x: Math.fround(100 / 999), y: Math.fround(200 / 999),
      width: Math.fround(200 / 999), height: Math.fround(200 / 999) }, ocr_text: '文字', tags: [], extra_metadata: null, card_id: 'ds_p2_r0' }]);
    expect(events).toContainEqual(expect.objectContaining({ level: 'warn', message: expect.stringContaining('尝试旧解析器回退') }));
    expect(await service.parse('1234567890', new Uint8Array(), 'page.png', 0, null)).toEqual([]);
    expect(await service.parse('一二三四', new Uint8Array(), 'page.png', 0, null)).toMatchObject([
      { card_id: 'fp_p0_r0', ocr_text: '一二三四', extra_metadata: { fallback_mode: 'full_page_text', engine: 'deepseek_ocr' } },
    ]);
  });
});
