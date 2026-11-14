import type { JsonValue, OcrEngineType, OcrMode, OcrPageResult, OcrRegion } from '../../api.ts';
import { rustTrim } from '../../../../platform/util/portable.ts';
import { array, f64, object, parseJsonExact, string } from '../json.ts';
import { BaseOcrAdapter } from './base.ts';
import { DeepSeekOcrAdapter } from './deepseek.ts';
import { OcrError } from './types.ts';

/** ocr_adapters/paddle.rs:214 `ParsedPaddleResponse`. */
export interface ParsedPaddleResponse {
  regions: OcrRegion[];
  markdown?: string;
}

function fieldOf(value: JsonValue | undefined, key: string): JsonValue | undefined {
  return object(value)?.[key];
}

/** ocr_adapters/paddle.rs:257 `extract_json_from_response`. */
export function extractJsonFromResponse(response: string): string {
  const trimmed = rustTrim(response);
  if (trimmed.startsWith('```json')) {
    const end = trimmed.lastIndexOf('```');
    const newline = trimmed.indexOf('\n');
    const start = newline >= 0 ? newline + 1 : 7;
    if (start < end) return rustTrim(trimmed.slice(start, end));
  }
  if (trimmed.startsWith('```')) {
    const end = trimmed.lastIndexOf('```');
    const newline = trimmed.indexOf('\n');
    const start = newline >= 0 ? newline + 1 : 3;
    if (start < end) return rustTrim(trimmed.slice(start, end));
  }
  const start = trimmed.indexOf('{');
  if (start >= 0) {
    const end = trimmed.lastIndexOf('}');
    if (start < end) return trimmed.slice(start, end + 1);
  }
  return trimmed;
}

/** ocr_adapters/paddle.rs:286 `parse_bbox_value` inner `resolve_xywh`. */
function resolveXywh(values: readonly number[], maxWidth: number, maxHeight: number): [number, number, number, number] | undefined {
  if (values.length !== 4) return undefined;
  const [x, y, a, b] = values as [number, number, number, number];
  const eps = 1e-6;
  const xywh: [number, number, number, number] = [x, y, a, b];
  const xyxy: [number, number, number, number] = [x, y, a - x, b - y];
  const validXywh = a > 0 && b > 0 && x >= 0 && y >= 0 && x + a <= maxWidth + eps && y + b <= maxHeight + eps;
  const validXyxy = a - x > 0 && b - y > 0 && x >= 0 && y >= 0 && a <= maxWidth + eps && b <= maxHeight + eps;
  if (validXyxy && !validXywh) return xyxy;
  if (!validXyxy && validXywh) return xywh;
  if (validXyxy && validXywh) return xyxy;
  return undefined;
}

/** ocr_adapters/paddle.rs:286 `parse_bbox_value`. */
function parseBboxValue(
  bbox: JsonValue | undefined,
  imageWidth: number,
  imageHeight: number,
): [number[] | undefined, number[] | undefined] {
  const values = array(bbox);
  if (!values || values.length < 4) return [undefined, undefined];
  const numbers: number[] = [];
  // paddle.rs:343 `filter_map(as_f64)`; under arbitrary_precision `as_f64` drops non-finite values.
  for (const value of values.slice(0, 4)) {
    const number = f64(value);
    if (number === undefined) return [undefined, undefined];
    numbers.push(number);
  }
  const isNormalized = numbers.every(value => value >= 0 && value <= 1);
  if (isNormalized) {
    const resolved = resolveXywh(numbers, 1, 1);
    if (!resolved) return [undefined, undefined];
    const [x, y, width, height] = resolved;
    return [
      [x, y, width, height],
      [x * imageWidth, y * imageHeight, width * imageWidth, height * imageHeight],
    ];
  }
  const resolved = resolveXywh(numbers, imageWidth, imageHeight);
  if (!resolved) return [undefined, undefined];
  const [x, y, width, height] = resolved;
  return [
    [x / imageWidth, y / imageHeight, width / imageWidth, height / imageHeight],
    [x, y, width, height],
  ];
}

/** ocr_adapters/paddle.rs:225 `parse_paddle_json_response`. */
export function parsePaddleJsonResponse(response: string, imageWidth: number, imageHeight: number): ParsedPaddleResponse {
  // paddle.rs:213 `serde_json::from_str::<Value>`: parseJsonExact also applies serde's recursion limit.
  const text = extractJsonFromResponse(response);
  const parsed = parseJsonExact(text);
  if (parsed === undefined) {
    let detail = 'recursion limit exceeded';
    try { JSON.parse(text); } catch (error) { detail = error instanceof Error ? error.message : String(error); }
    throw OcrError.parse(`JSON 解析失败: ${detail}`);
  }

  const regions: OcrRegion[] = [];
  const width = imageWidth;
  const height = imageHeight;
  for (const block of array(fieldOf(parsed, 'blocks')) ?? []) {
    const blockType = string(fieldOf(block, 'type')) ?? 'text';
    const content = string(fieldOf(block, 'content')) ?? string(fieldOf(block, 'text')) ?? '';
    // paddle.rs:222-240: `Value::get` on a non-object block is None, so it yields a default region.
    const blockObject = object(block);
    const bboxValue = blockObject === undefined ? undefined
      : Object.hasOwn(blockObject, 'bbox') ? blockObject.bbox : blockObject.block_bbox;
    const [bboxNormalized, bboxPixels] = bboxValue === undefined
      ? [undefined, undefined]
      : parseBboxValue(bboxValue, width, height);
    const confidence = f64(fieldOf(block, 'score'));
    const region: OcrRegion = { label: blockType, text: content };
    if (bboxNormalized) region.bbox_normalized = bboxNormalized;
    if (bboxPixels) region.bbox_pixels = bboxPixels;
    if (confidence !== undefined) region.confidence = confidence;
    regions.push(region);
  }

  const result: ParsedPaddleResponse = { regions };
  const markdown = string(fieldOf(parsed, 'markdown'));
  if (markdown !== undefined) result.markdown = markdown;
  return result;
}

/** ocr_adapters/paddle.rs:369 `parse_deepseek_style_response`. */
function parseDeepseekStyleResponse(
  response: string,
  imageWidth: number,
  imageHeight: number,
  pageIndex: number,
  imagePath: string,
  mode: OcrMode,
  engine: OcrEngineType,
): OcrPageResult {
  const result = new DeepSeekOcrAdapter().parseResponse(response, imageWidth, imageHeight, pageIndex, imagePath, mode);
  result.engine = engine;
  return result;
}

/** ocr_adapters/paddle.rs:41 `PaddleOcrVlAdapter`. */
export class PaddleOcrVlAdapter extends BaseOcrAdapter {
  private readonly engine: OcrEngineType;

  constructor(engine: OcrEngineType = 'paddle_ocr_vl') {
    super();
    this.engine = engine;
  }

  static withEngine(engine: OcrEngineType): PaddleOcrVlAdapter { return new PaddleOcrVlAdapter(engine); }

  engineType(): OcrEngineType { return this.engine; }
  supportsMode(_mode: OcrMode): boolean { return true; }

  buildPrompt(mode: OcrMode): string {
    switch (mode) {
      case 'grounding':
      case 'free_ocr':
        // PaddleOCR-VL has no native bbox grounding; the standard OCR task is used.
        return 'OCR:';
      case 'formula': return 'Formula Recognition:';
      case 'table': return 'Table Recognition:';
      case 'chart': return 'Chart Recognition:';
    }
  }

  override recommendedRepetitionPenalty(): number | null { return 1.1; }

  override parseResponse(
    response: string, imageWidth: number, imageHeight: number, pageIndex: number, imagePath: string, mode: OcrMode,
  ): OcrPageResult {
    if (mode === 'grounding') {
      let parsed: ParsedPaddleResponse | undefined;
      try {
        parsed = parsePaddleJsonResponse(response, imageWidth, imageHeight);
      } catch {
        parsed = undefined;
      }
      if (parsed) {
        const result: OcrPageResult = {
          page_index: pageIndex,
          image_path: imagePath,
          image_width: imageWidth,
          image_height: imageHeight,
          regions: parsed.regions,
          engine: this.engine,
          mode,
        };
        if (parsed.markdown !== undefined) result.markdown_text = parsed.markdown;
        return result;
      }
      if (response.includes('<|ref|>') && response.includes('<|det|>')) {
        return parseDeepseekStyleResponse(response, imageWidth, imageHeight, pageIndex, imagePath, mode, this.engine);
      }
      return {
        page_index: pageIndex,
        image_path: imagePath,
        image_width: imageWidth,
        image_height: imageHeight,
        regions: [{ label: 'document', text: rustTrim(response), raw_output: response }],
        markdown_text: rustTrim(response),
        engine: this.engine,
        mode,
      };
    }

    const label = mode === 'formula' ? 'formula' : mode === 'table' ? 'table' : mode === 'chart' ? 'chart' : 'document';
    return {
      page_index: pageIndex,
      image_path: imagePath,
      image_width: imageWidth,
      image_height: imageHeight,
      regions: [{ label, text: rustTrim(response), raw_output: response }],
      markdown_text: rustTrim(response),
      engine: this.engine,
      mode,
    };
  }

  override recommendedMaxTokens(mode: OcrMode): number {
    return mode === 'grounding' ? 8000 : 4096;
  }
}
