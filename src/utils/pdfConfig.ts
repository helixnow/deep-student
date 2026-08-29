import { FallbackCMapReaderFactory, FallbackStandardFontDataFactory } from './pdfAssets';

/**
 * react-pdf / pdf.js getDocument 公共参数。
 * cMapUrl / standardFontDataUrl 指向 dist 内 R2 裁剪后的本地子集（tier 1）；
 * 自定义 factory 补上 appData 缓存（tier 2）与预留远程源（tier 3），
 * 详见 src/utils/pdfAssets.ts。传入自定义 factory 后 pdf.js 自动关闭
 * useWorkerFetch，cmap/字体经主线程工厂加载（wasm 仍走 DOMWasmFactory + wasmUrl）。
 */
export const PDF_OPTIONS = {
  cMapUrl: `${import.meta.env.BASE_URL}cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${import.meta.env.BASE_URL}standard_fonts/`,
  wasmUrl: `${import.meta.env.BASE_URL}wasm/`,
  CMapReaderFactory: FallbackCMapReaderFactory,
  StandardFontDataFactory: FallbackStandardFontDataFactory,
};
