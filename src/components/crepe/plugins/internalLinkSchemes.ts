/**
 * 应用内部链接协议在编辑器里保留 href。
 *
 * Milkdown 7.22 起 link mark 的 toDOM 会把 http/https/mailto/tel/ftp 之外的协议
 * 一律清成空串（防 javascript: 等）。笔记里的 `pdfref://`（PDF 来源行回链）与
 * `note://`（@ 提及）因此渲染成 `<a href="">`，各自的点击插件读不到目标，点了没反应。
 * 这里只对这两个内部协议放行，其余仍走 Milkdown 原清洗。
 */

import { linkSchema } from '@milkdown/kit/preset/commonmark';

import { NOTE_HREF_PROTOCOL } from './mention/types';
import { PDF_REF_HREF_PROTOCOL } from './pdfRef/protocol';
import { MEDIA_REF_HREF_PROTOCOL } from './mediaRef/protocol';

const INTERNAL_LINK_PROTOCOLS = [PDF_REF_HREF_PROTOCOL, NOTE_HREF_PROTOCOL, MEDIA_REF_HREF_PROTOCOL];

export function isInternalLinkHref(href: unknown): href is string {
  if (typeof href !== 'string') return false;
  const value = href.trim().toLowerCase();
  return INTERNAL_LINK_PROTOCOLS.some((protocol) => value.startsWith(protocol));
}

export const internalLinkSchema = linkSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    toDOM: (mark, inline) => {
      const dom = base.toDOM!(mark, inline);
      if (!isInternalLinkHref(mark.attrs.href) || !Array.isArray(dom)) return dom;
      const [tag, attrs, ...rest] = dom as [string, Record<string, unknown>, ...unknown[]];
      return [tag, { ...attrs, href: mark.attrs.href.trim() }, ...rest] as typeof dom;
    },
  };
});
