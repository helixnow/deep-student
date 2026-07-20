import { describe, expect, it } from 'vitest';
import { collectLightboxGallery } from '../collectGallery';
import {
  clampGalleryIndex,
  nextLightboxFitMode,
  shouldCloseLightboxFromClick,
} from '../lightboxDom';
import { resolveLightboxImageTarget } from '../resolveImageTarget';
import { isNonEmptyHref } from '../nonEmptyHref';

describe('isNonEmptyHref', () => {
  it('rejects empty / whitespace / nullish', () => {
    expect(isNonEmptyHref(undefined)).toBe(false);
    expect(isNonEmptyHref(null)).toBe(false);
    expect(isNonEmptyHref('')).toBe(false);
    expect(isNonEmptyHref('   ')).toBe(false);
  });

  it('accepts trimmed non-empty href', () => {
    expect(isNonEmptyHref('https://example.com')).toBe(true);
    expect(isNonEmptyHref('  /path  ')).toBe(true);
  });
});

describe('nextLightboxFitMode', () => {
  it('toggles contain ↔ original', () => {
    expect(nextLightboxFitMode('contain')).toBe('original');
    expect(nextLightboxFitMode('original')).toBe('contain');
  });
});

describe('shouldCloseLightboxFromClick', () => {
  it('closes on root / backdrop / stage only', () => {
    const root = document.createElement('div');
    const backdrop = document.createElement('div');
    const stage = document.createElement('div');
    const img = document.createElement('img');
    const surfaces = { root, backdrop, stage };

    expect(shouldCloseLightboxFromClick(root, surfaces)).toBe(true);
    expect(shouldCloseLightboxFromClick(backdrop, surfaces)).toBe(true);
    expect(shouldCloseLightboxFromClick(stage, surfaces)).toBe(true);
    expect(shouldCloseLightboxFromClick(img, surfaces)).toBe(false);
    expect(shouldCloseLightboxFromClick(null, surfaces)).toBe(false);
  });
});

describe('resolveLightboxImageTarget', () => {
  it('returns img inside milkdown-image-block', () => {
    const root = document.createElement('div');
    const host = document.createElement('div');
    host.className = 'milkdown-image-block';
    const img = document.createElement('img');
    img.src = 'https://example.com/a.png';
    host.appendChild(img);
    root.appendChild(host);

    expect(resolveLightboxImageTarget(img, root)).toBe(img);
  });

  it('returns null for img outside image hosts', () => {
    const root = document.createElement('div');
    const img = document.createElement('img');
    img.src = 'https://example.com/a.png';
    root.appendChild(img);

    expect(resolveLightboxImageTarget(img, root)).toBeNull();
  });

  it('returns null for broken placeholder images', () => {
    const root = document.createElement('div');
    const host = document.createElement('div');
    host.className = 'milkdown-image-block';
    const img = document.createElement('img');
    img.src = 'https://example.com/a.png';
    img.classList.add('crepe-image--broken');
    host.appendChild(img);
    root.appendChild(host);

    expect(resolveLightboxImageTarget(img, root)).toBeNull();
  });

  it('resolves from child click target via closest(img)', () => {
    const root = document.createElement('div');
    const host = document.createElement('div');
    host.className = 'milkdown-image-block';
    const img = document.createElement('img');
    img.src = 'https://example.com/a.png';
    // 模拟点在 img 上（target 即 img）
    host.appendChild(img);
    root.appendChild(host);

    expect(resolveLightboxImageTarget(img, root)).toBe(img);
  });
});

describe('clampGalleryIndex', () => {
  it('moves within bounds and clamps at edges', () => {
    expect(clampGalleryIndex(1, 1, 3)).toBe(2);
    expect(clampGalleryIndex(1, -1, 3)).toBe(0);
    expect(clampGalleryIndex(0, -1, 3)).toBe(0);
    expect(clampGalleryIndex(2, 1, 3)).toBe(2);
  });
});

describe('collectLightboxGallery', () => {
  function makeImage(root: HTMLElement, src: string, alt = ''): HTMLImageElement {
    const host = document.createElement('div');
    host.className = 'milkdown-image-block';
    const img = document.createElement('img');
    img.src = src;
    if (alt) img.alt = alt;
    host.appendChild(img);
    root.appendChild(host);
    return img;
  }

  it('collects document images in order and points at the clicked one', () => {
    const root = document.createElement('div');
    makeImage(root, 'https://example.com/a.png', 'A');
    const second = makeImage(root, 'https://example.com/b.png', 'B');
    makeImage(root, 'https://example.com/c.png');

    const { gallery, startIndex } = collectLightboxGallery(root, second);
    expect(gallery.map((g) => g.alt)).toEqual(['A', 'B', '']);
    expect(startIndex).toBe(1);
  });

  it('skips broken placeholders and images outside hosts', () => {
    const root = document.createElement('div');
    const ok = makeImage(root, 'https://example.com/a.png');
    const broken = makeImage(root, 'https://example.com/broken.png');
    broken.classList.add('crepe-image--broken');
    const loose = document.createElement('img');
    loose.src = 'https://example.com/loose.png';
    root.appendChild(loose);

    const { gallery, startIndex } = collectLightboxGallery(root, ok);
    expect(gallery).toHaveLength(1);
    expect(startIndex).toBe(0);
  });

  it('falls back to the clicked image when nothing resolves', () => {
    const root = document.createElement('div');
    const orphan = document.createElement('img');
    orphan.src = 'https://example.com/x.png';

    const { gallery, startIndex } = collectLightboxGallery(root, orphan);
    expect(gallery).toHaveLength(1);
    expect(startIndex).toBe(0);
  });
});
