import ExcelJS from 'exceljs';
import { Writable } from 'node:stream';

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const error = (message: string): Error => new Error(`Excel解析错误: ${message}`);
const byteLength = (text: string): number => Buffer.byteLength(text, 'utf8');

// umya-spreadsheet 2.3.3 CellValue::guess_typed_data, not ExcelJS's string-only assignment.
export function cellValue(value: string, numericFirst: boolean): ExcelJS.CellValue {
  const upper = value.toUpperCase();
  const numeric = /^[+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|inf(?:inity)?|nan)$/iu.test(value);
  if (numeric && (numericFirst || upper !== 'NAN')) return Number(value.replace(/^([+-]?)inf(?:inity)?$/iu, '$1Infinity'));
  if (value === '') return null;
  if (upper === 'TRUE' || upper === 'FALSE') return upper === 'TRUE';
  if (['#NULL!', '#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#N/A', '#GETTING_DATA'].includes(upper)) {
    return { error: upper as ExcelJS.CellErrorValue['error'] };
  }
  return value;
}

export async function writeBounded(book: ExcelJS.Workbook, operation = '生成'): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  const stream = new Writable({ write(chunk: Buffer, _encoding, done) {
    size += chunk.length;
    if (size > 200 * 1024 * 1024) done(new Error('文档输出超过大小上限'));
    else { chunks.push(Buffer.from(chunk)); done(); }
  } });
  // ExcelJS emits stream errors independently of its write promise.
  const failed = new Promise<never>((_resolve, reject) => stream.once('error', reject));
  try {
    await Promise.race([book.xlsx.write(stream), failed]);
    return Buffer.concat(chunks);
  } catch (cause) { throw error(`XLSX ${operation}失败: ${cause instanceof Error ? cause.message : String(cause)}`); }
}

/** document_parser.rs:3185–3340. Edits/read safety gates are owned by L18. */
export async function generateXlsx(value: unknown): Promise<Uint8Array> {
  const spec = object(value), sheets = array(spec.sheets);
  const data = sheets.length === 0 ? [spec] : sheets;
  if (data.length > 256) throw error(`XLSX 工作表数量 ${data.length} 超过上限 256`);
  const book = new ExcelJS.Workbook();
  const sheetNames: string[] = [];
  let totalCells = 0, totalText = 0;
  const text = (value: unknown): string => {
    if (++totalCells > 1_000_000) throw error('XLSX spec 单元格数量超过上限 1000000');
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
      throw error('XLSX 单元格只支持字符串、数字、布尔值或 null');
    }
    const result = value === null ? '' : String(value);
    if (byteLength(result) > 8 * 1024 * 1024) throw error('XLSX spec 单元格文本超过 8MB 上限');
    totalText += byteLength(result);
    if (totalText > 64 * 1024 * 1024) throw error('XLSX spec 文本总量超过 64MB 上限');
    return result;
  };
  for (const [index, raw] of data.entries()) {
    const sheet = object(raw);
    const name = typeof sheet.name === 'string' ? sheet.name : index === 0 ? 'Sheet1' : '';
    if ([...name].length > 31) throw error('XLSX 工作表名称不能超过 31 个字符');
    const actualName = index !== 0 && name === '' ? `Sheet${index + 1}` : name;
    // umya set_name on the first sheet does no validation; new_sheet only rejects
    // exact duplicates. ExcelJS additionally rejects History, punctuation, empty
    // names and counts UTF-16 instead of Rust chars. Preserve umya's behaviour.
    if (index > 0 && sheetNames.includes(actualName)) throw error('创建工作表失败: name duplicate.');
    sheetNames.push(actualName);
    const ws = book.addWorksheet(`f7_sheet_${index + 1}`);
    let rowNumber = 1;
    if (Array.isArray(sheet.headers)) {
      if (sheet.headers.length > 16384) throw error('XLSX 列数超过 16384 上限');
      for (const [column, raw] of sheet.headers.entries()) {
        const cell = ws.getCell(rowNumber, column + 1);
        cell.value = cellValue(text(raw), false);
        cell.font = { bold: true };
      }
      rowNumber++;
    }
    if (Array.isArray(sheet.rows)) {
      if (sheet.rows.length > 1_048_575 - (rowNumber - 1)) throw error('XLSX 行数超过 1048576 上限');
      for (const row of sheet.rows) {
        if (!Array.isArray(row)) throw error('XLSX rows 中的每一项都必须是数组');
        if (row.length > 16384) throw error('XLSX 列数超过 16384 上限');
        for (const [column, raw] of row.entries()) ws.getCell(rowNumber, column + 1).value = cellValue(text(raw), true);
        rowNumber++;
      }
    }
  }
  // Pinned ExcelJS4.4.0 worksheet.name is backed by _name; serialize real names
  // after construction rather than invoking its stricter name setter.
  book.worksheets.forEach((sheet, index) => { (sheet as unknown as { _name: string })._name = sheetNames[index]!; });
  return writeBounded(book);
}

/** document_parser.rs:3452–3485,3559–3598; L18 owns all container/fidelity preflight gates. */
export async function editXlsxCells(bytes: Uint8Array, edits: readonly (readonly [string, string, string])[], warn: (message: string) => void): Promise<{ bytes: Uint8Array; editCount: number }> {
  if (edits.length > 10_000) throw error(`XLSX 单元格编辑数量 ${edits.length} 超过上限 10000`);
  let total = 0;
  for (const [sheet, cell, value] of edits) {
    if (sheet === '' || byteLength(sheet) > 255 || cell === '' || byteLength(cell) > 32) throw error('XLSX 工作表名或单元格引用无效');
    if (byteLength(value) > 8 * 1024 * 1024) throw error('XLSX 单元格文本超过 8MB 上限');
    total += byteLength(value);
  }
  if (total > 64 * 1024 * 1024) throw error('XLSX 编辑文本总量超过 64MB 上限');
  const book = new ExcelJS.Workbook();
  try { await book.xlsx.load(Buffer.from(bytes) as unknown as ExcelJS.Buffer); }
  catch (cause) { throw error(`XLSX 读取失败: ${cause instanceof Error ? cause.message : String(cause)}`); }
  let editCount = 0;
  for (const [name, address, value] of edits) {
    // umya sheet lookup is exact/case-sensitive.
    const sheet = book.worksheets.find(sheet => sheet.name === name);
    if (sheet === undefined) {
      warn(`[DocumentParser] XLSX 编辑：工作表 '${name}' 不存在，跳过`);
      continue;
    }
    sheet.getCell(address).value = cellValue(value, true); // assignment removes any old formula
    editCount++;
  }
  return { bytes: await writeBounded(book, '保存'), editCount };
}
