// @vitest-environment node
/**
 * pdfjs cmaps 子集裁剪（R2-pdfjs-subset）的"日文 PDF 不崩溃"回归测试。
 *
 * R1 静态资产审计与 R2 裁剪报告都要求补一条用例：加载一份日文 PDF，
 * 断言不抛错。本测试在临时目录里按 config/pdfjs-local-assets.json 的
 * 白名单（与 vite.config.ts / tests/vitest/pdf/pdfCjkNoCrash.test.ts
 * 同一份清单）复刻 dist/cmaps 子集，然后走【不带运行时 fallback 的】
 * 原生 pdfjs 链路——与 pdfCjkNoCrash.test.ts（走 PDF_OPTIONS 三级
 * fallback，简中正向 + 日文遗留降级）互补：
 *
 * 1. 保留场景：引用 UniJIS-UCS2-H（子集内）的日文 PDF 能正常加载，
 *    文本层可提取出日文字符——保证"现代日文 PDF 不依赖 fallback 也可用"；
 * 2. 裁剪场景：引用 90ms-RKSJ-H（遗留编码，已裁掉）的日文 PDF 在
 *    pdfjs 默认 ignoreErrors 下只降级不崩溃——getDocument / getPage /
 *    getOperatorList 全部正常 resolve（fallback 全落空时的兜底行为）。
 */
import { mkdtempSync, readdirSync, readFileSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const pdfjsDistPath = path.dirname(require.resolve('pdfjs-dist/package.json'));
const fullCMapsDir = path.join(pdfjsDistPath, 'cmaps');
const standardFontsDir = path.join(pdfjsDistPath, 'standard_fonts');

// 白名单单一事实来源（与 vite.config.ts 消费同一文件），匹配语义与
// pdfCjkNoCrash.test.ts 保持一致：去掉 .bcmap 扩展名后按 glob 整名匹配。
const { keptCMapGlobs } = JSON.parse(
  readFileSync(path.join(process.cwd(), 'config', 'pdfjs-local-assets.json'), 'utf8'),
) as { keptCMapGlobs: string[] };

const keptCMapPatterns = keptCMapGlobs.map(
  (glob) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`),
);

function isCMapKept(fileName: string): boolean {
  const bareName = fileName.replace(/\.bcmap$/, '');
  return keptCMapPatterns.some((pattern) => pattern.test(bareName));
}

let subsetCMapsDir: string;

/** 以正确的 xref 偏移组装单代号（1..n 顺序编号）PDF。 */
function buildPdf(objects: string[]): Uint8Array {
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(out.length);
    out += `${obj}\n`;
  }
  const xrefPos = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    out += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return new TextEncoder().encode(out);
}

/**
 * 未内嵌字体的日文 CID 字体 PDF：Type0 + 预定义编码 cmap（是否可用
 * 完全取决于 cMapUrl 目录里有没有对应文件）。
 */
function buildJapanesePdf(encoding: string, hexText: string): Uint8Array {
  const content = `BT /F1 12 Tf 20 100 Td <${hexText}> Tj ET`;
  return buildPdf([
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] '
      + '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj',
    `4 0 obj << /Type /Font /Subtype /Type0 /BaseFont /KozMinPro-Regular `
      + `/Encoding /${encoding} /DescendantFonts [6 0 R] >> endobj`,
    `5 0 obj << /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj`,
    '6 0 obj << /Type /Font /Subtype /CIDFontType0 /BaseFont /KozMinPro-Regular '
      + '/CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 4 >> '
      + '/FontDescriptor 7 0 R /DW 1000 >> endobj',
    '7 0 obj << /Type /FontDescriptor /FontName /KozMinPro-Regular /Flags 6 '
      + '/FontBBox [-437 -340 1147 1317] /ItalicAngle 0 /Ascent 1317 /Descent -349 '
      + '/CapHeight 742 /StemV 80 >> endobj',
  ]);
}

async function loadAllPages(data: Uint8Array) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({
    data,
    cMapUrl: `${subsetCMapsDir}${path.sep}`,
    cMapPacked: true,
    standardFontDataUrl: `${standardFontsDir}${path.sep}`,
    useSystemFonts: false,
  });
  try {
    const doc = await task.promise;
    const page = await doc.getPage(1);
    // 字体翻译（含内置 cmap 加载）发生在 getOperatorList；
    // pdfjs 默认 stopAtErrors:false，缺 cmap 只告警降级，不应 reject。
    await page.getOperatorList();
    const textContent = await page.getTextContent();
    const text = textContent.items
      .map((item) => ('str' in item ? item.str : ''))
      .join('');
    return { numPages: doc.numPages, text };
  } finally {
    await task.destroy();
  }
}

describe('pdfjs cmap subset: CJK/Japanese PDF must not crash', () => {
  beforeAll(() => {
    subsetCMapsDir = mkdtempSync(path.join(tmpdir(), 'ds-cmap-subset-'));
    for (const file of readdirSync(fullCMapsDir)) {
      if (isCMapKept(file)) {
        copyFileSync(path.join(fullCMapsDir, file), path.join(subsetCMapsDir, file));
      }
    }
  });

  afterAll(() => {
    rmSync(subsetCMapsDir, { recursive: true, force: true });
  });

  it('subset keeps modern Japanese cmaps and drops legacy ones', () => {
    expect(existsSync(path.join(subsetCMapsDir, 'UniJIS-UCS2-H.bcmap'))).toBe(true);
    expect(existsSync(path.join(subsetCMapsDir, 'Adobe-Japan1-UCS2.bcmap'))).toBe(true);
    expect(existsSync(path.join(subsetCMapsDir, '90ms-RKSJ-H.bcmap'))).toBe(false);
  });

  it('loads a Japanese PDF using a kept cmap (UniJIS-UCS2-H) and extracts text', async () => {
    // <30423044> = あい（UCS-2 大端）
    const { numPages, text } = await loadAllPages(buildJapanesePdf('UniJIS-UCS2-H', '30423044'));
    expect(numPages).toBe(1);
    expect(text).toContain('あ');
  });

  it('degrades without crashing when the PDF references a pruned legacy cmap (90ms-RKSJ-H)', async () => {
    // <82A082A2> = あい（Shift-JIS）；90ms-RKSJ-H 已被子集裁掉
    const { numPages } = await loadAllPages(buildJapanesePdf('90ms-RKSJ-H', '82A082A2'));
    expect(numPages).toBe(1);
  });
});
