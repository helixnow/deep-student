/**
 * TextFilePreview - 文本类文件的增强预览
 *
 * ★ 2026-06-12（审阅 UI/UX 建议）：替代原先所有文本文件统一 <pre> 的做法。
 * - .md/.markdown → ReactMarkdown 富渲染（GFM 表格/任务列表/删除线）
 * - .csv → 解析为表格展示（带引号转义处理，超长截断）
 * - 其余 → 等宽纯文本
 */

import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

/** CSV 最大渲染行数（超出截断，避免超大文件拖垮 DOM） */
const CSV_MAX_RENDER_ROWS = 1000;

export interface TextFilePreviewProps {
  /** 已解码的文本内容 */
  content: string;
  /** 文件名（用于判断渲染模式） */
  fileName: string;
  className?: string;
}

/** 简易 CSV 解析（支持双引号包裹、引号转义、字段内换行） */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // 丢弃末尾空行
  while (rows.length > 0 && rows[rows.length - 1].every((c) => c === '')) {
    rows.pop();
  }
  return rows;
}

function getExtension(fileName: string): string {
  const idx = fileName.lastIndexOf('.');
  return idx >= 0 ? fileName.slice(idx + 1).toLowerCase() : '';
}

export const TextFilePreview: React.FC<TextFilePreviewProps> = ({ content, fileName, className }) => {
  const { t } = useTranslation(['learningHub']);
  const ext = getExtension(fileName);

  const csvRows = useMemo(
    () => (ext === 'csv' ? parseCsv(content) : null),
    [ext, content]
  );

  // Markdown 富渲染
  if (ext === 'md' || ext === 'markdown') {
    return (
      <div className={cn('prose prose-sm dark:prose-invert max-w-none p-4', className)}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </div>
    );
  }

  // CSV 表格化
  if (csvRows && csvRows.length > 0) {
    const renderRows = csvRows.slice(0, CSV_MAX_RENDER_ROWS);
    const truncated = csvRows.length - renderRows.length;
    const [header, ...body] = renderRows;
    return (
      <div className={cn('p-4', className)}>
        {truncated > 0 && (
          <div className="mb-2 text-xs text-amber-600 dark:text-amber-400">
            {t('learningHub:docPreview.csvTruncated', '表格过大，仅显示前 {{shown}} 行（其余 {{hidden}} 行未渲染）', {
              shown: CSV_MAX_RENDER_ROWS,
              hidden: truncated,
            })}
          </div>
        )}
        <table className="border-collapse text-sm w-max min-w-full">
          <thead>
            <tr>
              {header.map((cell, i) => (
                <th
                  key={i}
                  className="border border-border bg-muted/50 px-3 py-1.5 text-left font-medium sticky top-0"
                >
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((cells, r) => (
              <tr key={r} className="even:bg-muted/20">
                {cells.map((cell, c) => (
                  <td key={c} className="border border-border px-3 py-1.5 align-top whitespace-pre-wrap">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  // 默认：等宽纯文本
  return (
    <pre className={cn('whitespace-pre-wrap text-sm p-4 m-0 min-h-full text-foreground', className)}>
      {content}
    </pre>
  );
};

export default TextFilePreview;
