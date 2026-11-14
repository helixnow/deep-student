import { describe, it, expect } from 'vitest';
import { readZip } from '../../util/node.ts';
import { createTestHost } from '../../../kernel/testing.ts';
import native from '../index.ts';

describe('document_parser.rs Office generation', () => {
  it('generate_xlsx_from_spec writes typed values, bold headers and ordered worksheets', async () => {
    const host = await createTestHost({ plugins: [native] });
    try {
      const bytes = await host.ctx.nativeOfficeWriter.generateXlsx({ sheets: [
        { name: '词表', headers: ['姓名', '年龄'], rows: [['张三', '25'], ['李四', 30], [true, null]] },
        { headers: ['A'] },
      ] });
      const zip = readZip(bytes);
      const workbook = zip.read('xl/workbook.xml').toString();
      expect(workbook).toContain('name="词表"');
      expect(workbook).toContain('name="Sheet2"');
      const xml = zip.read('xl/worksheets/sheet1.xml').toString();
      expect(xml).toContain('<v>25</v>');
      expect(xml).toContain('<v>30</v>');
      expect(xml).toContain('t="b"');
      expect(zip.read('xl/styles.xml').toString()).toContain('<b/>');
      expect(zip.read('xl/sharedStrings.xml').toString()).toContain('张三');
      await expect(host.ctx.nativeOfficeWriter.generateXlsx({ rows: [[{}]] })).rejects
        .toThrow('XLSX 单元格只支持字符串、数字、布尔值或 null');
      await expect(host.ctx.nativeOfficeWriter.generateXlsx({ rows: ['not a row'] })).rejects
        .toThrow('XLSX rows 中的每一项都必须是数组');
    } finally { await host.dispose(); }
  });

  it('generate_xlsx_from_spec retains umya first-sheet naming and case-sensitive duplicate rules', async () => {
    const host = await createTestHost({ plugins: [native] });
    try {
      const api = host.ctx.nativeOfficeWriter;
      const data = readZip(await api.generateXlsx({ sheets: [
        { name: '' }, { name: 'History' }, { name: 'history' }, { name: 'A/B' }, { name: '😀'.repeat(31) },
      ] })).read('xl/workbook.xml').toString();
      for (const name of ['', 'History', 'history', 'A/B', '😀'.repeat(31)]) expect(data).toContain(`name="${name}"`);
      await expect(api.generateXlsx({ sheets: [{ name: 'A' }, { name: 'A' }] })).rejects
        .toThrow('创建工作表失败: name duplicate.');
    } finally { await host.dispose(); }
  });

  it('generate_pptx_from_spec preserves titles, subtitles, bullet text, tables and slide dimensions/count', async () => {
    const host = await createTestHost({ plugins: [native] });
    try {
      const bytes = await host.ctx.nativeOfficeWriter.generatePptx({ title: 'Deck', slides: [
        { type: 'title', title: '欢迎', subtitle: '副标题' },
        { type: 'content', title: '重点', bullets: ['第一点', 42, '第二点'] },
        { type: 'table', title: '表格', headers: ['名称', '值'], rows: [['A', 'B']] },
        { type: 'unknown', title: '空白' },
      ] });
      const zip = readZip(bytes);
      expect(zip.entries.filter(e => /^ppt\/slides\/slide\d+\.xml$/u.test(e.name))).toHaveLength(4);
      expect(zip.read('ppt/slides/slide1.xml').toString()).toContain('副标题');
      const content = zip.read('ppt/slides/slide2.xml').toString();
      expect(content).toContain('第一点');
      expect(content).toContain('第二点');
      const table = zip.read('ppt/slides/slide3.xml').toString();
      expect(table).toContain('<a:tbl>');
      expect(table).toContain('名称');
      expect(table).toContain('<a:t>A</a:t>');
      const presentation = zip.read('ppt/presentation.xml').toString();
      expect(presentation).toContain('cx="9144000"');
      expect(presentation).toContain('cy="6858000"');
      const empty = readZip(await host.ctx.nativeOfficeWriter.generatePptx({}));
      expect(empty.read('ppt/slides/slide1.xml').toString()).toContain('Presentation');
    } finally { await host.dispose(); }
  });
});
