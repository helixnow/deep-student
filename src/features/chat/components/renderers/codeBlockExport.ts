import { fileManager } from '@/utils/fileManager';

import { ensureSvgNamespace, readSvgIntrinsicSize, sanitizeSvgMarkup } from './progressiveSvg';

/**
 * 代码块"更多"菜单里的导出动作。全部走 fileManager 的保存对话框流程
 * （桌面原生对话框；Android 返回 content:// URI，由 Tauri 端写入），
 * 不使用 <a download>——WebView 里那条路在移动端不可用。
 */

export type SaveResult = { canceled: boolean; path?: string };

export interface DownloadCodeOptions {
  content: string;
  fileName: string;
  filterName: string;
  extensions: string[];
}

export function downloadCodeFile({ content, fileName, filterName, extensions }: DownloadCodeOptions): Promise<SaveResult> {
  return fileManager.saveTextFile({
    title: fileName,
    defaultFileName: fileName,
    content,
    filters: [{ name: filterName, extensions }],
  });
}

/** SVG 源码另存为 .svg：补齐 xmlns，保证单独打开时是合法 SVG 文件 */
export function downloadSvgSource(source: string, fileName = 'image.svg'): Promise<SaveResult> {
  return downloadCodeFile({
    content: ensureSvgNamespace(source.trim()),
    fileName,
    filterName: 'SVG',
    extensions: ['svg'],
  });
}

export function downloadHtmlSource(source: string, fileName = 'page.html'): Promise<SaveResult> {
  return downloadCodeFile({
    content: source,
    fileName,
    filterName: 'HTML',
    extensions: ['html', 'htm'],
  });
}

const MAX_RASTER_EDGE = 4096;
const DEFAULT_RASTER_SIZE = { width: 800, height: 600 };

export interface RasterPlan {
  /** 写回 SVG 根节点的 CSS 像素尺寸 */
  width: number;
  height: number;
  /** 画布像素尺寸（含倍率、受最大边长限制） */
  canvasWidth: number;
  canvasHeight: number;
}

/** 计算栅格化尺寸：固有尺寸 × 倍率，最长边不超过 4096px */
export function planSvgRaster(markup: string, scale = 2): RasterPlan {
  const size = readSvgIntrinsicSize(markup) ?? { ...DEFAULT_RASTER_SIZE };
  const longest = Math.max(size.width, size.height) * scale;
  const k = longest > MAX_RASTER_EDGE ? MAX_RASTER_EDGE / longest : 1;
  return {
    width: size.width,
    height: size.height,
    canvasWidth: Math.max(1, Math.round(size.width * scale * k)),
    canvasHeight: Math.max(1, Math.round(size.height * scale * k)),
  };
}

/** 给根 <svg> 写入明确的像素宽高（作为 <img> 加载时需要固有尺寸） */
export function withExplicitSvgSize(markup: string, width: number, height: number): string {
  const ns = ensureSvgNamespace(markup);
  return ns.replace(/<svg\b([^>]*)>/i, (_match, attrs: string) => {
    const cleaned = attrs
      .replace(/\s(?:width|height)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/\s*\/$/, '');
    const selfClosing = /\/\s*$/.test(attrs);
    return `<svg${cleaned} width="${width}" height="${height}"${selfClosing ? ' /' : ''}>`;
  });
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('SVG image failed to load'));
    img.src = url;
  });
}

function blobToBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer().then((buf) => new Uint8Array(buf));
  }
  // 旧 WebView 没有 Blob.arrayBuffer
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read image data'));
    reader.readAsArrayBuffer(blob);
  });
}

function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error('Canvas export returned no data'));
          return;
        }
        blobToBytes(blob).then(resolve, reject);
      }, 'image/png');
    } catch (err) {
      // 画布被污染（外部资源）时 toBlob 抛 SecurityError
      reject(err);
    }
  });
}

/**
 * SVG → PNG 字节。走 blob: URL + <img> + canvas（release CSP 的 img-src 允许
 * blob:/data:，无需脚本求值）。SVG 已经过消毒（无 foreignObject/外链），
 * 作为图片加载时也不会拉取外部资源，因此画布不会被污染；万一失败抛错由调用方提示。
 */
export async function rasterizeSvgToPng(source: string, scale = 2): Promise<Uint8Array> {
  const safe = sanitizeSvgMarkup(source);
  if (!/<svg[\s>]/i.test(safe)) throw new Error('No renderable SVG');
  const plan = planSvgRaster(safe, scale);
  const sized = withExplicitSvgSize(safe, plan.width, plan.height);
  const blob = new Blob([sized], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = plan.canvasWidth;
    canvas.height = plan.canvasHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    ctx.drawImage(img, 0, 0, plan.canvasWidth, plan.canvasHeight);
    return await canvasToPngBytes(canvas);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function saveSvgAsPng(source: string, fileName = 'image.png'): Promise<SaveResult> {
  const data = await rasterizeSvgToPng(source);
  return fileManager.saveBinaryFile({
    title: fileName,
    defaultFileName: fileName,
    data,
    filters: [{ name: 'PNG', extensions: ['png'] }],
  });
}
