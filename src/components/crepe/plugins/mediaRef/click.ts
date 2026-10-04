/**
 * 点击媒体回链 → media-ref:open
 * - `<a href="mediaref://…">` 链接
 * - 装饰插件包裹的 `[媒体@id:mm:ss]` 纯文本标记（data-media-ref-id）
 */

import type { EditorView } from '@milkdown/prose/view';

import { dispatchOpenMediaRef } from '@/features/learning-hub/apps/views/media/mediaRefEvents';
import { parseMediaRefHref } from './protocol';

export const MEDIA_REF_ANCHOR_ATTR = 'data-media-ref-id';
export const MEDIA_REF_SECONDS_ATTR = 'data-media-ref-seconds';

export function handleMediaRefClick(view: EditorView, event: MouseEvent): boolean {
  const target = event.target;
  if (!(target instanceof Element)) return false;

  const anchor = target.closest('a[href]');
  if (anchor instanceof HTMLAnchorElement && view.dom.contains(anchor)) {
    const ref = parseMediaRefHref(anchor.getAttribute('href'));
    if (ref) {
      event.preventDefault();
      event.stopPropagation();
      dispatchOpenMediaRef(ref.resourceId, ref.seconds);
      return true;
    }
  }

  const marker = target.closest(`[${MEDIA_REF_ANCHOR_ATTR}]`);
  if (marker && view.dom.contains(marker)) {
    const resourceId = marker.getAttribute(MEDIA_REF_ANCHOR_ATTR);
    const seconds = Number(marker.getAttribute(MEDIA_REF_SECONDS_ATTR));
    if (resourceId && Number.isFinite(seconds) && seconds >= 0) {
      event.preventDefault();
      event.stopPropagation();
      dispatchOpenMediaRef(resourceId, seconds);
      return true;
    }
  }
  return false;
}
