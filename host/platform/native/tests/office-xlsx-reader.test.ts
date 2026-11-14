import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { createTestHost } from '../../../kernel/testing.ts';
import native from '../index.ts';

describe('document_parser.rs XLSX read/edit codec (L18 owns safety preflight)', () => {
  it('preserves headers/holes/boolean Display/cached formulas and empty-sheet metadata', async () => {
    const host = await createTestHost({ plugins: [native] });
    try {
      const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('Sheet1');
      book.addWorksheet('Empty');
      sheet.getCell('A1').value = '名称'; sheet.getCell('C1').value = '计数';
      sheet.getCell('A2').value = true; sheet.getCell('C2').value = { formula: '1+1', result: 2 };
      sheet.mergeCells('A3:C3'); sheet.getCell('A3').value = '合并';
      const bytes = new Uint8Array(await book.xlsx.writeBuffer());
      const api = host.ctx.nativeOfficeWriter;
      expect(await api.readXlsxSpec(bytes)).toEqual({ sheets: [
        { name: 'Sheet1', headers: ['名称', '', '计数'], rows: [['TRUE', '', '2'], ['合并', '', '']] },
        { name: 'Empty', headers: [], rows: [] },
      ] });
      expect(await api.readXlsxTables(bytes)).toEqual([{
        sheet_name: 'Sheet1', row_count: 3, col_count: 3,
        rows: [['名称', '', '计数'], ['TRUE', '', '2'], ['合并', '', '']],
      }]);
      expect(await api.readXlsxMetadata(bytes)).toEqual({ sheet_count: 2, total_rows: 3, total_cols: 3, format: 'xlsx',
        sheets: [{ name: 'Sheet1', row_count: 3, col_count: 3 }, { name: 'Empty', row_count: 0, col_count: 0 }] });
    } finally { await host.dispose(); }
  });

  it('test_xlsx_replace_rejects_empty_find_term (codec entry)', async () => {
    const host = await createTestHost({ plugins: [native] });
    try {
      const bytes = await host.ctx.nativeOfficeWriter.generateXlsx({ headers: ['value'] });
      await expect(host.ctx.nativeOfficeWriter.replaceXlsxText(bytes, [['', 'unbounded insertion']]))
        .rejects.toThrow('Excel解析错误: XLSX 替换查找文本不能为空');
    } finally { await host.dispose(); }
  });

  it('test_xlsx_replace_iterates_only_populated_sparse_cells (original XFD1048576 input, codec entry)', async () => {
    const host = await createTestHost({ plugins: [native] });
    try {
      const book = new ExcelJS.Workbook();
      book.addWorksheet('Sheet1').getCell('XFD1048576').value = 'needle';
      const input = new Uint8Array(await book.xlsx.writeBuffer()), api = host.ctx.nativeOfficeWriter;
      await expect(api.readXlsxSpec(input)).rejects.toThrow('范围会展开超过 1000000 个单元格');
      await expect(api.readXlsxTables(input)).rejects.toThrow('范围会展开超过 1000000 个单元格');
      const output = await api.replaceXlsxText(input, [['needle', 'replaced']]);
      expect(output.replacementCount).toBe(1);
      const check = new ExcelJS.Workbook();
      await check.xlsx.load(Buffer.from(output.bytes) as unknown as ExcelJS.Buffer);
      expect(check.getWorksheet('Sheet1')!.getCell('XFD1048576').value).toBe('replaced');
    } finally { await host.dispose(); }
  });

  it('counts changed cells, not occurrences, and applies replacement pairs sequentially', async () => {
    const host = await createTestHost({ plugins: [native] });
    try {
      const api = host.ctx.nativeOfficeWriter;
      const input = await api.generateXlsx({ headers: ['needle needle'], rows: [['needle']] });
      const output = await api.replaceXlsxText(input, [['needle', 'x'], ['x', 'TRUE']]);
      expect(output.replacementCount).toBe(2);
      expect(await api.readXlsxSpec(output.bytes)).toEqual({ sheets: [
        { name: 'Sheet1', headers: ['TRUE TRUE'], rows: [['TRUE']] },
      ] });
    } finally { await host.dispose(); }
  });
});
