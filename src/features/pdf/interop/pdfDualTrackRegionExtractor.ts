/**
 * PDF 框选双轨提取器（C7 §2.1 Dual-Track Region Capture）：
 *
 * - Track 1（0ms 原生几何文本提取）：同步查询目标页 `.textLayer span` 与框选矩形相交的文本片段，
 *   通过水平空隙聚类（Horizontal Gap Clustering）自动判别单栏 / 双栏学术版式，
 *   按「通栏标题 → 左栏自上而下 → 右栏自上而下 → 通栏图注」的学术阅读顺序组装干净文本。
 * - Track 2（扫描版 PDF / 复杂公式视觉回退）：当框选区命中 0 个原生文本 span（扫描页）或用户显式点击
 *   `[识别文字/公式]` 时，调用可注入的异步视觉/OCR 识别器（默认对接宿主 `chat_v2_perform_ocr` /
 *   `ocr_extract_text` 与公式整理通道），带严格超时与无阻塞降级，确保拖拽胶囊永不卡顿。
 */
import { invoke } from '@tauri-apps/api/core';
import type { NormalizedRect } from '@/ui-kernel/contracts/interop';
import { normalizePdfAcademicText } from '../pdfAcademicText';
import { blobToDataUrl, cleanExtractedStructuredText } from '../pdfRegionExtract';
import { normalizePdfLigatures } from '../pdfSearch';
import { intersectRects, type ScreenRect } from '../regionCapture';
import { rotateNormalizedRect } from './pdfInteropBridge';

// ============================================================================
// 类型与常量
// ============================================================================

export const DEFAULT_VISION_FALLBACK_TIMEOUT_MS = 3500;

const MIN_VERTICAL_OVERLAP_RATIO = 0.35;
const MIN_HORIZONTAL_OVERLAP_RATIO = 0.15;
const CJK_BOUNDARY_RE = /[\u2e80-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af，。！？；：、（）《》「」『』【】]/;
const FORMULA_HINT_RE =
  /(?:\$\$|\\\[|\\(?:frac|sum|int|prod|sqrt|begin|alpha|beta|gamma|delta|theta|lambda|sigma|omega|nabla|partial|infty|mathbb|mathcal|mathrm)|[∑∫∏√∂∇±≤≥≠≈∞∈∉⊂⊆∪∩α-ωΑ-Ω]|[_^][{a-zA-Z0-9])/;

export type AcademicColumnLayout = 'single-column' | 'two-column';

export interface PositionedTextSpan {
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface NativeRegionTextExtractionResult {
  extractedText: string;
  latex?: string;
  spanCount: number;
  layout: AcademicColumnLayout;
  orderedSpans: PositionedTextSpan[];
}

export interface PdfVisionRecognitionInput {
  blob: Blob;
  imageDataUrl: string;
  page: number;
  rectNorm?: NormalizedRect;
  nativeText?: string;
  preferFormula?: boolean;
  signal?: AbortSignal;
}

export interface PdfVisionRecognitionOutput {
  text?: string;
  latex?: string;
  source?: 'vision' | 'ocr';
}

export type PdfRegionVisionRecognizer = (
  input: PdfVisionRecognitionInput,
) => Promise<PdfVisionRecognitionOutput | null | undefined>;

export interface VisionFallbackOutcome {
  status: 'ok' | 'timeout' | 'fallback-image-only';
  text: string;
  latex?: string;
  source?: 'vision' | 'ocr';
}

export interface DualTrackRegionExtractionResult {
  track: 'native-text' | 'vision-ocr' | 'image-only';
  extractedText: string;
  latex?: string;
  spanCount: number;
  layout: AcademicColumnLayout;
  timedOut?: boolean;
}

interface InternalSpan extends PositionedTextSpan {
  right: number;
  bottom: number;
  centerX: number;
  centerY: number;
}

interface LineCluster {
  spans: InternalSpan[];
  top: number;
  bottom: number;
  height: number;
  centerY: number;
}

// ============================================================================
// Track 1：0ms 原生几何文本提取与双栏学术阅读序重排
// ============================================================================

function computeMedianHeight(spans: readonly InternalSpan[]): number {
  if (spans.length === 0) return 12;
  const heights = spans.map((s) => s.height).sort((a, b) => a - b);
  const mid = Math.floor(heights.length / 2);
  return heights.length % 2 === 1
    ? heights[mid]!
    : (heights[mid - 1]! + heights[mid]!) / 2;
}

function toInternalSpans(spans: readonly PositionedTextSpan[]): InternalSpan[] {
  const out: InternalSpan[] = [];
  for (const span of spans) {
    const cleaned = normalizePdfLigatures(span.text ?? '').replace(/[\r\n]+/g, ' ');
    if (!cleaned.trim()) continue;
    if (
      !Number.isFinite(span.left) ||
      !Number.isFinite(span.top) ||
      !Number.isFinite(span.width) ||
      !Number.isFinite(span.height) ||
      span.width <= 0 ||
      span.height <= 0
    ) {
      continue;
    }
    out.push({
      text: cleaned,
      left: span.left,
      top: span.top,
      width: span.width,
      height: span.height,
      right: span.left + span.width,
      bottom: span.top + span.height,
      centerX: span.left + span.width / 2,
      centerY: span.top + span.height / 2,
    });
  }
  return out;
}

function countDistinctVerticalLines(spans: readonly InternalSpan[], medianHeight: number): number {
  if (spans.length === 0) return 0;
  const sorted = [...spans].sort((a, b) => a.centerY - b.centerY);
  let lines = 1;
  let lastY = sorted[0]!.centerY;
  const threshold = Math.max(4, medianHeight * 0.6);
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i]!.centerY - lastY >= threshold) {
      lines += 1;
      lastY = sorted[i]!.centerY;
    }
  }
  return lines;
}

/**
 * 水平空隙投影聚类：在候选非通栏 span 的 X 投影区间中寻找位于中部走廊 `[0.20, 0.80]` 的栏间留白（gutter）。
 * 若满足栏宽、栏间距与多行条件，返回分栏中轴 `splitX`，否则返回 `null`（单栏版式）。
 */
function detectTwoColumnSplitX(
  spans: readonly InternalSpan[],
  medianHeight: number,
  regionLeft: number,
  regionRight: number,
): number | null {
  const regionWidth = regionRight - regionLeft;
  if (spans.length < 2 || regionWidth < medianHeight * 5.5) return null;

  const candidateSpans = spans.filter((s) => s.width <= regionWidth * 0.62);
  if (candidateSpans.length < 2) return null;

  const intervals = candidateSpans
    .map((s) => ({ left: s.left, right: s.right }))
    .sort((a, b) => a.left - b.left || a.right - b.right);

  const merged: Array<{ left: number; right: number }> = [];
  for (const interval of intervals) {
    const last = merged[merged.length - 1];
    if (!last || interval.left > last.right + 1) {
      merged.push({ ...interval });
    } else {
      last.right = Math.max(last.right, interval.right);
    }
  }

  if (merged.length < 2) return null;

  const corridorMin = regionLeft + regionWidth * 0.2;
  const corridorMax = regionLeft + regionWidth * 0.8;
  const minGutterWidth = Math.max(medianHeight * 0.8, regionWidth * 0.035);

  let bestSplitX: number | null = null;
  let bestGapWidth = 0;

  for (let i = 0; i < merged.length - 1; i += 1) {
    const gapLeft = merged[i]!.right;
    const gapRight = merged[i + 1]!.left;
    const gapWidth = gapRight - gapLeft;
    const midX = (gapLeft + gapRight) / 2;
    if (midX < corridorMin || midX > corridorMax) continue;
    if (gapWidth < minGutterWidth || gapWidth <= bestGapWidth) continue;

    const leftCol = candidateSpans.filter((s) => s.centerX < midX);
    const rightCol = candidateSpans.filter((s) => s.centerX >= midX);
    if (leftCol.length === 0 || rightCol.length === 0) continue;

    const leftExtent =
      Math.max(...leftCol.map((s) => s.right)) - Math.min(...leftCol.map((s) => s.left));
    const rightExtent =
      Math.max(...rightCol.map((s) => s.right)) - Math.min(...rightCol.map((s) => s.left));
    const minColExtent = Math.max(medianHeight * 2.2, regionWidth * 0.12);
    if (leftExtent < minColExtent || rightExtent < minColExtent) continue;

    // 排除单行左右两端文字（如单行公式右侧编号），至少一栏存在 >=2 行才构成双栏纵向阅读流
    const leftLines = countDistinctVerticalLines(leftCol, medianHeight);
    const rightLines = countDistinctVerticalLines(rightCol, medianHeight);
    if (leftLines < 2 && rightLines < 2) continue;

    bestGapWidth = gapWidth;
    bestSplitX = midX;
  }

  return bestSplitX;
}

function joinLineSpans(lineSpans: readonly InternalSpan[]): string {
  if (lineSpans.length === 0) return '';
  let lineText = lineSpans[0]!.text.trim();
  let prev = lineSpans[0]!;

  for (let i = 1; i < lineSpans.length; i += 1) {
    const curr = lineSpans[i]!;
    const currTrimmed = curr.text.trim();
    if (!currTrimmed) continue;
    if (!lineText) {
      lineText = currTrimmed;
      prev = curr;
      continue;
    }

    const hadBoundarySpace = /\s$/.test(prev.text) || /^\s/.test(curr.text);
    const gap = curr.left - prev.right;
    const refHeight = Math.min(prev.height, curr.height);
    const prevLast = lineText[lineText.length - 1] ?? '';
    const currFirst = currTrimmed[0] ?? '';
    const bothCjk = CJK_BOUNDARY_RE.test(prevLast) && CJK_BOUNDARY_RE.test(currFirst);

    const needsSpace = bothCjk
      ? gap > refHeight * 0.65
      : hadBoundarySpace || gap > Math.max(1.5, refHeight * 0.14);

    lineText = needsSpace ? `${lineText} ${currTrimmed}` : `${lineText}${currTrimmed}`;
    prev = curr;
  }

  return lineText;
}

function clusterColumnLines(columnSpans: readonly InternalSpan[]): {
  orderedSpans: PositionedTextSpan[];
  text: string;
} {
  if (columnSpans.length === 0) {
    return { orderedSpans: [], text: '' };
  }

  const byY = [...columnSpans].sort((a, b) => a.centerY - b.centerY || a.left - b.left);
  const lines: LineCluster[] = [];

  for (const span of byY) {
    const current = lines[lines.length - 1];
    if (
      current &&
      Math.abs(span.centerY - current.centerY) <= Math.max(current.height, span.height) * 0.55
    ) {
      const count = current.spans.length;
      current.spans.push(span);
      current.top = Math.min(current.top, span.top);
      current.bottom = Math.max(current.bottom, span.bottom);
      current.height = Math.max(current.height, span.height);
      current.centerY = (current.centerY * count + span.centerY) / (count + 1);
    } else {
      lines.push({
        spans: [span],
        top: span.top,
        bottom: span.bottom,
        height: span.height,
        centerY: span.centerY,
      });
    }
  }

  const orderedSpans: PositionedTextSpan[] = [];
  const rawLines: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    line.spans.sort((a, b) => a.left - b.left || a.top - b.top);
    for (const s of line.spans) {
      orderedSpans.push({
        text: s.text,
        left: s.left,
        top: s.top,
        width: s.width,
        height: s.height,
      });
    }

    if (i > 0) {
      const prevLine = lines[i - 1]!;
      const verticalGap = line.top - prevLine.bottom;
      if (verticalGap > Math.max(prevLine.height, line.height) * 0.85) {
        rawLines.push('');
      }
    }
    rawLines.push(joinLineSpans(line.spans));
  }

  const normalized = normalizePdfAcademicText(rawLines.join('\n'));
  return { orderedSpans, text: normalized };
}

/**
 * 从已识别文本中提取显式 LaTeX 块（`$$ ... $$`、`\[ ... \]` 或 `\begin{equation|align|...}`）。
 */
export function extractLatexFromRecognizedText(raw: string): string | undefined {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return undefined;

  const displayDollar = /\$\$([\s\S]+?)\$\$/.exec(trimmed);
  if (displayDollar?.[1]?.trim()) {
    return `$$\n${displayDollar[1].trim()}\n$$`;
  }

  const displayBracket = /\\\[([\s\S]+?)\\\]/.exec(trimmed);
  if (displayBracket?.[1]?.trim()) {
    return `$$\n${displayBracket[1].trim()}\n$$`;
  }

  const envMatch =
    /(\\begin\{(?:equation|align|aligned|gather|matrix|bmatrix|pmatrix|cases)\*?\}[\s\S]+?\\end\{(?:equation|align|aligned|gather|matrix|bmatrix|pmatrix|cases)\*?\})/.exec(
      trimmed,
    );
  if (envMatch?.[1]?.trim()) {
    return envMatch[1].trim();
  }

  return undefined;
}

/**
 * 将一组带几何包围盒的文本 span 按学术阅读序（自动识别单栏 vs 双栏）排序并拼接。
 */
export function sortTextSpansInAcademicReadingOrder(spans: readonly PositionedTextSpan[]): {
  layout: AcademicColumnLayout;
  orderedSpans: PositionedTextSpan[];
  extractedText: string;
  latex?: string;
} {
  const internal = toInternalSpans(spans);
  if (internal.length === 0) {
    return { layout: 'single-column', orderedSpans: [], extractedText: '' };
  }

  const medianHeight = computeMedianHeight(internal);
  const regionLeft = Math.min(...internal.map((s) => s.left));
  const regionRight = Math.max(...internal.map((s) => s.right));
  const regionWidth = regionRight - regionLeft;
  const splitX = detectTwoColumnSplitX(internal, medianHeight, regionLeft, regionRight);

  if (splitX === null) {
    const single = clusterColumnLines(internal);
    const latex = extractLatexFromRecognizedText(single.text);
    return {
      layout: 'single-column',
      orderedSpans: single.orderedSpans,
      extractedText: single.text,
      ...(latex ? { latex } : {}),
    };
  }

  // 双栏版式：通栏标题 / 图注（跨越 splitX 且宽度 > 0.62 * regionWidth）按纵向位置切分上下区段
  const spanning = internal
    .filter((s) => s.width > regionWidth * 0.62 && s.left < splitX && s.right > splitX)
    .sort((a, b) => a.centerY - b.centerY);

  const orderedSpans: PositionedTextSpan[] = [];
  const blockTexts: string[] = [];

  const flushTwoColumnBand = (bandSpans: InternalSpan[]) => {
    if (bandSpans.length === 0) return;
    const leftSpans = bandSpans.filter((s) => s.centerX < splitX);
    const rightSpans = bandSpans.filter((s) => s.centerX >= splitX);
    const leftResult = clusterColumnLines(leftSpans);
    const rightResult = clusterColumnLines(rightSpans);
    orderedSpans.push(...leftResult.orderedSpans, ...rightResult.orderedSpans);
    if (leftResult.text) blockTexts.push(leftResult.text);
    if (rightResult.text) blockTexts.push(rightResult.text);
  };

  if (spanning.length === 0) {
    flushTwoColumnBand(internal);
  } else {
    const spanningSet = new Set(spanning);
    let cursorY = Number.NEGATIVE_INFINITY;
    for (const divider of spanning) {
      const band = internal.filter(
        (s) => !spanningSet.has(s) && s.centerY >= cursorY && s.centerY < divider.top,
      );
      flushTwoColumnBand(band);
      const spanBlock = clusterColumnLines([divider]);
      orderedSpans.push(...spanBlock.orderedSpans);
      if (spanBlock.text) blockTexts.push(spanBlock.text);
      cursorY = divider.top;
    }
    const tailBand = internal.filter((s) => !spanningSet.has(s) && s.centerY >= cursorY);
    flushTwoColumnBand(tailBand);
  }

  const extractedText = blockTexts.filter(Boolean).join('\n\n').trim();
  const latex = extractLatexFromRecognizedText(extractedText);
  return {
    layout: 'two-column',
    orderedSpans,
    extractedText,
    ...(latex ? { latex } : {}),
  };
}

/**
 * 收集目标页内与框选矩形发生有效几何相交的 `.textLayer span` 叶子节点。
 */
export function collectIntersectingTextSpans(
  pageElement: ParentNode | null | undefined,
  cropRect: ScreenRect,
): PositionedTextSpan[] {
  if (!pageElement || !(cropRect.width > 0) || !(cropRect.height > 0)) return [];

  const candidates = pageElement.querySelectorAll<HTMLElement>(
    '.textLayer span, .react-pdf__Page__textContent span',
  );
  const matched: PositionedTextSpan[] = [];

  for (let i = 0; i < candidates.length; i += 1) {
    const el = candidates[i]!;
    if (el.classList.contains('markedContent') || el.classList.contains('endOfContent')) continue;
    // 跳过包裹子 span 的容器节点，避免同一字符被父子双重采集
    if (el.querySelector('span') !== null) continue;

    const rawText = el.textContent ?? '';
    if (!rawText.trim()) continue;

    const rect = el.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) continue;

    const overlap = intersectRects(cropRect, rect);
    if (!overlap) continue;

    const minH = Math.min(rect.height, cropRect.height);
    const minW = Math.min(rect.width, cropRect.width);
    if (
      overlap.height / minH < MIN_VERTICAL_OVERLAP_RATIO ||
      overlap.width / minW < MIN_HORIZONTAL_OVERLAP_RATIO
    ) {
      continue;
    }

    matched.push({
      text: rawText,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    });
  }

  return matched;
}

/**
 * Track 1 入口（0ms 同步）：从目标页 DOM 提取框选区域内的学术阅读序文本。
 */
export function extractNativeRegionTextFromPage(
  pageElement: ParentNode | null | undefined,
  cropRect: ScreenRect,
): NativeRegionTextExtractionResult {
  const rawSpans = collectIntersectingTextSpans(pageElement, cropRect);
  if (rawSpans.length === 0) {
    return {
      extractedText: '',
      spanCount: 0,
      layout: 'single-column',
      orderedSpans: [],
    };
  }

  // 相交测试使用屏幕坐标；排序前还原页面方向，否则 90°/270° 时同一行会变成一列，180° 时整页倒序。
  const page = pageElement as HTMLElement;
  const rotation = Number(page?.getAttribute?.('data-page-rotation') ?? 0);
  const bounds = page?.getBoundingClientRect?.();
  const unrotatedSpans = rotation % 360 !== 0 && bounds && bounds.width > 0 && bounds.height > 0
    ? rawSpans.map((span) => {
        const rect = rotateNormalizedRect({
          x: (span.left - bounds.left) / bounds.width,
          y: (span.top - bounds.top) / bounds.height,
          w: span.width / bounds.width,
          h: span.height / bounds.height,
        }, -rotation);
        if (!rect) return span;
        const width = rotation % 180 === 0 ? bounds.width : bounds.height;
        const height = rotation % 180 === 0 ? bounds.height : bounds.width;
        return { text: span.text, left: rect.x * width, top: rect.y * height, width: rect.w * width, height: rect.h * height };
      })
    : rawSpans;
  const sorted = sortTextSpansInAcademicReadingOrder(unrotatedSpans);
  return {
    extractedText: sorted.extractedText,
    ...(sorted.latex ? { latex: sorted.latex } : {}),
    spanCount: sorted.orderedSpans.length,
    layout: sorted.layout,
    orderedSpans: sorted.orderedSpans,
  };
}

export function extractNativeRegionTextFromViewport(
  viewport: ParentNode | null | undefined,
  page: number,
  cropRect: ScreenRect,
): NativeRegionTextExtractionResult {
  const pageEl = viewport?.querySelector<HTMLElement>(`[data-page-number="${page}"]`) ?? null;
  return extractNativeRegionTextFromPage(pageEl, cropRect);
}

// ============================================================================
// Track 2：扫描版 PDF / 复杂公式异步视觉识别与无阻塞超时降级
// ============================================================================

export function looksLikeFormulaRegionText(text: string): boolean {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return false;
  return FORMULA_HINT_RE.test(trimmed);
}

function buildDualTrackVisionPrompt(ocrText: string): string {
  return [
    'You are an academic PDF excerpt & formula transcription assistant.',
    'Clean up the following OCR output from a cropped PDF region:',
    '- Preserve prose sentences accurately in reading order.',
    '- Transcribe any mathematical equations or formulas into standard compilable LaTeX wrapped in $$ ... $$.',
    '- Output ONLY the cleaned excerpt text (with $$ ... $$ for equations), without commentary or markdown code fences.',
    '',
    '[OCR Output]',
    ocrText,
  ].join('\n');
}

async function invokeHostRegionOcr(dataUrl: string): Promise<string> {
  try {
    const primary = await invoke<{ ocr_text?: string }>('chat_v2_perform_ocr', {
      request: { images: [dataUrl] },
    });
    if (primary?.ocr_text?.trim()) {
      return primary.ocr_text.trim();
    }
  } catch {
    // 主通道不可用时回退通用 ocr_extract_text
  }

  const commaIdx = dataUrl.indexOf(',');
  const imageBase64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
  const fallback = await invoke<string>('ocr_extract_text', {
    imagePath: null,
    imageBase64,
  });
  return (fallback ?? '').trim();
}

export const defaultHostPdfVisionRecognizer: PdfRegionVisionRecognizer = async (input) => {
  if (input.signal?.aborted) return null;
  const dataUrl = input.imageDataUrl || (await blobToDataUrl(input.blob));
  if (!dataUrl || input.signal?.aborted) return null;

  const ocrText = await invokeHostRegionOcr(dataUrl);
  if (!ocrText || input.signal?.aborted) return null;

  const shouldFormatFormula = Boolean(input.preferFormula) || looksLikeFormulaRegionText(ocrText);
  if (shouldFormatFormula) {
    try {
      const llmRes = await invoke<{ assistant_message?: string }>('call_llm_for_boundary', {
        prompt: buildDualTrackVisionPrompt(ocrText),
      });
      const rawAssistant = (llmRes?.assistant_message ?? '').trim();
      if (rawAssistant && !input.signal?.aborted) {
        const unfenced = cleanExtractedStructuredText(rawAssistant, 'table');
        const extractedLatex = extractLatexFromRecognizedText(unfenced);
        const normalizedText = normalizePdfAcademicText(unfenced) || unfenced;
        return {
          text: normalizedText,
          ...(extractedLatex ? { latex: extractedLatex } : {}),
          source: 'vision',
        };
      }
    } catch {
      // LLM 整理未配置或超时时静默保留 OCR 结果
    }
  }

  const explicitLatex = extractLatexFromRecognizedText(ocrText);
  const formulaOnlyLatex =
    !explicitLatex && Boolean(input.preferFormula) && looksLikeFormulaRegionText(ocrText)
      ? cleanExtractedStructuredText(ocrText, 'latex')
      : explicitLatex;

  return {
    text: normalizePdfAcademicText(ocrText) || ocrText,
    ...(formulaOnlyLatex ? { latex: formulaOnlyLatex } : {}),
    source: 'ocr',
  };
};

let activeVisionRecognizer: PdfRegionVisionRecognizer = defaultHostPdfVisionRecognizer;

export function setDefaultPdfRegionVisionRecognizer(
  recognizer: PdfRegionVisionRecognizer | null,
): void {
  activeVisionRecognizer = recognizer ?? defaultHostPdfVisionRecognizer;
}

export function getDefaultPdfRegionVisionRecognizer(): PdfRegionVisionRecognizer {
  return activeVisionRecognizer;
}

/**
 * 带超时与异常隔离的异步视觉/OCR 识别调用：超时或未配置时从不抛错，优雅降级为仅原图模式。
 */
export async function recognizeRegionWithVisionFallback(
  params: PdfVisionRecognitionInput & {
    recognizer?: PdfRegionVisionRecognizer;
    timeoutMs?: number;
  },
): Promise<VisionFallbackOutcome> {
  const recognizer = params.recognizer ?? activeVisionRecognizer;
  if (params.signal?.aborted) {
    return { status: 'fallback-image-only', text: params.nativeText ?? '' };
  }
  const timeoutMs =
    typeof params.timeoutMs === 'number' && params.timeoutMs > 0
      ? params.timeoutMs
      : DEFAULT_VISION_FALLBACK_TIMEOUT_MS;

  const controller = new AbortController();
  let resolveAbort!: (value: null) => void;
  const aborted = new Promise<null>((resolve) => { resolveAbort = resolve; });
  const onParentAbort = () => { controller.abort(); resolveAbort(null); };
  params.signal?.addEventListener('abort', onParentAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  let didTimeout = false;

  const timeoutPromise = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      didTimeout = true;
      controller.abort();
      resolve(null);
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([
      Promise.resolve().then(() =>
        controller.signal.aborted ? null : recognizer({
          blob: params.blob,
          imageDataUrl: params.imageDataUrl,
          page: params.page,
          rectNorm: params.rectNorm,
          nativeText: params.nativeText,
          preferFormula: params.preferFormula,
          signal: controller.signal,
        }),
      ),
      timeoutPromise,
      aborted,
    ]);

    if (didTimeout) {
      return {
        status: 'timeout',
        text: params.nativeText ?? '',
      };
    }
    if (params.signal?.aborted) {
      return { status: 'fallback-image-only', text: params.nativeText ?? '' };
    }

    const cleanedLatex = result?.latex?.trim()
      ? cleanExtractedStructuredText(result.latex, 'latex')
      : '';
    const rawLatex = cleanedLatex
      ? (extractLatexFromRecognizedText(cleanedLatex) ?? cleanedLatex)
      : result?.text
        ? extractLatexFromRecognizedText(result.text)
        : undefined;
    const rawText = (result?.text ?? '').trim();
    const resolvedText = rawText || rawLatex || '';

    if (!resolvedText) {
      return {
        status: 'fallback-image-only',
        text: params.nativeText ?? '',
      };
    }

    return {
      status: 'ok',
      text: resolvedText,
      ...(rawLatex ? { latex: rawLatex } : {}),
      source: result?.source ?? 'vision',
    };
  } catch {
    return {
      status: didTimeout ? 'timeout' : 'fallback-image-only',
      text: params.nativeText ?? '',
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    params.signal?.removeEventListener('abort', onParentAbort);
  }
}

/**
 * 双轨提取总编排：
 * - 若目标页存在相交 `.textLayer` 文本且未强制走视觉识别，0ms 直接返回 Track 1 结果；
 * - 若框选落在扫描页（`spanCount === 0`）或显式请求 `forceVision`，走 Track 2 并在失败/超时时回退。
 */
export async function extractDualTrackPdfRegion(params: {
  pageElement?: ParentNode | null;
  viewport?: ParentNode | null;
  page: number;
  cropRect: ScreenRect;
  blob: Blob;
  imageDataUrl: string;
  rectNorm?: NormalizedRect;
  forceVision?: boolean;
  recognizer?: PdfRegionVisionRecognizer;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<DualTrackRegionExtractionResult> {
  const native = params.pageElement
    ? extractNativeRegionTextFromPage(params.pageElement, params.cropRect)
    : extractNativeRegionTextFromViewport(params.viewport, params.page, params.cropRect);

  if (native.spanCount > 0 && !params.forceVision) {
    return {
      track: 'native-text',
      extractedText: native.extractedText,
      ...(native.latex ? { latex: native.latex } : {}),
      spanCount: native.spanCount,
      layout: native.layout,
    };
  }

  const vision = await recognizeRegionWithVisionFallback({
    blob: params.blob,
    imageDataUrl: params.imageDataUrl,
    page: params.page,
    rectNorm: params.rectNorm,
    nativeText: native.extractedText,
    preferFormula: Boolean(params.forceVision),
    recognizer: params.recognizer,
    timeoutMs: params.timeoutMs,
    signal: params.signal,
  });

  if (vision.status === 'ok') {
    return {
      track: 'vision-ocr',
      extractedText: vision.text,
      ...(vision.latex ? { latex: vision.latex } : {}),
      spanCount: native.spanCount,
      layout: native.layout,
    };
  }

  return {
    track: native.spanCount > 0 ? 'native-text' : 'image-only',
    extractedText: native.extractedText,
    ...(native.latex ? { latex: native.latex } : {}),
    spanCount: native.spanCount,
    layout: native.layout,
    ...(vision.status === 'timeout' ? { timedOut: true } : {}),
  };
}
