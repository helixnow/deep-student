/** Image-byte entry to exam_engine.rs:1233–1479; callers own file resolution/read. */
import type { LlmOcrModels, LlmOcrRegions, ExamSegmentationCard } from '../api.ts';
import type { NativeImage } from '../../../platform/native/image/api.ts';
import { AppError, type JsonValue } from '../../../platform/errors/api.ts';
import { rustTrim, utf8ByteLength } from '../../../platform/util/portable.ts';
import { OcrAdapterFactory, type OcrAdapter, type OcrEngineType, type OcrRegion } from '../../llm-providers/api.ts';
import { parseDeepseekGrounding, projectToPixels } from './deepseek_ocr_parser.ts';
import { logDebug, logError } from './logging.ts';

const debugEngine: Record<OcrEngineType, string> = {
  deepseek_ocr: 'DeepSeekOcr', paddle_ocr_vl: 'PaddleOcrVl', paddle_ocr_vl_v1: 'PaddleOcrVlV1',
  glm4v_ocr: 'Glm4vOcr', generic_vlm: 'GenericVlm', system_ocr: 'SystemOcr',
};

export function createOcrRegionsService(image: Pick<NativeImage, 'dimensions'>,
  models: Pick<LlmOcrModels, 'getOcrEngineType'>,
  emit: (name: string, payload: JsonValue) => void,
  adapterFor: (engine: OcrEngineType) => OcrAdapter = OcrAdapterFactory.create): LlmOcrRegions {
  function debug(level: string, stage: string, page: number, message: string, data: JsonValue = null): void {
    const prefix = `[DeepSeek-OCR-Debug:${stage}:page-${page}]`;
    logDebug(`${prefix} [${level.toUpperCase()}] ${message}`);
    if (data !== null) logDebug(`${prefix}   data: ${JSON.stringify(data, null, 2)}`);
    try { emit('deepseek_ocr_log', { level, stage, page_index: page, message, data }); }
    catch (error) { logError(`[DeepSeek-OCR-Debug] 发送事件失败: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return {
    async parse(content, bytes, path, page, override) {
      const engine = override ?? await models.getOcrEngineType();
      let dimensions: { width: number; height: number };
      try { dimensions = await image.dimensions(bytes); }
      catch (error) { throw AppError.file_system(`读取图片尺寸失败: ${error instanceof Error ? error.message : String(error)}`); }
      const { width, height } = dimensions;
      debug('debug', 'parse', page, `content 全量预览 (engine: ${debugEngine[engine]})`, { preview: content, engine });
      const fullPage = (text: string): ExamSegmentationCard[] => {
        const trimmed = rustTrim(text);
        if (utf8ByteLength(trimmed) <= 10) return [];
        return [{ question_label: '全页内容', bbox: { x: 0, y: 0, width: 1, height: 1 }, ocr_text: trimmed,
          tags: [], extra_metadata: { fallback_mode: 'full_page_text', engine }, card_id: `fp_p${page}_r0` }];
      };
      const convert = (regions: OcrRegion[]): ExamSegmentationCard[] => regions.flatMap((region, index) => {
        let bbox = region.bbox_normalized;
        if (bbox === undefined) {
          const pixels = region.bbox_pixels;
          if (pixels === undefined || pixels.length !== 4 || width === 0 || height === 0) return [];
          bbox = [pixels[0]! / width, pixels[1]! / height, pixels[2]! / width, pixels[3]! / height];
        }
        if (bbox.length !== 4) return [];
        const [x, y, w, h] = bbox.map(value => Math.fround(Math.min(1, Math.max(0, value)))) as [number, number, number, number];
        if (w <= 0 || h <= 0) return [];
        return [{ question_label: rustTrim(region.label) === '' ? `区域${index}` : region.label,
          bbox: { x, y, width: w, height: h }, ocr_text: region.text, tags: [],
          extra_metadata: { engine, source: 'ocr_adapter' }, card_id: `ocr_p${page}_r${index}` }];
      });
      try {
        const result = adapterFor(engine).parseResponse(content, width, height, page, path, 'grounding');
        const cards = convert(result.regions);
        if (!cards.length) return fullPage(result.markdown_text ?? content);
        debug('info', 'parse', page, `适配器解析成功 (${engine}): ${cards.length} 个区域`);
        return cards;
      } catch (error) {
        debug('warn', 'parse', page, `适配器解析失败 (${engine}): ${error instanceof Error ? error.message : String(error)}, 尝试旧解析器回退`);
      }
      const spans = parseDeepseekGrounding(content);
      debug('info', 'parse', page, `解析结果: ${spans.length} 个 spans`);
      if (!spans.length) {
        debug('warn', 'parse', page, `⚠️ 未解析到 grounding 标记，使用纯文本模式 (engine: ${debugEngine[engine]})`);
        return fullPage(content);
      }
      debug('info', 'convert', page, `图片尺寸: ${width}x${height}`);
      const regions = projectToPixels(spans, width, height);
      debug('info', 'convert', page, `转换结果: ${regions.length} 个 regions`);
      const cards: ExamSegmentationCard[] = regions.flatMap((region, index) => {
        if (region.bbox_0_1_xywh.length !== 4) return [];
        const [x, y, w, h] = region.bbox_0_1_xywh.map(Math.fround) as [number, number, number, number];
        return [{ question_label: region.label === '' ? `区域${index}` : region.label,
          bbox: { x, y, width: w, height: h }, ocr_text: region.text, tags: [], extra_metadata: null,
          card_id: `ds_p${page}_r${index}` }];
      });
      debug('info', 'result', page, `DeepSeek-OCR 识别到 ${cards.length} 个原始区域`);
      return cards;
    },
  };
}
