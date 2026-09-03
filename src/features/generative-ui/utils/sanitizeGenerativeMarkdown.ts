/**
 * Generative markdown 消毒（防御纵深）。
 *
 * Chat `MarkdownRenderer` 已挂 `rehype-raw` + `rehype-sanitize`（GitHub `defaultSchema`）：
 * script 在 schema.strip 中，on* 事件属性不在 allowlist。
 * 本函数复用同一套 allowlist，在进入渲染器前剥掉可执行 HTML，
 * 避免 mock / 管线绕过时 payload 仍以可执行形态出现。
 *
 * 围栏代码块原文保留（由渲染器按文本展示，不作为 HTML 解析）。
 */

import { defaultSchema } from 'rehype-sanitize';
import { isDangerousGenerativeUrl } from './sanitizeGenerativeUrl';

const ALLOWED_TAGS = new Set(
  (defaultSchema.tagNames ?? []).map((name) => name.toLowerCase()),
);

const STRIP_WITH_CONTENT = new Set([
  ...(defaultSchema.strip ?? []),
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'form',
]);

const STRIP_TAG_ONLY = new Set(['base', 'link', 'meta']);

const PAIRED_STRIP_RE = new RegExp(
  `<\\s*(${[...STRIP_WITH_CONTENT].join('|')})\\b[^>]*>[\\s\\S]*?<\\s*/\\s*\\1\\s*>`,
  'gi',
);

const LOOSE_STRIP_RE = new RegExp(
  `<\\s*(${[...STRIP_WITH_CONTENT, ...STRIP_TAG_ONLY].join('|')})\\b[^>]*/?\\s*>`,
  'gi',
);

const EVENT_HANDLER_ATTR_RE = /\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi

const PRESENTATION_ATTR_RE =
  /\s+(?:style|srcdoc)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

const URL_ATTR_RE =
  /(\s+(?:href|src|xlink:href|action|formaction|cite|longdesc|poster|ping|background)\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

const SRCSET_ATTR_RE =
  /(\s+srcset\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

/** Markdown 链接 / 图片：`[text](url)` 与 `![alt](url)`，不含围栏代码。 */
const MD_LINK_RE = /(!?\[[^\]]*]\()([^)]*)(\))/g;

/** 参考定义：`[ref]: javascript:…` */
const MD_REF_DEF_RE = /^(\s*\[[^\]]+]:\s*)(\S+)/gm;

/** GFM 自动链接：`<javascript:…>` / `<//evil>` */
const MD_AUTOLINK_RE = /<([^>\s]+)>/g;

export const GENERATIVE_MARKDOWN_SANITIZE_SCHEMA = defaultSchema;

function isMarkdownAutolinkTag(tag: string): boolean {
  if (!tag.startsWith('<') || !tag.endsWith('>')) return false;
  const inner = tag.slice(1, -1).trim();
  if (!inner || /\s/.test(inner)) return false;
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(inner) || inner.startsWith('//');
}

function sanitizeOpenTag(tag: string): string {
  if (isMarkdownAutolinkTag(tag)) {
    const inner = tag.slice(1, -1).trim();
    return isDangerousGenerativeUrl(inner) ? '' : tag;
  }

  const nameMatch = tag.match(/^<\s*([a-zA-Z][\w:-]*)/);
  const name = nameMatch?.[1]?.toLowerCase() ?? '';
  if (!name || !ALLOWED_TAGS.has(name)) return '';

  let cleaned = tag.replace(EVENT_HANDLER_ATTR_RE, '');
  cleaned = cleaned.replace(PRESENTATION_ATTR_RE, '');
  cleaned = cleaned.replace(URL_ATTR_RE, (full, prefix: string, d?: string, s?: string, u?: string) => {
    const value = d ?? s ?? u ?? '';
    if (isDangerousGenerativeUrl(value)) return `${prefix}""`;
    return full;
  });
  cleaned = cleaned.replace(SRCSET_ATTR_RE, (_full, prefix: string, d?: string, s?: string, u?: string) => {
    const value = d ?? s ?? u ?? '';
    const safe = value
      .split(',')
      .map((part) => part.trim())
      .filter((part) => {
        const url = part.split(/\s+/)[0] ?? '';
        return url.length > 0 && !isDangerousGenerativeUrl(url);
      })
      .join(', ');
    return `${prefix}"${safe}"`;
  });
  return cleaned;
}

function sanitizeMarkdownLinks(prose: string): string {
  return prose.replace(MD_LINK_RE, (full, prefix: string, url: string, suffix: string) => {
    const trimmed = url.trim().replace(/^<|>$/g, '');
    if (!trimmed || isDangerousGenerativeUrl(trimmed)) {
      return `${prefix}#${suffix}`;
    }
    return full;
  });
}

function sanitizeMarkdownRefDefs(prose: string): string {
  return prose.replace(MD_REF_DEF_RE, (full, prefix: string, url: string) => {
    const trimmed = url.trim();
    if (!trimmed || isDangerousGenerativeUrl(trimmed)) {
      return `${prefix}#`;
    }
    return full;
  });
}

function sanitizeMarkdownAutolinks(prose: string): string {
  return prose.replace(MD_AUTOLINK_RE, (full, inner: string) => {
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:|^\/\//.test(inner)) return full;
    return isDangerousGenerativeUrl(inner) ? '<>' : full;
  });
}

function sanitizeProseHtml(prose: string): string {
  let out = prose.replace(PAIRED_STRIP_RE, '');
  out = out.replace(LOOSE_STRIP_RE, '');
  out = out.replace(/<[^>]+>/g, (tag) => {
    if (/^<\s*\//.test(tag)) {
      const close = tag.match(/^<\s*\/\s*([a-zA-Z][\w:-]*)/);
      const name = close?.[1]?.toLowerCase() ?? '';
      return name && ALLOWED_TAGS.has(name) ? tag : '';
    }
    if (/^<\s*!(?:--|$)/.test(tag) || /^<\s*\?/.test(tag)) return '';
    return sanitizeOpenTag(tag);
  });
  return sanitizeMarkdownAutolinks(sanitizeMarkdownRefDefs(sanitizeMarkdownLinks(out)));
}

function splitFencedSegments(source: string): Array<{ code: boolean; text: string }> {
  const lines = source.split('\n');
  const segments: Array<{ code: boolean; text: string }> = [];
  let buffer: string[] = [];
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;

  const flush = (code: boolean) => {
    segments.push({ code, text: buffer.join('\n') });
    buffer = [];
  };

  for (const line of lines) {
    const open = line.match(/^( {0,3})(`{3,}|~{3,})(.*)$/);
    if (!inFence && open) {
      if (buffer.length > 0) flush(false);
      buffer.push(line);
      inFence = true;
      fenceChar = open[2][0];
      fenceLen = open[2].length;
      continue;
    }
    if (inFence && open) {
      const marker = open[2];
      const closed =
        marker[0] === fenceChar &&
        marker.length >= fenceLen &&
        open[3].trim() === '';
      if (closed) {
        buffer.push(line);
        flush(true);
        inFence = false;
        fenceChar = '';
        fenceLen = 0;
        continue;
      }
    }
    buffer.push(line);
  }
  if (buffer.length > 0) flush(inFence);
  return segments;
}

/** 剥掉可执行 HTML，保留围栏代码与安全 Markdown / 白名单标签。 */
export function sanitizeGenerativeMarkdown(markdown: string): string {
  if (!markdown) return markdown;
  return splitFencedSegments(markdown)
    .map((part) => (part.code ? part.text : sanitizeProseHtml(part.text)))
    .join('\n');
}
