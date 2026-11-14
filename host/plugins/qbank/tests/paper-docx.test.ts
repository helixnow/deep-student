/**
 * `crates/dstu-qbank/src/qbank_practice/export.rs::docx_has_editable_text_table_and_a4_layout`
 * 的原样移植：可编辑文字、表格、A4 页面尺寸与表格边框色。
 */
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { buildPaperDocx, type PaperBlockInput } from '../src/paper-docx.ts';
import { paperImageCodecOf } from '../src/native-image.ts';
// boundary-allow cross-plugin-impl: 测试读取 F7 nativeImage 的真实能力
import { image as nativeImage } from '../../../platform/native/image/index.ts';

const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const FALLBACK = `[{"kind":"heading","level":0,"runs":[{"text":"数学综合练习"}]},{"kind":"paragraph","runs":[{"text":"普通文字可以编辑"}]},{"kind":"table","rows":[[[{"text":"题号"}],[{"text":"分值"}]],[[{"text":"1"}],[{"text":"10"}]]]}]`;

describe('qbank_practice/export.rs', () => {
  it('docx_has_editable_text_table_and_a4_layout', async () => {
    const qaDir = process.env.QBANK_EXPORT_QA_DIR;
    const input = qaDir === undefined ? FALLBACK
      : fs.readFileSync(path.join(qaDir, 'sample-blocks.json'), 'utf8');
    const blocks = JSON.parse(input) as PaperBlockInput[];
    const bytes = await buildPaperDocx('数学综合练习', blocks, null);
    const zip = await JSZip.loadAsync(bytes);
    const documentXml = await zip.file('word/document.xml')?.async('string');
    expect(documentXml).toBeDefined();
    expect(documentXml).toContain('数学综合练习');
    expect(documentXml).toContain('w:tbl');
    expect(documentXml).toContain('11906');
    expect(documentXml).toContain('16838');
    expect(documentXml).toContain('D9D9D9');
    if (qaDir !== undefined) {
      expect(Object.keys(zip.files).some(name => name.startsWith('word/media/'))).toBe(true);
      fs.writeFileSync(path.join(qaDir, 'sample.docx'), bytes);
    }
  });

  it('image_block_embeds_png_and_uses_rust_emu_sizing', async () => {
    // pngjs / jpeg-js 已在根依赖中；F7 真实编码必须可用，缺失即失败，不跳过。
    const codec = paperImageCodecOf({ get: () => nativeImage });
    expect(codec).not.toBeNull();
    const bytes = await buildPaperDocx('图片', [{
      kind: 'image',
      image: `data:image/png;base64,${ONE_PIXEL_PNG}`,
    }], codec!);
    const zip = await JSZip.loadAsync(bytes);
    expect(Object.keys(zip.files).filter(name => name.startsWith('word/media/'))).toHaveLength(1);
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(xml).toContain('<w:drawing>');
    // Rust：1px 宽缺省 0.75pt，但 `.max(1.0)` 抬到 1pt；1pt = 12700 EMU。
    expect(xml).toContain('cx="12700"');
    expect(xml).toContain('cy="12700"');
  });

  it('image_block_uses_the_native_image_contract_with_rust_emu_sizing', async () => {
    const png = Buffer.from(ONE_PIXEL_PNG, 'base64');
    const calls: string[] = [];
    // F7 边界替身：只验证 qbank 传给 nativeImage 的调用与 DOCX 尺寸，不复制 F7 编解码。
    const codec = {
      async decodeRgba() {
        calls.push('decode');
        return { width: 1, height: 1, rgba: new Uint8Array([0, 0, 0, 255]) };
      },
      resizeDimensions(width: number, height: number) {
        calls.push('dimensions');
        return { width, height };
      },
      resizeRgba(input: { width: number; height: number; rgba: Uint8Array }) {
        calls.push('resize');
        return input;
      },
      async encode() {
        calls.push('encode');
        return new Uint8Array(png);
      },
    };
    const bytes = await buildPaperDocx('图片', [{
      kind: 'image',
      image: `data:image/png;base64,${ONE_PIXEL_PNG}`,
    }], codec);
    const zip = await JSZip.loadAsync(bytes);
    expect(Object.keys(zip.files).filter(name => name.startsWith('word/media/'))).toHaveLength(1);
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(xml).toContain('<w:drawing>');
    // Rust `picture()`：`.max(1.0)` 把 0.75pt 缺省宽度抬到 1pt = 12700 EMU。
    expect(xml).toContain('cx="12700"');
    expect(xml).toContain('cy="12700"');
    expect(calls).toEqual(['decode', 'encode']);
  });

  it('image_data_decodes_like_docx_handout_decode_image_data', async () => {
    // docx_handout.rs:92-99：剥离 `char::is_whitespace` 后 `STANDARD.decode`（严格尾位）。
    const codec = paperImageCodecOf({ get: () => nativeImage })!;
    const build = (image: string) => buildPaperDocx('图片', [{ kind: 'image', image }], codec);
    const invalid = { appError: expect.objectContaining({ error_type: 'Validation', message: 'Invalid paper image' }) };
    const nonCanonical = `${ONE_PIXEL_PNG.slice(0, -3)}h==`;
    await expect(build(nonCanonical)).rejects.toMatchObject(invalid);
    await expect(build(`\uFEFF${ONE_PIXEL_PNG}`)).rejects.toMatchObject(invalid);
    const zip = await JSZip.loadAsync(await build(`data:image/png;base64,\u0085${ONE_PIXEL_PNG}\u3000`));
    expect(Object.keys(zip.files).filter(name => name.startsWith('word/media/'))).toHaveLength(1);
  });

  it('image_block_without_native_codec_reports_cannot_decode', async () => {
    await expect(buildPaperDocx('图片', [{
      kind: 'image',
      image: `data:image/png;base64,${ONE_PIXEL_PNG}`,
    }], null)).rejects.toMatchObject({ appError: expect.objectContaining({
      error_type: 'Validation', message: 'Cannot decode paper image',
    }) });
  });
});
