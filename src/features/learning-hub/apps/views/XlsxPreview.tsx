/**
 * XLSX 表格预览组件
 * 使用 ExcelJS 库解析和显示 Excel 文件（替换了存在 CVE 的 SheetJS xlsx@0.18.5）
 *
 * 工具栏已移至 FileContentView 统一管理
 * 本组件保留底部 Sheet 导航栏 + 状态条（选区信息 / 表格尺寸）
 *
 * 保真能力：
 * - 单元格样式（粗体/斜体/下划线/删除线/字色/填充色/对齐/字号）内联输出，仅对有样式的单元格生成
 * - 常见数字格式（百分比/千分位/小数位/货币符号/日期时间）尽力而为
 * - 列宽（colgroup）、合并单元格（含截断边界裁剪）、冻结行列头（sticky）
 * - Excel 式单元格点击/拖选高亮 + 行列头联动 + 键盘方向键移动选区
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ExcelJS from 'exceljs';
import DOMPurify from 'dompurify';
import { CaretLeft, CaretRight, Warning, Table as TableIcon } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import {
  normalizeBase64,
  decodeBase64ToArrayBuffer,
  waitForNextFrame,
  clampNumber,
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

// ============================================================================
// 数字格式（numFmt）尽力而为的格式化
// ============================================================================

/** 根据 numFmt 判断日期值是否需要时间/日期部分 */
function formatDateValue(date: Date, numFmt?: string): string {
  // 无效日期（如损坏的公式结果）直接输出空串，避免渲染 "Invalid Date"
  if (Number.isNaN(date.getTime())) return '';
  // 先剥离 locale/条件方括号段（[$-th-TH] 等含 'h'/'d'，但保留 [hh] 等经过时间 token）
  // 与引号字面量（"小时" 等），只在真正的格式 token 上探测，避免误判
  const fmt = (numFmt ?? '')
    .toLowerCase()
    .replace(/\[(?![hms]+\])[^\]]*\]/g, '')
    .replace(/"[^"]*"/g, '')
    // am/pm 中的 'm' 会被误判为月份 token，先剥离
    .replace(/am\/pm|a\/p/g, '');
  const hasTime = /[hs]/.test(fmt) || /:m|m:/.test(fmt);
  // 分钟 m 总是紧邻 ':' 或 h；剔除这些组合后剩余的 m 才是月份
  const hasDate = /[yd]/.test(fmt) || /m/.test(fmt.replace(/:m{1,2}|m{1,2}:|h+m{1,2}/g, ''));
  if (hasTime && hasDate) return date.toLocaleString();
  if (hasTime && !hasDate) return date.toLocaleTimeString();
  return date.toLocaleDateString();
}

/**
 * 常见数字格式的尽力而为渲染：百分比、千分位、固定小数位、货币符号。
 * 无法识别的格式回退为 String(value)，保证不丢数据。
 */
function formatNumericValue(value: number, numFmt?: string): string {
  if (!numFmt || numFmt === 'General' || numFmt === '@' || !Number.isFinite(value)) {
    return String(value);
  }
  // 只取正数段；token 探测在剥离引号字面量后的串上进行
  // （如 0.0"%"、0" kg" 中引号内的 % / 数字不是格式 token）
  const fmt = numFmt.split(';')[0];
  const tokenFmt = fmt.replace(/"[^"]*"/g, '');
  const fracMatch = /\.([0#]+)/.exec(tokenFmt);
  const frac = fracMatch?.[1] ?? '';
  // 上限 20：超长小数段（损坏/恶意 numFmt）会让 toFixed/toLocaleString 抛 RangeError
  const minFrac = Math.min((frac.match(/0/g) ?? []).length, 20);
  const maxFrac = Math.min(Math.max(minFrac, frac.length), 20);

  if (tokenFmt.includes('%')) {
    return `${(value * 100).toFixed(minFrac)}%`;
  }
  if (!/[#0]/.test(tokenFmt)) return String(value);

  const useGrouping = /[#0],[#0]/.test(tokenFmt);
  let text: string;
  try {
    text = value.toLocaleString(undefined, {
      minimumFractionDigits: minFrac,
      maximumFractionDigits: maxFrac,
      useGrouping,
    });
  } catch {
    text = String(value);
  }

  // 货币符号：优先 [$¥-804] 形式，其次格式串中的裸符号
  let symbol = '';
  const bracket = /\[\$([^\]-]+)[^\]]*\]/.exec(fmt);
  if (bracket) {
    symbol = bracket[1];
  } else {
    const direct = /[$¥€£]/.exec(fmt.replace(/\[[^\]]*\]/g, ''));
    if (direct) symbol = direct[0];
  }
  if (symbol) {
    text = text.startsWith('-') ? `-${symbol}${text.slice(1)}` : `${symbol}${text}`;
  }
  return text;
}

/** 将 ExcelJS 单元格值安全地转为字符串（应用常见 numFmt） */
function cellToString(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v == null) return '';
  const numFmt = cell.numFmt;
  if (v instanceof Date) {
    return formatDateValue(v, numFmt);
  }
  if (typeof v === 'number') {
    return formatNumericValue(v, numFmt);
  }
  if (typeof v === 'boolean') {
    return v ? 'TRUE' : 'FALSE';
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
      if (r instanceof Date) return formatDateValue(r, numFmt);
      if (typeof r === 'number') return formatNumericValue(r, numFmt);
      if (typeof r === 'boolean') return r ? 'TRUE' : 'FALSE';
      if (typeof r === 'object' && 'error' in r) return String(r.error ?? '');
      return String(r);
    }
    if ('hyperlink' in v) {
      // ExcelJS 反序列化超链接时直接把原 value 塞进 text（cell-xform reconcile），
      // 因此 text 实际可能是富文本对象或公式结果数值，而非类型声明中的 string
      const text: unknown = (v as ExcelJS.CellHyperlinkValue).text;
      if (typeof text === 'string') return text;
      if (typeof text === 'number') return formatNumericValue(text, numFmt);
      if (text && typeof text === 'object' && 'richText' in text) {
        return (text as ExcelJS.CellRichTextValue).richText.map((rt) => rt.text).join('');
      }
      return String((v as ExcelJS.CellHyperlinkValue).hyperlink ?? '');
    }
  }
  return String(v);
}

/** 值是否为数值/日期类（Excel 默认右对齐） */
function isNumericLike(v: ExcelJS.CellValue): boolean {
  if (typeof v === 'number' || v instanceof Date) return true;
  if (v && typeof v === 'object') {
    if ('result' in v) {
      const r = (v as ExcelJS.CellFormulaValue).result;
      return typeof r === 'number' || r instanceof Date;
    }
    // 与 cellToString 的超链接分支保持一致：text 可能是数值（reconcile 塞入原值）
    if ('hyperlink' in v) {
      return typeof (v as { text?: unknown }).text === 'number';
    }
  }
  return false;
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

/**
 * 内容指纹：双 FNV-1a 32-bit（不同素数/种子，等效 64-bit）+ 长度 + 8 点均匀采样 + 首尾片段。
 * 相比单 32-bit FNV，显著降低不同文件碰撞导致错误命中缓存的概率。
 */
function workbookCacheKey(content: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4 | 0;
  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 16777619);
    h2 = Math.imul(h2 ^ code, 0x85ebca77);
  }
  const n = content.length;
  let samples = '';
  for (let k = 0; k < 8; k += 1) {
    samples += n > 0 ? content.charAt(Math.floor(((n - 1) * k) / 7)) : '';
  }
  return `${n}:${(h1 >>> 0).toString(16)}:${(h2 >>> 0).toString(16)}:${samples}:${content.slice(0, 16)}:${content.slice(-16)}`;
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

interface MergeBounds {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/**
 * 读取工作表的合并区间边界。
 * 优先读 ExcelJS 内部 _merges（Range 对象字典，O(合并数)）；
 * 不能走 worksheet.model.merges——model getter 会序列化整表所有行/单元格，
 * 在超大表（截断前十万行级）上等于把文件重新解析一遍，截断优化全被抵消。
 * _merges 缺失时（未来版本变更）退回 model.merges 的 "A1:B2" 字符串解析。
 */
function readMergeBounds(worksheet: ExcelJS.Worksheet): MergeBounds[] {
  const internal = (worksheet as unknown as { _merges?: Record<string, MergeBounds> })._merges;
  if (internal && typeof internal === 'object') {
    return Object.values(internal).filter(
      (m) =>
        m &&
        typeof m.top === 'number' &&
        typeof m.left === 'number' &&
        typeof m.bottom === 'number' &&
        typeof m.right === 'number'
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

/**
 * ★ 2026-06-12（审阅问题 M4）：从 worksheet 的合并区间构建 rowspan/colspan 映射。
 * 旧实现的 mergeAttr 永远为空数组（注释自承"跳过"），合并单元格全部错位。
 *
 * ★ 截断边界裁剪：merges 覆盖全表，而渲染网格截断到 maxRow/maxCol。
 * 若不裁剪，跨截断边界的 rowspan/colspan 会越界撑出表格。
 */
function buildMergeMaps(worksheet: ExcelJS.Worksheet, maxRow: number, maxCol: number): MergeMaps {
  const masters = new Map<string, { rowspan: number; colspan: number }>();
  const covered = new Set<string>();

  for (const merge of readMergeBounds(worksheet)) {
    // 防御异常区间（end 在 start 之前的畸形数据会产生负跨度、错位整行）
    if (merge.bottom < merge.top || merge.right < merge.left) continue;
    // 主单元格（左上角）在截断区外：整个合并区间不会被渲染
    if (merge.top > maxRow || merge.left > maxCol) continue;

    // 裁剪合并区间到截断边界，避免 rowspan/colspan 越界
    const endRow = Math.min(merge.bottom, maxRow);
    const endCol = Math.min(merge.right, maxCol);
    const rowspan = endRow - merge.top + 1;
    const colspan = endCol - merge.left + 1;
    if (rowspan <= 1 && colspan <= 1) continue;

    masters.set(`${merge.top}:${merge.left}`, { rowspan, colspan });
    for (let r = merge.top; r <= endRow; r++) {
      for (let c = merge.left; c <= endCol; c++) {
        if (r === merge.top && c === merge.left) continue;
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

// ============================================================================
// 单元格样式 → 内联 CSS（有限保真，仅对有样式的单元格输出）
// ============================================================================

/** Office 默认主题色（theme 0-9），tint 尽力而为 */
const THEME_COLORS = [
  'FFFFFF', '000000', 'E7E6E6', '44546A', '4472C4',
  'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47',
];

/** 旧版 indexed 调色板（BIFF8 标准 0-63） */
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

interface LooseColor {
  argb?: string;
  theme?: number;
  tint?: number;
  indexed?: number;
}

/** Excel tint 算法：正值向白、负值向黑 */
function applyTint(channel: number, tint: number): number {
  const next = tint > 0 ? channel + (255 - channel) * tint : channel * (1 + tint);
  return Math.round(clampNumber(next, 0, 255));
}

/** 解析 ExcelJS 颜色（argb / theme+tint / indexed）为 #rrggbb，失败返回 null */
function resolveColor(color: LooseColor | undefined): string | null {
  if (!color) return null;
  let hex: string | null = null;
  if (typeof color.argb === 'string') {
    if (/^[0-9A-Fa-f]{8}$/.test(color.argb)) {
      // alpha=00（完全透明，常见于"自动"颜色的序列化）视为无颜色，
      // 否则透明填充会被错误渲染成实色
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

/** 相对亮度（0-1），用于填充色上的文字对比色 */
function hexLuminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/**
 * 从 ExcelJS 单元格样式生成内联 CSS。
 * 性能：无样式单元格立即返回空串，不产生额外 DOM 负担；
 * 跳过黑色字体/白色填充（交给主题变量，保证暗色主题可读）。
 */
function cellStyleToCss(cell: ExcelJS.Cell): string {
  const style = cell.style;
  if (!style || (style.font === undefined && style.fill === undefined && style.alignment === undefined)) {
    return '';
  }
  const parts: string[] = [];
  let hasFontColor = false;

  const font = style.font;
  if (font) {
    if (font.bold) parts.push('font-weight:600');
    if (font.italic) parts.push('font-style:italic');
    const deco: string[] = [];
    if (font.underline && font.underline !== 'none') deco.push('underline');
    if (font.strike) deco.push('line-through');
    if (deco.length > 0) parts.push(`text-decoration:${deco.join(' ')}`);
    if (typeof font.size === 'number' && Number.isFinite(font.size) && font.size > 0 && font.size !== 11) {
      // clamp 防御异常字号（NaN/Infinity 已排除；极端值会撑爆行高）
      parts.push(`font-size:calc(${clampNumber(font.size, 5, 128)}pt * var(--xlsx-font-scale, 1) * 0.85)`);
    }
    const fontColor = resolveColor(font.color as LooseColor | undefined);
    // 黑色字体视为默认色，交给主题 foreground（否则暗色主题下不可读）
    if (fontColor && fontColor !== '#000000') {
      parts.push(`color:${fontColor}`);
      hasFontColor = true;
    }
  }

  const fill = style.fill;
  if (fill && fill.type === 'pattern' && (fill as ExcelJS.FillPattern).pattern === 'solid') {
    const fillColor = resolveColor((fill as ExcelJS.FillPattern).fgColor as LooseColor | undefined);
    // 白色填充视为无填充，交给主题背景
    if (fillColor && fillColor !== '#ffffff') {
      parts.push(`background-color:${fillColor}`);
      if (!hasFontColor) {
        // 填充色来自文件数据（假设黑字白底设计），必须按亮度给对比色，
        // 不能用主题 token（暗色主题的 foreground 在浅色填充上不可读）
        parts.push(`color:${hexLuminance(fillColor) > 0.55 ? '#1f2328' : '#ffffff'}`);
      }
    }
  }

  const align = style.alignment;
  if (align) {
    if (align.horizontal === 'center' || align.horizontal === 'right' || align.horizontal === 'justify') {
      parts.push(`text-align:${align.horizontal}`);
    } else if (align.horizontal === 'left') {
      parts.push('text-align:left');
    }
    if (align.vertical === 'top') parts.push('vertical-align:top');
    else if (align.vertical === 'middle') parts.push('vertical-align:middle');
    if (align.wrapText) parts.push('white-space:normal;word-break:break-word;max-width:26rem');
  }

  return parts.join(';');
}

/** Excel 列宽（字符数）→ 像素（Calibri 11 近似），限制在合理区间 */
function columnWidthPx(width: number): number {
  return Math.round(clampNumber(width * 7 + 5, 28, 480));
}

interface SheetHtmlResult {
  html: string;
  totalRows: number;
  totalCols: number;
  renderedRows: number;
  renderedCols: number;
}

/** 将 ExcelJS worksheet 转为 HTML table 字符串 */
function worksheetToHtml(worksheet: ExcelJS.Worksheet, sheetName: string): SheetHtmlResult {
  // 必须用 rowCount/columnCount（已用区域边界）而非 actualRowCount/actualColumnCount：
  // actual* 只数"有值"的行/列，数据区内任何空白行、空白列都会让计数小于真实边界，
  // 导致尾部数据行被静默丢弃且截断提示不出现（totalRows == renderedRows）。
  // 另外 actualColumnCount 会遍历全表每个单元格，rowCount/columnCount 则是 O(行数)。
  const totalRows = worksheet.rowCount;
  const totalCols = worksheet.columnCount;
  const renderRows = Math.min(totalRows, MAX_RENDER_ROWS);
  const renderCols = Math.min(totalCols, MAX_RENDER_COLS);

  if (renderRows === 0 || renderCols === 0) {
    return { html: '', totalRows, totalCols, renderedRows: 0, renderedCols: 0 };
  }

  const { masters, covered } = buildMergeMaps(worksheet, renderRows, renderCols);

  const rows: string[] = [];
  // id 仅允许安全字符，避免工作表名中的空格/引号产生非法 HTML id
  const safeSheetId = sheetName.replace(/[^\w-]/g, '_');
  rows.push(`<table id="xlsx-sheet-${safeSheetId}" data-xlsx-sheet="${escapeHtml(sheetName)}">`);

  // 列宽保真：colgroup（第一列为行号列）
  rows.push('<colgroup><col>');
  for (let c = 1; c <= renderCols; c++) {
    const width = worksheet.getColumn(c)?.width;
    rows.push(
      typeof width === 'number' && width > 0
        ? `<col style="width:${columnWidthPx(width)}px">`
        : '<col>'
    );
  }
  rows.push('</colgroup>');

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
      // 数值/日期默认右对齐（Excel 惯例）；样式仅对有样式的单元格输出，控制 DOM 体积
      const classAttr = isNumericLike(cell.value) ? ' class="xlsx-num"' : '';
      const css = cellStyleToCss(cell);
      const styleAttr = css ? ` style="${css}"` : '';
      cells.push(`<td data-xlsx-cell="${columnLabel(c)}${r}"${classAttr}${spanAttr}${styleAttr}>${escaped}</td>`);
    }
    rows.push(`<tr>${cells.join('')}</tr>`);
  }

  rows.push('</tbody></table>');
  return {
    html: rows.join(''),
    totalRows,
    totalCols,
    renderedRows: renderRows,
    renderedCols: renderCols,
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

interface SheetData extends SheetHtmlResult {
  name: string;
  /** 该 sheet 没有任何内容 */
  isEmpty: boolean;
}

interface CellPos {
  row: number;
  col: number;
}

interface CellSelection {
  anchor: CellPos;
  focus: CellPos;
}

/** 拖选范围过大时跳过逐格高亮（仅保留行列头联动），避免大范围拖选卡顿 */
const MAX_HIGHLIGHT_CELLS = 20000;

const ARROW_DELTAS: Record<string, [number, number]> = {
  ArrowUp: [-1, 0],
  ArrowDown: [1, 0],
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1],
};

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
  const [selection, setSelection] = useState<CellSelection | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const activeTabRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const decoratedRef = useRef<Element[]>([]);
  const draggingRef = useRef(false);

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

  // Sheet 标签元数据一次性计算：rowCount/columnCount 为 O(行数)访问器，
  // 不能在每次渲染（每次选区变化）时对全部 sheet 重复求值
  const sheetTabs = useMemo(
    () =>
      worksheets.map((worksheet) => ({
        name: worksheet.name,
        isBig: worksheet.rowCount > MAX_RENDER_ROWS || worksheet.columnCount > MAX_RENDER_COLS,
      })),
  // eslint-disable-next-line react-hooks/exhaustive-deps -- worksheets 派生自 cachedEntry
    [cachedEntry]
  );

  // 惰性转换当前 Sheet（HTML 生成 + DOMPurify 消毒），结果缓存在 LRU 条目上，
  // 同一文件重新挂载后已转换的 Sheet 也无需重做
  const currentSheet = useMemo<SheetData | null>(() => {
    const worksheet = worksheets[currentSheetIndex];
    if (!worksheet || !cachedEntry) return null;

    const cached = cachedEntry.sheets.get(currentSheetIndex);
    if (cached) return cached;

    const result = worksheetToHtml(worksheet, worksheet.name);
    const data: SheetData = {
      ...result,
      name: worksheet.name,
      html: result.html ? sanitizeXlsxHtml(result.html) : '',
      isEmpty: result.renderedRows === 0 || result.renderedCols === 0,
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

  // 切换 Sheet / 更换文件时：清空选区、滚动回左上角
  useEffect(() => {
    setSelection(null);
    viewportRef.current?.scrollTo({ top: 0, left: 0 });
  }, [currentSheetIndex, cachedEntry]);

  // ==========================================================================
  // 单元格选区（Excel 式点击/拖选高亮）
  // ==========================================================================

  useEffect(() => {
    const endDrag = () => {
      draggingRef.current = false;
    };
    window.addEventListener('mouseup', endDrag);
    return () => window.removeEventListener('mouseup', endDrag);
  }, []);

  const posFromEventTarget = (target: EventTarget | null): CellPos | null => {
    if (!(target instanceof Element)) return null;
    const td = target.closest('td[data-xlsx-cell]');
    const addr = td?.getAttribute('data-xlsx-cell');
    return addr ? parseCellAddress(addr) : null;
  };

  // 不调用 preventDefault：原生文本选择（引用到聊天依赖 window.getSelection）必须保持可用
  const handleCellMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const pos = posFromEventTarget(e.target);
    if (!pos) return;
    draggingRef.current = true;
    setSelection((prev) =>
      e.shiftKey && prev ? { anchor: prev.anchor, focus: pos } : { anchor: pos, focus: pos }
    );
  };

  const handleCellMouseOver = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    const pos = posFromEventTarget(e.target);
    if (!pos) return;
    setSelection((prev) => {
      if (!prev || (prev.focus.row === pos.row && prev.focus.col === pos.col)) return prev;
      return { anchor: prev.anchor, focus: pos };
    });
  };

  // 触屏至少支持单击选中单元格（拖选保持鼠标专属，避免与滚动手势冲突；
  // 部分场景合成 mousedown 不触发，这里用 pointerdown 兜底）
  const handleCellPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse') return; // 鼠标走 onMouseDown（含 Shift 扩选/拖选）
    const pos = posFromEventTarget(e.target);
    if (!pos) return;
    setSelection({ anchor: pos, focus: pos });
  };

  const selectionInfo = useMemo(() => {
    if (!selection) return null;
    const r1 = Math.min(selection.anchor.row, selection.focus.row);
    const r2 = Math.max(selection.anchor.row, selection.focus.row);
    const c1 = Math.min(selection.anchor.col, selection.focus.col);
    const c2 = Math.max(selection.anchor.col, selection.focus.col);
    const single = r1 === r2 && c1 === c2;
    const label = single
      ? `${columnLabel(c1)}${r1}`
      : `${columnLabel(c1)}${r1}:${columnLabel(c2)}${r2}`;
    return { r1, r2, c1, c2, single, label, count: (r2 - r1 + 1) * (c2 - c1 + 1) };
  }, [selection]);

  // 将选区映射为 DOM class（直接操作已渲染表格，避免重建 25 万级单元格的 HTML）
  useEffect(() => {
    const cleanup = () => {
      for (const el of decoratedRef.current) {
        el.classList.remove('xlsx-cell-active', 'xlsx-cell-in-range', 'xlsx-header-active');
      }
      decoratedRef.current = [];
    };
    cleanup();
    if (!selection || !selectionInfo) return;

    const table = contentRef.current?.querySelector('table');
    if (!table) return;
    const { r1, r2, c1, c2, count } = selectionInfo;
    const decorated: Element[] = [];

    // 列头联动高亮（cells[0] 是角格）
    const headRow = table.tHead?.rows[0];
    if (headRow) {
      for (let c = c1; c <= Math.min(c2, headRow.cells.length - 1); c++) {
        const th = headRow.cells[c];
        if (th) {
          th.classList.add('xlsx-header-active');
          decorated.push(th);
        }
      }
    }

    const bodyRows = table.tBodies[0]?.rows;
    if (bodyRows) {
      const cellBudgetOk = count <= MAX_HIGHLIGHT_CELLS;
      for (let r = r1; r <= r2; r++) {
        const rowEl = bodyRows[r - 1];
        if (!rowEl) break;
        const rowHeader = rowEl.cells[0];
        if (rowHeader) {
          rowHeader.classList.add('xlsx-header-active');
          decorated.push(rowHeader);
        }
        if (!cellBudgetOk) continue;
        for (let i = 1; i < rowEl.cells.length; i++) {
          const td = rowEl.cells[i];
          const addr = td.getAttribute('data-xlsx-cell');
          if (!addr) continue;
          const pos = parseCellAddress(addr);
          if (!pos) continue;
          if (pos.col > c2) break;
          if (pos.col < c1) continue;
          td.classList.add('xlsx-cell-in-range');
          decorated.push(td);
          if (pos.row === selection.anchor.row && pos.col === selection.anchor.col) {
            td.classList.add('xlsx-cell-active');
          }
        }
      }
      if (!cellBudgetOk) {
        const anchorTd = table.querySelector(
          `td[data-xlsx-cell="${columnLabel(selection.anchor.col)}${selection.anchor.row}"]`
        );
        if (anchorTd) {
          anchorTd.classList.add('xlsx-cell-active');
          decorated.push(anchorTd);
        }
      }
    }

    decoratedRef.current = decorated;
    return cleanup;
  }, [selection, selectionInfo, currentSheet]);

  const scrollCellIntoView = (pos: CellPos) => {
    const td = contentRef.current?.querySelector(
      `td[data-xlsx-cell="${columnLabel(pos.col)}${pos.row}"]`
    );
    td?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };

  // 键盘支持：Ctrl+PageUp/PageDown 切换工作表（Excel 惯例）；
  // 方向键移动选区（Shift 扩展范围）、Escape 清除选区；
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
    if (e.key === 'Escape') {
      if (selection) {
        setSelection(null);
        e.preventDefault();
      }
      return;
    }
    const delta = ARROW_DELTAS[e.key];
    if (delta && currentSheet && !currentSheet.isEmpty) {
      // 无选区时按方向键：从 A1 建立选区（Excel 打开即选中 A1 的惯例）
      if (!selection) {
        const origin: CellPos = { row: 1, col: 1 };
        setSelection({ anchor: origin, focus: origin });
        scrollCellIntoView(origin);
        e.preventDefault();
        return;
      }
      const base = e.shiftKey ? selection.focus : selection.anchor;
      const next: CellPos = {
        row: clampNumber(base.row + delta[0], 1, currentSheet.renderedRows),
        col: clampNumber(base.col + delta[1], 1, currentSheet.renderedCols),
      };
      setSelection(e.shiftKey ? { anchor: selection.anchor, focus: next } : { anchor: next, focus: next });
      scrollCellIntoView(next);
      e.preventDefault();
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

  // isEmpty 守卫：totalRows>0 但 renderedRows=0（如仅有空行、columnCount 为 0）时
  // 不显示"已显示前 0 行"这类误导性提示
  const isTruncated =
    !!currentSheet &&
    !currentSheet.isEmpty &&
    (currentSheet.totalRows > currentSheet.renderedRows ||
      currentSheet.totalCols > currentSheet.renderedCols);

  const compactTabs = sheetCount > 8;

  const selectionTitle = selectionInfo
    ? t('learningHub:officePreview.selectionLabel', { range: selectionInfo.label })
    : undefined;

  // 注意：出错时不整体卸载渲染容器（与 DOCX/PPTX 预览策略一致），
  // 错误以覆盖层形式展示，结构保持挂载，切换到正常文件后可直接恢复
  return (
    <div
      className={`relative flex flex-col h-full ${className}`}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      aria-busy={isLoading && !error}
    >
      {error && (
        <div
          className="absolute inset-0 z-20 flex items-center justify-center p-8 text-destructive bg-background"
          role="alert"
        >
          <p>{t('learningHub:docPreview.cannotPreviewDoc')}: {error}</p>
        </div>
      )}

      {isLoading && !error && (
        <div
          className="absolute inset-0 z-10 overflow-hidden bg-background p-4"
          aria-label={t('learningHub:officePreview.loadingWorkbook')}
        >
          {/* 表格形加载骨架 */}
          <div className="animate-pulse">
            <div className="mb-1 flex gap-1">
              <div className="h-7 w-10 flex-shrink-0 rounded-sm bg-muted" />
              {Array.from({ length: 7 }).map((_, i) => (
                <div key={i} className="h-7 flex-1 rounded-sm bg-muted" />
              ))}
            </div>
            {Array.from({ length: 14 }).map((_, r) => (
              <div key={r} className="mb-1 flex gap-1">
                <div className="h-7 w-10 flex-shrink-0 rounded-sm bg-muted/70" />
                {Array.from({ length: 7 }).map((_, c) => (
                  <div key={c} className="h-7 flex-1 rounded-sm bg-muted/40" />
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 截断提示条：固定在表格上方，不随内容滚动 */}
      {isTruncated && currentSheet && (
        <div
          className="flex flex-shrink-0 items-center gap-2 border-b border-warning/30 bg-warning/10 px-4 py-1.5 text-xs text-warning"
          role="status"
        >
          <Warning size={14} weight="fill" className="flex-shrink-0" aria-hidden="true" />
          <span className="tabular-nums">
            {currentSheet.totalRows > currentSheet.renderedRows &&
              t('learningHub:officePreview.rowsTruncatedInfo', {
                shown: currentSheet.renderedRows,
                total: currentSheet.totalRows,
              })}
            {currentSheet.totalRows > currentSheet.renderedRows &&
              currentSheet.totalCols > currentSheet.renderedCols && ' · '}
            {currentSheet.totalCols > currentSheet.renderedCols &&
              t('learningHub:officePreview.colsTruncatedInfo', {
                shown: currentSheet.renderedCols,
                total: currentSheet.totalCols,
              })}
          </span>
          <span className="text-warning/80">
            {t('learningHub:officePreview.truncatedNotice')}
          </span>
        </div>
      )}

      {/* 表格内容 */}
      <CustomScrollArea className="xlsx-scroll-area flex-1" orientation="both" viewportRef={viewportRef}>
        {!isLoading && !error && sheetCount === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 p-12 text-muted-foreground">
            <TableIcon size={24} aria-hidden="true" />
            <p className="text-sm">{t('learningHub:officePreview.noSheets')}</p>
          </div>
        )}
        {currentSheet && currentSheet.isEmpty && (
          <div className="flex flex-col items-center justify-center gap-2 p-12 text-muted-foreground">
            <TableIcon size={24} aria-hidden="true" />
            <p className="text-sm">{t('learningHub:officePreview.emptySheet')}</p>
          </div>
        )}
        {currentSheet && !currentSheet.isEmpty && (
          <div
            key={currentSheetIndex}
            ref={contentRef}
            className="xlsx-container xlsx-fade-in p-4"
            style={scaledContainerStyle}
            aria-label={fileName ? t('learningHub:docPreview.xlsxPreviewLabel', { name: fileName }) : t('learningHub:docPreview.xlsxPreviewDefault')}
            onMouseDown={handleCellMouseDown}
            onMouseOver={handleCellMouseOver}
            onPointerDown={handleCellPointerDown}
            dangerouslySetInnerHTML={{ __html: currentSheet.html }}
          />
        )}
      </CustomScrollArea>

      {/* 底部状态条：Sheet 标签（多 Sheet 时）+ 选区信息 + 表格尺寸 */}
      {sheetCount > 0 && !error && (
        <div className="flex flex-shrink-0 items-center gap-1.5 border-t bg-muted/30 px-2 py-1">
          {sheetCount > 1 ? (
            <>
              <DsButton
                variant="ghost"
                size="sm"
                className="h-6 w-6 flex-shrink-0 p-0 [@media(pointer:coarse)]:h-10 [@media(pointer:coarse)]:w-10"
                onClick={handlePrevSheet}
                disabled={currentSheetIndex === 0}
                title={t('learningHub:officePreview.prevSheet')}
                aria-label={t('learningHub:officePreview.prevSheet')}
              >
                <CaretLeft size={14} />
              </DsButton>
              <div
                role="tablist"
                aria-label={t('learningHub:officePreview.sheetTabs')}
                className="xlsx-tabstrip flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto px-1"
              >
                {sheetTabs.map((tab, index) => {
                  const isActive = index === currentSheetIndex;
                  return (
                    <DsButton
                      key={`${index}-${tab.name}`}
                      ref={isActive ? activeTabRef : undefined}
                      variant="ghost"
                      size="sm"
                      role="tab"
                      aria-selected={isActive}
                      title={
                        tab.isBig
                          ? `${tab.name} — ${t('learningHub:officePreview.sheetTruncatedHint')}`
                          : tab.name
                      }
                      onClick={() => setCurrentSheetIndex(index)}
                      className={`h-6 [@media(pointer:coarse)]:h-10 flex-shrink-0 rounded-sm py-0 text-xs transition-colors duration-150 ${
                        compactTabs ? 'max-w-[6rem] px-1.5' : 'max-w-[10rem] px-2'
                      } ${
                        isActive
                          ? 'bg-primary/10 font-medium text-primary shadow-[inset_0_2px_0_0_hsl(var(--primary))]'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      <span className="min-w-0 truncate">{tab.name}</span>
                      {tab.isBig && (
                        <span
                          className="ml-1 inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-warning"
                          aria-hidden="true"
                        />
                      )}
                    </DsButton>
                  );
                })}
              </div>
              <DsButton
                variant="ghost"
                size="sm"
                className="h-6 w-6 flex-shrink-0 p-0 [@media(pointer:coarse)]:h-10 [@media(pointer:coarse)]:w-10"
                onClick={handleNextSheet}
                disabled={currentSheetIndex === sheetCount - 1}
                title={t('learningHub:officePreview.nextSheet')}
                aria-label={t('learningHub:officePreview.nextSheet')}
              >
                <CaretRight size={14} />
              </DsButton>
              <span
                className="flex-shrink-0 text-[11px] tabular-nums text-muted-foreground"
                aria-live="polite"
              >
                {currentSheetIndex + 1}/{sheetCount}
              </span>
            </>
          ) : (
            <div className="min-w-0 flex-1" />
          )}
          <div className="flex flex-shrink-0 items-center gap-3 pl-2 text-[11px] text-muted-foreground">
            {selectionInfo && (
              <span
                className="font-medium tabular-nums text-primary"
                title={selectionTitle}
                aria-label={selectionTitle}
              >
                {selectionInfo.label}
              </span>
            )}
            {/* 📱 多 Sheet 时窄屏（<sm）隐藏表格尺寸读数：把宝贵宽度让给 Sheet 标签条与选区信息 */}
            {currentSheet && !currentSheet.isEmpty && (
              <span className={sheetCount > 1 ? 'tabular-nums max-sm:hidden' : 'tabular-nums'}>
                {t('learningHub:officePreview.dimensions', {
                  rows: currentSheet.totalRows,
                  cols: currentSheet.totalCols,
                })}
              </span>
            )}
          </div>
        </div>
      )}

      <style>{`
        .xlsx-container {
          /* 使用 zoom 而非 transform:scale——zoom 参与布局，
             缩小后不残留空白滚动区域、放大后滚动范围完整 */
          zoom: var(--xlsx-zoom, 1);
          width: max-content;
          min-width: 100%;
        }
        @keyframes xlsx-fade-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        .xlsx-fade-in {
          animation: xlsx-fade-in 150ms ease-out;
        }
        .xlsx-container table {
          border-collapse: collapse;
          width: max-content;
          min-width: 100%;
          font-size: calc(13px * var(--xlsx-font-scale, 1));
        }
        .xlsx-container th,
        .xlsx-container td {
          border: 1px solid hsl(var(--border));
          padding: 4px 10px;
          text-align: left;
          white-space: nowrap;
          color: hsl(var(--foreground));
        }
        .xlsx-container td {
          cursor: cell;
        }
        .xlsx-container td.xlsx-num {
          text-align: right;
          font-variant-numeric: tabular-nums;
        }
        .xlsx-container th {
          background-color: hsl(var(--muted));
          font-weight: 500;
          color: hsl(var(--muted-foreground));
          user-select: none;
        }
        .xlsx-container .xlsx-column-header {
          position: sticky;
          top: 0;
          z-index: 2;
          min-width: 4rem;
          text-align: center;
          font-size: calc(11px * var(--xlsx-font-scale, 1));
        }
        .xlsx-container .xlsx-row-header {
          position: sticky;
          left: 0;
          z-index: 1;
          min-width: 2.75rem;
          text-align: center;
          font-size: calc(11px * var(--xlsx-font-scale, 1));
        }
        .xlsx-container .xlsx-corner {
          position: sticky;
          top: 0;
          left: 0;
          z-index: 3;
          min-width: 2.75rem;
        }
        .xlsx-container tbody tr:hover td:not([style*="background"]) {
          background-color: hsl(var(--muted) / 0.35);
        }
        /* 选区高亮（Excel 式蓝框）：
           inset box-shadow 叠加在内联填充色之上，outline 不参与布局 */
        .xlsx-container td.xlsx-cell-in-range {
          box-shadow: inset 0 0 0 9999px hsl(var(--primary) / 0.08);
        }
        .xlsx-container td.xlsx-cell-active {
          outline: 2px solid hsl(var(--primary));
          outline-offset: -2px;
        }
        .xlsx-container th.xlsx-header-active {
          box-shadow: inset 0 0 0 9999px hsl(var(--primary) / 0.12);
          color: hsl(var(--primary));
          font-weight: 600;
        }
        /* Sheet 标签条：溢出横向滚动 + 两端渐隐，隐藏原生滚动条 */
        .xlsx-tabstrip {
          -webkit-mask-image: linear-gradient(to right, transparent 0, black 12px, black calc(100% - 12px), transparent 100%);
          mask-image: linear-gradient(to right, transparent 0, black 12px, black calc(100% - 12px), transparent 100%);
          scrollbar-width: none;
        }
        .xlsx-tabstrip::-webkit-scrollbar {
          display: none;
        }
      `}</style>
    </div>
  );
};

export default XlsxPreview;
