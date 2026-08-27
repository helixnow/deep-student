/**
 * Crepe 编辑器 pdfref:// 来源行回链插件（0824 Wave2-B r5，S4）
 *
 * 笔记里的 PDF 摘录/批注来源行写成 markdown 链接
 * `[…第 N 页](pdfref://tb_xxx?page=N)`，点击即回到原 PDF 对应页
 * （对标 Zotero「Show on Page」）。本插件只做 click 拦截 + 事件派发，
 * 打开/跳页全部复用既有 pdf-ref:open → pdf-ref:focus 链路。
 *
 * 使用（由 plugins/index.ts 统一注册）：
 *   crepe.editor.use(pdfRefPlugin());
 *   // 需在 crepe.create() 之前
 */

import { Plugin, PluginKey } from '@milkdown/prose/state';
import { $prose } from '@milkdown/utils';

import { handlePdfRefLinkClick } from './click';

export {
  PDF_REF_HREF_PROTOCOL,
  buildPdfRefHref,
  parsePdfRefHref,
  type PdfRefHrefTarget,
} from './protocol';
export { PDF_REF_EVENTS, dispatchOpenPdfRef, type PdfRefOpenDetail } from './types';
export { handlePdfRefLinkClick } from './click';

export const pdfRefKey = new PluginKey('crepePdfRefLink');

/** 统一入口：返回可 `editor.use(...)` 的插件。不自行注册到 Crepe。 */
export function pdfRefPlugin() {
  return $prose(() =>
    new Plugin({
      key: pdfRefKey,
      props: {
        handleDOMEvents: {
          click(view, event) {
            return handlePdfRefLinkClick(view, event);
          },
        },
      },
    }),
  );
}
