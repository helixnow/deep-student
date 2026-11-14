/**
 * DeepSeek-OCR Grounding 解析器（移植 `dstu-llm/src/deepseek_ocr_parser.rs`）。
 *
 * 输出格式：
 * ```text
 * 普通文本...
 * <|ref|>标签文本<|/ref|><|det|>[[x1,y1,x2,y2],...]<|/det|>
 * 更多文本...
 * ```
 *
 * 坐标系统：DeepSeek-OCR 输出 0-999 归一化 xyxy 坐标，(0,0) 在左上角。
 * 像素换算：x_px = round(x * W / 999)，y_px = round(y * H / 999)，
 * 再转换为 xywh（width = x2 - x1，height = y2 - y1）。
 *
 * Rust 按 UTF-8 字节扫描并做字符边界修正；这里复用同样的字节语义，
 * 保证含中文/emoji 的输入切片结果与 Rust 一致。
 */
import { rustTrim } from '../../../platform/util/portable.ts';

/** DeepSeek-OCR 原始 Grounding 片段（0-999 归一化坐标）。 */
export interface DeepseekGroundingSpan {
  /** `<|ref|>` 标签文本。 */
  label: string;
  /** `[x1,y1,x2,y2]` 归一化到 0-999。 */
  bbox_0_999_xyxy: number[];
  /** 原始 `<|ref|>...<|/det|>` 片段（不含后续文本）。 */
  raw_text: string;
  /** `<|/det|>` 之后、下一个 `<|ref|>` 之前的文本。 */
  following_text: string;
}

/** 转换后的像素坐标区域。 */
export interface DeepseekRegion {
  label: string;
  /** OCR 识别的文本内容。 */
  text: string;
  /** `[x, y, width, height]` 归一化到 0-1。 */
  bbox_0_1_xywh: number[];
  /** `[x, y, width, height]` 像素坐标。 */
  bbox_px_xywh: number[];
}

const REF_OPEN = '<|ref|>';
const REF_CLOSE = '<|/ref|>';
const DET_OPEN = '<|det|>';
const DET_CLOSE = '<|/det|>';

const utf8 = new TextEncoder();

function isCharBoundary(bytes: Uint8Array, index: number): boolean {
  if (index <= 0 || index >= bytes.length) return true;
  const byte = bytes[index];
  return byte !== undefined && (byte & 0xc0) !== 0x80;
}

/**
 * 安全的 UTF-8 字符串切片，确保不会在字符边界中间切割。
 *
 * - start 不在字符边界时向前回退到前一个字符边界；
 * - end 不在字符边界时向后前进到下一个字符边界；
 * - start > end 时返回空字符串。
 */
export function safeSlice(source: string, byteStart: number, byteEnd: number): string {
  if (source === '') return '';
  const bytes = utf8.encode(source);
  const length = bytes.length;
  let start = Math.min(byteStart, length);
  let end = Math.min(byteEnd, length);

  while (start > 0 && !isCharBoundary(bytes, start)) start -= 1;
  while (end < length && !isCharBoundary(bytes, end)) end += 1;

  if (start > end) return '';
  return new TextDecoder().decode(bytes.subarray(start, end));
}

/** 在字节数组中从 `start` 起查找子串；不存在返回 null。 */
export function findSubstr(haystack: Uint8Array, needle: Uint8Array, start: number): number | null {
  if (start >= haystack.length) return null;
  const last = haystack.length - needle.length;
  for (let index = start; index <= last; index += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return index;
  }
  return null;
}

/** 解析 `[[x1,y1,x2,y2],...]`；存在多个框时只取第一个。 */
function parseBboxArray(text: string): number[] | null {
  const trimmed = rustTrim(text);
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;

  const inner = rustTrim(trimmed.slice(1, -1));
  const start = inner.indexOf('[');
  if (start < 0) return null;
  const end = inner.indexOf(']', start);
  if (end < 0) return null;

  const parts = inner.slice(start + 1, end).split(',').map(rustTrim);
  if (parts.length !== 4) return null;
  const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
  if (parts.some((part) => part === '' || !numeric.test(part))) return null;
  return parts.map((part) => Number(part));
}

/**
 * 解析 DeepSeek-OCR 的 grounding 输出。
 *
 * 扫描循环线性推进：找不到下一个标记直接结束，残缺标记则跳过该标记继续，
 * 整体 O(n)（对应 Rust C1 修复）。
 */
export function parseDeepseekGrounding(raw: string): DeepseekGroundingSpan[] {
  const spans: DeepseekGroundingSpan[] = [];
  const text = utf8.encode(raw);
  const refOpen = utf8.encode(REF_OPEN);
  const refClose = utf8.encode(REF_CLOSE);
  const detOpen = utf8.encode(DET_OPEN);
  const detClose = utf8.encode(DET_CLOSE);
  let pos = 0;

  while (pos < text.length) {
    const refStart = findSubstr(text, refOpen, pos);
    if (refStart === null) break;
    const labelStart = refStart + REF_OPEN.length;

    const refEnd = findSubstr(text, refClose, labelStart);
    if (refEnd === null) {
      pos = labelStart;
      continue;
    }
    const label = safeSlice(raw, labelStart, refEnd);

    const detSearchStart = refEnd + REF_CLOSE.length;
    const detStart = findSubstr(text, detOpen, detSearchStart);
    if (detStart === null) {
      pos = detSearchStart;
      continue;
    }
    const coordsStart = detStart + DET_OPEN.length;

    const detEnd = findSubstr(text, detClose, coordsStart);
    if (detEnd === null) {
      pos = coordsStart;
      continue;
    }

    const bbox = parseBboxArray(safeSlice(raw, coordsStart, detEnd));
    if (bbox !== null) {
      const rawText = safeSlice(raw, refStart, detEnd + DET_CLOSE.length);
      const afterDetStart = detEnd + DET_CLOSE.length;
      const nextRef = findSubstr(text, refOpen, afterDetStart) ?? text.length;
      const followingText = rustTrim(safeSlice(raw, afterDetStart, nextRef));
      spans.push({
        label,
        bbox_0_999_xyxy: bbox,
        raw_text: rawText,
        following_text: followingText,
      });
    }

    pos = detEnd + DET_CLOSE.length;
  }

  return spans;
}

/** Rust `f64::round`：半数远离零。 */
function rustRound(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/**
 * 将 0-999 归一化坐标转换为 0-1 归一化坐标和像素坐标。
 *
 * 文本优先使用 `<|/det|>` 之后跟随的文本；为空时回退到 label。
 */
export function projectToPixels(
  spans: readonly DeepseekGroundingSpan[],
  imageWidth: number,
  imageHeight: number,
): DeepseekRegion[] {
  if (imageWidth === 0 || imageHeight === 0) return [];

  const width = imageWidth;
  const height = imageHeight;
  const regions: DeepseekRegion[] = [];

  for (const span of spans) {
    if (span.bbox_0_999_xyxy.length !== 4) continue;
    const [x1_999, y1_999, x2_999, y2_999] = span.bbox_0_999_xyxy as [
      number, number, number, number,
    ];

    const x1Px = rustRound((x1_999 * width) / 999);
    const y1Px = rustRound((y1_999 * height) / 999);
    const x2Px = rustRound((x2_999 * width) / 999);
    const y2Px = rustRound((y2_999 * height) / 999);

    const widthPx = Math.max(x2Px - x1Px, 1);
    const heightPx = Math.max(y2Px - y1Px, 1);

    const text = rustTrim(span.following_text);
    regions.push({
      label: span.label,
      text: text === '' ? span.label : text,
      bbox_0_1_xywh: [x1Px / width, y1Px / height, widthPx / width, heightPx / height],
      bbox_px_xywh: [x1Px, y1Px, widthPx, heightPx],
    });
  }

  return regions;
}
