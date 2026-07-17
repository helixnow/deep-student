import { describe, expect, it } from 'vitest';
import { nextLightboxFitMode, shouldCloseLightboxFromClick } from '../lightboxDom';
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
