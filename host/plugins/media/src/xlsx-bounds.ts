/** XLSX round-trip editing bounds (`document_parser.rs` `validate_xlsx_*`, `replace_xlsx_text_bounded`). */
import { utf8ByteLength } from '../../../platform/util/portable.ts';
import { ParsingError } from './document-errors.ts';

export const MAX_XLSX_CELL_EDITS = 10_000;
export const MAX_XLSX_REPLACEMENTS = 256;
export const MAX_XLSX_REPLACEMENT_TERM_BYTES = 64 * 1024;
export const MAX_XLSX_CELL_TEXT_BYTES = 8 * 1024 * 1024;
export const MAX_XLSX_EDITED_TEXT_BYTES = 64 * 1024 * 1024;

function excelError(detail: string): ParsingError {
  return new ParsingError('ExcelParsingError', detail);
}

/** `validate_xlsx_edits`：数量 / 名称长度 / 文本字节数上限。 */
export function validateXlsxEdits(edits: ReadonlyArray<readonly [string, string, string]>): void {
  if (edits.length > MAX_XLSX_CELL_EDITS) {
    throw excelError(`XLSX 单元格编辑数量 ${edits.length} 超过上限 ${MAX_XLSX_CELL_EDITS}`);
  }
  let totalValueBytes = 0;
  for (const [sheet, cell, value] of edits) {
    if (sheet === '' || utf8ByteLength(sheet) > 255
      || cell === '' || utf8ByteLength(cell) > 32) {
      throw excelError('XLSX 工作表名或单元格引用无效');
    }
    const valueBytes = utf8ByteLength(value);
    if (valueBytes > MAX_XLSX_CELL_TEXT_BYTES) {
      throw excelError(`XLSX 单元格文本超过 ${MAX_XLSX_CELL_TEXT_BYTES / (1024 * 1024)}MB 上限`);
    }
    totalValueBytes += valueBytes;
    if (!Number.isSafeInteger(totalValueBytes)) throw excelError('XLSX 编辑文本总长度溢出');
  }
  if (totalValueBytes > MAX_XLSX_EDITED_TEXT_BYTES) {
    throw excelError(`XLSX 编辑文本总量超过 ${MAX_XLSX_EDITED_TEXT_BYTES / (1024 * 1024)}MB 上限`);
  }
}

/** `validate_xlsx_replacements`：空查找串 / 单条与总量上限。 */
export function validateXlsxReplacements(
  replacements: ReadonlyArray<readonly [string, string]>,
): void {
  if (replacements.length > MAX_XLSX_REPLACEMENTS) {
    throw excelError(`XLSX 替换规则数量 ${replacements.length} 超过上限 ${MAX_XLSX_REPLACEMENTS}`);
  }
  let totalTermBytes = 0;
  for (const [find, replacement] of replacements) {
    if (find === '') throw excelError('XLSX 替换查找文本不能为空');
    const findBytes = utf8ByteLength(find);
    const replacementBytes = utf8ByteLength(replacement);
    if (findBytes > MAX_XLSX_REPLACEMENT_TERM_BYTES
      || replacementBytes > MAX_XLSX_REPLACEMENT_TERM_BYTES) {
      throw excelError(`XLSX 单条替换文本超过 ${MAX_XLSX_REPLACEMENT_TERM_BYTES / 1024}KB 上限`);
    }
    totalTermBytes += findBytes + replacementBytes;
    if (!Number.isSafeInteger(totalTermBytes)) throw excelError('XLSX 替换规则总长度溢出');
  }
  if (totalTermBytes > MAX_XLSX_CELL_TEXT_BYTES) {
    throw excelError(`XLSX 替换规则总量超过 ${MAX_XLSX_CELL_TEXT_BYTES / (1024 * 1024)}MB 上限`);
  }
}

/** `replace_xlsx_text_bounded`：替换前按字节数预测结果，超过单元格上限即拒绝。 */
export function replaceXlsxTextBounded(
  value: string,
  replacements: ReadonlyArray<readonly [string, string]>,
): string {
  let current = value;
  for (const [find, replacement] of replacements) {
    if (!current.includes(find)) continue;
    const occurrences = current.split(find).length - 1;
    const predicted = utf8ByteLength(current)
      - occurrences * utf8ByteLength(find)
      + occurrences * utf8ByteLength(replacement);
    if (predicted > MAX_XLSX_CELL_TEXT_BYTES) {
      throw excelError(
        `XLSX 替换后单元格文本超过 ${MAX_XLSX_CELL_TEXT_BYTES / (1024 * 1024)}MB 上限`);
    }
    current = current.split(find).join(replacement);
  }
  return current;
}
