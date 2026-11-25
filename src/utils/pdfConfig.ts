import {
  FallbackCMapReaderFactory,
  FallbackStandardFontDataFactory,
  getPdfAssetRemoteBase,
  isTauriRuntime,
} from './pdfAssets';

export interface PdfDocumentOptions {
  cMapUrl: string;
  cMapPacked: boolean;
  standardFontDataUrl: string;
  wasmUrl: string;
  disableFontFace: boolean;
  useWorkerFetch?: boolean;
  CMapReaderFactory?: typeof FallbackCMapReaderFactory;
  StandardFontDataFactory?: typeof FallbackStandardFontDataFactory;
}

/**
 * 浏览器（非 Tauri、无远程补齐源、支持真实 Web Worker 且为 http/https 源）下
 * 优先走 pdf.js 原生 worker-fetch 加载本地 cmaps/standard_fonts/wasm，避免主线程
 * FetchBinaryData 往返阻塞；Tauri 桌面（需 appData 缓存）、已配置远程源或
 * 无 Worker 环境（如测试）继续挂载三级 fallback 工厂。
 */
export function canUseWorkerFetchForPdfAssets(): boolean {
  if (typeof Worker === 'undefined' || typeof window === 'undefined') {
    return false;
  }
  if (isTauriRuntime() || Boolean(getPdfAssetRemoteBase())) {
    return false;
  }
  const protocol = window.location?.protocol ?? '';
  return protocol === 'http:' || protocol === 'https:';
}

/**
 * 构造 react-pdf / pdf.js getDocument 公共参数：
 * - `disableFontFace: true`：内嵌子集字体（尤其多字体 CJK LaTeX 文档）直接经 Canvas
 *   路径绘制，不再向主线程 `document.fonts` 批量注册 FontFace，避免 `document.fonts`
 *   永久 pending 与同步重排风暴；
 * - 可用时优先由 Worker 直接 fetch `cMapUrl` / `standardFontDataUrl`，否则启用
 *   `FallbackCMapReaderFactory` / `FallbackStandardFontDataFactory` 三级补齐链路。
 */
export function createPdfDocumentOptions(options?: {
  preferWorkerFetch?: boolean;
}): PdfDocumentOptions {
  const baseUrl = import.meta.env.BASE_URL ?? '/';
  const useWorkerFetch = options?.preferWorkerFetch ?? canUseWorkerFetchForPdfAssets();
  const base: PdfDocumentOptions = {
    cMapUrl: `${baseUrl}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${baseUrl}standard_fonts/`,
    wasmUrl: `${baseUrl}wasm/`,
    disableFontFace: true,
  };
  if (useWorkerFetch) {
    return {
      ...base,
      useWorkerFetch: true,
    };
  }
  return {
    ...base,
    CMapReaderFactory: FallbackCMapReaderFactory,
    StandardFontDataFactory: FallbackStandardFontDataFactory,
  };
}

export const PDF_OPTIONS: PdfDocumentOptions = createPdfDocumentOptions();
