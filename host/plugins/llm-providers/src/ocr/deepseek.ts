import type { OcrEngineType, OcrMode, OcrPageResult, OcrRegion } from '../../api.ts';
import { rustTrim } from '../../../../platform/util/portable.ts';
import { parseRustF64 } from '../json.ts';
import { BaseOcrAdapter } from './base.ts';

/** ocr_adapters/deepseek.rs:181 `DeepseekGroundingSpan`. */
export interface DeepseekGroundingSpan {
  label: string;
  bbox_0_999_xyxy: number[];
  raw_text: string;
  following_text: string;
}

function rustRound(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/** ocr_adapters/deepseek.rs:190 `parse_deepseek_grounding` (linear scan, C1 fix). */
export function parseDeepseekGrounding(raw: string): DeepseekGroundingSpan[] {
  const spans: DeepseekGroundingSpan[] = [];
  let pos = 0;

  while (pos < raw.length) {
    const refStart = raw.indexOf('<|ref|>', pos);
    if (refStart < 0) break;
    const labelStart = refStart + 7;

    const refEnd = raw.indexOf('<|/ref|>', labelStart);
    if (refEnd < 0) { pos = labelStart; continue; }
    const label = raw.slice(labelStart, refEnd);

    const detSearchStart = refEnd + 8;
    const detStart = raw.indexOf('<|det|>', detSearchStart);
    if (detStart < 0) { pos = detSearchStart; continue; }
    const coordsStart = detStart + 7;

    const detEnd = raw.indexOf('<|/det|>', coordsStart);
    if (detEnd < 0) { pos = coordsStart; continue; }

    const bbox = parseBboxArray(raw.slice(coordsStart, detEnd));
    if (bbox) {
      const afterDetStart = detEnd + 8;
      const nextRef = raw.indexOf('<|ref|>', afterDetStart);
      const following = rustTrim(raw.slice(afterDetStart, nextRef < 0 ? raw.length : nextRef));
      spans.push({
        label,
        bbox_0_999_xyxy: bbox,
        raw_text: raw.slice(refStart, detEnd + 8),
        following_text: following,
      });
    }
    pos = detEnd + 8;
  }
  return spans;
}

/** ocr_adapters/deepseek.rs:248 `project_to_unified_format`. */
function projectToUnifiedFormat(
  spans: readonly DeepseekGroundingSpan[],
  imageWidth: number,
  imageHeight: number,
): OcrRegion[] {
  if (imageWidth === 0 || imageHeight === 0) return [];
  const width = imageWidth;
  const height = imageHeight;
  const regions: OcrRegion[] = [];
  for (const span of spans) {
    if (span.bbox_0_999_xyxy.length !== 4) continue;
    const [x1_999, y1_999, x2_999, y2_999] = span.bbox_0_999_xyxy as [number, number, number, number];
    const x1Px = rustRound(x1_999 * width / 999);
    const y1Px = rustRound(y1_999 * height / 999);
    const x2Px = rustRound(x2_999 * width / 999);
    const y2Px = rustRound(y2_999 * height / 999);
    const widthPx = Math.max(x2Px - x1Px, 1);
    const heightPx = Math.max(y2Px - y1Px, 1);
    const following = rustTrim(span.following_text);
    regions.push({
      label: span.label,
      text: following === '' ? span.label : following,
      bbox_normalized: [x1Px / width, y1Px / height, widthPx / width, heightPx / height],
      bbox_pixels: [x1Px, y1Px, widthPx, heightPx],
    });
  }
  return regions;
}

/** ocr_adapters/deepseek.rs:312 `extract_markdown_text`. */
export function extractMarkdownText(response: string): string {
  let clean = '';
  let pos = 0;
  while (pos < response.length) {
    const refStart = response.indexOf('<|ref|>', pos);
    if (refStart >= 0) {
      clean += response.slice(pos, refStart);
      const detEnd = response.indexOf('<|/det|>', refStart);
      if (detEnd >= 0) { pos = detEnd + 8; continue; }
      clean += response.slice(refStart);
      break;
    }
    clean += response.slice(pos);
    break;
  }
  return rustTrim(clean.replaceAll('<|grounding|>', ''));
}

/** ocr_adapters/deepseek.rs:353 `parse_bbox_array`. */
function parseBboxArray(text: string): number[] | undefined {
  const trimmed = rustTrim(text);
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return undefined;
  const inner = rustTrim(trimmed.slice(1, -1));
  const start = inner.indexOf('[');
  if (start < 0) return undefined;
  const end = inner.slice(start).indexOf(']');
  if (end < 0) return undefined;
  const numbers: number[] = [];
  for (const part of inner.slice(start + 1, start + end).split(',')) {
    const value = parseRustF64(rustTrim(part));
    if (value === undefined) return undefined;
    numbers.push(value);
  }
  return numbers.length === 4 ? numbers : undefined;
}

/** ocr_adapters/deepseek.rs:35 `DeepSeekOcrAdapter`. */
export class DeepSeekOcrAdapter extends BaseOcrAdapter {
  engineType(): OcrEngineType { return 'deepseek_ocr'; }
  supportsMode(_mode: OcrMode): boolean { return true; }

  buildPrompt(mode: OcrMode): string {
    switch (mode) {
      case 'grounding': return '<|grounding|>Convert the document to markdown.';
      case 'free_ocr': return 'Free OCR.';
      case 'formula': return 'Parse the figure.';
      case 'table': return '<|grounding|>Convert the document to markdown.';
      case 'chart': return 'Parse the figure.';
    }
  }

  override buildCustomPrompt(customPrompt: string, mode: OcrMode): string {
    if (customPrompt.includes('<|grounding|>')) return customPrompt;
    if (mode === 'grounding' || mode === 'table') return `<|grounding|>${customPrompt}`;
    return customPrompt;
  }

  override parseResponse(
    response: string, imageWidth: number, imageHeight: number, pageIndex: number, imagePath: string, mode: OcrMode,
  ): OcrPageResult {
    if (mode === 'grounding' || mode === 'table') {
      const spans = parseDeepseekGrounding(response);
      return {
        page_index: pageIndex,
        image_path: imagePath,
        image_width: imageWidth,
        image_height: imageHeight,
        regions: projectToUnifiedFormat(spans, imageWidth, imageHeight),
        markdown_text: extractMarkdownText(response),
        engine: 'deepseek_ocr',
        mode,
      };
    }
    return {
      page_index: pageIndex,
      image_path: imagePath,
      image_width: imageWidth,
      image_height: imageHeight,
      regions: [{ label: 'document', text: rustTrim(response), raw_output: response }],
      markdown_text: rustTrim(response),
      engine: 'deepseek_ocr',
      mode,
    };
  }

  override recommendedMaxTokens(mode: OcrMode): number {
    return mode === 'grounding' ? 8000 : 4096;
  }
}
