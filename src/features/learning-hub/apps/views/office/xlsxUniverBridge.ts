/**
 * Bidirectional converter between `ExcelJS` (.xlsx) and Apache-2.0 `Univer` (`IWorkbookData`).
 *
 * Avoids any dependency on closed-source `@univerjs-pro/exchange-client` while supporting:
 * - Multi-sheet order, visibility, tab color, gridlines, and freeze panes
 * - Full cell values (numbers, dates as Excel serials + numFmt, booleans, strings, rich text, hyperlinks, errors)
 * - Formulas (`=SUM(...)` + cached results) and shared-formula expansion
 * - Deduplicated cell styles (font family/size/bold/italic/underline/strike/color, solid fill, borders, alignment, wrap, numFmt)
 * - Merged cell ranges, custom row heights / column widths, and hidden rows / columns
 * - Round-trip export back to `.xlsx` bytes, preserving workbook-level metadata when a baseline buffer is provided
 */
import {
  BorderStyleTypes,
  BooleanNumber,
  CellValueType,
  HorizontalAlign,
  LocaleType,
  VerticalAlign,
  WrapStrategy,
  type IBorderData,
  type IBorderStyleData,
  type ICellData,
  type IColumnData,
  type IFreeze,
  type IObjectArrayPrimitiveType,
  type IObjectMatrixPrimitiveType,
  type IRange,
  type IRowData,
  type IStyleData,
  type IWorkbookData,
  type IWorksheetData,
  type Nullable,
} from '@univerjs/core';
import ExcelJS from 'exceljs';

const ZIP_EOCD_MIN_BYTES = 22;
const ZIP_MAX_COMMENT_BYTES = 65_535;
const EXCEL_EPOCH_UTC_MS = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;

const DEFAULT_EXTRA_ROWS = 60;
const DEFAULT_EXTRA_COLS = 12;
const MIN_SHEET_ROWS = 200;
const MIN_SHEET_COLS = 26;
const DEFAULT_COL_WIDTH_PX = 88;
const DEFAULT_ROW_HEIGHT_PX = 24;

/** Office default theme palette (0-9). */
const THEME_COLORS = [
  'FFFFFF', '000000', 'E7E6E6', '44546A', '4472C4',
  'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47',
];

/** Standard BIFF8 indexed color palette (0-63). */
const INDEXED_COLORS = [
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080',
  '9999FF', '993366', 'FFFFCC', 'CCFFFF', '660066', 'FF8080', '0066CC', 'CCCCFF',
  '000080', 'FF00FF', 'FFFF00', '00FFFF', '800080', '800000', '008080', '0000FF',
  '00CCFF', 'CCFFFF', 'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99',
  '3366FF', '33CCCC', '99CC00', 'FFCC00', 'FF9900', 'FF6600', '666699', '969696',
  '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333',
];

interface LooseExcelColor {
  argb?: string;
  theme?: number;
  tint?: number;
  indexed?: number;
}

interface MergeBounds {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export type XlsxContainerIssue = 'encrypted-or-legacy' | 'truncated' | 'invalid';

export interface LoadedUniverWorkbook {
  workbookData: IWorkbookData;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function hasCompleteZipContainer(bytes: Uint8Array): boolean {
  if (bytes.length < ZIP_EOCD_MIN_BYTES) return false;
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
    return false;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minOffset = Math.max(0, bytes.length - (ZIP_EOCD_MIN_BYTES + ZIP_MAX_COMMENT_BYTES));
  for (let offset = bytes.length - ZIP_EOCD_MIN_BYTES; offset >= minOffset; offset -= 1) {
    if (
      bytes[offset] === 0x50 &&
      bytes[offset + 1] === 0x4b &&
      bytes[offset + 2] === 0x05 &&
      bytes[offset + 3] === 0x06
    ) {
      const commentLength = view.getUint16(offset + 20, true);
      if (offset + ZIP_EOCD_MIN_BYTES + commentLength !== bytes.length) continue;
      const cdSize = view.getUint32(offset + 12, true);
      const cdOffset = view.getUint32(offset + 16, true);
      if (cdSize === 0xffffffff || cdOffset === 0xffffffff) return true;
      if (cdOffset + cdSize > offset) return false;
      if (
        cdSize > 0 &&
        (bytes[cdOffset] !== 0x50 ||
          bytes[cdOffset + 1] !== 0x4b ||
          bytes[cdOffset + 2] !== 0x01 ||
          bytes[cdOffset + 3] !== 0x02)
      ) {
        return false;
      }
      return true;
    }
  }
  return false;
}

export function detectXlsxContainerIssue(buffer: ArrayBuffer): XlsxContainerIssue | null {
  const bytes = new Uint8Array(buffer);
  if (
    bytes.length >= 4 &&
    bytes[0] === 0xd0 &&
    bytes[1] === 0xcf &&
    bytes[2] === 0x11 &&
    bytes[3] === 0xe0
  ) {
    return 'encrypted-or-legacy';
  }
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    return hasCompleteZipContainer(bytes) ? null : 'truncated';
  }
  return 'invalid';
}

function applyTint(channel: number, tint: number): number {
  const next = tint > 0 ? channel + (255 - channel) * tint : channel * (1 + tint);
  return Math.round(clamp(next, 0, 255));
}

function resolveExcelColorHex(color: LooseExcelColor | undefined): string | null {
  if (!color) return null;
  let hex: string | null = null;
  if (typeof color.argb === 'string') {
    if (/^[0-9A-Fa-f]{8}$/.test(color.argb)) {
      if (color.argb.slice(0, 2) === '00') return null;
      hex = color.argb.slice(2);
    } else if (/^[0-9A-Fa-f]{6}$/.test(color.argb)) {
      hex = color.argb;
    }
  } else if (typeof color.theme === 'number') {
    hex = THEME_COLORS[color.theme] ?? null;
  } else if (typeof color.indexed === 'number') {
    hex = INDEXED_COLORS[color.indexed] ?? null;
  }
  if (!hex) return null;
  const tint = typeof color.tint === 'number' ? color.tint : 0;
  if (tint !== 0) {
    const r = applyTint(parseInt(hex.slice(0, 2), 16), tint);
    const g = applyTint(parseInt(hex.slice(2, 4), 16), tint);
    const b = applyTint(parseInt(hex.slice(4, 6), 16), tint);
    hex = [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
  }
  return `#${hex.toLowerCase()}`;
}

function hexToArgb(rgb: string | null | undefined): string | undefined {
  if (!rgb) return undefined;
  const trimmed = rgb.trim();
  const hexMatch = /^#?([0-9a-fA-F]{6})$/.exec(trimmed);
  if (hexMatch) return `FF${hexMatch[1]!.toUpperCase()}`;
  const rgbMatch = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(trimmed);
  if (rgbMatch) {
    const toHex2 = (n: string) => clamp(Number(n), 0, 255).toString(16).padStart(2, '0').toUpperCase();
    return `FF${toHex2(rgbMatch[1]!)}${toHex2(rgbMatch[2]!)}${toHex2(rgbMatch[3]!)}`;
  }
  return undefined;
}

function dateToExcelSerial(date: Date): number {
  const ms = date.getTime();
  if (Number.isNaN(ms)) return 0;
  let serial = (ms - EXCEL_EPOCH_UTC_MS) / MS_PER_DAY;
  // Excel 1900 leap-year compatibility: dates before 1900-03-01 sit 1 day lower.
  if (serial < 60) serial -= 1;
  return Number(serial.toFixed(10));
}

function mapExcelBorderStyle(style?: ExcelJS.BorderStyle): BorderStyleTypes {
  switch (style) {
    case 'thin': return BorderStyleTypes.THIN;
    case 'hair': return BorderStyleTypes.HAIR;
    case 'dotted': return BorderStyleTypes.DOTTED;
    case 'dashed': return BorderStyleTypes.DASHED;
    case 'dashDot': return BorderStyleTypes.DASH_DOT;
    case 'dashDotDot': return BorderStyleTypes.DASH_DOT_DOT;
    case 'double': return BorderStyleTypes.DOUBLE;
    case 'medium': return BorderStyleTypes.MEDIUM;
    case 'mediumDashed': return BorderStyleTypes.MEDIUM_DASHED;
    case 'mediumDashDot': return BorderStyleTypes.MEDIUM_DASH_DOT;
    case 'mediumDashDotDot': return BorderStyleTypes.MEDIUM_DASH_DOT_DOT;
    case 'slantDashDot': return BorderStyleTypes.SLANT_DASH_DOT;
    case 'thick': return BorderStyleTypes.THICK;
    default: return BorderStyleTypes.NONE;
  }
}

function mapUniverBorderStyle(style?: BorderStyleTypes): ExcelJS.BorderStyle | undefined {
  switch (style) {
    case BorderStyleTypes.THIN: return 'thin';
    case BorderStyleTypes.HAIR: return 'hair';
    case BorderStyleTypes.DOTTED: return 'dotted';
    case BorderStyleTypes.DASHED: return 'dashed';
    case BorderStyleTypes.DASH_DOT: return 'dashDot';
    case BorderStyleTypes.DASH_DOT_DOT: return 'dashDotDot';
    case BorderStyleTypes.DOUBLE: return 'double';
    case BorderStyleTypes.MEDIUM: return 'medium';
    case BorderStyleTypes.MEDIUM_DASHED: return 'mediumDashed';
    case BorderStyleTypes.MEDIUM_DASH_DOT: return 'mediumDashDot';
    case BorderStyleTypes.MEDIUM_DASH_DOT_DOT: return 'mediumDashDotDot';
    case BorderStyleTypes.SLANT_DASH_DOT: return 'slantDashDot';
    case BorderStyleTypes.THICK: return 'thick';
    default: return undefined;
  }
}

function convertBorderEdge(edge: Partial<ExcelJS.Border> | undefined): IBorderStyleData | undefined {
  if (!edge || !edge.style) return undefined;
  const s = mapExcelBorderStyle(edge.style);
  if (s === BorderStyleTypes.NONE) return undefined;
  const rgb = resolveExcelColorHex(edge.color as LooseExcelColor | undefined) ?? '#d0d7de';
  return { s, cl: { rgb } };
}

function excelStyleToUniverStyle(
  cell: ExcelJS.Cell,
  overrideNumFmt?: string,
): IStyleData | null {
  const style = cell.style;
  const out: IStyleData = {};
  let hasAny = false;

  const font = style?.font;
  if (font) {
    if (font.name) {
      out.ff = font.name;
      hasAny = true;
    }
    if (typeof font.size === 'number' && Number.isFinite(font.size) && font.size > 0) {
      out.fs = clamp(font.size, 5, 128);
      hasAny = true;
    }
    if (font.bold) {
      out.bl = BooleanNumber.TRUE;
      hasAny = true;
    }
    if (font.italic) {
      out.it = BooleanNumber.TRUE;
      hasAny = true;
    }
    if (font.underline && font.underline !== 'none') {
      out.ul = { s: BooleanNumber.TRUE };
      hasAny = true;
    }
    if (font.strike) {
      out.st = { s: BooleanNumber.TRUE };
      hasAny = true;
    }
    const fg = resolveExcelColorHex(font.color as LooseExcelColor | undefined);
    if (fg) {
      out.cl = { rgb: fg };
      hasAny = true;
    }
  }

  const fill = style?.fill;
  if (fill && fill.type === 'pattern' && fill.pattern === 'solid') {
    const bg = resolveExcelColorHex(fill.fgColor as LooseExcelColor | undefined);
    if (bg) {
      out.bg = { rgb: bg };
      hasAny = true;
    }
  }

  const border = style?.border;
  if (border) {
    const bd: IBorderData = {};
    const t = convertBorderEdge(border.top);
    const r = convertBorderEdge(border.right);
    const b = convertBorderEdge(border.bottom);
    const l = convertBorderEdge(border.left);
    if (t) bd.t = t;
    if (r) bd.r = r;
    if (b) bd.b = b;
    if (l) bd.l = l;
    if (t || r || b || l) {
      out.bd = bd;
      hasAny = true;
    }
  }

  const align = style?.alignment;
  if (align) {
    if (align.horizontal === 'left') { out.ht = HorizontalAlign.LEFT; hasAny = true; }
    else if (align.horizontal === 'center') { out.ht = HorizontalAlign.CENTER; hasAny = true; }
    else if (align.horizontal === 'right') { out.ht = HorizontalAlign.RIGHT; hasAny = true; }
    else if (align.horizontal === 'justify') { out.ht = HorizontalAlign.JUSTIFIED; hasAny = true; }
    else if (align.horizontal === 'distributed') { out.ht = HorizontalAlign.DISTRIBUTED; hasAny = true; }

    if (align.vertical === 'top') { out.vt = VerticalAlign.TOP; hasAny = true; }
    else if (align.vertical === 'middle') { out.vt = VerticalAlign.MIDDLE; hasAny = true; }
    else if (align.vertical === 'bottom') { out.vt = VerticalAlign.BOTTOM; hasAny = true; }

    if (align.wrapText) {
      out.tb = WrapStrategy.WRAP;
      hasAny = true;
    }
    if (typeof align.textRotation === 'number' && Number.isFinite(align.textRotation) && align.textRotation !== 0) {
      out.tr = { a: clamp(align.textRotation, -90, 90) };
      hasAny = true;
    } else if (align.textRotation === 'vertical') {
      out.tr = { a: 0, v: BooleanNumber.TRUE };
      hasAny = true;
    }
  }

  const pattern = overrideNumFmt ?? (typeof cell.numFmt === 'string' && cell.numFmt !== '' && cell.numFmt !== 'General'
    ? cell.numFmt
    : undefined);
  if (pattern) {
    out.n = { pattern };
    hasAny = true;
  }

  return hasAny ? out : null;
}

function parseCellAddress(addr: string): { row: number; col: number } | null {
  const match = /^([A-Z]+)(\d+)$/i.exec(addr.trim());
  if (!match) return null;
  const letters = match[1]!.toUpperCase();
  let col = 0;
  for (let i = 0; i < letters.length; i += 1) {
    col = col * 26 + (letters.charCodeAt(i) - 64);
  }
  return { row: parseInt(match[2]!, 10), col };
}

export function columnIndexToLabel(colZeroBased: number): string {
  let value = colZeroBased + 1;
  let label = '';
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label || 'A';
}

export function formatA1Range(range: Pick<IRange, 'startRow' | 'endRow' | 'startColumn' | 'endColumn'>): string {
  const start = `${columnIndexToLabel(range.startColumn)}${range.startRow + 1}`;
  if (range.startRow === range.endRow && range.startColumn === range.endColumn) {
    return start;
  }
  const end = `${columnIndexToLabel(range.endColumn)}${range.endRow + 1}`;
  return `${start}:${end}`;
}

function readMergeBounds(worksheet: ExcelJS.Worksheet): MergeBounds[] {
  const internal = (worksheet as unknown as { _merges?: Record<string, MergeBounds> })._merges;
  if (internal && typeof internal === 'object') {
    return Object.values(internal).filter(
      (m): m is MergeBounds =>
        Boolean(m) &&
        typeof m.top === 'number' &&
        typeof m.left === 'number' &&
        typeof m.bottom === 'number' &&
        typeof m.right === 'number',
    );
  }
  const merges: string[] = (worksheet.model as { merges?: string[] })?.merges ?? [];
  const bounds: MergeBounds[] = [];
  for (const range of merges) {
    const [startAddr, endAddr] = range.split(':');
    if (!startAddr || !endAddr) continue;
    const start = parseCellAddress(startAddr);
    const end = parseCellAddress(endAddr);
    if (!start || !end) continue;
    bounds.push({ top: start.row, left: start.col, bottom: end.row, right: end.col });
  }
  return bounds;
}

function convertCellValueToUniver(
  cell: ExcelJS.Cell,
): { cellData: ICellData | null; impliedNumFmt?: string } {
  const raw = cell.value;
  if (raw === null || raw === undefined) {
    return { cellData: null };
  }
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return { cellData: null };
    return {
      cellData: {
        v: dateToExcelSerial(raw),
        t: CellValueType.NUMBER,
      },
      impliedNumFmt: cell.numFmt && cell.numFmt !== 'General' ? cell.numFmt : 'yyyy-mm-dd',
    };
  }
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return { cellData: { v: String(raw), t: CellValueType.STRING } };
    return { cellData: { v: raw, t: CellValueType.NUMBER } };
  }
  if (typeof raw === 'boolean') {
    return { cellData: { v: raw ? 1 : 0, t: CellValueType.BOOLEAN } };
  }
  if (typeof raw === 'string') {
    const forceStr = cell.numFmt === '@';
    return {
      cellData: {
        v: raw,
        t: forceStr ? CellValueType.FORCE_STRING : CellValueType.STRING,
      },
    };
  }
  if (typeof raw === 'object') {
    if ('formula' in raw || 'sharedFormula' in raw) {
      const formulaVal = raw as ExcelJS.CellFormulaValue & { sharedFormula?: string };
      const effectiveFormula = typeof cell.formula === 'string' && cell.formula !== ''
        ? cell.formula
        : (typeof formulaVal.formula === 'string' ? formulaVal.formula : '');
      const normalizedF = effectiveFormula
        ? (effectiveFormula.startsWith('=') ? effectiveFormula : `=${effectiveFormula}`)
        : undefined;
      const out: ICellData = {};
      if (normalizedF) out.f = normalizedF;
      if (typeof formulaVal.sharedFormula === 'string' && !normalizedF) {
        out.si = formulaVal.sharedFormula;
      }
      const res = formulaVal.result;
      let impliedNumFmt: string | undefined;
      if (res instanceof Date && !Number.isNaN(res.getTime())) {
        out.v = dateToExcelSerial(res);
        out.t = CellValueType.NUMBER;
        impliedNumFmt = cell.numFmt && cell.numFmt !== 'General' ? cell.numFmt : 'yyyy-mm-dd';
      } else if (typeof res === 'number' && Number.isFinite(res)) {
        out.v = res;
        out.t = CellValueType.NUMBER;
      } else if (typeof res === 'boolean') {
        out.v = res ? 1 : 0;
        out.t = CellValueType.BOOLEAN;
      } else if (typeof res === 'string') {
        out.v = res;
        out.t = CellValueType.STRING;
      } else if (res && typeof res === 'object' && 'error' in res) {
        out.v = String(res.error ?? '');
        out.t = CellValueType.STRING;
      }
      return { cellData: Object.keys(out).length > 0 ? out : null, impliedNumFmt };
    }
    if ('richText' in raw && Array.isArray((raw as ExcelJS.CellRichTextValue).richText)) {
      const text = (raw as ExcelJS.CellRichTextValue).richText.map((part) => part.text ?? '').join('');
      return { cellData: { v: text, t: CellValueType.STRING } };
    }
    if ('hyperlink' in raw) {
      const hl = raw as ExcelJS.CellHyperlinkValue;
      const rawText: unknown = hl.text;
      let text = '';
      if (typeof rawText === 'string') text = rawText;
      else if (typeof rawText === 'number') return { cellData: { v: rawText, t: CellValueType.NUMBER } };
      else if (rawText && typeof rawText === 'object' && 'richText' in rawText) {
        text = (rawText as ExcelJS.CellRichTextValue).richText.map((part) => part.text ?? '').join('');
      } else {
        text = String(hl.hyperlink ?? '');
      }
      return { cellData: { v: text, t: CellValueType.STRING } };
    }
    if ('error' in raw) {
      return { cellData: { v: String((raw as ExcelJS.CellErrorValue).error ?? ''), t: CellValueType.STRING } };
    }
  }
  return { cellData: { v: String(raw), t: CellValueType.STRING } };
}

function columnWidthToPx(excelWidth: number): number {
  return Math.round(clamp(excelWidth * 7.5 + 5, 28, 640));
}

function pxToColumnWidth(px: number): number {
  return Number(clamp((px - 5) / 7.5, 2, 120).toFixed(2));
}

function rowHeightPtToPx(pt: number): number {
  return Math.round(clamp((pt * 4) / 3, 16, 540));
}

function rowHeightPxToPt(px: number): number {
  return Number(clamp((px * 3) / 4, 10, 405).toFixed(2));
}

function convertFreeze(worksheet: ExcelJS.Worksheet): IFreeze {
  const view = worksheet.views?.[0];
  if (view && view.state === 'frozen') {
    const xSplit = typeof view.xSplit === 'number' && view.xSplit > 0 ? Math.floor(view.xSplit) : 0;
    const ySplit = typeof view.ySplit === 'number' && view.ySplit > 0 ? Math.floor(view.ySplit) : 0;
    if (xSplit > 0 || ySplit > 0) {
      return {
        xSplit,
        ySplit,
        startRow: ySplit,
        startColumn: xSplit,
      };
    }
  }
  return {
    xSplit: 0,
    ySplit: 0,
    startRow: -1,
    startColumn: -1,
  };
}

/**
 * Parse an `.xlsx` ArrayBuffer into Univer's `IWorkbookData` snapshot.
 */
export async function excelBufferToUniverWorkbook(
  buffer: ArrayBuffer,
  options?: { fileName?: string; locale?: LocaleType; unitId?: string },
): Promise<LoadedUniverWorkbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);

  const styles: Record<string, Nullable<IStyleData>> = {};
  const styleIdByKey = new Map<string, string>();
  const registerStyle = (style: IStyleData | null): string | undefined => {
    if (!style) return undefined;
    const key = JSON.stringify(style);
    const existing = styleIdByKey.get(key);
    if (existing !== undefined) return existing;
    const id = `s${styleIdByKey.size}`;
    styleIdByKey.set(key, id);
    styles[id] = style;
    return id;
  };

  const sheetOrder: string[] = [];
  const sheets: Record<string, Partial<IWorksheetData>> = {};

  wb.eachSheet((worksheet, sheetNumericId) => {
    const sheetId = `sheet_${sheetNumericId}`;
    sheetOrder.push(sheetId);

    const mergeBounds = readMergeBounds(worksheet);
    const coveredNonMaster = new Set<string>();
    const mergeData: IRange[] = [];
    let maxMergeRow = 0;
    let maxMergeCol = 0;

    for (const m of mergeBounds) {
      if (m.bottom < m.top || m.right < m.left) continue;
      maxMergeRow = Math.max(maxMergeRow, m.bottom);
      maxMergeCol = Math.max(maxMergeCol, m.right);
      mergeData.push({
        startRow: m.top - 1,
        endRow: m.bottom - 1,
        startColumn: m.left - 1,
        endColumn: m.right - 1,
      });
      for (let r = m.top; r <= m.bottom; r += 1) {
        for (let c = m.left; c <= m.right; c += 1) {
          if (r === m.top && c === m.left) continue;
          coveredNonMaster.add(`${r}:${c}`);
        }
      }
    }

    const cellData: IObjectMatrixPrimitiveType<ICellData> = {};
    const rowData: IObjectArrayPrimitiveType<Partial<IRowData>> = {};
    const columnData: IObjectArrayPrimitiveType<Partial<IColumnData>> = {};

    const totalCols = Math.max(worksheet.columnCount, maxMergeCol);
    for (let c = 1; c <= totalCols; c += 1) {
      const col = worksheet.getColumn(c);
      const colEntry: Partial<IColumnData> = {};
      let hasColMeta = false;
      if (typeof col.width === 'number' && col.width > 0) {
        colEntry.w = columnWidthToPx(col.width);
        hasColMeta = true;
      }
      if (col.hidden) {
        colEntry.hd = BooleanNumber.TRUE;
        hasColMeta = true;
      }
      if (hasColMeta) {
        columnData[c - 1] = colEntry;
      }
    }

    worksheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      const rIdx = rowNumber - 1;
      const rowEntry: Partial<IRowData> = {};
      let hasRowMeta = false;
      if (typeof row.height === 'number' && row.height > 0) {
        rowEntry.h = rowHeightPtToPx(row.height);
        rowEntry.ia = BooleanNumber.FALSE;
        hasRowMeta = true;
      }
      if (row.hidden) {
        rowEntry.hd = BooleanNumber.TRUE;
        hasRowMeta = true;
      }
      if (hasRowMeta) {
        rowData[rIdx] = rowEntry;
      }

      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        const isCovered = coveredNonMaster.has(`${rowNumber}:${colNumber}`);
        const { cellData: converted, impliedNumFmt } = isCovered
          ? { cellData: null, impliedNumFmt: undefined }
          : convertCellValueToUniver(cell);
        const styleObj = excelStyleToUniverStyle(cell, impliedNumFmt);
        const styleId = registerStyle(styleObj);
        if (!converted && !styleId) return;

        const outCell: ICellData = converted ? { ...converted } : {};
        if (styleId) outCell.s = styleId;
        if (!cellData[rIdx]) cellData[rIdx] = {};
        cellData[rIdx]![colNumber - 1] = outCell;
      });
    });

    const tabColorHex = resolveExcelColorHex(
      (worksheet.properties as { tabColor?: LooseExcelColor } | undefined)?.tabColor,
    ) ?? '';
    const hiddenState = worksheet.state === 'veryHidden'
      ? 2
      : worksheet.state === 'hidden'
        ? BooleanNumber.TRUE
        : BooleanNumber.FALSE;
    const showGridlines = worksheet.views?.[0]?.showGridLines === false
      ? BooleanNumber.FALSE
      : BooleanNumber.TRUE;

    sheets[sheetId] = {
      id: sheetId,
      name: worksheet.name || `Sheet${sheetNumericId}`,
      tabColor: tabColorHex,
      hidden: hiddenState,
      freeze: convertFreeze(worksheet),
      rowCount: Math.max(worksheet.rowCount + DEFAULT_EXTRA_ROWS, maxMergeRow + DEFAULT_EXTRA_ROWS, MIN_SHEET_ROWS),
      columnCount: Math.max(totalCols + DEFAULT_EXTRA_COLS, MIN_SHEET_COLS),
      zoomRatio: 1,
      scrollTop: 0,
      scrollLeft: 0,
      defaultColumnWidth: DEFAULT_COL_WIDTH_PX,
      defaultRowHeight: DEFAULT_ROW_HEIGHT_PX,
      mergeData,
      cellData,
      rowData,
      columnData,
      rowHeader: { width: 46, hidden: BooleanNumber.FALSE },
      columnHeader: { height: 24, hidden: BooleanNumber.FALSE },
      showGridlines,
      rightToLeft: BooleanNumber.FALSE,
      custom: { excelSheetId: sheetNumericId },
    };
  });

  if (sheetOrder.length === 0) {
    const fallbackId = 'sheet_1';
    sheetOrder.push(fallbackId);
    sheets[fallbackId] = {
      id: fallbackId,
      name: 'Sheet1',
      tabColor: '',
      hidden: BooleanNumber.FALSE,
      freeze: { xSplit: 0, ySplit: 0, startRow: -1, startColumn: -1 },
      rowCount: MIN_SHEET_ROWS,
      columnCount: MIN_SHEET_COLS,
      zoomRatio: 1,
      scrollTop: 0,
      scrollLeft: 0,
      defaultColumnWidth: DEFAULT_COL_WIDTH_PX,
      defaultRowHeight: DEFAULT_ROW_HEIGHT_PX,
      mergeData: [],
      cellData: {},
      rowData: {},
      columnData: {},
      rowHeader: { width: 46, hidden: BooleanNumber.FALSE },
      columnHeader: { height: 24, hidden: BooleanNumber.FALSE },
      showGridlines: BooleanNumber.TRUE,
      rightToLeft: BooleanNumber.FALSE,
    };
  }

  const workbookData: IWorkbookData = {
    id: options?.unitId ?? 'dstu-xlsx-workbook',
    name: options?.fileName ?? 'Workbook.xlsx',
    appVersion: '1.6.2',
    locale: options?.locale ?? LocaleType.ZH_CN,
    styles,
    sheetOrder,
    sheets,
  };

  return { workbookData };
}

/** Extract plain text or primitive value from a Univer cell (including multiline `p.body.dataStream`). */
export function extractUniverCellPlainText(cell: Nullable<ICellData>): string {
  if (!cell) return '';
  const richDoc = cell.p ?? undefined;
  if (richDoc && richDoc.body?.dataStream) {
    return richDoc.body.dataStream.replace(/\r\n$/, '');
  }
  if (cell.v === null || cell.v === undefined) return '';
  if (cell.t === CellValueType.BOOLEAN) {
    return cell.v === true || cell.v === 1 || cell.v === '1' ? 'TRUE' : 'FALSE';
  }
  return String(cell.v);
}

function resolveStyleObject(
  styleRef: Nullable<IStyleData | string> | undefined,
  stylesMap: Record<string, Nullable<IStyleData>>,
): IStyleData | null {
  if (!styleRef) return null;
  if (typeof styleRef === 'string') return (stylesMap[styleRef] || null) as IStyleData | null;
  return styleRef;
}

function applyUniverStyleToExcelCell(target: ExcelJS.Cell, style: IStyleData | null): void {
  if (!style) return;

  const font: Partial<ExcelJS.Font> = {};
  let hasFont = false;
  if (style.ff) { font.name = style.ff; hasFont = true; }
  if (typeof style.fs === 'number' && style.fs > 0) { font.size = style.fs; hasFont = true; }
  if (style.bl === BooleanNumber.TRUE) { font.bold = true; hasFont = true; }
  if (style.it === BooleanNumber.TRUE) { font.italic = true; hasFont = true; }
  if (style.ul?.s === BooleanNumber.TRUE) { font.underline = true; hasFont = true; }
  if (style.st?.s === BooleanNumber.TRUE) { font.strike = true; hasFont = true; }
  const fontColor = style.cl || undefined;
  const fontArgb = hexToArgb(fontColor?.rgb || undefined);
  if (fontArgb) { font.color = { argb: fontArgb }; hasFont = true; }
  if (hasFont) target.font = { ...(target.font ?? {}), ...font };

  const fillColor = style.bg || undefined;
  const fillArgb = hexToArgb(fillColor?.rgb || undefined);
  if (fillArgb) {
    target.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: fillArgb },
    };
  }

  if (style.bd) {
    const borders: Partial<ExcelJS.Borders> = {};
    let hasBorder = false;
    const toEdge = (edge: Nullable<IBorderStyleData> | undefined): Partial<ExcelJS.Border> | undefined => {
      if (!edge) return undefined;
      const mapped = mapUniverBorderStyle(edge.s);
      if (!mapped) return undefined;
      const edgeColor = edge.cl || undefined;
      const argb = hexToArgb(edgeColor?.rgb || undefined);
      return argb ? { style: mapped, color: { argb } } : { style: mapped };
    };
    const top = toEdge(style.bd.t);
    const right = toEdge(style.bd.r);
    const bottom = toEdge(style.bd.b);
    const left = toEdge(style.bd.l);
    if (top) { borders.top = top; hasBorder = true; }
    if (right) { borders.right = right; hasBorder = true; }
    if (bottom) { borders.bottom = bottom; hasBorder = true; }
    if (left) { borders.left = left; hasBorder = true; }
    if (hasBorder) target.border = { ...(target.border ?? {}), ...borders };
  }

  const alignment: Partial<ExcelJS.Alignment> = {};
  let hasAlign = false;
  if (style.ht === HorizontalAlign.LEFT) { alignment.horizontal = 'left'; hasAlign = true; }
  else if (style.ht === HorizontalAlign.CENTER) { alignment.horizontal = 'center'; hasAlign = true; }
  else if (style.ht === HorizontalAlign.RIGHT) { alignment.horizontal = 'right'; hasAlign = true; }
  else if (style.ht === HorizontalAlign.JUSTIFIED) { alignment.horizontal = 'justify'; hasAlign = true; }
  else if (style.ht === HorizontalAlign.DISTRIBUTED) { alignment.horizontal = 'distributed'; hasAlign = true; }

  if (style.vt === VerticalAlign.TOP) { alignment.vertical = 'top'; hasAlign = true; }
  else if (style.vt === VerticalAlign.MIDDLE) { alignment.vertical = 'middle'; hasAlign = true; }
  else if (style.vt === VerticalAlign.BOTTOM) { alignment.vertical = 'bottom'; hasAlign = true; }

  if (style.tb === WrapStrategy.WRAP) { alignment.wrapText = true; hasAlign = true; }
  if (style.tr) {
    if (style.tr.v === BooleanNumber.TRUE) { alignment.textRotation = 'vertical'; hasAlign = true; }
    else if (typeof style.tr.a === 'number' && style.tr.a !== 0) { alignment.textRotation = style.tr.a; hasAlign = true; }
  }
  if (hasAlign) target.alignment = { ...(target.alignment ?? {}), ...alignment };

  const numFmt = style.n || undefined;
  if (numFmt?.pattern) {
    target.numFmt = numFmt.pattern;
  }
}

function uniqueExcelSheetName(desired: string, used: Set<string>, index: number): string {
  const sanitized = (desired || `Sheet${index + 1}`)
    .replace(/[\\/?*[\]:]/g, '_')
    .slice(0, 31)
    .trim() || `Sheet${index + 1}`;
  if (!used.has(sanitized.toLowerCase())) {
    used.add(sanitized.toLowerCase());
    return sanitized;
  }
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const tail = `_${suffix}`;
    const candidate = `${sanitized.slice(0, 31 - tail.length)}${tail}`;
    if (!used.has(candidate.toLowerCase())) {
      used.add(candidate.toLowerCase());
      return candidate;
    }
  }
  return `Sheet_${index + 1}`;
}

/**
 * Serialize a Univer `IWorkbookData` snapshot back into a valid `.xlsx` `Uint8Array`.
 * When `baselineBuffer` is provided, workbook-level metadata (creator, properties, etc.) is preserved.
 */
export async function univerWorkbookToExcelBytes(
  snapshot: IWorkbookData,
  baselineBuffer?: ArrayBuffer,
): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  if (baselineBuffer) {
    try {
      const baselineWb = new ExcelJS.Workbook();
      await baselineWb.xlsx.load(baselineBuffer);
      wb.creator = baselineWb.creator;
      wb.lastModifiedBy = baselineWb.lastModifiedBy;
      wb.created = baselineWb.created;
      wb.modified = new Date();
      wb.properties = baselineWb.properties;
    } catch {
      // Baseline metadata is optional; proceed with clean workbook if unavailable.
    }
  }

  const stylesMap = snapshot.styles ?? {};
  const usedNames = new Set<string>();
  const orderedIds = snapshot.sheetOrder?.length
    ? snapshot.sheetOrder
    : Object.keys(snapshot.sheets ?? {});

  orderedIds.forEach((sheetId, index) => {
    const sheetSnap = snapshot.sheets?.[sheetId];
    if (!sheetSnap) return;

    const sheetName = uniqueExcelSheetName(sheetSnap.name ?? `Sheet${index + 1}`, usedNames, index);
    const tabArgb = hexToArgb(sheetSnap.tabColor);
    const hidden = sheetSnap.hidden === 2
      ? 'veryHidden'
      : sheetSnap.hidden === BooleanNumber.TRUE
        ? 'hidden'
        : 'visible';

    const ws = wb.addWorksheet(sheetName, {
      state: hidden,
      properties: tabArgb ? { tabColor: { argb: tabArgb } } : undefined,
    });

    const freeze = sheetSnap.freeze;
    const showGridLines = sheetSnap.showGridlines !== BooleanNumber.FALSE;
    if (freeze && (freeze.xSplit > 0 || freeze.ySplit > 0)) {
      ws.views = [{
        state: 'frozen',
        xSplit: Math.max(0, freeze.xSplit),
        ySplit: Math.max(0, freeze.ySplit),
        showGridLines,
      }];
    } else if (!showGridLines) {
      ws.views = [{ state: 'normal', showGridLines: false }];
    }

    if (sheetSnap.columnData) {
      for (const [colKey, colMeta] of Object.entries(sheetSnap.columnData)) {
        const cIdx = Number(colKey);
        if (!Number.isInteger(cIdx) || cIdx < 0 || !colMeta) continue;
        const excelCol = ws.getColumn(cIdx + 1);
        if (typeof colMeta.w === 'number' && colMeta.w > 0) {
          excelCol.width = pxToColumnWidth(colMeta.w);
        }
        if (colMeta.hd === BooleanNumber.TRUE) {
          excelCol.hidden = true;
        }
      }
    }

    if (sheetSnap.rowData) {
      for (const [rowKey, rowMeta] of Object.entries(sheetSnap.rowData)) {
        const rIdx = Number(rowKey);
        if (!Number.isInteger(rIdx) || rIdx < 0 || !rowMeta) continue;
        const excelRow = ws.getRow(rIdx + 1);
        if (typeof rowMeta.h === 'number' && rowMeta.h > 0 && rowMeta.ia === BooleanNumber.FALSE) {
          excelRow.height = rowHeightPxToPt(rowMeta.h);
        }
        if (rowMeta.hd === BooleanNumber.TRUE) {
          excelRow.hidden = true;
        }
      }
    }

    const cellMatrix = sheetSnap.cellData ?? {};
    for (const [rowKey, rowCells] of Object.entries(cellMatrix)) {
      const rIdx = Number(rowKey);
      if (!Number.isInteger(rIdx) || rIdx < 0 || !rowCells) continue;
      const excelRow = ws.getRow(rIdx + 1);

      for (const [colKey, rawCellData] of Object.entries(rowCells as Record<string, Nullable<ICellData>>)) {
        const cIdx = Number(colKey);
        const cellData = rawCellData || undefined;
        if (!Number.isInteger(cIdx) || cIdx < 0 || !cellData) continue;
        const excelCell = excelRow.getCell(cIdx + 1);

        const rawFormula = typeof cellData.f === 'string' && cellData.f.trim() !== ''
          ? cellData.f.trim().replace(/^=/, '')
          : null;
        const richCellDoc = cellData.p || undefined;

        if (rawFormula) {
          let cachedResult: string | number | boolean | undefined;
          if (typeof cellData.v === 'number' || typeof cellData.v === 'string') {
            cachedResult = cellData.v;
          } else if (typeof cellData.v === 'boolean') {
            cachedResult = cellData.v;
          } else if (cellData.t === CellValueType.BOOLEAN && cellData.v !== null && cellData.v !== undefined) {
            cachedResult = Number(cellData.v) !== 0;
          }
          excelCell.value = cachedResult !== undefined
            ? { formula: rawFormula, result: cachedResult }
            : { formula: rawFormula };
        } else if (richCellDoc?.body?.dataStream) {
          excelCell.value = richCellDoc.body.dataStream.replace(/\r\n$/, '');
        } else if (cellData.v !== null && cellData.v !== undefined) {
          if (cellData.t === CellValueType.BOOLEAN) {
            excelCell.value = cellData.v === true || cellData.v === 1 || cellData.v === '1';
          } else if (cellData.t === CellValueType.NUMBER && typeof cellData.v !== 'number') {
            const parsed = Number(cellData.v);
            excelCell.value = Number.isFinite(parsed) ? parsed : String(cellData.v);
          } else if (cellData.t === CellValueType.FORCE_STRING) {
            excelCell.value = String(cellData.v);
            excelCell.numFmt = '@';
          } else {
            excelCell.value = cellData.v as ExcelJS.CellValue;
          }
        }

        const resolvedStyle = resolveStyleObject(cellData.s, stylesMap);
        applyUniverStyleToExcelCell(excelCell, resolvedStyle);
      }
    }

    if (Array.isArray(sheetSnap.mergeData)) {
      for (const m of sheetSnap.mergeData) {
        if (
          m.endRow < m.startRow ||
          m.endColumn < m.startColumn ||
          (m.endRow === m.startRow && m.endColumn === m.startColumn)
        ) {
          continue;
        }
        try {
          ws.mergeCells(m.startRow + 1, m.startColumn + 1, m.endRow + 1, m.endColumn + 1);
        } catch {
          // Ignore overlapping/invalid merge ranges rather than failing workbook save.
        }
      }
    }
  });

  if (wb.worksheets.length === 0) {
    wb.addWorksheet('Sheet1');
  }

  const outBuffer = await wb.xlsx.writeBuffer();
  return outBuffer instanceof Uint8Array
    ? outBuffer
    : new Uint8Array(outBuffer as ArrayBuffer);
}
