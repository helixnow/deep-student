/**
 * pdfjs 资源三级 fallback（本地子集 → appData 缓存 → 远程）单元测试。
 * Tauri fs 与网络均为 mock，真实 pdfjs 链路见 tests/vitest/pdf/pdfCjkNoCrash.test.ts。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const readFileMock = vi.fn();
const writeFileMock = vi.fn();
const mkdirMock = vi.fn();

vi.mock('@tauri-apps/plugin-fs', () => ({
  BaseDirectory: { AppData: 13 },
  readFile: (...args: unknown[]) => readFileMock(...args),
  writeFile: (...args: unknown[]) => writeFileMock(...args),
  mkdir: (...args: unknown[]) => mkdirMock(...args),
}));

import {
  FallbackCMapReaderFactory,
  FallbackStandardFontDataFactory,
  PDF_ASSET_REMOTE_BASE_STORAGE_KEY,
  clearMissingPdfAssetLog,
  getMissingPdfAssetLog,
  loadPdfAsset,
} from '../pdfAssets';

const BYTES = new Uint8Array([1, 2, 3, 4]);

// jsdom 不保证提供 fetch API 全家桶，headers 用最小接口对象模拟
function mockHeaders(contentType?: string) {
  return { get: (key: string) => (key.toLowerCase() === 'content-type' ? contentType ?? null : null) };
}

function okResponse(bytes: Uint8Array = BYTES, contentType = 'application/octet-stream') {
  return {
    ok: true,
    headers: mockHeaders(contentType),
    arrayBuffer: async () => bytes.buffer.slice(0),
  };
}

const notFoundResponse = { ok: false, status: 404, headers: mockHeaders() };

function enterTauriRuntime() {
  (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
}

describe('loadPdfAsset 三级 fallback', () => {
  beforeEach(() => {
    clearMissingPdfAssetLog();
    readFileMock.mockReset();
    writeFileMock.mockReset();
    mkdirMock.mockReset();
    localStorage.removeItem(PDF_ASSET_REMOTE_BASE_STORAGE_KEY);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('tier1：本地子集命中时直接返回，不触碰缓存与远程', async () => {
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal('fetch', fetchMock);

    const data = await loadPdfAsset('cmap', 'UniGB-UCS2-H.bcmap', '/cmaps/');

    expect(data).toEqual(BYTES);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/cmaps/UniGB-UCS2-H.bcmap');
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it('tier1：SPA fallback 返回的 text/html 视为未命中', async () => {
    enterTauriRuntime();
    const fetchMock = vi.fn(async () => okResponse(BYTES, 'text/html'));
    vi.stubGlobal('fetch', fetchMock);
    readFileMock.mockResolvedValue(new Uint8Array([9, 9]));

    const data = await loadPdfAsset('cmap', '90ms-RKSJ-H.bcmap', '/cmaps/');

    expect(data).toEqual(new Uint8Array([9, 9]));
    expect(readFileMock).toHaveBeenCalledWith('pdfjs-assets/cmaps/90ms-RKSJ-H.bcmap', { baseDir: 13 });
  });

  it('tier2：本地 404 时读 appData 缓存（Tauri 运行时）', async () => {
    enterTauriRuntime();
    vi.stubGlobal('fetch', vi.fn(async () => notFoundResponse));
    readFileMock.mockResolvedValue(new Uint8Array([5, 6]));

    const data = await loadPdfAsset('standard_font', 'FoxitSerif.pfb', '/standard_fonts/');

    expect(data).toEqual(new Uint8Array([5, 6]));
    expect(readFileMock).toHaveBeenCalledWith('pdfjs-assets/standard_fonts/FoxitSerif.pfb', { baseDir: 13 });
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it('tier3：本地与缓存均未命中时走远程并写回缓存', async () => {
    enterTauriRuntime();
    localStorage.setItem(PDF_ASSET_REMOTE_BASE_STORAGE_KEY, 'https://cdn.example/pdfjs-dist@5.4.296');
    const fetchMock = vi.fn(async (url: string) =>
      url.startsWith('https://cdn.example/') ? okResponse() : notFoundResponse,
    );
    vi.stubGlobal('fetch', fetchMock);
    readFileMock.mockRejectedValue(new Error('not cached'));

    const data = await loadPdfAsset('cmap', '90ms-RKSJ-H.bcmap', '/cmaps/');

    expect(data).toEqual(BYTES);
    // 基址自动补尾斜杠，目录布局镜像 pdfjs-dist 包
    expect(fetchMock).toHaveBeenCalledWith('https://cdn.example/pdfjs-dist@5.4.296/cmaps/90ms-RKSJ-H.bcmap');
    await vi.waitFor(() => {
      expect(mkdirMock).toHaveBeenCalledWith('pdfjs-assets/cmaps', { baseDir: 13, recursive: true });
      expect(writeFileMock).toHaveBeenCalledWith('pdfjs-assets/cmaps/90ms-RKSJ-H.bcmap', BYTES, { baseDir: 13 });
    });
    expect(getMissingPdfAssetLog()).toHaveLength(0);
  });

  it('三级全部落空：抛错并记录缺字日志（同一资源只记一次）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => notFoundResponse));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(loadPdfAsset('cmap', 'KSC-EUC-H.bcmap', '/cmaps/')).rejects.toThrow('三级 fallback 均未命中');
    await expect(loadPdfAsset('cmap', 'KSC-EUC-H.bcmap', '/cmaps/')).rejects.toThrow();

    const log = getMissingPdfAssetLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ kind: 'cmap', fileName: 'KSC-EUC-H.bcmap' });
    expect(log[0].attemptedSources).toEqual([
      'local:/cmaps/KSC-EUC-H.bcmap',
      'appData:pdfjs-assets/cmaps/KSC-EUC-H.bcmap',
      'remote:<未配置>',
    ]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('拒绝路径穿越等非法文件名', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse()));
    await expect(loadPdfAsset('cmap', '../evil', '/cmaps/')).rejects.toThrow('非法资源文件名');
    await expect(loadPdfAsset('cmap', 'a/b.bcmap', '/cmaps/')).rejects.toThrow('非法资源文件名');
  });
});

describe('pdf.js factory 接口', () => {
  beforeEach(() => {
    clearMissingPdfAssetLog();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('FallbackCMapReaderFactory：packed 模式拼 .bcmap 并返回 { cMapData, isCompressed }', async () => {
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal('fetch', fetchMock);

    const factory = new FallbackCMapReaderFactory({ baseUrl: '/cmaps/', isCompressed: true });
    const result = await factory.fetch({ name: 'UniGB-UCS2-H' });

    expect(fetchMock).toHaveBeenCalledWith('/cmaps/UniGB-UCS2-H.bcmap');
    expect(result).toEqual({ cMapData: BYTES, isCompressed: true });
  });

  it('FallbackStandardFontDataFactory：按 filename 加载', async () => {
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal('fetch', fetchMock);

    const factory = new FallbackStandardFontDataFactory({ baseUrl: '/standard_fonts/' });
    const result = await factory.fetch({ filename: 'LiberationSans-Regular.ttf' });

    expect(fetchMock).toHaveBeenCalledWith('/standard_fonts/LiberationSans-Regular.ttf');
    expect(result).toEqual(BYTES);
  });

  it('缺 name/filename 时抛错（与 pdf.js 基类行为一致）', async () => {
    const cmapFactory = new FallbackCMapReaderFactory({ baseUrl: '/cmaps/' });
    await expect(cmapFactory.fetch({ name: '' })).rejects.toThrow('CMap name must be specified.');
    const fontFactory = new FallbackStandardFontDataFactory({ baseUrl: '/standard_fonts/' });
    await expect(fontFactory.fetch({ filename: '' })).rejects.toThrow('Font filename must be specified.');
  });
});
