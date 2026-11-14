import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Skeleton,
  SkeletonReveal,
  useSkeletonGate,
} from '@/components/ui/skeleton';
import { ArtifactUndoStack } from '../artifactEditEngine';
import { DiagramAndLiveSvgView } from '../DiagramAndLiveSvgView';

describe('useSkeletonGate & SkeletonReveal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not flash skeleton when loading finishes within 200ms', () => {
    const { result, rerender } = renderHook(
      ({ loading }) => useSkeletonGate(loading, { delayMs: 200, minVisibleMs: 400 }),
      { initialProps: { loading: true } },
    );

    expect(result.current).toBe(false);

    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(result.current).toBe(false);

    // 150ms (< 200ms) 内结束加载，骨架屏一次都不出现
    rerender({ loading: false });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current).toBe(false);
  });

  it('shows skeleton after 200ms and keeps it visible for at least 400ms (minVisibleMs)', () => {
    const { result, rerender } = renderHook(
      ({ loading }) => useSkeletonGate(loading, { delayMs: 200, minVisibleMs: 400 }),
      { initialProps: { loading: true } },
    );

    expect(result.current).toBe(false);

    // 到达 200ms 门控阈值，显示骨架屏
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current).toBe(true);

    // 仅过 100ms 后加载完成（总耗时 300ms），骨架屏仍须补足剩余 300ms 驻留时间
    act(() => {
      vi.advanceTimersByTime(100);
    });
    rerender({ loading: false });
    expect(result.current).toBe(true);

    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(result.current).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(false);
  });

  it('renders SkeletonReveal with CSS Grid same-cell stacking and smooth opacity/translateY transition', () => {
    const { rerender } = render(
      <SkeletonReveal
        loading={true}
        delayMs={200}
        minVisibleMs={400}
        skeleton={<Skeleton data-testid="custom-skel" variant="pulse" className="h-12 w-full" />}
      >
        <div data-testid="real-content">真实业务内容</div>
      </SkeletonReveal>,
    );

    const container = screen.getByTestId('skeleton-reveal');
    const skelLayer = screen.getByTestId('skeleton-reveal-skeleton');
    const contentLayer = screen.getByTestId('skeleton-reveal-content');

    expect(container.style.display).toBe('grid');
    expect(container.style.gridTemplateAreas).toBe('"stack"');
    expect(skelLayer.style.gridArea).toBe('stack');
    expect(contentLayer.style.gridArea).toBe('stack');

    // 200ms 前不闪出骨架
    expect(skelLayer.style.opacity).toBe('0');

    // 越过 200ms 门控后，骨架显示，内容层处于 translateY(4px) 预备态
    act(() => {
      vi.advanceTimersByTime(210);
    });
    expect(skelLayer.style.opacity).toBe('1');
    expect(contentLayer.style.opacity).toBe('0');
    expect(contentLayer.style.transform).toBe('translateY(4px)');

    // 加载结束且驻留满 400ms 后，切换到真实内容（opacity -> 1, translateY(0)）
    rerender(
      <SkeletonReveal
        loading={false}
        delayMs={200}
        minVisibleMs={400}
        skeleton={<Skeleton data-testid="custom-skel" variant="pulse" className="h-12 w-full" />}
      >
        <div data-testid="real-content">真实业务内容</div>
      </SkeletonReveal>,
    );
    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(skelLayer.style.opacity).toBe('0');
    expect(contentLayer.style.opacity).toBe('1');
    expect(contentLayer.style.transform).toBe('translateY(0)');
  });
});

describe('typography.css & markdown.css text-autospace rule', () => {
  it('enables CSS Text Level 4 text-autospace: normal in both typography.css and markdown.css', () => {
    const rootDir = path.resolve(__dirname, '../../../..');
    const typographyCss = fs.readFileSync(
      path.join(rootDir, 'src/styles/typography.css'),
      'utf8',
    );
    const markdownCss = fs.readFileSync(
      path.join(rootDir, 'src/features/chat/styles/markdown.css'),
      'utf8',
    );

    expect(typographyCss).toContain(':where(.markdown-body, .chat-prose, body):lang(zh)');
    expect(typographyCss).toContain('text-autospace: normal;');
    expect(markdownCss).toContain(':where(.markdown-body, .chat-prose, body):lang(zh)');
    expect(markdownCss).toContain('text-autospace: normal;');
  });
});

describe('DiagramAndLiveSvgView: streaming/closed diagram & svg rendering and ArtifactUndoStack integration', () => {
  it('progressively renders streaming diagram JSON and validates full diagram on completion', () => {
    const partialDiagram =
      '{"type":"graph","direction":"LR","nodes":[{"id":"a","label":"输入节点"},{"id":"b","label":"处理节点"},{"id":"c","label":"未写完';

    const { rerender } = render(
      <DiagramAndLiveSvgView
        mode="diagram"
        code={partialDiagram}
        isStreaming={true}
        theme="light"
      />,
    );

    const canvas = screen.getByTestId('diagram-svg-canvas');
    expect(canvas.querySelector('svg')).not.toBeNull();
    expect(canvas.textContent).toContain('输入节点');
    expect(canvas.textContent).toContain('处理节点');

    const fullDiagram = JSON.stringify({
      type: 'plot',
      x: [-4, 4],
      y: [-2, 2],
      curves: [{ fn: 'sin(x)', label: '正弦曲线' }],
    });

    rerender(
      <DiagramAndLiveSvgView
        mode="diagram"
        code={fullDiagram}
        isStreaming={false}
        theme="dark"
      />,
    );

    expect(canvas.querySelector('svg')).not.toBeNull();
    expect(canvas.textContent).toContain('正弦曲线');
    expect(canvas.innerHTML).toContain('<path');
  });

  it('renders only closed top-level SVG primitives with stroke-draw / fade-in classes while streaming and supports patch + undo', () => {
    const streamingSvg = [
      '<svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">',
      '<path d="M10 10 L120 80" stroke="#1677ff" fill="none"/>',
      '<rect x="20" y="20" width="40" height="30" fill="#52c41a"/>',
      '<circle cx="90" cy="50" r="15',
    ].join('');

    const undoStack = new ArtifactUndoStack();
    const onApplyPatch = vi.fn();

    const { rerender } = render(
      <DiagramAndLiveSvgView
        mode="svg"
        code={streamingSvg}
        isStreaming={true}
        undoStack={undoStack}
        onApplyPatch={onApplyPatch}
      />,
    );

    const canvas = screen.getByTestId('diagram-svg-canvas');
    const pathEl = canvas.querySelector('path');
    const rectEl = canvas.querySelector('rect');
    const unclosedCircle = canvas.querySelector('circle');

    expect(pathEl).not.toBeNull();
    expect(rectEl).not.toBeNull();
    expect(unclosedCircle).toBeNull();
    expect(pathEl?.classList.contains('stroke-draw')).toBe(true);
    expect(rectEl?.classList.contains('fade-in')).toBe(true);

    const closedSvg = [
      '<svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">',
      '<path d="M10 10 L120 80" stroke="#1677ff" fill="none"/>',
      '<rect x="20" y="20" width="40" height="30" fill="#52c41a"/>',
      '<circle cx="90" cy="50" r="15" fill="#f5222d"/>',
      '</svg>',
    ].join('');

    rerender(
      <DiagramAndLiveSvgView
        mode="svg"
        code={closedSvg}
        isStreaming={false}
        undoStack={undoStack}
        onApplyPatch={onApplyPatch}
      />,
    );

    expect(canvas.querySelector('circle')).not.toBeNull();

    // 打开局部修改栏并应用补丁
    const editBtn = screen.getByTestId('canvas-toggle-edit');
    fireEvent.click(editBtn);

    fireEvent.change(screen.getByTestId('canvas-patch-search'), {
      target: { value: 'r="15"' },
    });
    fireEvent.change(screen.getByTestId('canvas-patch-replace'), {
      target: { value: 'r="28"' },
    });
    fireEvent.click(screen.getByTestId('canvas-apply-patch'));

    expect(onApplyPatch).toHaveBeenCalledTimes(1);
    expect(canvas.querySelector('circle')?.getAttribute('r')).toBe('28');

    // 验证源码预览与撤销操作
    fireEvent.click(screen.getByTestId('canvas-toggle-source'));
    expect(screen.getByTestId('canvas-source-view').textContent).toContain('r="28"');

    const undoBtn = screen.getByTestId('canvas-undo-button');
    expect(undoBtn).not.toBeDisabled();
    fireEvent.click(undoBtn);

    expect(canvas.querySelector('circle')?.getAttribute('r')).toBe('15');
    expect(onApplyPatch).toHaveBeenLastCalledWith(closedSvg);
  });
});
