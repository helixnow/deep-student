/**
 * 收集编辑器内全部可预览图片，作为 lightbox 左右切换的画廊。
 */

import type { LightboxGalleryItem } from './lightboxDom';
import { resolveLightboxImageTarget } from './resolveImageTarget';

export function collectLightboxGallery(
  editorRoot: ParentNode,
  clicked: HTMLImageElement,
): { gallery: LightboxGalleryItem[]; startIndex: number } {
  const gallery: LightboxGalleryItem[] = [];
  let startIndex = 0;

  const candidates = editorRoot.querySelectorAll('img');
  candidates.forEach((el) => {
    const img = resolveLightboxImageTarget(el, editorRoot);
    if (!img) return;
    const src = img.currentSrc || img.getAttribute('src') || '';
    if (!src) return;
    if (img === clicked) startIndex = gallery.length;
    gallery.push({ src, alt: img.getAttribute('alt') || '' });
  });

  if (gallery.length === 0) {
    const src = clicked.currentSrc || clicked.getAttribute('src') || '';
    gallery.push({ src, alt: clicked.getAttribute('alt') || '' });
    startIndex = 0;
  }

  return { gallery, startIndex };
}
