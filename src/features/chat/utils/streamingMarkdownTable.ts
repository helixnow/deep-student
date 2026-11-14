/**
 * 流式 Markdown 表格渐进渲染与零抖动列宽冻结器
 *
 * 核心能力：
 * 1. 完整行渐进过滤（filterStreamingTableRows）：仅保留单元格数与表头列数对齐的完整行，
 *    流式期间额外剔除全空白占坑行；残缺行不参与数值列右对齐判定（detectNumericColumns）。
 * 2. 首帧列宽估算与冻结器（estimateFrozenColumnWidthsPx / StreamingColumnWidthFreezer）：
 *    按表头 + 首帧前 3 行完整数据估算像素列宽（CJK/全角按 2 单位，ASCII 按 1 单位，
 *    下限 64px、上限 320px），流式期间冻结不重算，流式结束后释放回自动布局。
 * 3. 多列 6 行预览窗与单列全露折叠判定（computeTableCollapseState）：
 *    单列表格（colCount === 1）始终全露不折叠；多列表格流式期只露前 6 行并展示不可点进度态，
 *    流式结束后平滑切换为「展开全部 · N 行」。
 * 4. Markdown 与 RFC 4180 CSV 序列化器（tableToMarkdown / tableToCsv）。
 */

export type TableAlign = 'left' | 'center' | 'right' | null;

export interface StreamingTableRow {
  cells: string[];
  aligns?: TableAlign[];
  id?: string;
}

export type TableRowInput = StreamingTableRow | string[];

/** 折叠前默认露出的数据行数（含表头共 7 行） */
export const TABLE_PREVIEW_ROW_LIMIT = 6;

/** 流式首帧列宽估算采样的数据行数上限 */
export const FROZEN_WIDTH_SAMPLE_ROWS = 3;

/** 列宽像素下限与上限 */
export const MIN_COLUMN_WIDTH_PX = 64;
export const MAX_COLUMN_WIDTH_PX = 320;

const CJK_OR_FULLWIDTH_PATTERN =
  /[\u1100-\u115f\u2e80-\u303e\u3040-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/;

const NUMERIC_CELL_PATTERN =
  /^[+-]?[¥$€]?\d[\d,]*(?:\.\d+)?\s?(?:%|[A-Za-z]{1,3}|[万千百亿元人份个次秒分]|毫秒)?$/;

const NEUTRAL_CELL_PATTERN = /^[\s—–-]*$/;

function extractCells(row: TableRowInput): string[] {
  return Array.isArray(row) ? row : row.cells;
}

/**
 * 视觉字符宽度估算：CJK 与全角字符按 2 单位宽度计，ASCII 与其余半角字符按 1 单位宽度计。
 */
export function visualLength(text: string): number {
  let units = 0;
  for (const ch of text) {
    units += CJK_OR_FULLWIDTH_PATTERN.test(ch) ? 2 : 1;
  }
  return units;
}

/**
 * 完整行渐进过滤器：
 * - 仅保留 `row.cells.length === headers.length` 的完整对齐行（少一格的半截行整行不挂载，等 `|` 补齐再出现）；
 * - 流式期间（`isStreaming === true`）额外剔除「所有单元格均为空白」的占坑行。
 */
export function filterStreamingTableRows<T extends TableRowInput>(
  headers: readonly string[],
  rows: readonly T[],
  isStreaming: boolean,
): T[] {
  const colCount = headers.length;
  if (colCount === 0) return [];

  return rows.filter((row) => {
    const cells = extractCells(row);
    if (cells.length !== colCount) {
      return false;
    }
    if (isStreaming) {
      const allBlank = cells.every((cell) => cell.trim().length === 0);
      if (allBlank) {
        return false;
      }
    }
    return true;
  });
}

/**
 * 数值列右对齐判定器：
 * - 行列数不齐的残缺行绝不参与数值列判定，避免整列对齐在流式期间左右跳变；
 * - 显式指定了对齐方式（`explicitAligns[j] != null`）的列保持作者意图，不覆盖；
 * - 空单元格与破折号（`—` / `-`）视为中立，其余非空单元格必须全部匹配数值格式。
 */
export function detectNumericColumns(
  headers: readonly string[],
  rows: readonly TableRowInput[],
  explicitAligns?: readonly TableAlign[],
): Set<number> {
  const result = new Set<number>();
  const colCount = headers.length;
  if (colCount === 0) return result;

  // 只纳入与表头列数严格对齐的完整行，排除残缺半行与全空占坑行
  const completeRows = rows
    .map((row) => ({
      cells: extractCells(row),
      aligns: Array.isArray(row) ? undefined : row.aligns,
    }))
    .filter(
      ({ cells }) =>
        cells.length === colCount && cells.some((cell) => cell.trim().length > 0),
    );

  if (completeRows.length === 0) return result;

  for (let colIdx = 0; colIdx < colCount; colIdx += 1) {
    const headerAlign = explicitAligns?.[colIdx] ?? null;
    const hasRowExplicitAlign = completeRows.some(
      (row) => row.aligns?.[colIdx] != null,
    );
    if (headerAlign !== null || hasRowExplicitAlign) {
      continue;
    }

    const nonNeutralTexts = completeRows
      .map((row) => (row.cells[colIdx] ?? '').trim())
      .filter((text) => !NEUTRAL_CELL_PATTERN.test(text));

    if (nonNeutralTexts.length === 0) {
      continue;
    }

    if (nonNeutralTexts.every((text) => NUMERIC_CELL_PATTERN.test(text))) {
      result.add(colIdx);
    }
  }

  return result;
}

/**
 * 首帧列宽估算器：
 * 按表头 + 首帧已完整的前 3 行估算每列像素宽度（CJK 与全角字符按 2 单位计，ASCII 按 1 单位计），
 * 每列下限 64px（防止窄屏把两字表头压成竖排），长文本列上限 320px。
 */
export function estimateFrozenColumnWidthsPx(
  headers: readonly string[],
  firstCompleteRows: readonly TableRowInput[],
): number[] {
  const colCount = headers.length;
  if (colCount === 0) return [];

  const CHAR_UNIT_PX = 7.5;
  const CELL_PADDING_PX = 24;

  const sampledRows = firstCompleteRows
    .map(extractCells)
    .filter((cells) => cells.length === colCount)
    .slice(0, FROZEN_WIDTH_SAMPLE_ROWS);

  return headers.map((header, colIdx) => {
    let maxVisualUnits = visualLength(header);
    for (const row of sampledRows) {
      maxVisualUnits = Math.max(maxVisualUnits, visualLength(row[colIdx] ?? ''));
    }
    const rawPx = maxVisualUnits * CHAR_UNIT_PX + CELL_PADDING_PX;
    return Math.round(
      Math.max(MIN_COLUMN_WIDTH_PX, Math.min(rawPx, MAX_COLUMN_WIDTH_PX)),
    );
  });
}

/**
 * 流式列宽冻结器状态管理：
 * 一旦流式首帧算出列宽即冻结，后续新行到来绝不重算；
 * 流式结束（`isStreaming === false`）时立即释放回自动布局（返回 `null`）。
 */
export class StreamingColumnWidthFreezer {
  private frozenSignature: string | null = null;
  private frozenWidths: number[] | null = null;

  public resolveColumnWidths(
    headers: readonly string[],
    completeRows: readonly TableRowInput[],
    isStreaming: boolean,
  ): number[] | null {
    if (!isStreaming || headers.length === 0) {
      this.frozenSignature = null;
      this.frozenWidths = null;
      return null;
    }

    const signature = `${headers.length}:${headers.join('\u0000')}`;
    if (this.frozenWidths === null || this.frozenSignature !== signature) {
      this.frozenSignature = signature;
      this.frozenWidths = estimateFrozenColumnWidthsPx(headers, completeRows);
    }

    return [...this.frozenWidths];
  }

  public isFrozen(): boolean {
    return this.frozenWidths !== null;
  }

  public reset(): void {
    this.frozenSignature = null;
    this.frozenWidths = null;
  }
}

export interface TableCollapseState {
  /** 是否需要纵向折叠（单列表格永不折叠，多列表格超出 6 行时折叠） */
  needsVerticalCollapse: boolean;
  /** 是否属于长表或宽表（决定流式结束后是否展示底部工具栏） */
  isLongTable: boolean;
  /** 当前应渲染的可见行数 */
  visibleRowCount: number;
  /** 被折叠隐藏的行数 */
  hiddenRowCount: number;
  /** 流式期间第 7 行起是否显示不可点击的生成提示态 */
  showStreamingProgressHint: boolean;
  /** 流式期间生成提示文案 */
  streamingProgressText: string | null;
  /** 流式结束后是否显示展开/收起按钮 */
  showExpandButton: boolean;
  /** 流式结束后展开按钮文案（如「展开全部 · 15 行」或「收起」） */
  expandButtonText: string | null;
  /** 是否展示底部复制与展开工具行 */
  showToolbar: boolean;
  /** 是否在表格底部显示渐变遮罩 */
  showBottomFadeMask: boolean;
}

/**
 * 多列 6 行预览窗 vs 单列全露折叠判定器：
 * - `needsVerticalCollapse = colCount > 1 && completeRowCount > 6`
 *   （单列表格 `colCount === 1` 像清单，流式与结束后均全部露出且永不折叠）；
 * - 多列表格在流式期固定只露前 6 行，第 7 行起显示不可点的生成提示态，
 *   流式结束后平滑切换为「展开全部 · N 行」，消除「流式画满 50 行、结束瞬间塌缩回 6 行」的布局跳变。
 */
export function computeTableCollapseState(
  colCount: number,
  completeRowCount: number,
  isStreaming: boolean,
  isHorizontallyOverflowing: boolean,
  isExpanded = false,
): TableCollapseState {
  const safeRowCount = Math.max(0, completeRowCount);
  const canPreviewCollapse = colCount > 1;
  const needsVerticalCollapse =
    canPreviewCollapse && safeRowCount > TABLE_PREVIEW_ROW_LIMIT;

  const shouldClipRows =
    canPreviewCollapse &&
    safeRowCount > TABLE_PREVIEW_ROW_LIMIT &&
    (isStreaming || !isExpanded);

  const visibleRowCount = shouldClipRows
    ? TABLE_PREVIEW_ROW_LIMIT
    : safeRowCount;
  const hiddenRowCount = Math.max(0, safeRowCount - visibleRowCount);

  const showStreamingProgressHint =
    isStreaming && canPreviewCollapse && safeRowCount > TABLE_PREVIEW_ROW_LIMIT;
  const streamingProgressText = showStreamingProgressHint
    ? '正在生成更多行…'
    : null;

  const isLongTable =
    needsVerticalCollapse || (!isStreaming && isHorizontallyOverflowing);
  const showToolbar = !isStreaming && safeRowCount > 0 && isLongTable;
  const showExpandButton = !isStreaming && needsVerticalCollapse;
  const expandButtonText = showExpandButton
    ? isExpanded
      ? '收起'
      : `展开全部 · ${safeRowCount} 行`
    : null;

  const showBottomFadeMask =
    !isStreaming && needsVerticalCollapse && !isExpanded;

  return {
    needsVerticalCollapse,
    isLongTable,
    visibleRowCount,
    hiddenRowCount,
    showStreamingProgressHint,
    streamingProgressText,
    showExpandButton,
    expandButtonText,
    showToolbar,
    showBottomFadeMask,
  };
}

function normalizeCellText(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim();
}

/**
 * Markdown 表格单元格转义：
 * 严格按「先转义反斜杠 `\\` -> 再转义管道符 `\|` -> 最后将换行替换为 `<br>`」顺序执行。
 */
export function escapeMarkdownCell(value: string): string {
  return normalizeCellText(value)
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\n+/g, '<br>');
}

function normalizeRowToWidth(
  cells: readonly string[],
  width: number,
): string[] {
  const normalized = cells.slice(0, width);
  while (normalized.length < width) {
    normalized.push('');
  }
  return normalized;
}

/**
 * 生成可直接粘贴回 Markdown 的表格文本。
 */
export function tableToMarkdown(
  headers: readonly string[],
  rows: readonly TableRowInput[],
  aligns?: readonly TableAlign[],
  options?: { serializedCells?: boolean },
): string {
  const width = headers.length;
  if (width === 0) return '';

  const formatCell = options?.serializedCells
    ? (value: string) => value
    : escapeMarkdownCell;

  const formatLine = (cells: readonly string[]) =>
    `| ${normalizeRowToWidth(cells, width).map(formatCell).join(' | ')} |`;

  const separator = headers.map((_, colIdx) => {
    const align = aligns?.[colIdx] ?? null;
    if (align === 'left') return ':---';
    if (align === 'center') return ':---:';
    if (align === 'right') return '---:';
    return '---';
  });

  return [
    formatLine(headers),
    formatLine(separator),
    ...rows.map((row) => formatLine(extractCells(row))),
  ].join('\n');
}

function formatCsvCell(value: string): string {
  const normalized = value.replace(/\r\n?/g, '\n');
  if (/[",\n]/.test(normalized)) {
    return `"${normalized.replace(/"/g, '""')}"`;
  }
  return normalized;
}

/**
 * 遵循 RFC 4180 的 CSV 序列化器：
 * 含逗号、双引号或换行的单元格外包双引号并将内部双引号翻倍 `""`，行尾统一使用 CRLF (`\r\n`)。
 */
export function tableToCsv(
  headers: readonly string[],
  rows: readonly TableRowInput[],
): string {
  const width = headers.length;
  if (width === 0) return '';

  const allRows: readonly (readonly string[])[] = [
    headers,
    ...rows.map(extractCells),
  ];

  return allRows
    .map((cells) =>
      normalizeRowToWidth(cells, width).map(formatCsvCell).join(','),
    )
    .join('\r\n');
}
