/**
 * 点击 pdfref:// 链接 → 派发 pdf-ref:open（打开资源窗 + 跳页）
 *
 * 消费方（均为既有链路，本插件零新增通道）：
 * - workbench 模式：WorkbenchEventBridge 监听 document 的 pdf-ref:open，
 *   launch textbook/file 资源窗后按 0/250/800ms 三连发 pdf-ref:focus；
 * - legacy 模式：ChatV2Page（useChatPageEvents）监听同名事件。
 */

import type { EditorView } from '@milkdown/prose/view';

import { parsePdfRefHref } from './protocol';
import { dispatchOpenPdfRef } from './types';

/**
 * 从 click 目标解析 pdfref:// 链接。可单测。
 * 命中则 preventDefault 并派发打开事件，返回 true；否则返回 false 让
 * 其余插件（note:// 提及、默认链接行为）继续处理。
 */
export function handlePdfRefLinkClick(
  view: EditorView,
  event: MouseEvent,
): boolean {
  const target = event.target;
  if (!(target instanceof Element)) return false;

  const anchor = target.closest('a[href]');
  if (!(anchor instanceof HTMLAnchorElement)) return false;
  if (!view.dom.contains(anchor)) return false;

  const refTarget = parsePdfRefHref(anchor.getAttribute('href'));
  if (!refTarget) return false;

  event.preventDefault();
  event.stopPropagation();
  dispatchOpenPdfRef(refTarget.sourceId, refTarget.page);
  return true;
}
