/**
 * 图片全屏预览（portal 到 document.body）
 * 原尺寸 / 适应屏幕切换；Esc 或点击遮罩关闭。
 */

import i18next from 'i18next';

export type LightboxFitMode = 'contain' | 'original';

export interface LightboxState {
  src: string;
  alt: string;
  mode: LightboxFitMode;
}

let activeRoot: HTMLDivElement | null = null;
let keyHandler: ((e: KeyboardEvent) => void) | null = null;

function t(key: string): string {
  try {
    return String(i18next.t(key));
  } catch {
    return key;
  }
}

function applyFitMode(img: HTMLImageElement, mode: LightboxFitMode): void {
  img.classList.toggle('crepe-image-lightbox__img--contain', mode === 'contain');
  img.classList.toggle('crepe-image-lightbox__img--original', mode === 'original');
}

export function isLightboxOpen(): boolean {
  return activeRoot != null;
}

/** 点击目标是否为应关闭预览的遮罩/空白层（非图片、非工具栏） */
export function shouldCloseLightboxFromClick(
  target: EventTarget | null,
  surfaces: { root: EventTarget; backdrop: EventTarget; stage: EventTarget },
): boolean {
  return (
    target === surfaces.root ||
    target === surfaces.backdrop ||
    target === surfaces.stage
  );
}

export function closeImageLightbox(): void {
  if (keyHandler) {
    document.removeEventListener('keydown', keyHandler, true);
    keyHandler = null;
  }
  if (activeRoot) {
    activeRoot.remove();
    activeRoot = null;
  }
}

export function openImageLightbox(src: string, alt = ''): void {
  if (typeof document === 'undefined') return;
  closeImageLightbox();

  const root = document.createElement('div');
  root.className = 'crepe-image-lightbox';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', t('notes:editor.image.lightbox_label'));

  const backdrop = document.createElement('div');
  backdrop.className = 'crepe-image-lightbox__backdrop';

  const stage = document.createElement('div');
  stage.className = 'crepe-image-lightbox__stage';

  const img = document.createElement('img');
  img.className = 'crepe-image-lightbox__img crepe-image-lightbox__img--contain';
  img.src = src;
  img.alt = alt || t('notes:editor.image.lightbox_alt');
  img.draggable = false;

  const toolbar = document.createElement('div');
  toolbar.className = 'crepe-image-lightbox__toolbar';

  const fitBtn = document.createElement('button');
  fitBtn.type = 'button';
  fitBtn.className = 'crepe-image-lightbox__btn';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'crepe-image-lightbox__btn crepe-image-lightbox__btn--close';
  closeBtn.textContent = t('notes:editor.image.lightbox_close');

  let mode: LightboxFitMode = 'contain';

  const syncFitLabel = () => {
    const label =
      mode === 'contain'
        ? t('notes:editor.image.lightbox_original')
        : t('notes:editor.image.lightbox_fit');
    fitBtn.textContent = label;
    fitBtn.setAttribute('aria-label', label);
  };
  syncFitLabel();

  fitBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    mode = mode === 'contain' ? 'original' : 'contain';
    applyFitMode(img, mode);
    syncFitLabel();
  });

  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeImageLightbox();
  });

  // 点遮罩 / stage 空白关闭；点图片或工具栏不关闭（原尺寸大图仍可滚动）
  const tryCloseFromOverlay = (e: MouseEvent) => {
    if (
      shouldCloseLightboxFromClick(e.target, {
        root,
        backdrop,
        stage,
      })
    ) {
      closeImageLightbox();
    }
  };
  root.addEventListener('click', tryCloseFromOverlay);
  toolbar.addEventListener('click', (e) => {
    e.stopPropagation();
  });
  img.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  keyHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeImageLightbox();
    }
  };
  document.addEventListener('keydown', keyHandler, true);

  toolbar.append(fitBtn, closeBtn);
  stage.append(img);
  root.append(backdrop, toolbar, stage);
  document.body.appendChild(root);
  activeRoot = root;

  // 聚焦关闭按钮，便于键盘操作
  requestAnimationFrame(() => {
    closeBtn.focus();
  });
}

/** 供单测：切换模式文案与 class 语义 */
export function nextLightboxFitMode(mode: LightboxFitMode): LightboxFitMode {
  return mode === 'contain' ? 'original' : 'contain';
}
