import ExcelJS from 'exceljs';
import type { XlsxMetadata, XlsxSpec, XlsxTable } from './api.ts';
import { cellValue, writeBounded } from './xlsx.ts';

const error = (message: string): Error => new Error(`Excel解析错误: ${message}`);
const bytes = (value: string): number => Buffer.byteLength(value, 'utf8');
interface StoredCell { address: string; type: ExcelJS.ValueType }
function storedRows(sheet: ExcelJS.Worksheet): Array<{ cells?: StoredCell[] }> {
  // ExcelJS4.4.0's runtime Worksheet.model includes rows, omitted by its public
  // WorksheetModel declaration. Do not use rowCount*columnCount to materialize it.
  return (sheet.model as unknown as { rows: Array<{ cells?: StoredCell[] }> }).rows;
}

async function read(input: Uint8Array): Promise<ExcelJS.Workbook> {
  const book = new ExcelJS.Workbook();
  try { await book.xlsx.load(Buffer.from(input) as unknown as ExcelJS.Buffer); }
  catch (cause) { throw error(`XLSX 读取失败: ${cause instanceof Error ? cause.message : String(cause)}`); }
  return book;
}

/** umya CellRawValue Display: cached formula values, uppercase bools, raw serial dates. */
function valueText(value: ExcelJS.CellValue, date1904: boolean): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return String(value.getTime() / 86_400_000 + (date1904 ? 24107 : 25569));
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value !== 'object') return String(value);
  if ('formula' in value || 'sharedFormula' in value) return valueText(value.result ?? null, date1904);
  if ('richText' in value) return value.richText.map(run => run.text).join('');
  if ('error' in value) return value.error;
  if ('text' in value) return value.text;
  return '';
}

function dimensions(sheet: ExcelJS.Worksheet): { maxRow: number; maxCol: number } {
  let maxRow = 0, maxCol = 0;
  // ExcelJS's merge proxy cells do not correspond to stored umya cells. Style-only
  // cell models do: umya's get_highest_column_and_row includes those addresses.
  for (const row of storedRows(sheet)) {
    for (const cell of row.cells ?? []) {
      if (cell.type === ExcelJS.ValueType.Merge) continue;
      const match = /^([A-Z]+)(\d+)$/u.exec(cell.address);
      if (match === null) continue;
      let column = 0;
      for (const letter of match[1]!) column = column * 26 + letter.charCodeAt(0) - 64;
      maxCol = Math.max(maxCol, column);
      maxRow = Math.max(maxRow, Number(match[2]));
    }
  }
  return { maxRow, maxCol };
}

function accountText(total: number, value: string): number {
  const length = bytes(value);
  if (length > 8 * 1024 * 1024) throw error('XLSX 单元格文本超过 8MB 上限');
  total += length;
  if (total > 64 * 1024 * 1024) throw error('XLSX 输出文本总量超过 64MB 上限');
  return total;
}

async function denseTables(input: Uint8Array): Promise<XlsxTable[]> {
  const book = await read(input);
  const tables: XlsxTable[] = [];
  let totalCells = 0, totalText = 0;
  for (const sheet of book.worksheets) {
    const { maxRow, maxCol } = dimensions(sheet);
    totalCells += maxRow * maxCol;
    if (totalCells > 1_000_000) {
      throw error(`工作表 '${sheet.name}' 的 ${maxRow}x${maxCol} 范围会展开超过 1000000 个单元格`);
    }
    const rows: string[][] = [];
    for (let row = 1; row <= maxRow; row++) {
      const values: string[] = [];
      for (let column = 1; column <= maxCol; column++) {
        const cell = sheet.findRow(row)?.findCell(column);
        // Do not repeat the top-left value into merged cells: umya reads the
        // underlying raw cell value, not ExcelJS's merge master proxy.
        const text = cell?.type === ExcelJS.ValueType.Merge ? '' : valueText(cell?.value ?? null, book.properties.date1904 ?? false);
        totalText = accountText(totalText, text);
        values.push(text);
      }
      rows.push(values);
    }
    tables.push({ sheet_name: sheet.name, row_count: maxRow, col_count: maxCol, rows });
  }
  return tables;
}

export async function readXlsxSpec(input: Uint8Array): Promise<XlsxSpec> {
  return { sheets: (await denseTables(input)).map(table => ({ name: table.sheet_name,
    headers: table.rows[0] ?? [], rows: table.rows.slice(1) })) };
}

export async function readXlsxTables(input: Uint8Array): Promise<XlsxTable[]> {
  return (await denseTables(input)).filter(table => table.row_count > 0 && table.col_count > 0);
}

export async function readXlsxMetadata(input: Uint8Array): Promise<XlsxMetadata> {
  const book = await read(input);
  const sheets = book.worksheets.map(sheet => {
    const { maxRow, maxCol } = dimensions(sheet);
    return { name: sheet.name, row_count: maxRow, col_count: maxCol };
  });
  return { sheet_count: sheets.length, total_rows: sheets.reduce((sum, sheet) => sum + sheet.row_count, 0),
    total_cols: sheets.reduce((max, sheet) => Math.max(max, sheet.col_count), 0), sheets, format: 'xlsx' };
}

export async function replaceXlsxText(input: Uint8Array, replacements: readonly (readonly [string, string])[]): Promise<{ bytes: Uint8Array; replacementCount: number }> {
  if (replacements.length > 256) throw error(`XLSX 替换规则数量 ${replacements.length} 超过上限 256`);
  let totalTerms = 0;
  for (const [find, replacement] of replacements) {
    if (find === '') throw error('XLSX 替换查找文本不能为空');
    if (bytes(find) > 64 * 1024 || bytes(replacement) > 64 * 1024) throw error('XLSX 单条替换文本超过 64KB 上限');
    totalTerms += bytes(find) + bytes(replacement);
  }
  if (totalTerms > 8 * 1024 * 1024) throw error('XLSX 替换规则总量超过 8MB 上限');
  const book = await read(input);
  let replacementCount = 0, totalChangedText = 0;
  for (const sheet of book.worksheets) {
    // Model contains populated/style cells only; avoid dense row*column scans.
    const models = storedRows(sheet).flatMap(row => row.cells ?? []).filter(cell => cell.type !== ExcelJS.ValueType.Merge);
    if (models.length > 1_000_000) throw error(`工作表 '${sheet.name}' 的实际单元格数量 ${models.length} 超过上限 1000000`);
    for (const model of models) {
      const cell = sheet.getCell(model.address);
      const old = valueText(cell.value, book.properties.date1904 ?? false);
      let next = old;
      for (const [find, replacement] of replacements) {
        let count = 0, start = 0;
        while ((start = next.indexOf(find, start)) !== -1) { count++; start += find.length; }
        const predicted = bytes(next) - count * bytes(find) + count * bytes(replacement);
        if (predicted > 8 * 1024 * 1024) throw error('XLSX 替换后单元格文本超过 8MB 上限');
        if (count > 0) next = next.split(find).join(replacement);
      }
      if (next !== old) {
        totalChangedText += bytes(next);
        if (totalChangedText > 64 * 1024 * 1024) throw error('XLSX 替换后的文本总量超过 64MB 上限');
        cell.value = cellValue(next, false);
        replacementCount++;
      }
    }
  }
  return { bytes: await writeBounded(book, '保存'), replacementCount };
}
