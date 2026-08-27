/**
 * pdfref:// 内部协议 —— 笔记内「PDF 来源行」回链（0824 Wave2-B r5，S4）。
 *
 * 与 mention 插件的 note:// 协议同构：markdown 链接的 href 携带
 * `pdfref://<sourceId>?page=<N>`，点击侧解析后派发既有的 `pdf-ref:open`
 * 事件（WorkbenchEventBridge / legacy ChatV2Page 均已监听：拉起对应
 * textbook/file 资源窗并经 pdf-ref:focus 跳到目标页）。
 *
 * 写入侧（PDF 批注汇总导出 / 摘录笔记来源行）经 buildPdfRefHref 生成；
 * 两侧共用本模块，格式只此一处定义。
 */

export const PDF_REF_HREF_PROTOCOL = 'pdfref://';

export interface PdfRefHrefTarget {
  /** DSTU 资源 id（如 tb_xxx / file_xxx），即 pdf-ref:open 的 sourceId */
  sourceId: string;
  /** 目标页码（1-based） */
  page: number;
}

/** 构造来源行回链 href：`pdfref://tb_xxx?page=3` */
export function buildPdfRefHref(sourceId: string, page: number): string {
  return `${PDF_REF_HREF_PROTOCOL}${encodeURIComponent(sourceId)}?page=${page}`;
}

/**
 * 从 href 解析回链目标。
 * 支持 `pdfref://id?page=3`（标准形态）与宽松的 `pdfref://id`（无页码返回 null，
 * 没有页码的回链无法定位，视为无效）。页码非正整数一律判无效。
 */
export function parsePdfRefHref(href: string | null | undefined): PdfRefHrefTarget | null {
  if (!href || typeof href !== 'string') return null;
  const trimmed = href.trim();
  if (!trimmed.startsWith(PDF_REF_HREF_PROTOCOL)) return null;
  const rest = trimmed.slice(PDF_REF_HREF_PROTOCOL.length);
  const queryIndex = rest.search(/[?#]/);
  const rawId = (queryIndex >= 0 ? rest.slice(0, queryIndex) : rest).trim();
  if (!rawId) return null;

  let sourceId = rawId;
  try {
    sourceId = decodeURIComponent(rawId);
  } catch {
    /* 尽力解码：失败保留原文 */
  }

  const query = queryIndex >= 0 ? rest.slice(queryIndex + 1) : '';
  const pageMatch = /(?:^|[?&#])page=(\d+)/.exec(query);
  if (!pageMatch) return null;
  const page = Number.parseInt(pageMatch[1], 10);
  if (!Number.isInteger(page) || page <= 0) return null;

  return { sourceId, page };
}
