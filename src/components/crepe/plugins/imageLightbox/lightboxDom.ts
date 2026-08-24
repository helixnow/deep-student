/**
 * 图片全屏预览（portal 到 document.body）
 * 原尺寸 / 适应屏幕切换；Esc / Android 返回键 / 点击遮罩关闭；← → 切换同文档图片。
 */

import i18next from 'i18next';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';

export type LightboxFitMode = 'contain' | 'original';

export interface LightboxState {
  src: string;
  alt: string;
  mode: LightboxFitMode;
}

export interface LightboxGalleryItem {
  src: string;
  alt: string;
}

export interface OpenImageLightboxOptions {
  gallery?: LightboxGalleryItem[];
  startIndex?: number;
}

let activeRoot: HTMLDivElement | null = null;
let keyHandler: ((e: KeyboardEvent) => void) | null = null;
let unregisterBack: (() => void) | null = null;

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

/** 供单测：夹取相邻图片下标（不循环，越界返回原下标） */
export function clampGalleryIndex(current: number, delta: number, length: number): number {
  const next = current + delta;
  if (next < 0 || next >= length) return current;
  return next;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function removeRootWithExitAnimation(root: HTMLDivElement): void {
  if (prefersReducedMotion()) {
    root.remove();
    return;
  }

  root.classList.add('crepe-image-lightbox--closing');
  let timer: number | null = null;
  const remove = () => {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
    root.remove();
  };
  root.addEventListener('animationend', remove, { once: true });
  // 兜底：animationend 丢失（如 display:none 祖先）时仍能移除
  timer = window.setTimeout(remove, 280);
}

export function closeImageLightbox(): void {
  if (keyHandler) {
    document.removeEventListener('keydown', keyHandler, true);
    keyHandler = null;
  }
  if (unregisterBack) {
    unregisterBack();
    unregisterBack = null;
  }
  const root = activeRoot;
  activeRoot = null;
  if (root) {
    removeRootWithExitAnimation(root);
  }
}

export function openImageLightbox(
  src: string,
  alt = '',
  options: OpenImageLightboxOptions = {},
): void {
  if (typeof document === 'undefined') return;
  closeImageLightbox();

  const gallery = options.gallery?.length ? options.gallery : [{ src, alt }];
  let index = options.startIndex ?? gallery.findIndex((item) => item.src === src);
  if (index < 0 || index >= gallery.length) index = 0;

  const root = document.createElement('div');
  root.className = 'crepe-image-lightbox';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', t('notes:editor.image.lightbox_label'));

  const backdrop = document.createElement('div');
  backdrop.className = 'crepe-image-lightbox__backdrop';

  const stage = document.createElement('div');
  stage.className = 'crepe-image-lightbox__stage';

  const spinner = document.createElement('div');
  spinner.className = 'crepe-image-lightbox__spinner';
  spinner.setAttribute('aria-hidden', 'true');

  const img = document.createElement('img');
  img.className = 'crepe-image-lightbox__img crepe-image-lightbox__img--contain';
  img.draggable = false;

  const counter = document.createElement('div');
  counter.className = 'crepe-image-lightbox__counter';
  counter.setAttribute('aria-hidden', 'true');

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

  const onImgLoad = () => {
    root.dataset.loading = 'false';
  };
  const onImgError = () => {
    root.dataset.loading = 'false';
    root.dataset.error = 'true';
  };
  img.addEventListener('load', onImgLoad);
  img.addEventListener('error', onImgError);

  const showAt = (nextIndex: number) => {
    index = nextIndex;
    const item = gallery[index]!;
    delete root.dataset.error;
    root.dataset.loading = 'true';
    img.src = item.src;
    img.alt = item.alt || t('notes:editor.image.lightbox_alt');
    if (img.complete && img.naturalWidth > 0) {
      root.dataset.loading = 'false';
    }
    counter.textContent = `${index + 1} / ${gallery.length}`;
    counter.style.display = gallery.length > 1 ? '' : 'none';
  };
  showAt(index);

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
      return;
    }
    if (gallery.length > 1 && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      e.stopPropagation();
      const delta = e.key === 'ArrowLeft' ? -1 : 1;
      const next = clampGalleryIndex(index, delta, gallery.length);
      if (next !== index) showAt(next);
    }
  };
  document.addEventListener('keydown', keyHandler, true);

  toolbar.append(fitBtn, closeBtn);
  stage.append(spinner, img);
  root.append(backdrop, toolbar, stage, counter);
  document.body.appendChild(root);
  activeRoot = root;

  // 📱 Android 系统返回键：灯箱打开时先关灯箱（overlay 级），对齐块菜单接入方式。
  // root 无 data-state="open"，Radix Escape 兜底探测不会命中，必须显式注册。
  unregisterBack = registerBackHandler(() => {
    closeImageLightbox();
    return true;
  }, BACK_PRIORITY.overlay);

  // 聚焦关闭按钮，便于键盘操作
  requestAnimationFrame(() => {
    closeBtn.focus();
  });
}

/** 供单测：切换模式文案与 class 语义 */
export function nextLightboxFitMode(mode: LightboxFitMode): LightboxFitMode {
  return mode === 'contain' ? 'original' : 'contain';
}
