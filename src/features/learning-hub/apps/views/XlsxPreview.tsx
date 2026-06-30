/**
 * XLSX 表格预览组件
 * 使用 ExcelJS 库解析和显示 Excel 文件（替换了存在 CVE 的 SheetJS xlsx@0.18.5）
 *
 * 工具栏已移至 FileContentView 统一管理
 * 本组件保留底部 Sheet 导航栏
 */

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ExcelJS from 'exceljs';
import DOMPurify from 'dompurify';
import { CircleNotch, CaretLeft, CaretRight } from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import {
  normalizeBase64,
  decodeBase64ToArrayBuffer,
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
    ALLOWED_ATTR: ['class', 'style', 'colspan', 'rowspan', 'id'],
    ALLOW_DATA_ATTR: false,
  }) as string;
}

/** 将 ExcelJS 单元格值安全地转为字符串 */
function cellToString(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v == null) return '';
  if (typeof v === 'object' && 'result' in v) {
    // 公式单元格：取 result
    const r = (v as ExcelJS.CellFormulaValue).result;
    return r != null ? String(r) : '';
  }
  if (typeof v === 'object' && 'richText' in v) {
    return (v as ExcelJS.CellRichTextValue).richText.map((rt) => rt.text).join('');
  }
  if (v instanceof Date) {
    return v.toLocaleDateString();
  }
  return String(v);
}

/** 渲染行数上限（超大表格截断展示，避免一次性渲染数十万 DOM 节点卡死页面） */
const MAX_RENDER_ROWS = 1000;

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
): { html: string; truncatedRows: number } {
  const { masters, covered } = buildMergeMaps(worksheet);

  const totalRows = worksheet.actualRowCount;
  const totalCols = worksheet.actualColumnCount;
  const renderRows = Math.min(totalRows, MAX_RENDER_ROWS);

  const rows: string[] = [];
  rows.push(`<table id="xlsx-sheet-${escapeHtml(sheetName)}">`);

  // 按固定网格遍历（行/列均含空白），保证合并跨度与列对齐正确
  for (let r = 1; r <= renderRows; r++) {
    const row = worksheet.getRow(r);
    const tag = r === 1 ? 'th' : 'td';
    const cells: string[] = [];

    for (let c = 1; c <= totalCols; c++) {
      const key = `${r}:${c}`;
      if (covered.has(key)) continue;

      const cell = row.getCell(c);
      const escaped = escapeHtml(cellToString(cell));

      const span = masters.get(key);
      const spanAttr = span
        ? `${span.colspan > 1 ? ` colspan="${span.colspan}"` : ''}${span.rowspan > 1 ? ` rowspan="${span.rowspan}"` : ''}`
        : '';
      cells.push(`<${tag}${spanAttr}>${escaped}</${tag}>`);
    }
    rows.push(`<tr>${cells.join('')}</tr>`);
  }

  rows.push('</table>');
  return { html: rows.join(''), truncatedRows: Math.max(0, totalRows - renderRows) };
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
}

/**
 * XLSX 表格预览组件
 * 将 Excel 文件渲染为可视化的 HTML 表格
 */
export const XlsxPreview: React.FC<XlsxPreviewProps> = ({
  base64Content,
  fileName,
  className = '',
  zoomScale = 1,
  fontScale = 1,
}) => {
  const { t } = useTranslation(['learningHub']);
  const [sheets, setSheets] = useState<SheetData[]>([]);
  const [currentSheetIndex, setCurrentSheetIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 计算缩放后的布局宽度（用于容器宽度调整）
  const scaledContainerStyle: React.CSSProperties = {
    ['--xlsx-zoom' as string]: zoomScale.toString(),
    ['--xlsx-font-scale' as string]: fontScale.toString(),
  } as React.CSSProperties;

  useEffect(() => {
    let isMounted = true;

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

        // 解码 Base64 为 ArrayBuffer
        const arrayBuffer = decodeBase64ToArrayBuffer(normalizedBase64);

        // 使用 ExcelJS 解析 XLSX
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(arrayBuffer);

        // 转换每个工作表为 HTML（使用 DOMPurify 消毒，防止 XSS）
        const sheetDataList: SheetData[] = workbook.worksheets.map((worksheet) => {
          const { html: rawHtml, truncatedRows } = worksheetToHtml(worksheet, worksheet.name);
          const html = sanitizeXlsxHtml(rawHtml);
          return { name: worksheet.name, html, truncatedRows };
        });

        if (isMounted) {
          setSheets(sheetDataList);
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

  const handlePrevSheet = () => {
    setCurrentSheetIndex((prev) => Math.max(0, prev - 1));
  };

  const handleNextSheet = () => {
    setCurrentSheetIndex((prev) => Math.min(sheets.length - 1, prev + 1));
  };

  if (error) {
    return (
      <div className={`flex items-center justify-center p-8 text-destructive ${className}`}>
        <p>{t('learningHub:docPreview.cannotPreviewDoc')}: {error}</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className={`flex items-center justify-center p-8 ${className}`}>
        <CircleNotch size={32} className="animate-spin text-primary" />
      </div>
    );
  }

  const currentSheet = sheets[currentSheetIndex];

  return (
    <div className={`relative flex flex-col h-full ${className}`}>
      {/* 底部工作表导航栏 - 多个 Sheet 时显示 */}
      {sheets.length > 1 && (
        <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/30 flex-shrink-0">
          <NotionButton
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={handlePrevSheet}
            disabled={currentSheetIndex === 0}
          >
            <CaretLeft size={16} />
          </NotionButton>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{currentSheet?.name}</span>
            <span className="text-xs text-muted-foreground">
              ({currentSheetIndex + 1} / {sheets.length})
            </span>
          </div>
          <NotionButton
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={handleNextSheet}
            disabled={currentSheetIndex === sheets.length - 1}
          >
            <CaretRight size={16} />
          </NotionButton>
        </div>
      )}

      {/* 表格内容 */}
      <CustomScrollArea className="xlsx-scroll-area flex-1" orientation="both">
        {currentSheet && (
          <>
            {currentSheet.truncatedRows > 0 && (
              <div className="px-4 pt-3 text-xs text-amber-600 dark:text-amber-400">
                {t(
                  'learningHub:docPreview.xlsxTruncated',
                  '表格过大，仅显示前 {{shown}} 行（其余 {{hidden}} 行未渲染，可下载文件查看完整内容）',
                  { shown: MAX_RENDER_ROWS, hidden: currentSheet.truncatedRows }
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
          transform: scale(var(--xlsx-zoom, 1));
          transform-origin: top left;
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
        .xlsx-container tr:nth-child(even) {
          background-color: hsl(var(--muted) / 0.3);
        }
        .xlsx-container tr:hover {
          background-color: hsl(var(--muted) / 0.5);
        }
        .xlsx-container td:first-child {
          font-weight: 500;
          background-color: hsl(var(--muted) / 0.5);
        }
      `}</style>
    </div>
  );
};

export default XlsxPreview;
