/**
 * pdfjs cMap / 标准字体资源运行时三级 fallback（WI-9 运行时化）
 * ---------------------------------------------------------------------------
 * 安装包只随带 R2 裁剪后的本地子集（dist/cmaps 68 个、dist/standard_fonts 全量，
 * 见 vite.config.ts 与 docs/dev/optimization0824/progress/R2-pdfjs-subset.md）。
 * 命中子集外的资源（日/繁/韩遗留编码 cmap 等）时按以下顺序补齐：
 *
 *   1. 本地子集   —— dist 内静态资源（cMapUrl / standardFontDataUrl 指向的目录）
 *   2. appData 缓存 —— 此前从远程拉取过并落盘的资源（仅 Tauri 运行时）
 *   3. 远程        —— 预留 URL 配置（默认关闭）；成功后写入 appData 缓存
 *
 * 三级全部落空时记录「缺字日志」并抛错：pdf.js 默认 ignoreErrors（stopAtErrors:
 * false）下仅该字体渲染空白，不 crash、不影响其余页面内容。
 *
 * 远程基址配置（预留，当前无稳定可依赖的 CDN，默认不启用）：
 * - 构建期：环境变量 `VITE_PDFJS_REMOTE_ASSET_BASE`
 * - 运行时：localStorage `ds.pdfjs.remoteAssetBase`（优先级高于构建期）
 * 基址需镜像 pdfjs-dist 包目录布局并锁定版本，例如
 * `https://<host>/pdfjs-dist@5.4.296/`（其下有 cmaps/、standard_fonts/）。
 */

export type PdfAssetKind = 'cmap' | 'standard_font';

export interface MissingPdfAssetEntry {
  kind: PdfAssetKind;
  fileName: string;
  /** 依次尝试过的来源描述（local:… / appData:… / remote:…） */
  attemptedSources: string[];
  timestamp: number;
}

/** 运行时覆盖远程基址的 localStorage key（预留给设置页/诊断工具） */
export const PDF_ASSET_REMOTE_BASE_STORAGE_KEY = 'ds.pdfjs.remoteAssetBase';

/** appData 下的缓存根目录 */
const CACHE_ROOT = 'pdfjs-assets';

/** 远程/缓存目录布局与 pdfjs-dist 包一致 */
const KIND_DIRS: Record<PdfAssetKind, string> = {
  cmap: 'cmaps',
  standard_font: 'standard_fonts',
};

/** 文件名白名单：cmap（UniGB-UCS2-H.bcmap）与字体（LiberationSans-Bold.ttf）均满足 */
const SAFE_FILE_NAME = /^[A-Za-z0-9._-]+$/;

// ---------------------------------------------------------------------------
// 缺字日志：记录三级 fallback 全部落空的资源，供诊断与后续远程源配置决策
// ---------------------------------------------------------------------------

const missingAssetLog = new Map<string, MissingPdfAssetEntry>();

export function getMissingPdfAssetLog(): MissingPdfAssetEntry[] {
  return [...missingAssetLog.values()];
}

export function clearMissingPdfAssetLog(): void {
  missingAssetLog.clear();
}

function recordMissingAsset(kind: PdfAssetKind, fileName: string, attemptedSources: string[]): void {
  const key = `${kind}:${fileName}`;
  if (missingAssetLog.has(key)) return;
  missingAssetLog.set(key, { kind, fileName, attemptedSources, timestamp: Date.now() });
  console.warn(
    `[pdfAssets] 缺字资源不可用: ${kind} "${fileName}"（已尝试 ${attemptedSources.join(' → ')}）。` +
      '相关字体将渲染为空白；可通过 VITE_PDFJS_REMOTE_ASSET_BASE 或 ' +
      `localStorage["${PDF_ASSET_REMOTE_BASE_STORAGE_KEY}"] 配置远程补齐源。`,
  );
}

// ---------------------------------------------------------------------------
// 远程基址（预留配置）
// ---------------------------------------------------------------------------

export function getPdfAssetRemoteBase(): string {
  let configured = '';
  try {
    configured = (typeof localStorage !== 'undefined'
      && localStorage.getItem(PDF_ASSET_REMOTE_BASE_STORAGE_KEY)) || '';
  } catch {
    // localStorage 不可用（隐私模式等）时仅用构建期配置
  }
  if (!configured) {
    configured = (import.meta.env?.VITE_PDFJS_REMOTE_ASSET_BASE as string | undefined) ?? '';
  }
  configured = configured.trim();
  if (!configured) return '';
  return configured.endsWith('/') ? configured : `${configured}/`;
}

// ---------------------------------------------------------------------------
// 三级加载
// ---------------------------------------------------------------------------

function isTauriRuntime(): boolean {
  return (
    typeof window !== 'undefined' &&
    ((window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== undefined ||
      (window as { __TAURI_IPC__?: unknown }).__TAURI_IPC__ !== undefined)
  );
}

/** fetch 一个二进制资源；404/网络错误/SPA fallback 命中 HTML 均视为未命中 */
async function fetchBytes(url: string): Promise<Uint8Array | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    // dev server / 网关的 HTML fallback 会用 200 + text/html 顶替缺失文件
    if ((response.headers?.get?.('content-type') ?? '').includes('text/html')) return null;
    return new Uint8Array(await response.arrayBuffer());
  } catch {
    return null;
  }
}

async function readCachedAsset(kind: PdfAssetKind, fileName: string): Promise<Uint8Array | null> {
  if (!isTauriRuntime()) return null;
  try {
    const { readFile, BaseDirectory } = await import('@tauri-apps/plugin-fs');
    return await readFile(`${CACHE_ROOT}/${KIND_DIRS[kind]}/${fileName}`, {
      baseDir: BaseDirectory.AppData,
    });
  } catch {
    return null;
  }
}

async function writeCachedAsset(kind: PdfAssetKind, fileName: string, data: Uint8Array): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const { mkdir, writeFile, BaseDirectory } = await import('@tauri-apps/plugin-fs');
    const dir = `${CACHE_ROOT}/${KIND_DIRS[kind]}`;
    await mkdir(dir, { baseDir: BaseDirectory.AppData, recursive: true });
    await writeFile(`${dir}/${fileName}`, data, { baseDir: BaseDirectory.AppData });
  } catch (error) {
    // 缓存写失败只影响下次离线可用性，不影响本次渲染
    console.warn('[pdfAssets] 写入 appData 缓存失败:', fileName, error);
  }
}

/**
 * 按「本地子集 → appData 缓存 → 远程」顺序加载资源。
 * @param localBaseUrl 本地子集基址（pdf.js 传入的 cMapUrl / standardFontDataUrl）
 */
export async function loadPdfAsset(
  kind: PdfAssetKind,
  fileName: string,
  localBaseUrl?: string | null,
): Promise<Uint8Array> {
  if (!SAFE_FILE_NAME.test(fileName)) {
    throw new Error(`[pdfAssets] 非法资源文件名: ${JSON.stringify(fileName)}`);
  }
  const attemptedSources: string[] = [];

  if (localBaseUrl) {
    const localUrl = `${localBaseUrl}${fileName}`;
    attemptedSources.push(`local:${localUrl}`);
    const local = await fetchBytes(localUrl);
    if (local) return local;
  }

  attemptedSources.push(`appData:${CACHE_ROOT}/${KIND_DIRS[kind]}/${fileName}`);
  const cached = await readCachedAsset(kind, fileName);
  if (cached) return cached;

  const remoteBase = getPdfAssetRemoteBase();
  if (remoteBase) {
    const remoteUrl = `${remoteBase}${KIND_DIRS[kind]}/${fileName}`;
    attemptedSources.push(`remote:${remoteUrl}`);
    const remote = await fetchBytes(remoteUrl);
    if (remote) {
      void writeCachedAsset(kind, fileName, remote);
      return remote;
    }
  } else {
    attemptedSources.push('remote:<未配置>');
  }

  recordMissingAsset(kind, fileName, attemptedSources);
  throw new Error(`[pdfAssets] ${kind} "${fileName}" 三级 fallback 均未命中`);
}

// ---------------------------------------------------------------------------
// pdf.js 工厂：构造签名与返回值同 pdf.js 内部 Base{CMapReader,StandardFontData}Factory
//（pdfjs-dist 未导出基类，此处按接口自实现）。传入 getDocument 参数
// CMapReaderFactory / StandardFontDataFactory 后 pdf.js 自动关闭 useWorkerFetch，
// 资源改经主线程工厂加载。
// ---------------------------------------------------------------------------

export class FallbackCMapReaderFactory {
  private readonly baseUrl: string | null;
  private readonly isCompressed: boolean;

  constructor({ baseUrl = null, isCompressed = true }: { baseUrl?: string | null; isCompressed?: boolean } = {}) {
    this.baseUrl = baseUrl;
    this.isCompressed = isCompressed;
  }

  async fetch({ name }: { name: string }): Promise<{ cMapData: Uint8Array; isCompressed: boolean }> {
    if (!name) throw new Error('CMap name must be specified.');
    const fileName = this.isCompressed ? `${name}.bcmap` : name;
    const cMapData = await loadPdfAsset('cmap', fileName, this.baseUrl);
    return { cMapData, isCompressed: this.isCompressed };
  }
}

export class FallbackStandardFontDataFactory {
  private readonly baseUrl: string | null;

  constructor({ baseUrl = null }: { baseUrl?: string | null } = {}) {
    this.baseUrl = baseUrl;
  }

  async fetch({ filename }: { filename: string }): Promise<Uint8Array> {
    if (!filename) throw new Error('Font filename must be specified.');
    return loadPdfAsset('standard_font', filename, this.baseUrl);
  }
}
