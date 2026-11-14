import { describe, expect, it } from 'vitest';
import { readZip } from '../../util/node.ts';
import { createTestHost } from '../../../kernel/testing.ts';
import native from '../index.ts';

describe('docx_handout.rs production generator', () => {
  it('embeds a fixed PNG input instead of silently replacing it with an image placeholder', async () => {
    // Independent input: one red RGBA pixel with alpha 0, not produced by nativeImage.encode.
    const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DAAAAEAQEARwbK3gAAAABJRU5ErkJggg==';
    const host = await createTestHost({ plugins: [native] });
    try {
      const output = await host.ctx.nativeOfficeWriter.generateDocx({ blocks: [{ type: 'image', data, caption: 'fixed PNG' }] });
      const zip = readZip(output), xml = zip.read('word/document.xml').toString();
      const media = zip.entries.filter(e => e.name.startsWith('word/media/') && e.name.endsWith('.png'));
      expect(media).toHaveLength(1);
      expect(xml).toContain('<w:drawing');
      expect(xml).toContain('fixed PNG');
      expect(xml).not.toContain('[image]');
      expect(await host.ctx.nativeImage.decodeRgba(zip.read(media[0]!)))
        .toEqual({ width: 1, height: 1, rgba: new Uint8Array([255, 0, 0, 0]) });
    } finally { await host.dispose(); }
  });

  it('default_spec_renders_image_block', async () => {
    const host = await createTestHost({ plugins: [native] });
    try {
      const data = await host.ctx.nativeImage.encode({ width: 32, height: 16, rgba: new Uint8Array(32 * 16 * 4).fill(128) }, { format: 'jpeg', quality: 80 });
      const output = await host.ctx.nativeOfficeWriter.generateDocx({ title: 'T', blocks: [
        { type: 'paragraph', text: 'hello' },
        { type: 'image', data: `data:image/jpeg;base64,${Buffer.from(data).toString('base64')}`, caption: 'Figure 1' },
      ] });
      const zip = readZip(output), xml = zip.read('word/document.xml').toString();
      expect(zip.entries.some(e => e.name.startsWith('word/media/') && e.name.endsWith('.png'))).toBe(true);
      expect(xml).toContain('<w:drawing');
      expect(xml).toContain('Figure 1');
      expect(xml).not.toContain('仿宋');
      expect(xml).not.toContain('w:lineRule="exact"');
    } finally { await host.dispose(); }
  });

  it('broken_image_degrades_to_placeholder', async () => {
    const host = await createTestHost({ plugins: [native] });
    try {
      const output = await host.ctx.nativeOfficeWriter.generateDocx({ blocks: [{ type: 'image', data: 'bm90LWFuLWltYWdl', alt: 'slide' }] });
      const zip = readZip(output);
      expect(zip.read('word/document.xml').toString()).toContain('[slide]');
      expect(zip.entries.some(e => e.name.startsWith('word/media/') && e.name.endsWith('.png'))).toBe(false);
    } finally { await host.dispose(); }
  });

  it('handout_template_applies_official_layout', async () => {
    const host = await createTestHost({ plugins: [native] });
    try {
      const bytes = await host.ctx.nativeImage.encode({ width: 2400, height: 1200, rgba: new Uint8Array(2400 * 1200 * 4).fill(128) }, { format: 'jpeg', quality: 80 });
      const output = await host.ctx.nativeOfficeWriter.generateDocx({ title: '讲义', template: 'handout', subtitle: '课程：测试', blocks: [
        { type: 'heading', level: 1, text: '一、概述' },
        { type: 'paragraph', text: '正文' }, { type: 'paragraph', role: 'note', text: '注意' },
        { type: 'table', header: true, caption: '表 1', rows: [['A', 'B'], ['1', '2']] },
        { type: 'image', data: `data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}`, caption: '图 1 课件' },
      ] });
      const zip = readZip(output), xml = zip.read('word/document.xml').toString();
      expect(zip.entries.some(e => e.name.startsWith('word/media/') && !e.isDirectory)).toBe(true);
      for (const expected of ['w:lineRule="exact"', 'w:line="560"', 'w:eastAsia="仿宋"',
        'w:eastAsia="黑体"', 'w:firstLine="640"', 'w:left="1587"', 'w:top="2098"',
        '图 1 课件', 'cx="5616575"']) expect(xml).toContain(expected);
      const media = zip.entries.find(e => e.name.startsWith('word/media/') && e.name.endsWith('.png'))!;
      expect(await host.ctx.nativeImage.dimensions(zip.read(media))).toEqual({ width: 2000, height: 1000 });
    } finally { await host.dispose(); }
  });

  it('settings_omit_even_and_odd_headers_like_docx_rs', async () => {
    // docx-rs Settings::build: `.apply_if(self.even_and_odd_headers, ..)`, default false.
    const host = await createTestHost({ plugins: [native] });
    try {
      for (const spec of [
        { title: 'T', blocks: [{ type: 'paragraph', text: 'hello' }] },
        { title: '讲义', template: 'handout', blocks: [{ type: 'paragraph', text: '正文' }] },
      ]) {
        const zip = readZip(await host.ctx.nativeOfficeWriter.generateDocx(spec));
        const settings = zip.read('word/settings.xml').toString();
        expect(settings).toContain('<w:settings');
        expect(settings).toContain('w:defaultTabStop');
        expect(settings).not.toContain('evenAndOddHeaders');
        expect(zip.read('word/document.xml').toString()).not.toContain('w:titlePg');
      }
    } finally { await host.dispose(); }
  });
});
