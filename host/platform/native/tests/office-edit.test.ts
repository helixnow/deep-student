import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { readZip } from '../../util/node.ts';
import { createTestHost } from '../../../kernel/testing.ts';
import native from '../index.ts';

describe('document_parser.rs edit_xlsx_cells native codec seam', () => {
  it('updates selected cells, clears overwritten formulas and skips a missing worksheet', async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Sheet1');
    sheet.getCell('A1').value = { formula: '1+1', result: 2 };
    sheet.getCell('B1').value = 'retained';
    const host = await createTestHost({ plugins: [native] });
    try {
      const output = await host.ctx.nativeOfficeWriter.editXlsxCells(new Uint8Array(await book.xlsx.writeBuffer()), [
        ['Sheet1', 'A1', '42'], ['missing', 'A1', 'not written'], ['Sheet1', 'A2', '新值'],
      ]);
      expect(output.editCount).toBe(2);
      const zip = readZip(output.bytes);
      const xml = zip.read('xl/worksheets/sheet1.xml').toString();
      expect(xml).toContain('<v>42</v>');
      expect(xml).not.toContain('<f>1+1</f>');
      expect(zip.read('xl/sharedStrings.xml').toString()).toContain('retained');
      expect(zip.read('xl/sharedStrings.xml').toString()).toContain('新值');
      await expect(host.ctx.nativeOfficeWriter.editXlsxCells(output.bytes, [['', 'A1', 'x']])).rejects
        .toThrow('XLSX 工作表名或单元格引用无效');
    } finally { await host.dispose(); }
  });
});
