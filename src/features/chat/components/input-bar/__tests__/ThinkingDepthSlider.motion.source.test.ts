import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('ThinkingDepthSlider spring snap motion', () => {
  const css = readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/input-bar/ThinkingDepthSlider.css'),
    'utf-8'
  );
  const source = readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/input-bar/ThinkingDepthSlider.tsx'),
    'utf-8'
  );

  it('uses the shared gentle spring curve for discrete snap movement', () => {
    expect(css).toContain('--tds-snap-dur: 220ms;');
    expect(css).toContain('--tds-snap-ease: cubic-bezier(0.16, 1, 0.3, 1);');
    expect(css).toContain('transition: transform var(--tds-snap-dur) var(--tds-snap-ease);');
    // 拇指 snap 走 transform 合成器动画；禁止回退到逐帧 layout 的 left 过渡
    expect(css).toContain('.tds-thumb-positioner {');
    expect(css).not.toContain('transition: left');
    expect(css).not.toContain('will-change: left');
    expect(css).not.toContain('--digit-ease');
    expect(css).not.toContain('transition: all');
  });

  it('uses a nonlinear magnetic curve while dragging instead of jumping between stop indices', () => {
    expect(source).toContain('function magnetizeRatio');
    expect(source).toContain('Math.pow(closeness, MAGNETIC_PULL_CURVE)');
    expect(source).toContain('setDragRatio(rawRatio);');

    const draggingCss = css.slice(css.indexOf('.tds-root[data-dragging] .tds-fill {'));
    expect(draggingCss).toContain('transition: none;');
  });

  it('matches the Codex-style pill track and oversized white thumb silhouette', () => {
    expect(css).toContain('--tds-rail-height: 24px;');
    expect(css).toContain('--tds-thumb-size: 28px;');
    expect(css).toContain('--tds-thumb-inset: 14px;');
    expect(css).toContain('--tds-track-active: hsl(var(--primary));');
    expect(css).toContain('padding: 0;');

    const railStart = css.indexOf('.tds-rail {');
    const railEnd = css.indexOf('.tds-fill {', railStart);
    const railCss = css.slice(railStart, railEnd);
    expect(railCss).toContain('width: 100%;');
    expect(railCss).toContain('margin-inline: 0;');
    expect(railCss).toContain('overflow: visible;');

    expect(css).toContain('.tds-range {');
    expect(css).toContain('inset: 0 var(--tds-thumb-inset);');
    expect(css).toContain('width: calc(100% - var(--tds-thumb-inset));');
    expect(source).toContain('const usableWidth = Math.max(1, rect.width - thumbInset * 2);');

    const tickStart = css.indexOf('.tds-tick {');
    const tickEnd = css.indexOf(".tds-tick[data-lit='true']", tickStart);
    const tickCss = css.slice(tickStart, tickEnd);
    expect(tickCss).toContain('width: 4px;');
    expect(tickCss).toContain('height: 4px;');

    const scaleStart = css.indexOf('.tds-scale-label {');
    const scaleEnd = css.indexOf('.tds-scale-label-efficient {', scaleStart);
    const scaleCss = css.slice(scaleStart, scaleEnd);
    expect(scaleCss).toContain('color: var(--text-muted);');

    const thumbStart = css.indexOf('.tds-thumb-core {');
    const thumbEnd = css.indexOf('.tds-drag-label-slot {', thumbStart);
    const thumbCss = css.slice(thumbStart, thumbEnd);
    expect(thumbCss).toContain('width: var(--tds-thumb-size);');
    expect(thumbCss).toContain('height: var(--tds-thumb-size);');
    expect(thumbCss).toContain('background: var(--surface-elevated);');
    expect(thumbCss).toContain('border: 1px solid var(--border-default);');
  });

  it('gives active stops a restrained elastic acknowledgement', () => {
    const tickStart = css.indexOf('.tds-tick {');
    const tickEnd = css.indexOf('.tds-thumb {', tickStart);
    const tickCss = css.slice(tickStart, tickEnd);

    expect(tickCss).toContain('transform 180ms var(--tds-snap-ease)');
    expect(tickCss).toContain('scale(1.25)');
  });

  it('keeps the canvas treatment to a flat low-contrast sheen', () => {
    expect(source).toContain('context.fillRect');
    expect(source).not.toContain('context.stroke()');
    expect(source).not.toContain('Math.sin(');
  });

  it('enlarges the thumb on hover with a bouncy spring and further on drag', () => {
    expect(css).toContain('--tds-thumb-hover-scale: 1.1;');
    expect(css).toContain('--tds-thumb-drag-scale: 1.18;');
    expect(css).toContain('--tds-thumb-hold-dur: 220ms;');
    expect(css).toContain('--tds-thumb-release-dur: 160ms;');
    expect(css).toContain('--tds-thumb-ease: cubic-bezier(0.22, 1, 0.36, 1);');
    expect(css).toContain('--tds-thumb-hover-ease: cubic-bezier(0.34, 1.45, 0.64, 1);');

    const thumbStart = css.indexOf('.tds-thumb-core {');
    const thumbEnd = css.indexOf('.tds-drag-label-slot {', thumbStart);
    const thumbCss = css.slice(thumbStart, thumbEnd);
    expect(thumbCss).toContain('transition: transform var(--tds-thumb-release-dur) var(--tds-thumb-ease)');
    expect(thumbCss).toContain('.tds-track:hover .tds-thumb-core');
    expect(thumbCss).toContain('transform: scale(var(--tds-thumb-hover-scale));');
    expect(thumbCss).toContain('.tds-root[data-dragging] .tds-track .tds-thumb-core');
    expect(thumbCss).toContain('transform: scale(var(--tds-thumb-drag-scale));');
  });

  it('briefly fades in the guidance row when the long press is recognized', () => {
    expect(css).toContain('--tds-guidance-dur: 140ms;');
    expect(css).toContain('--tds-guidance-ease: cubic-bezier(0.22, 1, 0.36, 1);');

    const guidanceStart = css.indexOf('.tds-drag-label-slot {');
    const guidanceEnd = css.indexOf('.tds-scale-label {', guidanceStart);
    const guidanceCss = css.slice(guidanceStart, guidanceEnd);
    expect(guidanceCss).toContain('animation: tds-guidance-in var(--tds-guidance-dur) var(--tds-guidance-ease) both;');
    expect(css).toContain('@keyframes tds-guidance-in');
  });

  it('keeps the reduced-motion override for every snapping element', () => {
    const reducedMotion = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));

    expect(reducedMotion).toContain('.tds-root .tds-fill');
    expect(reducedMotion).toContain('.tds-root .tds-thumb');
    expect(reducedMotion).toContain('.tds-root .tds-tick');
    expect(reducedMotion).toContain('transition: none;');
    expect(reducedMotion).toContain('.tds-root .tds-drag-label-slot');
    expect(reducedMotion).toContain('animation: none;');
  });
});
