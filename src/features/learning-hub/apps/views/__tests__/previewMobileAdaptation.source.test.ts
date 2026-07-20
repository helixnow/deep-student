/**
 * 文件预览类视图移动端适配 — source 守卫
 *
 * 2026-07-20 移动端适配审计的回归防线（375-430px 窄视口）：
 * - UnifiedPreviewToolbar 在 <md 收敛按钮数量（重置类操作让位给 ≥44px 触控目标），
 *   幻灯片页码在窄屏使用紧凑数字读数；
 * - DocxPreview 移动端收窄台面留白，提高 autoScale 后的可读宽度；
 * - EpubPreview 的移动端断点与 App shell 同源（md=768），不再自造 700px；
 * - XlsxPreview 多 Sheet 时窄屏隐藏尺寸读数，防止底部状态条挤压标签条；
 * - TextFilePreview 触屏触控目标 ≥44px、Markdown 长词不横向溢出。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const viewsDir = path.join(process.cwd(), 'src/features/learning-hub/apps/views');

function read(fileName: string): string {
  return readFileSync(path.join(viewsDir, fileName), 'utf8');
}

describe('UnifiedPreviewToolbar mobile adaptation', () => {
  const source = read('UnifiedPreviewToolbar.tsx');

  it('hides the standalone zoom-reset button below md (action stays reachable via zoom menu)', () => {
    const zoomResetButton = source.match(/<DsButton[^>]*onClick=\{onZoomReset\}[^>]*className="[^"]*max-md:hidden[^"]*"[^>]*\/?>|className="modern-viewer-icon-button max-md:hidden" onClick=\{onZoomReset\}/);
    expect(zoomResetButton, 'zoom reset 按钮应带 max-md:hidden').not.toBeNull();
    // 菜单内的重置项必须保留，作为移动端的等价入口
    expect(source).toContain("<AppMenuItem disabled={zoomIsDefault} onClick={onZoomReset}>");
  });

  it('hides the font-reset button below md', () => {
    expect(source).toContain('className="modern-viewer-icon-button max-md:hidden" onClick={onFontReset}');
  });

  it('renders a compact numeric slide readout below md and keeps the full label for md+', () => {
    expect(source).toContain('max-md:hidden');
    expect(source).toMatch(/md:hidden[^"]*"[^>]*aria-hidden="true"\s*>\s*\{slideNav\.current \+ 1\} \/ \{slideNav\.total\}/);
  });

  it('keeps coarse-pointer touch targets at >=44px on toolbar buttons', () => {
    expect(source).toContain('[@media(pointer:coarse)]:[&_button]:min-h-11');
    expect(source).toContain('[@media(pointer:coarse)]:[&_button]:min-w-11');
  });
});

describe('DocxPreview mobile desk padding', () => {
  const source = read('DocxPreview.tsx');

  it('uses the shared useIsMobile hook (md=768) instead of a bespoke breakpoint', () => {
    expect(source).toContain("import { useIsMobile } from '@/hooks/useBreakpoint'");
    expect(source).toContain('const isMobile = useIsMobile();');
  });

  it('narrows desk padding on mobile and feeds it into the autoScale computation', () => {
    expect(source).toContain('DESK_PADDING_X_MOBILE');
    expect(source).toContain('DESK_PADDING_Y_MOBILE');
    expect(source).toContain('viewport.clientWidth - deskPaddingXRef.current * 2');
    // 骨架屏与真实台面必须使用同一份响应式留白，加载完成后无缝过渡
    expect(source).toContain('padding: `${deskPaddingY}px ${deskPaddingX}px 0`');
    expect(source).toContain('padding: ${deskPaddingY}px ${deskPaddingX}px;');
  });
});

describe('EpubPreview breakpoint alignment', () => {
  it('derives narrow-mode from useIsMobile, not a hand-rolled 700px media query', () => {
    const source = read('EpubPreview.tsx');
    expect(source).toContain("import { useIsMobile } from '@/hooks/useBreakpoint'");
    expect(source).toContain('const isNarrow = useIsMobile();');
    expect(source).not.toContain('max-width: 700px');
  });

  it('keeps the stylesheet media query in sync with the md=768 shell boundary', () => {
    const css = read('EpubPreview.css');
    expect(css).toContain('@media (width < 768px)');
    expect(css).not.toContain('700px');
  });
});

describe('XlsxPreview narrow status bar', () => {
  it('hides the dimensions readout below sm only when multiple sheets compete for space', () => {
    const source = read('XlsxPreview.tsx');
    expect(source).toContain("sheetCount > 1 ? 'tabular-nums max-sm:hidden' : 'tabular-nums'");
  });
});

describe('TextFilePreview touch targets and overflow', () => {
  const source = read('TextFilePreview.tsx');

  it('grows the copy button and csv sort headers to >=44px on coarse pointers', () => {
    expect(source).toContain('[@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:px-2.5');
    expect(source).toContain('hover:bg-accent [@media(pointer:coarse)]:min-h-11');
    expect(source).toContain('gap-1.5 [@media(pointer:coarse)]:min-h-11');
  });

  it('prevents long-word horizontal overflow in markdown prose', () => {
    expect(source).toContain('prose prose-sm dark:prose-invert max-w-none break-words');
  });
});
