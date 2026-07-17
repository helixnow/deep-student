/**
 * 判断点击目标是否为编辑器内可放大预览的图片（image-block / image-inline）。
 */

const IMAGE_HOST_SELECTOR =
  '.milkdown-image-block, .milkdown-image-inline, [data-type="image-block"], [data-type="image"]';

export function resolveLightboxImageTarget(
  target: EventTarget | null,
  editorRoot: ParentNode | null | undefined,
): HTMLImageElement | null {
  if (!(target instanceof Element) || !editorRoot) return null;

  const img =
    target instanceof HTMLImageElement
      ? target
      : target.closest('img');

  if (!img || !editorRoot.contains(img)) return null;

  // 排除破图占位、图标等非内容图
  if (img.classList.contains('crepe-image--broken')) return null;
  if (!img.getAttribute('src')) return null;

  const host = img.closest(IMAGE_HOST_SELECTOR);
  if (!host || !editorRoot.contains(host)) return null;

  return img;
}
