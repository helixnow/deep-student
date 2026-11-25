import { extractPairingCodeFromText } from './qrCodeSvg';

export interface RgbaImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface QrRegionBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DecodePairingFrameOptions {
  /**
   * 'exhaustive' (default) runs the full multi-pass screenshot locator & decoder.
   * 'fast' is tuned for repeated live-camera frame polling.
   */
  mode?: 'exhaustive' | 'fast';
  /** Try native BarcodeDetector when available in Chromium/Electron runtimes. */
  useBarcodeDetector?: boolean;
  /** Cap maximum side length when extracting pixels from a canvas source. */
  maxNativeDimension?: number;
}

type JsQrFn = typeof import('jsqr').default;

interface BarcodeDetectorResultLike {
  rawValue?: string;
}

interface BarcodeDetectorInstanceLike {
  detect(source: CanvasImageSource): Promise<BarcodeDetectorResultLike[]>;
}

interface BarcodeDetectorCtorLike {
  new (options?: { formats?: string[] }): BarcodeDetectorInstanceLike;
}

const DEFAULT_EXHAUSTIVE_MAX_DIM = 3200;
const DEFAULT_FAST_MAX_DIM = 1600;
const MULTI_RES_TARGETS = [1600, 1200, 800] as const;

let cachedJsQrPromise: Promise<JsQrFn> | null = null;

async function loadJsQr(): Promise<JsQrFn> {
  if (!cachedJsQrPromise) {
    cachedJsQrPromise = import('jsqr').then((mod) => mod.default);
  }
  return cachedJsQrPromise;
}

/**
 * Extracts a DSPAIR1 (or DSPAIR2) pairing code payload from decoded QR text or SVG markup.
 */
export function extractPairingCode(raw: string): string | null {
  if (!raw) return null;
  const direct = extractPairingCodeFromText(raw);
  if (direct) return direct;

  const compact = raw.replace(/[\s\u200B-\u200D\uFEFF]+/g, '');
  if (compact !== raw) {
    const compactMatch = extractPairingCodeFromText(compact);
    if (compactMatch) return compactMatch;
  }

  const dspair2 = raw.match(/DSPAIR2\.[A-Za-z0-9_-]{8,}/) ?? compact.match(/DSPAIR2\.[A-Za-z0-9_-]{8,}/);
  return dspair2 ? dspair2[0] : null;
}

async function tryBarcodeDetector(source: CanvasImageSource): Promise<string | null> {
  if (typeof globalThis === 'undefined') return null;
  const Ctor = (globalThis as unknown as { BarcodeDetector?: BarcodeDetectorCtorLike }).BarcodeDetector;
  if (typeof Ctor !== 'function') return null;
  try {
    const detector = new Ctor({ formats: ['qr_code'] });
    const detected = await detector.detect(source);
    if (!Array.isArray(detected)) return null;
    for (const item of detected) {
      if (typeof item?.rawValue === 'string') {
        const code = extractPairingCode(item.rawValue);
        if (code) return code;
      }
    }
  } catch {
    // BarcodeDetector may reject unsupported formats or synthetic test sources; fall back to jsQR.
  }
  return null;
}

function tryJsQr(jsQR: JsQrFn, frame: RgbaImageData): string | null {
  if (frame.width < 21 || frame.height < 21) return null;
  const decoded = jsQR(frame.data, frame.width, frame.height, {
    inversionAttempts: 'attemptBoth',
  });
  return decoded?.data ? extractPairingCode(decoded.data) : null;
}

function toGrayscaleLuma(frame: RgbaImageData): Uint8Array {
  const { data, width, height } = frame;
  const count = width * height;
  const luma = new Uint8Array(count);
  for (let i = 0, p = 0; i < count; i++, p += 4) {
    const raw = (77 * data[p]! + 150 * data[p + 1]! + 29 * data[p + 2]!) >> 8;
    const alpha = data[p + 3]!;
    luma[i] = alpha === 255 ? raw : ((raw * alpha + 255 * (255 - alpha)) / 255) | 0;
  }
  return luma;
}

function lumaToRgba(luma: Uint8Array, width: number, height: number): RgbaImageData {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, p = 0; i < luma.length; i++, p += 4) {
    const v = luma[i]!;
    out[p] = v;
    out[p + 1] = v;
    out[p + 2] = v;
    out[p + 3] = 255;
  }
  return { data: out, width, height };
}

function computeOtsuThreshold(luma: Uint8Array): number {
  const hist = new Uint32Array(256);
  const total = luma.length;
  let sumAll = 0;
  for (let i = 0; i < total; i++) {
    const v = luma[i]!;
    hist[v]!++;
    sumAll += v;
  }

  let sumB = 0;
  let weightB = 0;
  let maxBetween = -1;
  let bestThreshold = 128;

  for (let t = 0; t < 256; t++) {
    weightB += hist[t]!;
    if (weightB === 0) continue;
    const weightF = total - weightB;
    if (weightF === 0) break;
    sumB += t * hist[t]!;
    const meanB = sumB / weightB;
    const meanF = (sumAll - sumB) / weightF;
    const diff = meanB - meanF;
    const between = weightB * weightF * diff * diff;
    if (between > maxBetween) {
      maxBetween = between;
      bestThreshold = t;
    }
  }
  return bestThreshold;
}

function binarizeFixed(luma: Uint8Array, width: number, height: number, threshold: number): RgbaImageData {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, p = 0; i < luma.length; i++, p += 4) {
    const v = luma[i]! > threshold ? 255 : 0;
    out[p] = v;
    out[p + 1] = v;
    out[p + 2] = v;
    out[p + 3] = 255;
  }
  return { data: out, width, height };
}

function binarizeOtsu(frame: RgbaImageData, precomputedLuma?: Uint8Array): RgbaImageData {
  const luma = precomputedLuma ?? toGrayscaleLuma(frame);
  const threshold = computeOtsuThreshold(luma);
  return binarizeFixed(luma, frame.width, frame.height, threshold);
}

/**
 * Bradley-Roth O(W*H) integral-image adaptive binarization.
 * Handles dark-mode UI framing, vignette shadows, and uneven contrast across screenshots.
 */
function binarizeAdaptiveIntegral(
  frame: RgbaImageData,
  precomputedLuma?: Uint8Array,
  bias = 0.12,
): RgbaImageData {
  const { width, height } = frame;
  const luma = precomputedLuma ?? toGrayscaleLuma(frame);
  const stride = width + 1;
  const integral = new Float64Array(stride * (height + 1));

  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    const rowOffset = y * width;
    const intRow = (y + 1) * stride;
    const prevIntRow = y * stride;
    for (let x = 0; x < width; x++) {
      rowSum += luma[rowOffset + x]!;
      integral[intRow + x + 1] = integral[prevIntRow + x + 1]! + rowSum;
    }
  }

  const radius = Math.max(8, Math.min(28, Math.round(Math.min(width, height) / 18)));
  const factor = 1 - bias;
  const out = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height, y + radius + 1);
    const r0 = y0 * stride;
    const r1 = y1 * stride;
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width, x + radius + 1);
      const area = (x1 - x0) * (y1 - y0);
      const sum =
        integral[r1 + x1]! -
        integral[r0 + x1]! -
        integral[r1 + x0]! +
        integral[r0 + x0]!;
      const v = luma[rowOffset + x]! * area >= sum * factor ? 255 : 0;
      const p = (rowOffset + x) * 4;
      out[p] = v;
      out[p + 1] = v;
      out[p + 2] = v;
      out[p + 3] = 255;
    }
  }

  return { data: out, width, height };
}

function resizeNearest(frame: RgbaImageData, targetWidth: number, targetHeight: number): RgbaImageData {
  const dstW = Math.max(1, Math.round(targetWidth));
  const dstH = Math.max(1, Math.round(targetHeight));
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  const { data: src, width: srcW, height: srcH } = frame;
  const xRatio = srcW / dstW;
  const yRatio = srcH / dstH;

  for (let y = 0; y < dstH; y++) {
    const sy = Math.min(srcH - 1, Math.floor(y * yRatio));
    const srcRow = sy * srcW;
    const dstRow = y * dstW;
    for (let x = 0; x < dstW; x++) {
      const sx = Math.min(srcW - 1, Math.floor(x * xRatio));
      const sp = (srcRow + sx) * 4;
      const dp = (dstRow + x) * 4;
      out[dp] = src[sp]!;
      out[dp + 1] = src[sp + 1]!;
      out[dp + 2] = src[sp + 2]!;
      out[dp + 3] = src[sp + 3]!;
    }
  }
  return { data: out, width: dstW, height: dstH };
}

function resizeBilinear(frame: RgbaImageData, targetWidth: number, targetHeight: number): RgbaImageData {
  const dstW = Math.max(1, Math.round(targetWidth));
  const dstH = Math.max(1, Math.round(targetHeight));
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  const { data: src, width: srcW, height: srcH } = frame;
  const xScale = srcW / dstW;
  const yScale = srcH / dstH;

  for (let y = 0; y < dstH; y++) {
    const fy = (y + 0.5) * yScale - 0.5;
    const y0 = Math.max(0, Math.min(srcH - 1, Math.floor(fy)));
    const y1 = Math.min(srcH - 1, y0 + 1);
    const wy = Math.max(0, fy - y0);
    const wy0 = 1 - wy;
    const row0 = y0 * srcW;
    const row1 = y1 * srcW;
    const dstRow = y * dstW;

    for (let x = 0; x < dstW; x++) {
      const fx = (x + 0.5) * xScale - 0.5;
      const x0 = Math.max(0, Math.min(srcW - 1, Math.floor(fx)));
      const x1 = Math.min(srcW - 1, x0 + 1);
      const wx = Math.max(0, fx - x0);
      const wx0 = 1 - wx;

      const w00 = wx0 * wy0;
      const w10 = wx * wy0;
      const w01 = wx0 * wy;
      const w11 = wx * wy;

      const p00 = (row0 + x0) * 4;
      const p10 = (row0 + x1) * 4;
      const p01 = (row1 + x0) * 4;
      const p11 = (row1 + x1) * 4;
      const dp = (dstRow + x) * 4;

      out[dp] = (src[p00]! * w00 + src[p10]! * w10 + src[p01]! * w01 + src[p11]! * w11 + 0.5) | 0;
      out[dp + 1] =
        (src[p00 + 1]! * w00 + src[p10 + 1]! * w10 + src[p01 + 1]! * w01 + src[p11 + 1]! * w11 + 0.5) | 0;
      out[dp + 2] =
        (src[p00 + 2]! * w00 + src[p10 + 2]! * w10 + src[p01 + 2]! * w01 + src[p11 + 2]! * w11 + 0.5) | 0;
      out[dp + 3] = 255;
    }
  }
  return { data: out, width: dstW, height: dstH };
}

function cropRegion(frame: RgbaImageData, box: QrRegionBox): RgbaImageData {
  const x0 = Math.max(0, Math.min(frame.width - 1, Math.floor(box.x)));
  const y0 = Math.max(0, Math.min(frame.height - 1, Math.floor(box.y)));
  const x1 = Math.max(x0 + 1, Math.min(frame.width, Math.ceil(box.x + box.width)));
  const y1 = Math.max(y0 + 1, Math.min(frame.height, Math.ceil(box.y + box.height)));
  const w = x1 - x0;
  const h = y1 - y0;
  const out = new Uint8ClampedArray(w * h * 4);
  const srcStride = frame.width * 4;
  const dstStride = w * 4;

  for (let y = 0; y < h; y++) {
    const srcStart = (y0 + y) * srcStride + x0 * 4;
    out.set(frame.data.subarray(srcStart, srcStart + dstStride), y * dstStride);
  }
  return { data: out, width: w, height: h };
}

function padWhiteBorder(frame: RgbaImageData, padPx?: number): RgbaImageData {
  const pad = padPx ?? Math.max(16, Math.min(48, Math.round(Math.min(frame.width, frame.height) * 0.08)));
  const w = frame.width + pad * 2;
  const h = frame.height + pad * 2;
  const out = new Uint8ClampedArray(w * h * 4);
  out.fill(255);
  const srcStride = frame.width * 4;
  const dstStride = w * 4;
  for (let y = 0; y < frame.height; y++) {
    const srcStart = y * srcStride;
    const dstStart = (y + pad) * dstStride + pad * 4;
    out.set(frame.data.subarray(srcStart, srcStart + srcStride), dstStart);
  }
  return { data: out, width: w, height: h };
}

function expandBox(box: QrRegionBox, width: number, height: number, padRatio: number, minPad = 14): QrRegionBox {
  const padX = Math.max(minPad, Math.round(box.width * padRatio));
  const padY = Math.max(minPad, Math.round(box.height * padRatio));
  const x0 = Math.max(0, box.x - padX);
  const y0 = Math.max(0, box.y - padY);
  const x1 = Math.min(width, box.x + box.width + padX);
  const y1 = Math.min(height, box.y + box.height + padY);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function computeIoU(a: QrRegionBox, b: QrRegionBox): number {
  const ix0 = Math.max(a.x, b.x);
  const iy0 = Math.max(a.y, b.y);
  const ix1 = Math.min(a.x + a.width, b.x + b.width);
  const iy1 = Math.min(a.y + a.height, b.y + b.height);
  if (ix1 <= ix0 || iy1 <= iy0) return 0;
  const inter = (ix1 - ix0) * (iy1 - iy0);
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

interface ScoredBox {
  box: QrRegionBox;
  score: number;
}

function addSquareSubCrops(candidates: ScoredBox[], box: QrRegionBox, baseScore: number, width: number, height: number): void {
  const aspect = box.width / Math.max(1, box.height);
  if (aspect < 0.72) {
    // Tall card (e.g. QR on top + PIN/code below) -> add top & middle square sub-crops
    const side = Math.min(box.width, box.height);
    candidates.push({
      box: expandBox({ x: box.x, y: box.y, width: side, height: side }, width, height, 0.14),
      score: baseScore * 0.96,
    });
    const midY = box.y + Math.round((box.height - side) / 2);
    candidates.push({
      box: expandBox({ x: box.x, y: midY, width: side, height: side }, width, height, 0.14),
      score: baseScore * 0.85,
    });
  } else if (aspect > 1.45) {
    // Wide card (e.g. settings row + right QR card) -> add right & left square sub-crops
    const side = Math.min(box.width, box.height);
    candidates.push({
      box: expandBox({ x: box.x + box.width - side, y: box.y, width: side, height: side }, width, height, 0.14),
      score: baseScore * 0.96,
    });
    candidates.push({
      box: expandBox({ x: box.x, y: box.y, width: side, height: side }, width, height, 0.14),
      score: baseScore * 0.88,
    });
  }
}

/**
 * Connected-component locator for bright/high-contrast QR cards inside dark-mode or dimmed screenshots.
 */
function locateBrightCardRegions(luma: Uint8Array, width: number, height: number): ScoredBox[] {
  const maxDim = Math.max(width, height);
  const cell = Math.max(4, Math.floor(maxDim / 180));
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const mask = new Uint8Array(cols * rows);
  const highContrast = new Uint8Array(cols * rows);
  const step = cell > 8 ? 2 : 1;

  for (let gy = 0; gy < rows; gy++) {
    const y0 = gy * cell;
    const y1 = Math.min(height, y0 + cell);
    for (let gx = 0; gx < cols; gx++) {
      const x0 = gx * cell;
      const x1 = Math.min(width, x0 + cell);
      let minL = 255;
      let maxL = 0;
      let sumL = 0;
      let bright = 0;
      let count = 0;
      for (let y = y0; y < y1; y += step) {
        const rowOff = y * width;
        for (let x = x0; x < x1; x += step) {
          const v = luma[rowOff + x]!;
          if (v < minL) minL = v;
          if (v > maxL) maxL = v;
          sumL += v;
          if (v >= 175) bright++;
          count++;
        }
      }
      const idx = gy * cols + gx;
      if (count > 0 && maxL >= 175 && (bright / count >= 0.22 || sumL / count >= 135)) {
        mask[idx] = 1;
      }
      if (maxL - minL >= 85 && maxL >= 165 && minL <= 115) {
        highContrast[idx] = 1;
      }
    }
  }

  const visited = new Uint8Array(cols * rows);
  const queue = new Int32Array(cols * rows);
  const results: ScoredBox[] = [];
  const minSide = Math.max(48, Math.round(Math.min(width, height) * 0.055));

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || visited[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;

    let minGx = cols;
    let maxGx = 0;
    let minGy = rows;
    let maxGy = 0;
    let cellCount = 0;
    let contrastCells = 0;

    while (head < tail) {
      const idx = queue[head++]!;
      const gy = (idx / cols) | 0;
      const gx = idx - gy * cols;
      if (gx < minGx) minGx = gx;
      if (gx > maxGx) maxGx = gx;
      if (gy < minGy) minGy = gy;
      if (gy > maxGy) maxGy = gy;
      cellCount++;
      if (highContrast[idx]) contrastCells++;

      if (gx > 0 && mask[idx - 1] && !visited[idx - 1]) {
        visited[idx - 1] = 1;
        queue[tail++] = idx - 1;
      }
      if (gx + 1 < cols && mask[idx + 1] && !visited[idx + 1]) {
        visited[idx + 1] = 1;
        queue[tail++] = idx + 1;
      }
      if (gy > 0 && mask[idx - cols] && !visited[idx - cols]) {
        visited[idx - cols] = 1;
        queue[tail++] = idx - cols;
      }
      if (gy + 1 < rows && mask[idx + cols] && !visited[idx + cols]) {
        visited[idx + cols] = 1;
        queue[tail++] = idx + cols;
      }
    }

    const bx = minGx * cell;
    const by = minGy * cell;
    const bw = Math.min(width, (maxGx + 1) * cell) - bx;
    const bh = Math.min(height, (maxGy + 1) * cell) - by;
    if (bw < minSide || bh < minSide) continue;
    if (bw > width * 0.92 && bh > height * 0.92) continue;

    const contrastRatio = contrastCells / Math.max(1, cellCount);
    if (contrastRatio < 0.12) continue;

    const aspect = bw / Math.max(1, bh);
    const squareness = 1 / Math.max(aspect, 1 / aspect);
    const fill = cellCount / Math.max(1, (maxGx - minGx + 1) * (maxGy - minGy + 1));
    const score = (squareness * 2.2 + contrastRatio * 2.0 + fill) * (aspect >= 0.55 && aspect <= 1.85 ? 1.25 : 0.75);

    const rawBox: QrRegionBox = { x: bx, y: by, width: bw, height: bh };
    results.push({ box: expandBox(rawBox, width, height, 0.14), score });
    addSquareSubCrops(results, rawBox, score, width, height);
  }

  return results;
}

/**
 * Connected-component locator for isotropic high-frequency checkerboard blocks (QR codes).
 * Works in both light mode and dark mode (including inverted QR codes).
 */
function locateIsotropicTextureRegions(luma: Uint8Array, width: number, height: number): ScoredBox[] {
  const maxDim = Math.max(width, height);
  const cell = Math.max(6, Math.floor(maxDim / 120));
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const rawMask = new Uint8Array(cols * rows);
  const diffStep = Math.max(1, Math.floor(cell / 8));
  const minEdgeHits = Math.max(4, Math.floor(cell * 0.55));

  for (let gy = 0; gy < rows; gy++) {
    const y0 = gy * cell;
    const y1 = Math.min(height, y0 + cell);
    for (let gx = 0; gx < cols; gx++) {
      const x0 = gx * cell;
      const x1 = Math.min(width, x0 + cell);
      let minL = 255;
      let maxL = 0;
      let hTrans = 0;
      let vTrans = 0;

      for (let y = y0; y < y1; y++) {
        const rowOff = y * width;
        const prevRowOff = Math.max(0, y - diffStep) * width;
        for (let x = x0; x < x1; x++) {
          const cur = luma[rowOff + x]!;
          if (cur < minL) minL = cur;
          if (cur > maxL) maxL = cur;
          if (x >= x0 + diffStep && Math.abs(cur - luma[rowOff + x - diffStep]!) >= 55) {
            hTrans++;
          }
          if (y >= y0 + diffStep && Math.abs(cur - luma[prevRowOff + x]!) >= 55) {
            vTrans++;
          }
        }
      }

      if (maxL - minL >= 80 && hTrans >= minEdgeHits && vTrans >= minEdgeHits) {
        const ratio = Math.min(hTrans, vTrans) / Math.max(hTrans, vTrans);
        if (ratio >= 0.32) {
          rawMask[gy * cols + gx] = 1;
        }
      }
    }
  }

  // 1-cell dilation bridges tiny quiet/alignment gaps inside a QR matrix.
  const mask = new Uint8Array(cols * rows);
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      if (!rawMask[gy * cols + gx]) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = gy + dy;
        if (ny < 0 || ny >= rows) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = gx + dx;
          if (nx < 0 || nx >= cols) continue;
          mask[ny * cols + nx] = 1;
        }
      }
    }
  }

  const visited = new Uint8Array(cols * rows);
  const queue = new Int32Array(cols * rows);
  const results: ScoredBox[] = [];
  const minSide = Math.max(44, Math.round(Math.min(width, height) * 0.05));

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || visited[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;

    let minGx = cols;
    let maxGx = 0;
    let minGy = rows;
    let maxGy = 0;
    let rawHits = 0;

    while (head < tail) {
      const idx = queue[head++]!;
      const gy = (idx / cols) | 0;
      const gx = idx - gy * cols;
      if (gx < minGx) minGx = gx;
      if (gx > maxGx) maxGx = gx;
      if (gy < minGy) minGy = gy;
      if (gy > maxGy) maxGy = gy;
      if (rawMask[idx]) rawHits++;

      if (gx > 0 && mask[idx - 1] && !visited[idx - 1]) {
        visited[idx - 1] = 1;
        queue[tail++] = idx - 1;
      }
      if (gx + 1 < cols && mask[idx + 1] && !visited[idx + 1]) {
        visited[idx + 1] = 1;
        queue[tail++] = idx + 1;
      }
      if (gy > 0 && mask[idx - cols] && !visited[idx - cols]) {
        visited[idx - cols] = 1;
        queue[tail++] = idx - cols;
      }
      if (gy + 1 < rows && mask[idx + cols] && !visited[idx + cols]) {
        visited[idx + cols] = 1;
        queue[tail++] = idx + cols;
      }
    }

    const gridW = maxGx - minGx + 1;
    const gridH = maxGy - minGy + 1;
    const bx = minGx * cell;
    const by = minGy * cell;
    const bw = Math.min(width, (maxGx + 1) * cell) - bx;
    const bh = Math.min(height, (maxGy + 1) * cell) - by;

    if (bw < minSide || bh < minSide) continue;
    if (bw > width * 0.9 && bh > height * 0.9) continue;

    const aspect = bw / Math.max(1, bh);
    if (aspect < 0.35 || aspect > 2.8) continue;

    const fill = rawHits / Math.max(1, gridW * gridH);
    if (fill < 0.22) continue;

    const squareness = 1 / Math.max(aspect, 1 / aspect);
    const score = (squareness * 2.5 + fill * 2.0) * (aspect >= 0.65 && aspect <= 1.55 ? 1.3 : 0.8);

    const rawBox: QrRegionBox = { x: bx, y: by, width: bw, height: bh };
    results.push({ box: expandBox(rawBox, width, height, 0.2, 18), score });
    addSquareSubCrops(results, rawBox, score, width, height);
  }

  return results;
}

/**
 * Locates likely QR code bounding boxes inside a full desktop/mobile screenshot.
 * Combines bright-card detection (dark mode) and isotropic edge-density detection (light & dark mode).
 */
export function locatePairingQrRegions(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): QrRegionBox[] {
  if (width < 48 || height < 48 || data.length < width * height * 4) return [];
  const luma = toGrayscaleLuma({ data, width, height });
  const combined: ScoredBox[] = [
    ...locateBrightCardRegions(luma, width, height),
    ...locateIsotropicTextureRegions(luma, width, height),
  ];
  combined.sort((a, b) => b.score - a.score);

  const selected: QrRegionBox[] = [];
  for (const item of combined) {
    if (selected.some((existing) => computeIoU(existing, item.box) > 0.72)) {
      continue;
    }
    selected.push(item.box);
    if (selected.length >= 8) break;
  }
  return selected;
}

function buildStructuredFallbackCrops(width: number, height: number): QrRegionBox[] {
  const make = (rx: number, ry: number, rw: number, rh: number): QrRegionBox => ({
    x: Math.round(width * rx),
    y: Math.round(height * ry),
    width: Math.max(1, Math.round(width * rw)),
    height: Math.max(1, Math.round(height * rh)),
  });

  return [
    // Right panel where desktop DevicePairingSection renders its QR card
    make(0.42, 0.08, 0.58, 0.87),
    // Centered modal crop
    make(0.15, 0.1, 0.7, 0.8),
    // Tighter centered modal crop
    make(0.24, 0.18, 0.52, 0.64),
    // Left panel crop
    make(0.0, 0.08, 0.58, 0.87),
    // Overlapping quadrants (16% overlap so midline QR codes are never sliced)
    make(0.42, 0.0, 0.58, 0.58),
    make(0.42, 0.42, 0.58, 0.58),
    make(0.0, 0.0, 0.58, 0.58),
    make(0.0, 0.42, 0.58, 0.58),
  ];
}

function decodeCropCandidate(
  jsQR: JsQrFn,
  crop: RgbaImageData,
  options?: { includePaddingAndAdaptive?: boolean },
): string | null {
  const full = options?.includePaddingAndAdaptive !== false;

  // 1) Native crop (full crispness preserved)
  const direct = tryJsQr(jsQR, crop);
  if (direct) return direct;

  const maxSide = Math.max(crop.width, crop.height);
  const luma = toGrayscaleLuma(crop);

  // 2) Upscale small dense QR crops so 2px modules become 4-6px modules for jsQR's 1:1:3:1:1 finder
  if (maxSide < 560) {
    const scale = maxSide < 280 ? 3 : 2;
    const targetW = Math.min(960, crop.width * scale);
    const targetH = Math.min(960, crop.height * scale);
    const upscaled = resizeNearest(crop, targetW, targetH);
    const upRes = tryJsQr(jsQR, upscaled);
    if (upRes) return upRes;
  }

  // 3) Otsu high-contrast binarization (snaps anti-aliased gray edges cleanly)
  const otsu = binarizeOtsu(crop, luma);
  const otsuRes = tryJsQr(jsQR, otsu);
  if (otsuRes) return otsuRes;

  if (maxSide < 520) {
    const scale = maxSide < 260 ? 3 : 2;
    const upOtsu = resizeNearest(otsu, Math.min(960, crop.width * scale), Math.min(960, crop.height * scale));
    const upOtsuRes = tryJsQr(jsQR, upOtsu);
    if (upOtsuRes) return upOtsuRes;
  }

  if (!full) {
    return null;
  }

  // 4) Pad crisp white quiet-zone border (rescues tight user crops with zero white margin)
  const padded = padWhiteBorder(crop);
  const paddedRes = tryJsQr(jsQR, padded);
  if (paddedRes) return paddedRes;

  const paddedOtsu = padWhiteBorder(otsu);
  const paddedOtsuRes = tryJsQr(jsQR, paddedOtsu);
  if (paddedOtsuRes) return paddedOtsuRes;

  // 5) Bright-biased threshold (170) & adaptive Bradley-Roth binarization for blurry/dim/glared cards
  const brightFixed = binarizeFixed(luma, crop.width, crop.height, 170);
  const brightRes = tryJsQr(jsQR, brightFixed);
  if (brightRes) return brightRes;

  const adaptive = binarizeAdaptiveIntegral(crop, luma);
  const adaptiveRes = tryJsQr(jsQR, adaptive);
  if (adaptiveRes) return adaptiveRes;

  return null;
}

/**
 * Pure RGBA multi-pass QR locator & decoder:
 * - Pass 1: native scale with `inversionAttempts: 'attemptBoth'`
 * - Pass 2: multi-resolution scales (`1600px`, `1200px`, `800px`, plus `2x` upscale for small images)
 * - Pass 3: high-contrast Otsu thresholding & Bradley-Roth adaptive binarization
 * - Pass 4: bright-card & isotropic-texture QR bounding-box locator + modal/panel/quadrant crops
 */
export async function decodePairingPixels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options?: DecodePairingFrameOptions,
): Promise<string | null> {
  if (!width || !height || data.length < width * height * 4) return null;
  const jsQR = await loadJsQr();
  const nativeFrame: RgbaImageData = { data, width, height };
  const maxDim = Math.max(width, height);
  const minDim = Math.min(width, height);

  // Pass 1: Native scale with inversionAttempts: 'attemptBoth'
  const pass1 = tryJsQr(jsQR, nativeFrame);
  if (pass1) return pass1;

  // Fast mode for live camera frames (~3fps polling)
  if (options?.mode === 'fast') {
    const workFrame =
      maxDim > 960
        ? resizeBilinear(nativeFrame, (width * 960) / maxDim, (height * 960) / maxDim)
        : nativeFrame;
    const otsuFast = binarizeOtsu(workFrame);
    const fastBinarized = tryJsQr(jsQR, otsuFast);
    if (fastBinarized) return fastBinarized;

    const centerBox: QrRegionBox = {
      x: Math.round(workFrame.width * 0.18),
      y: Math.round(workFrame.height * 0.14),
      width: Math.max(1, Math.round(workFrame.width * 0.64)),
      height: Math.max(1, Math.round(workFrame.height * 0.72)),
    };
    const centerCrop = cropRegion(workFrame, centerBox);
    return tryJsQr(jsQR, centerCrop) ?? tryJsQr(jsQR, binarizeOtsu(centerCrop));
  }

  // Quick rescue when the input itself is already a small/tightly cropped QR image
  if (maxDim <= 640 && minDim >= 48) {
    const quickCrop = decodeCropCandidate(jsQR, nativeFrame);
    if (quickCrop) return quickCrop;
  }

  // Pass 4A/4B (fast dynamic ROI locator, ~5ms): locate bright QR cards (dark mode) & high-variance QR blocks (light/dark)
  const dynamicRegions = locatePairingQrRegions(data, width, height);
  for (const box of dynamicRegions) {
    const crop = cropRegion(nativeFrame, box);
    const decoded = decodeCropCandidate(jsQR, crop);
    if (decoded) return decoded;
  }

  // Pass 2: Multi-resolution scales (1600px, 1200px, 800px for dense QR codes; 2x upscale for small images)
  const triedDims = new Set<number>([maxDim]);
  for (const targetMax of MULTI_RES_TARGETS) {
    if (targetMax >= maxDim * 0.92) continue;
    if (triedDims.has(targetMax)) continue;
    triedDims.add(targetMax);
    const ratio = targetMax / maxDim;
    const scaled = resizeBilinear(nativeFrame, width * ratio, height * ratio);
    const res = tryJsQr(jsQR, scaled);
    if (res) return res;
  }

  if (maxDim < 600 && minDim >= 48) {
    const targetScale = Math.min(2, 1024 / maxDim);
    const upscaled = resizeNearest(nativeFrame, width * targetScale, height * targetScale);
    const upRes = tryJsQr(jsQR, upscaled);
    if (upRes) return upRes;
  }

  // Pass 3: High-contrast luminance thresholding / adaptive binarization
  const thresholdFrame =
    maxDim > 1600
      ? resizeBilinear(nativeFrame, (width * 1600) / maxDim, (height * 1600) / maxDim)
      : nativeFrame;
  const thresholdLuma = toGrayscaleLuma(thresholdFrame);

  const otsuFull = tryJsQr(jsQR, binarizeOtsu(thresholdFrame, thresholdLuma));
  if (otsuFull) return otsuFull;

  // Contrast-stretched grayscale pass for low-contrast / dimmed screenshots
  let minL = 255;
  let maxL = 0;
  for (let i = 0; i < thresholdLuma.length; i++) {
    const v = thresholdLuma[i]!;
    if (v < minL) minL = v;
    if (v > maxL) maxL = v;
  }
  if (maxL - minL > 20 && (minL > 20 || maxL < 235)) {
    const stretched = new Uint8Array(thresholdLuma.length);
    const span = maxL - minL;
    for (let i = 0; i < thresholdLuma.length; i++) {
      stretched[i] = Math.min(255, Math.max(0, Math.round(((thresholdLuma[i]! - minL) * 255) / span)));
    }
    const stretchedRes = tryJsQr(jsQR, lumaToRgba(stretched, thresholdFrame.width, thresholdFrame.height));
    if (stretchedRes) return stretchedRes;
  }

  const adaptiveFull = tryJsQr(jsQR, binarizeAdaptiveIntegral(thresholdFrame, thresholdLuma));
  if (adaptiveFull) return adaptiveFull;

  // Pass 4C: Deterministic panel / centered-modal / overlapping-quadrant fallback crops
  const fallbackCrops = buildStructuredFallbackCrops(width, height);
  for (const box of fallbackCrops) {
    if (dynamicRegions.some((seen) => computeIoU(seen, box) > 0.72)) continue;
    let crop = cropRegion(nativeFrame, box);
    const cropMax = Math.max(crop.width, crop.height);
    if (cropMax > 1100) {
      const r = 960 / cropMax;
      crop = resizeBilinear(crop, crop.width * r, crop.height * r);
    }
    const decoded = decodeCropCandidate(jsQR, crop, { includePaddingAndAdaptive: false });
    if (decoded) return decoded;
  }

  return null;
}

export async function decodePairingFrame(
  canvas: HTMLCanvasElement,
  source: CanvasImageSource,
  width: number,
  height: number,
  options?: DecodePairingFrameOptions,
): Promise<string | null> {
  if (!width || !height) return null;

  if (options?.useBarcodeDetector !== false) {
    const nativeDetected = await tryBarcodeDetector(source);
    if (nativeDetected) return nativeDetected;
  }

  const mode = options?.mode ?? 'exhaustive';
  const maxDimCap =
    options?.maxNativeDimension ??
    (mode === 'fast' ? DEFAULT_FAST_MAX_DIM : DEFAULT_EXHAUSTIVE_MAX_DIM);
  const scale = Math.min(1, maxDimCap / Math.max(width, height));
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context =
    canvas.getContext('2d', { willReadFrequently: true }) ?? canvas.getContext('2d');
  if (!context) throw new Error('无法读取二维码图像');
  context.imageSmoothingEnabled = scale < 1;
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  return decodePairingPixels(pixels.data, pixels.width, pixels.height, options);
}

async function loadImageElement(url: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.decoding = 'async';
  image.src = url;
  if (typeof image.decode === 'function') {
    try {
      await image.decode();
      if ((image.naturalWidth || image.width) > 0 && (image.naturalHeight || image.height) > 0) {
        return image;
      }
    } catch {
      // Fall back to onload/onerror for runtimes where decode() rejects valid data/blob images.
    }
  }
  return new Promise<HTMLImageElement>((resolve, reject) => {
    if (image.complete && (image.naturalWidth || image.width) > 0) {
      resolve(image);
      return;
    }
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('无法加载所选图片'));
  });
}

async function readFileText(file: File): Promise<string> {
  if (typeof file.text === 'function') {
    return file.text();
  }
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('无法读取所选文件'));
    reader.readAsText(file);
  });
}

export async function decodePairingImage(file: File): Promise<string | null> {
  if (file.type === 'image/svg+xml' || /\.svg$/i.test(file.name)) {
    const code = extractPairingCode(await readFileText(file));
    if (code) return code;
  }
  const url = URL.createObjectURL(file);
  try {
    const image = await loadImageElement(url);
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!width || !height) return null;

    const nativeDetected = await tryBarcodeDetector(image);
    if (nativeDetected) return nativeDetected;

    return await decodePairingFrame(document.createElement('canvas'), image, width, height, {
      mode: 'exhaustive',
      useBarcodeDetector: false,
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
