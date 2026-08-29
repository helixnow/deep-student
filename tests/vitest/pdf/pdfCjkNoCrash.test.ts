/**
 * 中文/CJK PDF 真实 pdfjs 链路测试（WI-9 运行时化）。
 *
 * 用真实 pdfjs-dist（fake worker，主线程 LoopbackPort）加载手工构造的
 * 未内嵌字体 CID PDF，走 PDF_OPTIONS 里的三级 fallback factory：
 *  - 简中 UniGB-UCS2-H 命中本地子集（config/pdfjs-local-assets.json 白名单模拟
 *    dist/cmaps），文本可正确提取为「中文」；
 *  - 日文遗留编码 90ms-RKSJ-H 已被 R2 裁出子集：无远程源时不崩溃、记缺字日志；
 *  - 配置远程源（tier 3）后同一份 PDF 文本恢复可提取。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  PDF_ASSET_REMOTE_BASE_STORAGE_KEY,
  clearMissingPdfAssetLog,
  getMissingPdfAssetLog,
} from '@/utils/pdfAssets';
import { PDF_OPTIONS } from '@/utils/pdfConfig';

const require = createRequire(import.meta.url);
const pdfjsDistDir = path.dirname(require.resolve('pdfjs-dist/package.json'));
const cMapsDir = path.join(pdfjsDistDir, 'cmaps');
const standardFontsDir = path.join(pdfjsDistDir, 'standard_fonts');

const { keptCMapGlobs } = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'config', 'pdfjs-local-assets.json'), 'utf8'),
) as { keptCMapGlobs: string[] };

const keptCMapPatterns = keptCMapGlobs.map(
  (glob) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`),
);

function isInLocalSubset(fileName: string): boolean {
  const bareName = fileName.replace(/\.bcmap$/, '');
  return keptCMapPatterns.some((pattern) => pattern.test(bareName));
}

/** 模拟 dist 静态资源：/cmaps/ 只提供白名单子集，/standard_fonts/ 全量 */
function localAssetFetchStub(remoteBase?: string) {
  return vi.fn(async (input: string | URL) => {
    const url = String(input);
    let filePath: string | null = null;
    if (remoteBase && url.startsWith(remoteBase)) {
      const rest = url.slice(remoteBase.length);
      if (rest.startsWith('cmaps/')) filePath = path.join(cMapsDir, rest.slice('cmaps/'.length));
      if (rest.startsWith('standard_fonts/')) {
        filePath = path.join(standardFontsDir, rest.slice('standard_fonts/'.length));
      }
    } else if (url.startsWith('/cmaps/')) {
      const fileName = url.slice('/cmaps/'.length);
      if (isInLocalSubset(fileName)) filePath = path.join(cMapsDir, fileName);
    } else if (url.startsWith('/standard_fonts/')) {
      filePath = path.join(standardFontsDir, url.slice('/standard_fonts/'.length));
    }
    if (!filePath || !fs.existsSync(filePath)) {
      return { ok: false, status: 404, headers: { get: () => null } };
    }
    const bytes = fs.readFileSync(filePath);
    return {
      ok: true,
      headers: { get: (key: string) => (key.toLowerCase() === 'content-type' ? 'application/octet-stream' : null) },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  });
}

/** 手工构造单页 PDF：对象体列表 → 带 xref 的完整文件（纯 ASCII） */
function buildPdf(objects: string[]): Uint8Array {
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/** 未内嵌字体的 Type0/CIDFontType0 PDF，文本用预定义 cmap 编码的 hex 串 */
function buildCjkPdf(encoding: string, ordering: string, hexText: string): Uint8Array {
  const content = `BT /F1 16 Tf 40 100 Td <${hexText}> Tj ET`;
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>',
    `<< /Type /Font /Subtype /Type0 /BaseFont /TestCJK /Encoding /${encoding} /DescendantFonts [5 0 R] >>`,
    `<< /Type /Font /Subtype /CIDFontType0 /BaseFont /TestCJK /CIDSystemInfo << /Registry (Adobe) /Ordering (${ordering}) /Supplement 2 >> /FontDescriptor 6 0 R /DW 1000 >>`,
    '<< /Type /FontDescriptor /FontName /TestCJK /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 900 /StemV 80 >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ]);
}

type PdfjsModule = typeof import('pdfjs-dist');
let pdfjs: PdfjsModule;

async function extractText(pdfBytes: Uint8Array): Promise<{ text: string; numPages: number }> {
  const loadingTask = pdfjs.getDocument({ ...PDF_OPTIONS, data: pdfBytes });
  try {
    const doc = await loadingTask.promise;
    const page = await doc.getPage(1);
    const textContent = await page.getTextContent();
    const text = textContent.items
      .map((item) => ('str' in item ? item.str : ''))
      .join('');
    return { text, numPages: doc.numPages };
  } finally {
    await loadingTask.destroy();
  }
}

beforeAll(async () => {
  // jsdom 无 DOMMatrix；pdf.mjs 模块顶层 new DOMMatrix()（仅渲染路径真正使用，
  // 文本提取不触及），给个最小 shim 让模块可加载
  if (typeof globalThis.DOMMatrix === 'undefined') {
    class DOMMatrixShim {
      a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
      constructor(init?: number[]) {
        if (Array.isArray(init) && init.length === 6) {
          [this.a, this.b, this.c, this.d, this.e, this.f] = init;
        }
      }
    }
    (globalThis as Record<string, unknown>).DOMMatrix = DOMMatrixShim;
  }
  pdfjs = await import('pdfjs-dist');
  // jsdom 无 Worker，pdfjs 走 fake worker（动态 import workerSrc 到主线程）
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
    path.join(pdfjsDistDir, 'build', 'pdf.worker.mjs'),
  ).href;
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.removeItem(PDF_ASSET_REMOTE_BASE_STORAGE_KEY);
  clearMissingPdfAssetLog();
});

describe('CJK PDF 三级 fallback（真实 pdfjs）', () => {
  it('简中 UniGB-UCS2-H 命中本地子集，文本正确提取', async () => {
    vi.stubGlobal('fetch', localAssetFetchStub());

    // 「中文」的 UCS-2BE 编码
    const { text, numPages } = await extractText(buildCjkPdf('UniGB-UCS2-H', 'GB1', '4E2D6587'));

    expect(numPages).toBe(1);
    expect(text).toBe('中文');
    expect(getMissingPdfAssetLog()).toHaveLength(0);
  }, 60_000);

  it('子集外的日文遗留编码 90ms-RKSJ-H：无远程源时不崩溃，记缺字日志', async () => {
    vi.stubGlobal('fetch', localAssetFetchStub());

    // 「日本語」的 Shift-JIS 编码；90ms-RKSJ-H 已被 R2 裁出本地子集
    const { numPages } = await extractText(buildCjkPdf('90ms-RKSJ-H', 'Japan1', '93FA967B8CEA'));

    expect(numPages).toBe(1);
    const missing = getMissingPdfAssetLog();
    expect(missing.map((entry) => entry.fileName)).toContain('90ms-RKSJ-H.bcmap');
  }, 60_000);

  it('配置远程源后，子集外 cmap 经 tier3 补齐，文本恢复可提取', async () => {
    const remoteBase = 'https://mirror.example/pdfjs-dist@5.4.296/';
    localStorage.setItem(PDF_ASSET_REMOTE_BASE_STORAGE_KEY, remoteBase);
    const fetchStub = localAssetFetchStub(remoteBase);
    vi.stubGlobal('fetch', fetchStub);

    const { text } = await extractText(buildCjkPdf('90ms-RKSJ-H', 'Japan1', '93FA967B8CEA'));

    expect(text).toBe('日本語');
    expect(getMissingPdfAssetLog()).toHaveLength(0);
    expect(fetchStub).toHaveBeenCalledWith(`${remoteBase}cmaps/90ms-RKSJ-H.bcmap`);
  }, 60_000);
});
