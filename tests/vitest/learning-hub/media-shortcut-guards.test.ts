/**
 * 媒体/图片查看器快捷键守卫 + 预览壳 ⌘F 转发契约
 *
 * - 单键快捷键（F 全屏 / M 静音 / R 旋转等）必须放行 ⌘/Ctrl/Alt 组合键，
 *   否则 ⌘F（搜索）触发全屏、⌘M（最小化）静音、⌘R（刷新）旋转图片。
 * - 壳层 ⌘F 对 EPUB/PDF 只做事件转发（不做 DOM 扫描），
 *   且 canSearch=false 时不 preventDefault 空吞按键。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  hasShortcutModifier,
  isInteractiveShortcutTarget,
} from '@/features/learning-hub/apps/views/media/mediaShortcuts';

function readSource(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), 'utf-8');
}

describe('hasShortcutModifier', () => {
  it('returns false for bare keys so single-key player shortcuts stay active', () => {
    expect(hasShortcutModifier({ metaKey: false, ctrlKey: false, altKey: false })).toBe(false);
  });

  it.each([
    ['meta（⌘F 搜索）', { metaKey: true, ctrlKey: false, altKey: false }],
    ['ctrl（Windows Ctrl+F）', { metaKey: false, ctrlKey: true, altKey: false }],
    ['alt', { metaKey: false, ctrlKey: false, altKey: true }],
    ['meta+ctrl+alt', { metaKey: true, ctrlKey: true, altKey: true }],
  ])('returns true with %s so the viewer must not consume the key', (_label, event) => {
    expect(hasShortcutModifier(event)).toBe(true);
  });
});

describe('isInteractiveShortcutTarget', () => {
  it('recognizes native controls and ARIA sliders', () => {
    expect(isInteractiveShortcutTarget(document.createElement('button'))).toBe(true);
    expect(isInteractiveShortcutTarget(document.createElement('input'))).toBe(true);
    const slider = document.createElement('div');
    slider.setAttribute('role', 'slider');
    expect(isInteractiveShortcutTarget(slider)).toBe(true);
  });

  it('treats plain containers and null as non-interactive', () => {
    expect(isInteractiveShortcutTarget(document.createElement('div'))).toBe(false);
    expect(isInteractiveShortcutTarget(null)).toBe(false);
  });
});

describe('media/image keydown guards (source contract)', () => {
  it.each([
    'src/features/learning-hub/apps/views/media/VideoPlayer.tsx',
    'src/features/learning-hub/apps/views/media/AudioPlayer.tsx',
  ])('%s early-returns on modifier combos before its key switch', (file) => {
    const source = readSource(file);
    expect(source).toContain('if (hasShortcutModifier(event)) return;');
    expect(source.indexOf('hasShortcutModifier(event)')).toBeLessThan(
      source.indexOf('switch (event.key)'),
    );
  });

  it('ImageContentView guards ⌘R against being hijacked as rotate', () => {
    const source = readSource('src/features/learning-hub/apps/views/ImageContentView.tsx');
    expect(source).toContain('if (hasShortcutModifier(e)) return;');
    expect(source.indexOf('hasShortcutModifier(e)')).toBeLessThan(
      source.indexOf('switch (e.key)'),
    );
  });
});

describe('preview shell ⌘F (source contract)', () => {
  const shell = readSource('src/features/workbench/apps/preview/FilePreviewAppWindow.tsx');

  it('forwards search to embedded EPUB/PDF readers instead of DOM scanning', () => {
    expect(shell).toContain("previewMode === 'epub' || previewMode === 'pdf'");
    expect(shell).toContain("new CustomEvent('epub-preview-open-search')");
    expect(shell).toContain("new CustomEvent('pdf-preview-open-search')");
  });

  it('only preventDefaults ⌘F when canSearch is true (no key swallowing)', () => {
    expect(shell).toMatch(
      /if \(canSearch\) \{\s*event\.preventDefault\(\);\s*openSearchPanel\(\);/,
    );
  });

  it('EnhancedPdfViewer exposes the forward target and listens for the event', () => {
    const pdf = readSource('src/features/pdf/components/EnhancedPdfViewer.tsx');
    expect(pdf).toContain('data-pdf-preview');
    expect(pdf).toContain("addEventListener('pdf-preview-open-search'");
    expect(pdf).toContain("removeEventListener('pdf-preview-open-search'");
  });
});
