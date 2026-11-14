/**
 * Crepe 图片上传调试：采集元素信息、编辑器里 ImageBlock 的 DOM 快照，以及点击目标对上传相关选择器的匹配情况。
 */

import type { DOMInfo, ImageBlockDOMSnapshot, SelectorMatchResult } from './model';

/**
 * 捕获 DOM 元素信息
 */
export const captureDOMInfo = (element: HTMLElement | null): DOMInfo | undefined => {
  if (!element) return undefined;
  
  const attrs: Record<string, string> = {};
  for (let i = 0; i < element.attributes.length; i++) {
    const attr = element.attributes[i];
    attrs[attr.name] = attr.value;
  }
  
  return {
    tagName: element.tagName.toLowerCase(),
    className: element.className,
    id: element.id,
    innerText: element.innerText?.slice(0, 100),
    attributes: attrs,
  };
};

/**
 * 捕获 ImageBlock DOM 快照
 */
export const captureImageBlockSnapshot = (container: HTMLElement | null): ImageBlockDOMSnapshot => {
  if (!container) {
    container = document.querySelector('.crepe-editor-wrapper') as HTMLElement | null;
  }
  
  const snapshot: ImageBlockDOMSnapshot = {
    hasImageBlock: false,
    hasImageInline: false,
    hasImageEdit: false,
    hasPlaceholder: false,
    hasUploader: false,
    hasHiddenInput: false,
    imageBlockClasses: [],
    fullDOMPath: [],
  };
  
  if (!container) return snapshot;
  
  const imageBlock = container.querySelector('.milkdown-image-block');
  const imageInline = container.querySelector('.milkdown-image-inline');
  const imageEdit = container.querySelector('.image-edit');
  const placeholder = container.querySelector('.placeholder');
  const uploader = container.querySelector('.uploader');
  const hiddenInput = container.querySelector('input[type="file"].hidden, input[type="file"][style*="display: none"]');
  
  snapshot.hasImageBlock = !!imageBlock;
  snapshot.hasImageInline = !!imageInline;
  snapshot.hasImageEdit = !!imageEdit;
  snapshot.hasPlaceholder = !!placeholder;
  snapshot.hasUploader = !!uploader;
  snapshot.hasHiddenInput = !!hiddenInput;
  
  if (imageBlock) {
    snapshot.imageBlockClasses = Array.from(imageBlock.classList);
  }
  
  if (hiddenInput) {
    snapshot.hiddenInputId = (hiddenInput as HTMLInputElement).id;
  }
  
  if (uploader && uploader.tagName === 'LABEL') {
    snapshot.uploaderForAttr = (uploader as HTMLLabelElement).htmlFor;
  }
  
  // 构建 DOM 路径
  if (uploader) {
    let current: HTMLElement | null = uploader as HTMLElement;
    const path: string[] = [];
    while (current && current !== container) {
      const tag = current.tagName.toLowerCase();
      const cls = current.className ? `.${current.className.split(' ').join('.')}` : '';
      path.unshift(`${tag}${cls}`);
      current = current.parentElement;
    }
    snapshot.fullDOMPath = path;
  }
  
  return snapshot;
};

/**
 * 检查选择器匹配
 */
export const checkSelectorMatches = (target: HTMLElement): SelectorMatchResult[] => {
  const selectors = [
    'label.uploader',
    '.uploader',
    '.placeholder',
    '.image-edit',
    '.link-importer',
    '.milkdown-image-block',
    '.milkdown-image-inline',
    'input[type="file"]',
  ];
  
  return selectors.map(selector => {
    const matched = target.closest(selector);
    return {
      selector,
      matched: !!matched,
      matchedElement: matched ? captureDOMInfo(matched as HTMLElement) : undefined,
    };
  });
};
