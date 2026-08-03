import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('chat inline image viewer fullscreen contract', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/InlineImageViewer.tsx'),
    'utf-8'
  );

  it('renders the overlay against the full viewport instead of chat container bounds', () => {
    expect(source).toContain("inset: 0");
    expect(source).toContain("document.body.style.overflow = 'hidden'");
    expect(source).not.toContain('getBoundingClientRect()');
  });

  it('keeps the top chrome minimal and moves image actions into the bottom tray', () => {
    expect(source).not.toContain('{currentIndex + 1} / {images.length}');
    expect(source).toContain('底部操作托盘');
    expect(source).toContain('absolute inset-x-0 bottom-0 z-20');
  });

  it('marks the top hot zone as a desktop drag region for the preview window', () => {
    expect(source).toContain("'data-tauri-drag-region': true");
    expect(source).toContain("!isAndroid()");
    expect(source).toContain('getCurrentWindow().startDragging()');
    expect(source).toContain("data-no-drag");
  });

  it('keeps the top hot zone height fixed and respects safe-area fallback', () => {
    expect(source).toContain("const topHotzoneHeightClassName = 'h-[96px] sm:h-[112px]'");
    expect(source).toContain("const stageTopPaddingClassName = 'pt-[96px] sm:pt-[112px]'");
    expect(source).toContain("max(env(safe-area-inset-top, 0px), var(--safe-area-inset-top-fallback, 0px))");
  });

  it('prevents plain mouse wheel from changing preview zoom', () => {
    // wheel 必须以非 passive 的原生监听注册（React 根节点 wheel 为 passive，
    // onWheel 里 preventDefault 不生效），且仅 ctrl/meta（触控板捏合）才缩放
    expect(source).toContain("stage.addEventListener('wheel', handleWheel, { passive: false })");
    expect(source).toContain('e.preventDefault();');
    expect(source).toContain('if (e.ctrlKey || e.metaKey)');
  });

  it('only renders contextual prev and next buttons instead of disabled edge controls', () => {
    expect(source).toContain('const canNavigatePrev = images.length > 1 && currentIndex > 0');
    expect(source).toContain('const canNavigateNext = images.length > 1 && currentIndex < images.length - 1');
    expect(source).toContain('{canNavigatePrev && (');
    expect(source).toContain('{canNavigateNext && (');
    expect(source).not.toContain('disabled={currentIndex === 0}');
    expect(source).not.toContain('disabled={currentIndex === images.length - 1}');
  });
});
