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
import { Loader2, ChevronLeft, ChevronRight } from 'lucide-react';
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

/** 将 ExcelJS worksheet 转为 HTML table 字符串 */
function worksheetToHtml(worksheet: ExcelJS.Worksheet, sheetName: string): string {
  const rows: string[] = [];
  rows.push(`<table id="xlsx-sheet-${sheetName}">`);

  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const tag = rowNumber === 1 ? 'th' : 'td';
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell) => {
      const text = cellToString(cell);
      // 基础 HTML 转义
      const escaped = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

      const mergeAttr: string[] = [];
      if (cell.isMerged && (cell as any).master === cell) {
        // 仅在合并区域的主单元格添加 colspan/rowspan
        const ref = worksheet.getCell(cell.address);
        if (ref.model && (ref.model as any).master) {
          // ExcelJS 不直接暴露 span 信息，跳过
        }
      }
      cells.push(`<${tag}${mergeAttr.join('')}>${escaped}</${tag}>`);
    });
    rows.push(`<tr>${cells.join('')}</tr>`);
  });

  rows.push('</table>');
  return rows.join('');
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
          const rawHtml = worksheetToHtml(worksheet, worksheet.name);
          const html = sanitizeXlsxHtml(rawHtml);
          return { name: worksheet.name, html };
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
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
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
            <ChevronLeft className="h-4 w-4" />
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
            <ChevronRight className="h-4 w-4" />
          </NotionButton>
        </div>
      )}

      {/* 表格内容 */}
      <CustomScrollArea className="xlsx-scroll-area flex-1" orientation="both">
        {currentSheet && (
          <div
            className="xlsx-container p-4"
            style={scaledContainerStyle}
            aria-label={fileName ? t('learningHub:docPreview.xlsxPreviewLabel', { name: fileName }) : t('learningHub:docPreview.xlsxPreviewDefault')}
            dangerouslySetInnerHTML={{ __html: currentSheet.html }}
          />
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
