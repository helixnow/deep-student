/**
 * Anki 卡片格式化工具函数
 *
 * 从 AnkiCardGeneration.tsx 提取的格式化相关函数
 */

import DOMPurify from 'dompurify';

/**
 * 格式化日期显示
 * @param value - 日期字符串或 null
 * @returns 格式化后的日期字符串
 */
export function formatDisplayDate(value?: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) {
    try {
      return date.toLocaleString();
    } catch {
      return value;
    }
  }
  return value;
}

/**
 * 渲染 Cloze 填空文本，高亮显示填空部分
 *
 * @param text - 包含 Cloze 语法的文本 (e.g., "{{c1::answer}}")
 * @returns 带有高亮 span 的 HTML 字符串
 *
 * @example
 * renderClozeText("The capital of France is {{c1::Paris}}")
 * // Returns: "The capital of France is <span class=\"cloze-highlight\">Paris</span>"
 */
export function renderClozeText(text: string): string {
  if (!text) return "";

  // Replace cloze syntax with HTML spans
  // We need to escape the content but keep the span tags
  const processedText = text.replace(
    /\{\{c(\d+)::([^}]+?)\}\}/g,
    (_match, _clozeNum, content) => {
      // Escape only the content inside cloze markers
      const escapedContent = content
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#x27;");
      return `<span class="cloze-highlight">${escapedContent}</span>`;
    }
  );

  // Sanitize the final HTML with DOMPurify for security
  const sanitized = DOMPurify.sanitize(processedText, {
    ALLOWED_TAGS: ["span"],
    ALLOWED_ATTR: ["class"],
  });

  return typeof sanitized === 'string' ? sanitized : String(sanitized);
}

/**
 * 解析日期字符串为时间戳
 * @param value - 日期字符串
 * @returns 时间戳，解析失败返回 0
 */
export function parseDate(value?: string): number {
  if (!value) return 0;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

/**
 * 截断文本并添加省略号
 * @param text - 原始文本
 * @param maxLength - 最大长度
 * @returns 截断后的文本
 */
export function truncateText(text: string, maxLength: number = 100): string {
  if (!text || text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}
