/**
 * Crepe 图片点击放大（lightbox）插件
 *
 * 监听编辑器内 milkdown image-block / image-inline 渲染的 img 点击，
 * 以 portal 形式挂到 document.body 做全屏预览。
 *
 * 注册（由接线代理完成，本代理不改 plugins/index.ts）：
 *   import { imageLightboxPlugin } from './imageLightbox';
 *   crepe.editor.use(imageLightboxPlugin());
 *   // 需在 crepe.create() 之前
 */

import { Plugin, PluginKey } from '@milkdown/prose/state';
import { $prose } from '@milkdown/utils';

import './imageLightbox.css';
import { collectLightboxGallery } from './collectGallery';
import { closeImageLightbox, openImageLightbox } from './lightboxDom';
import { resolveLightboxImageTarget } from './resolveImageTarget';

export {
  clampGalleryIndex,
  closeImageLightbox,
  openImageLightbox,
  nextLightboxFitMode,
  shouldCloseLightboxFromClick,
  type LightboxGalleryItem,
  type OpenImageLightboxOptions,
} from './lightboxDom';
export { collectLightboxGallery } from './collectGallery';
export { resolveLightboxImageTarget } from './resolveImageTarget';
export { isNonEmptyHref } from './nonEmptyHref';

export const imageLightboxKey = new PluginKey('crepeImageLightbox');

export function imageLightboxPlugin() {
  return $prose(() =>
    new Plugin({
      key: imageLightboxKey,
      props: {
        handleDOMEvents: {
          click(view, event) {
            const img = resolveLightboxImageTarget(event.target, view.dom);
            if (!img) return false;

            const src = img.currentSrc || img.getAttribute('src') || '';
            if (!src) return false;

            event.preventDefault();
            event.stopPropagation();

            const { gallery, startIndex } = collectLightboxGallery(view.dom, img);
            openImageLightbox(src, img.getAttribute('alt') || '', {
              gallery,
              startIndex,
            });
            return true;
          },
        },
      },
      view() {
        return {
          destroy() {
            closeImageLightbox();
          },
        };
      },
    }),
  );
}
