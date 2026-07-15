/**
 * TextFilePreview - 文本类文件的增强预览
 *
 * ★ 2026-06-12（审阅 UI/UX 建议）：替代原先所有文本文件统一 <pre> 的做法。
 * - .md/.markdown → ReactMarkdown 富渲染（GFM 表格/任务列表/删除线），链接经 openUrl 外部打开
 * - .csv/.tsv → 解析为表格展示（带引号转义处理，超长截断）
 * - .json → 单行压缩内容自动格式化
 * - 代码类扩展名 → 不换行 + 横向滚动；其余 → 等宽换行纯文本
 *
 * ★ 2026-07-08：超大文本截断渲染（避免超长字符串拖垮 DOM）、空文件空状态、
 *   React.memo 避免父组件无关重渲染导致的重复解析。
 * ★ 2026-07-08 R2：大文件渐进渲染（首屏先出首块内容，剩余部分在 transition 中补齐）。
 */

import React, { startTransition, useCallback, useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { openUrl } from '@/utils/urlOpener';

/** CSV 最大渲染行数（超出截断，避免超大文件拖垮 DOM） */
const CSV_MAX_RENDER_ROWS = 1000;

/** 纯文本 / Markdown 最大渲染字符数（超出截断并提示） */
const TEXT_MAX_RENDER_CHARS = 500_000;

/** 渐进渲染：首屏立即渲染的字符数 / CSV 行数，剩余在 transition 中补齐 */
const TEXT_FIRST_CHUNK_CHARS = 64_000;
const CSV_FIRST_CHUNK_ROWS = 100;

/** 代码类扩展名：不自动换行，长行走横向滚动（更接近编辑器行为，便于阅读缩进结构） */
const CODE_LIKE_EXTENSIONS = new Set([
  'json', 'jsonc', 'jsonl', 'xml', 'yaml', 'yml', 'toml', 'ini',
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'css', 'scss', 'less',
  'py', 'rs', 'go', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs',
  'sql', 'sh', 'bash', 'ps1', 'bat', 'rb', 'php', 'swift', 'lua',
]);

export interface TextFilePreviewProps {
  /** 已解码的文本内容 */
  content: string;
  /** 文件名（用于判断渲染模式） */
  fileName: string;
  className?: string;
}

interface ParsedCsv {
  rows: string[][];
  /** 超出 maxRows 而未构建的剩余行数 */
  hiddenRows: number;
  /** 渲染列数（取各行最大值，短行渲染时补齐，保证网格完整） */
  colCount: number;
}

/**
 * 简易 CSV/TSV 解析（支持双引号包裹、引号转义、字段内换行）。
 * 达到 maxRows 后停止构建字符串，仅统计剩余行数，避免超大文件的无用解析开销。
 */
function parseCsv(text: string, maxRows: number = Infinity, delimiter: string = ','): ParsedCsv {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  for (; i < text.length && rows.length < maxRows; i++) {
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
    } else if (ch === delimiter) {
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

  const finalize = (hiddenRows: number): ParsedCsv => {
    let colCount = 0;
    for (const r of rows) {
      if (r.length > colCount) colCount = r.length;
    }
    return { rows, hiddenRows, colCount };
  };

  if (i >= text.length) {
    // 全量解析完成：收尾 + 丢弃末尾空行
    if (field.length > 0 || row.length > 0) {
      row.push(field);
      rows.push(row);
    }
    while (rows.length > 0 && rows[rows.length - 1].every((c) => c === '')) {
      rows.pop();
    }
    return finalize(0);
  }

  // 截断：剩余部分只统计行数（尊重引号内换行），不再构建字符串
  let hiddenRows = 0;
  let hasTrailingContent = false;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') i++;
        else inQuotes = false;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      hasTrailingContent = true;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      hiddenRows++;
      hasTrailingContent = false;
    } else {
      hasTrailingContent = true;
    }
  }
  if (hasTrailingContent) hiddenRows++;
  return finalize(hiddenRows);
}

function getExtension(fileName: string): string {
  const idx = fileName.lastIndexOf('.');
  return idx >= 0 ? fileName.slice(idx + 1).toLowerCase() : '';
}

/** 截断时避免切断代理对（否则末尾出现孤立代理项渲染为 �） */
function sliceSafe(text: string, end: number): string {
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/**
 * 大内容渐进渲染：首屏只渲染首块，commit 后在 transition 中补齐完整（截断上限内的）内容。
 * 内容切换时同步重置（render 阶段派生状态，避免旧内容全量渲染一帧）。
 */
function useProgressiveReveal(contentKey: string, isLarge: boolean): boolean {
  const [state, setState] = useState({ key: contentKey, full: !isLarge });
  if (state.key !== contentKey) {
    setState({ key: contentKey, full: !isLarge });
  }
  const pending = isLarge && !state.full;

  useEffect(() => {
    if (!pending) return;
    let cancelled = false;
    // 先让首块内容 paint，再在低优先级 transition 中渲染剩余部分
    const raf = requestAnimationFrame(() => {
      startTransition(() => {
        if (!cancelled) {
          setState((s) => (s.key === contentKey && !s.full ? { ...s, full: true } : s));
        }
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [pending, contentKey]);

  return state.key === contentKey ? state.full : !isLarge;
}

const TextFilePreviewComponent: React.FC<TextFilePreviewProps> = ({ content, fileName, className }) => {
  const { t } = useTranslation(['learningHub']);
  const ext = getExtension(fileName);
  const isTabular = ext === 'csv' || ext === 'tsv';
  const isMarkdown = ext === 'md' || ext === 'markdown';

  const parsedCsv = useMemo(
    () => (isTabular ? parseCsv(content, CSV_MAX_RENDER_ROWS, ext === 'tsv' ? '\t' : ',') : null),
    [isTabular, ext, content]
  );

  // 单行压缩 JSON 自动格式化（已格式化/超大文件保持原样）
  const displayContent = useMemo(() => {
    if (ext === 'json' && content.length <= TEXT_MAX_RENDER_CHARS && !content.includes('\n')) {
      try {
        return JSON.stringify(JSON.parse(content), null, 2);
      } catch {
        // 非法 JSON：按原文展示
      }
    }
    return content;
  }, [ext, content]);

  const isTextTruncated = displayContent.length > TEXT_MAX_RENDER_CHARS;
  const cappedText = isTextTruncated ? sliceSafe(displayContent, TEXT_MAX_RENDER_CHARS) : displayContent;

  // 渐进渲染（Markdown 不分块：部分内容会破坏语法结构导致布局跳变）
  const isLargeForReveal = parsedCsv
    ? parsedCsv.rows.length > CSV_FIRST_CHUNK_ROWS
    : !isMarkdown && cappedText.length > TEXT_FIRST_CHUNK_CHARS;
  const revealFull = useProgressiveReveal(content, isLargeForReveal);

  // Markdown 链接：拦截并交给系统浏览器打开，避免劫持应用内导航
  const handleMarkdownClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element
      ? (event.target.closest('a[href]') as HTMLAnchorElement | null)
      : null;
    const href = target?.getAttribute('href');
    if (!target || !href) return;
    event.preventDefault();
    event.stopPropagation();
    if (/^(https?:|mailto:)/i.test(href)) {
      void openUrl(href);
    }
    // 相对路径/锚点链接：文档预览内没有可导航目标，仅阻断默认行为
  }, []);

  // 空文件：给出明确空状态，避免呈现"看似加载失败"的空白区域
  if (content.trim() === '' && (!parsedCsv || parsedCsv.rows.length === 0)) {
    return (
      <div className={cn('flex items-center justify-center h-full p-6', className)}>
        <p className="text-sm text-muted-foreground">
          {t('learningHub:docPreview.emptyContent')}
        </p>
      </div>
    );
  }

  const truncationNotice = isTextTruncated ? (
    <div className="not-prose mb-2 text-xs text-amber-600 dark:text-amber-400" role="note">
      {t('learningHub:filePreview.textTruncated')}
    </div>
  ) : null;

  // Markdown 富渲染
  if (isMarkdown) {
    return (
      <div
        className={cn('prose prose-sm dark:prose-invert max-w-none p-4', className)}
        onClick={handleMarkdownClick}
      >
        {truncationNotice}
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{cappedText}</ReactMarkdown>
      </div>
    );
  }

  // CSV/TSV 表格化
  if (parsedCsv && parsedCsv.rows.length > 0) {
    const visibleRows = revealFull ? parsedCsv.rows : parsedCsv.rows.slice(0, CSV_FIRST_CHUNK_ROWS);
    const [header, ...body] = visibleRows;
    const padCells = (cells: string[]): string[] =>
      cells.length >= parsedCsv.colCount
        ? cells
        : [...cells, ...Array<string>(parsedCsv.colCount - cells.length).fill('')];
    return (
      <div className={cn('p-4', className)}>
        {parsedCsv.hiddenRows > 0 && (
          <div className="mb-2 text-xs text-amber-600 dark:text-amber-400" role="note">
            {t('learningHub:docPreview.csvTruncated', {
              shown: CSV_MAX_RENDER_ROWS,
              hidden: parsedCsv.hiddenRows,
            })}
          </div>
        )}
        <table className="border-collapse text-sm w-max min-w-full">
          <thead>
            <tr>
              {padCells(header).map((cell, i) => (
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
                {padCells(cells).map((cell, c) => (
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

  // 默认：等宽纯文本（代码类扩展名不换行，长行由外层滚动容器横向滚动）
  const renderText = revealFull ? cappedText : sliceSafe(cappedText, TEXT_FIRST_CHUNK_CHARS);
  const wrapClass = CODE_LIKE_EXTENSIONS.has(ext) ? 'whitespace-pre w-max min-w-full' : 'whitespace-pre-wrap';

  if (isTextTruncated) {
    return (
      <div className={cn('min-h-full', className)}>
        <div className="px-4 pt-4">{truncationNotice}</div>
        <pre className={cn('text-sm px-4 pb-4 m-0 text-foreground', wrapClass)}>
          {renderText}
        </pre>
      </div>
    );
  }
  return (
    <pre className={cn('text-sm p-4 m-0 min-h-full text-foreground', wrapClass, className)}>
      {renderText}
    </pre>
  );
};

/** memo：父组件（如缩放/字号等上下文变化）重渲染时避免重复解析 CSV/Markdown */
export const TextFilePreview = React.memo(TextFilePreviewComponent);

export default TextFilePreview;
