/**
 * XLSX 表格预览组件
 * 使用 ExcelJS 库解析和显示 Excel 文件（替换了存在 CVE 的 SheetJS xlsx@0.18.5）
 *
 * 工具栏已移至 FileContentView 统一管理
 * 本组件保留底部 Sheet 导航栏
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ExcelJS from 'exceljs';
import DOMPurify from 'dompurify';
import { CircleNotch, CaretLeft, CaretRight } from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import {
  normalizeBase64,
  decodeBase64ToArrayBuffer,
  waitForNextFrame,
} from './previewUtils';

/**
 * 使用 DOMPurify 消毒生成的 HTML
 * 仅允许表格相关的安全标签和属性，移除 javascript: 链接等 XSS 向量
 */
function sanitizeXlsxHtml(rawHtml: string): string {
  return DOMPurify.sanitize(rawHtml, {
    ALLOWED_TAGS: [
      'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
      'colgroup', 'col', 'caption', 'span', 'br', 'b', 'i', 'em', 'strong', 'sub', 'sup',
    ],
    ALLOWED_ATTR: ['class', 'style', 'colspan', 'rowspan', 'id', 'data-xlsx-cell', 'data-xlsx-sheet'],
    ALLOW_DATA_ATTR: false,
  }) as string;
}

/** 将 ExcelJS 单元格值安全地转为字符串 */
function cellToString(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v == null) return '';
  if (v instanceof Date) {
    return v.toLocaleDateString();
  }
  if (typeof v === 'object') {
    if ('richText' in v) {
      return (v as ExcelJS.CellRichTextValue).richText.map((rt) => rt.text).join('');
    }
    if ('error' in v) {
      return String((v as ExcelJS.CellErrorValue).error ?? '');
    }
    if ('result' in v) {
      // 公式单元格：取 result（result 本身也可能是日期或错误对象）
      const r = (v as ExcelJS.CellFormulaValue).result;
      if (r == null) return '';
      if (r instanceof Date) return r.toLocaleDateString();
      if (typeof r === 'object' && 'error' in r) return String(r.error ?? '');
      return String(r);
    }
    if ('hyperlink' in v) {
      const text = (v as ExcelJS.CellHyperlinkValue).text;
      return typeof text === 'string' ? text : String((v as ExcelJS.CellHyperlinkValue).hyperlink ?? '');
    }
  }
  return String(v);
}

/** 渲染行数上限（超大表格截断展示，避免一次性渲染数十万 DOM 节点卡死页面） */
const MAX_RENDER_ROWS = 1000;
/** 渲染列数上限（异常宽表可能声明数千列，同样需要截断） */
const MAX_RENDER_COLS = 256;

/**
 * 检查解码后的二进制是否为合法的 OOXML（ZIP）容器。
 * OLE 复合文档头（D0 CF 11 E0）意味着文件被密码保护（加密 OOXML 的外层包装）
 * 或是旧版二进制格式（.xls），两者都无法用当前解析器预览。
 */
function detectContainerIssue(buffer: ArrayBuffer): 'encrypted-or-legacy' | 'invalid' | null {
  const bytes = new Uint8Array(buffer);
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) return null;
  if (bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    return 'encrypted-or-legacy';
  }
  return 'invalid';
}

interface CachedWorkbook {
  workbook: ExcelJS.Workbook;
  /** 已转换 Sheet 的 HTML 缓存（索引 → SheetData） */
  sheets: Map<number, SheetData>;
}

/**
 * 模块级解析结果缓存（LRU，容量 2）：
 * 用户在同一会话中切走再切回同一文件（组件被卸载重建）时避免整本重新解析。
 * 使用紧凑内容指纹作为键，避免组件卸载后缓存继续持有几十 MB 的 Base64 字符串。
 */
const workbookCache = new Map<string, CachedWorkbook>();
const WORKBOOK_CACHE_MAX = 2;

function workbookCacheKey(content: string): string {
  let hash = 2166136261;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${content.length}:${(hash >>> 0).toString(16)}:${content.slice(0, 16)}:${content.slice(-16)}`;
}

function getCachedWorkbook(key: string): CachedWorkbook | null {
  const hit = workbookCache.get(key);
  if (!hit) return null;
  // LRU：命中后移到末尾
  workbookCache.delete(key);
  workbookCache.set(key, hit);
  return hit;
}

function setCachedWorkbook(key: string, value: CachedWorkbook): void {
  workbookCache.delete(key);
  workbookCache.set(key, value);
  while (workbookCache.size > WORKBOOK_CACHE_MAX) {
    const oldest = workbookCache.keys().next().value;
    if (oldest === undefined) break;
    workbookCache.delete(oldest);
  }
}

/** 解析 A1 格式单元格地址为 {row, col}（1-based） */
function parseCellAddress(addr: string): { row: number; col: number } | null {
  const match = /^([A-Z]+)(\d+)$/i.exec(addr.trim());
  if (!match) return null;
  const letters = match[1].toUpperCase();
  let col = 0;
  for (let i = 0; i < letters.length; i++) {
    col = col * 26 + (letters.charCodeAt(i) - 64);
  }
  return { row: parseInt(match[2], 10), col };
}

function columnLabel(col: number): string {
  let value = col;
  let label = '';
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

interface MergeMaps {
  /** 主单元格 "row:col" → 跨度 */
  masters: Map<string, { rowspan: number; colspan: number }>;
  /** 被合并覆盖（需跳过渲染）的单元格 "row:col" */
  covered: Set<string>;
}

/**
 * ★ 2026-06-12（审阅问题 M4）：从 worksheet 的合并区间构建 rowspan/colspan 映射。
 * 旧实现的 mergeAttr 永远为空数组（注释自承"跳过"），合并单元格全部错位。
 */
function buildMergeMaps(worksheet: ExcelJS.Worksheet): MergeMaps {
  const masters = new Map<string, { rowspan: number; colspan: number }>();
  const covered = new Set<string>();

  // ExcelJS 在 model.merges 中以 "A1:B2" 字符串数组暴露合并区间
  const merges: string[] = (worksheet.model as { merges?: string[] })?.merges ?? [];

  for (const range of merges) {
    const [startAddr, endAddr] = range.split(':');
    if (!startAddr || !endAddr) continue;
    const start = parseCellAddress(startAddr);
    const end = parseCellAddress(endAddr);
    if (!start || !end) continue;

    const rowspan = end.row - start.row + 1;
    const colspan = end.col - start.col + 1;
    if (rowspan <= 1 && colspan <= 1) continue;

    masters.set(`${start.row}:${start.col}`, { rowspan, colspan });
    for (let r = start.row; r <= end.row; r++) {
      for (let c = start.col; c <= end.col; c++) {
        if (r === start.row && c === start.col) continue;
        covered.add(`${r}:${c}`);
      }
    }
  }

  return { masters, covered };
}

/** HTML 转义（含引号：sheetName 会进入属性值上下文） */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 将 ExcelJS worksheet 转为 HTML table 字符串 */
function worksheetToHtml(
  worksheet: ExcelJS.Worksheet,
  sheetName: string
): { html: string; truncatedRows: number; truncatedCols: number } {
  const { masters, covered } = buildMergeMaps(worksheet);

  const totalRows = worksheet.actualRowCount;
  const totalCols = worksheet.actualColumnCount;
  const renderRows = Math.min(totalRows, MAX_RENDER_ROWS);
  const renderCols = Math.min(totalCols, MAX_RENDER_COLS);

  const rows: string[] = [];
  // id 仅允许安全字符，避免工作表名中的空格/引号产生非法 HTML id
  const safeSheetId = sheetName.replace(/[^\w-]/g, '_');
  rows.push(`<table id="xlsx-sheet-${safeSheetId}" data-xlsx-sheet="${escapeHtml(sheetName)}">`);
  rows.push('<thead><tr><th class="xlsx-corner"></th>');
  for (let c = 1; c <= renderCols; c++) {
    rows.push(`<th class="xlsx-column-header">${columnLabel(c)}</th>`);
  }
  rows.push('</tr></thead><tbody>');

  // 按固定网格遍历（行/列均含空白），保证合并跨度与列对齐正确
  for (let r = 1; r <= renderRows; r++) {
    const row = worksheet.getRow(r);
    const cells: string[] = [`<th class="xlsx-row-header">${r}</th>`];

    for (let c = 1; c <= renderCols; c++) {
      const key = `${r}:${c}`;
      if (covered.has(key)) continue;

      const cell = row.getCell(c);
      const escaped = escapeHtml(cellToString(cell));

      const span = masters.get(key);
      const spanAttr = span
        ? `${span.colspan > 1 ? ` colspan="${span.colspan}"` : ''}${span.rowspan > 1 ? ` rowspan="${span.rowspan}"` : ''}`
        : '';
      cells.push(`<td data-xlsx-cell="${columnLabel(c)}${r}"${spanAttr}>${escaped}</td>`);
    }
    rows.push(`<tr>${cells.join('')}</tr>`);
  }

  rows.push('</tbody></table>');
  return {
    html: rows.join(''),
    truncatedRows: Math.max(0, totalRows - renderRows),
    truncatedCols: Math.max(0, totalCols - renderCols),
  };
}

interface XlsxPreviewProps {
  /** Base64 编码的 XLSX 文件内容 */
  base64Content: string;
  /** 文件名 */
  fileName: string;
  /** 自定义类名 */
  className?: string;
  /** 外部控制：缩放比例（由 FileContentView 管理） */
  zoomScale?: number;
  /** 外部控制：字号比例（由 FileContentView 管理） */
  fontScale?: number;
}

interface SheetData {
  name: string;
  html: string;
  /** 因超大表格被截断未渲染的行数（0 表示完整渲染） */
  truncatedRows: number;
  /** 因超宽表格被截断未渲染的列数（0 表示完整渲染） */
  truncatedCols: number;
}

/**
 * XLSX 表格预览组件
 * 将 Excel 文件渲染为可视化的 HTML 表格
 *
 * 性能：workbook 解析一次；HTML 转换按 Sheet 惰性执行并缓存，
 * 切换 Sheet / 缩放 / 字号变化不会重新解析文件。
 */
export const XlsxPreview: React.FC<XlsxPreviewProps> = ({
  base64Content,
  fileName,
  className = '',
  zoomScale = 1,
  fontScale = 1,
}) => {
  const { t } = useTranslation(['learningHub']);
  const [cachedEntry, setCachedEntry] = useState<CachedWorkbook | null>(null);
  const [currentSheetIndex, setCurrentSheetIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const activeTabRef = useRef<HTMLButtonElement>(null);

  // 计算缩放后的布局宽度（用于容器宽度调整）
  const scaledContainerStyle: React.CSSProperties = {
    ['--xlsx-zoom' as string]: zoomScale.toString(),
    ['--xlsx-font-scale' as string]: fontScale.toString(),
  } as React.CSSProperties;

  useEffect(() => {
    let isMounted = true;

    // 模块级缓存命中：同一文件在会话内被重新挂载（切走再切回）时跳过解析
    const cacheKey = workbookCacheKey(base64Content);
    const cacheHit = getCachedWorkbook(cacheKey);
    if (cacheHit) {
      setCachedEntry(cacheHit);
      setCurrentSheetIndex(0);
      setError(null);
      setIsLoading(false);
      return () => {
        isMounted = false;
      };
    }

    const parseXlsx = async () => {
      setIsLoading(true);
      setError(null);

      try {
        const normalizedBase64 = normalizeBase64(base64Content);
        if (!normalizedBase64) {
          if (isMounted) {
            setError(t('learningHub:docPreview.emptyContent'));
            setIsLoading(false);
          }
          return;
        }

        // 先让加载指示器完成绘制，再进行重解码/解析
        await waitForNextFrame();
        if (!isMounted) return;

        // 解码 Base64 为 ArrayBuffer
        const arrayBuffer = decodeBase64ToArrayBuffer(normalizedBase64);

        // 提前识别加密/旧版二进制/非 Office 文件，给出可操作的提示
        const containerIssue = detectContainerIssue(arrayBuffer);
        if (containerIssue) {
          if (isMounted) {
            setError(t(
              containerIssue === 'encrypted-or-legacy'
                ? 'learningHub:officePreview.encryptedOrLegacy'
                : 'learningHub:officePreview.invalidFormat'
            ));
            setIsLoading(false);
          }
          return;
        }

        // 使用 ExcelJS 解析 XLSX
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(arrayBuffer);

        const entry: CachedWorkbook = { workbook: wb, sheets: new Map() };
        setCachedWorkbook(cacheKey, entry);

        if (isMounted) {
          setCachedEntry(entry);
          setCurrentSheetIndex(0);
          setIsLoading(false);
        }
      } catch (err: unknown) {
        console.error('Failed to parse XLSX:', err);
        if (isMounted) {
          setError(err instanceof Error ? err.message : t('learningHub:docPreview.parseXlsxFailed'));
          setIsLoading(false);
        }
      }
    };

    void parseXlsx();

    return () => {
      isMounted = false;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t 不加入依赖：语言切换不应重新解析文件
  }, [base64Content]);

  const worksheets = cachedEntry?.workbook.worksheets ?? [];
  const sheetCount = worksheets.length;

  // 惰性转换当前 Sheet（HTML 生成 + DOMPurify 消毒），结果缓存在 LRU 条目上，
  // 同一文件重新挂载后已转换的 Sheet 也无需重做
  const currentSheet = useMemo<SheetData | null>(() => {
    const worksheet = worksheets[currentSheetIndex];
    if (!worksheet || !cachedEntry) return null;

    const cached = cachedEntry.sheets.get(currentSheetIndex);
    if (cached) return cached;

    const { html: rawHtml, truncatedRows, truncatedCols } = worksheetToHtml(worksheet, worksheet.name);
    const data: SheetData = {
      name: worksheet.name,
      html: sanitizeXlsxHtml(rawHtml),
      truncatedRows,
      truncatedCols,
    };
    cachedEntry.sheets.set(currentSheetIndex, data);
    return data;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- worksheets 派生自 cachedEntry
  }, [cachedEntry, currentSheetIndex]);

  const handlePrevSheet = () => {
    setCurrentSheetIndex((prev) => Math.max(0, prev - 1));
  };

  const handleNextSheet = () => {
    setCurrentSheetIndex((prev) => Math.min(sheetCount - 1, prev + 1));
  };

  // 活动 Sheet 标签滚入可见区域（多 Sheet 溢出时）
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [currentSheetIndex]);

  // 键盘支持：Ctrl+PageUp/PageDown 切换工作表（Excel 惯例）；
  // PageUp/PageDown/Home/End 滚动表格（OverlayScrollbars 视口不在焦点链上，需手动路由）
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.altKey) return;
    if (e.ctrlKey) {
      if (e.key === 'PageDown') {
        handleNextSheet();
        e.preventDefault();
      } else if (e.key === 'PageUp') {
        handlePrevSheet();
        e.preventDefault();
      }
      return;
    }
    const viewport = viewportRef.current;
    if (!viewport) return;
    const pageHeight = viewport.clientHeight * 0.9;
    switch (e.key) {
      case 'PageDown':
        viewport.scrollBy({ top: pageHeight, behavior: 'smooth' });
        break;
      case 'PageUp':
        viewport.scrollBy({ top: -pageHeight, behavior: 'smooth' });
        break;
      case 'Home':
        viewport.scrollTo({ top: 0, behavior: 'smooth' });
        break;
      case 'End':
        viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' });
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  if (error) {
    return (
      <div className={`flex items-center justify-center p-8 text-destructive ${className}`} role="alert">
        <p>{t('learningHub:docPreview.cannotPreviewDoc')}: {error}</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className={`flex items-center justify-center p-8 ${className}`} aria-busy="true">
        <CircleNotch size={32} className="animate-spin text-primary" />
      </div>
    );
  }

  if (sheetCount === 0) {
    return (
      <div className={`flex items-center justify-center p-8 text-muted-foreground ${className}`}>
        <p>{t('learningHub:officePreview.noSheets')}</p>
      </div>
    );
  }

  return (
    <div
      className={`relative flex flex-col h-full ${className}`}
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {/* 底部工作表导航栏 - 多个 Sheet 时显示；标签条可横向滚动以容纳大量 Sheet */}
      {sheetCount > 1 && (
        <div className="flex items-center px-4 py-2 border-b bg-muted/30 flex-shrink-0 gap-2">
          <NotionButton
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 flex-shrink-0"
            onClick={handlePrevSheet}
            disabled={currentSheetIndex === 0}
            title={t('learningHub:officePreview.prevSheet')}
            aria-label={t('learningHub:officePreview.prevSheet')}
          >
            <CaretLeft size={16} />
          </NotionButton>
          <div
            role="tablist"
            aria-label={t('learningHub:officePreview.sheetTabs')}
            className="flex items-center gap-1 overflow-x-auto flex-1 min-w-0"
          >
            {worksheets.map((worksheet, index) => {
              const isActive = index === currentSheetIndex;
              return (
                <NotionButton
                  key={`${index}-${worksheet.name}`}
                  ref={isActive ? activeTabRef : undefined}
                  variant="ghost"
                  size="sm"
                  role="tab"
                  aria-selected={isActive}
                  title={worksheet.name}
                  onClick={() => setCurrentSheetIndex(index)}
                  className={
                    isActive
                      ? 'h-6 px-2 py-0 text-xs max-w-[10rem] truncate bg-background text-foreground font-medium border border-border shadow-sm flex-shrink-0'
                      : 'h-6 px-2 py-0 text-xs max-w-[10rem] truncate text-muted-foreground flex-shrink-0'
                  }
                >
                  {worksheet.name}
                </NotionButton>
              );
            })}
          </div>
          <span className="text-xs text-muted-foreground flex-shrink-0" aria-live="polite">
            ({currentSheetIndex + 1} / {sheetCount})
          </span>
          <NotionButton
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 flex-shrink-0"
            onClick={handleNextSheet}
            disabled={currentSheetIndex === sheetCount - 1}
            title={t('learningHub:officePreview.nextSheet')}
            aria-label={t('learningHub:officePreview.nextSheet')}
          >
            <CaretRight size={16} />
          </NotionButton>
        </div>
      )}

      {/* 表格内容 */}
      <CustomScrollArea className="xlsx-scroll-area flex-1" orientation="both" viewportRef={viewportRef}>
        {currentSheet && (
          <>
            {currentSheet.truncatedRows > 0 && (
              <div className="px-4 pt-3 text-xs text-amber-600 dark:text-amber-400">
                {t(
                  'learningHub:docPreview.xlsxTruncated', { shown: MAX_RENDER_ROWS, hidden: currentSheet.truncatedRows }
                )}
              </div>
            )}
            {currentSheet.truncatedCols > 0 && (
              <div className="px-4 pt-3 text-xs text-amber-600 dark:text-amber-400">
                {t(
                  'learningHub:officePreview.xlsxColsTruncated',
                  { shown: MAX_RENDER_COLS, hidden: currentSheet.truncatedCols }
                )}
              </div>
            )}
            <div
              className="xlsx-container p-4"
              style={scaledContainerStyle}
              aria-label={fileName ? t('learningHub:docPreview.xlsxPreviewLabel', { name: fileName }) : t('learningHub:docPreview.xlsxPreviewDefault')}
              dangerouslySetInnerHTML={{ __html: currentSheet.html }}
            />
          </>
        )}
      </CustomScrollArea>

      <style>{`
        .xlsx-container {
          /* 使用 zoom 而非 transform:scale——zoom 参与布局，
             缩小后不残留空白滚动区域、放大后滚动范围完整 */
          zoom: var(--xlsx-zoom, 1);
          width: max-content;
          min-width: 100%;
        }
        .xlsx-container table {
          border-collapse: collapse;
          width: max-content;
          min-width: 100%;
          font-size: calc(14px * var(--xlsx-font-scale, 1));
        }
        .xlsx-container th,
        .xlsx-container td {
          border: 1px solid hsl(var(--border));
          padding: 8px 12px;
          text-align: left;
          white-space: nowrap;
          color: hsl(var(--foreground));
        }
        .xlsx-container th {
          background-color: hsl(var(--muted));
          font-weight: 600;
        }
        .xlsx-container .xlsx-column-header {
          position: sticky;
          top: 0;
          z-index: 2;
          min-width: 5rem;
          text-align: center;
        }
        .xlsx-container .xlsx-row-header {
          position: sticky;
          left: 0;
          z-index: 1;
          min-width: 2.75rem;
          text-align: center;
          color: hsl(var(--muted-foreground));
        }
        .xlsx-container .xlsx-corner {
          position: sticky;
          top: 0;
          left: 0;
          z-index: 3;
          min-width: 2.75rem;
        }
        .xlsx-container tr:nth-child(even) {
          background-color: hsl(var(--muted) / 0.3);
        }
        .xlsx-container tr:hover {
          background-color: hsl(var(--muted) / 0.5);
        }
      `}</style>
    </div>
  );
};

export default XlsxPreview;
