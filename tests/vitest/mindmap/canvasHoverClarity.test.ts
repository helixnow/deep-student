import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf-8');
}

describe('mind map hover clarity contract', () => {
  const canvasSource = readSource(
    'src/features/mindmap/components/mindmap/MindMapCanvas.tsx',
  );
  const hoverPathHookSource = readSource(
    'src/features/mindmap/components/mindmap/hooks/useCanvasHoverPath.ts',
  );
  const rootNodeSource = readSource(
    'src/features/mindmap/components/mindmap/nodes/RootNode.tsx',
  );
  const branchNodeSource = readSource(
    'src/features/mindmap/components/mindmap/nodes/BranchNode.tsx',
  );
  const canvasStyles = readSource(
    'src/features/mindmap/styles/mindmap.css',
  );
  const enhancementStyles = readSource(
    'src/features/mindmap/styles/canvas-enhancements.css',
  );

  it('keeps hover path highlighting zero-rerender via DOM classes without dimming all edges', () => {
    // 旧反模式：hoveredNodeId / hoverPathNodeId 驱动全边重样式 + 非路径边整体压暗（opacity 0.25）
    expect(canvasSource).not.toContain('hoveredNodeId');
    expect(canvasSource).not.toContain('hoverPathNodeId');
    expect(canvasSource).not.toContain('hoverPathEdgeKeys');
    expect(canvasSource).not.toContain('opacity: 0.25');

    // 悬停路径由 useCanvasHoverPath 直接操作命中的 .react-flow__edge[data-id] DOM 类名实现（0 React state、0 全边重建）
    expect(canvasSource).toContain('useCanvasHoverPath');
    expect(hoverPathHookSource).not.toContain('useState');
    expect(hoverPathHookSource).toMatch(/if \(isCoarsePointer\) return;/);
    expect(hoverPathHookSource).toContain('mm-edge-hover-path');
    expect(hoverPathHookSource).toContain('classList.add');
    expect(hoverPathHookSource).toContain('classList.remove');
    expect(hoverPathHookSource).toContain('.react-flow__edge[data-id=');

    // CSS 仅靠类名即可驱动主色 65% color-mix 提亮
    expect(enhancementStyles).toContain('.mm-edge-hover-path');
    expect(enhancementStyles).toContain('1.95px');
    expect(enhancementStyles).toContain('0.96');
  });

  it('uses visibility instead of opacity transitions for hover-only node controls', () => {
    expect(rootNodeSource).not.toContain('transition-opacity');
    expect(rootNodeSource).not.toContain('showActions');
    expect(branchNodeSource).not.toContain('transition-opacity');
    expect(branchNodeSource).not.toContain('group-hover:opacity');
    expect(branchNodeSource).not.toContain('group-hover:!opacity');
  });

  it('does not change completed node opacity on hover', () => {
    expect(canvasStyles).not.toContain('.mm-root-node.mm-completed:hover');
    expect(canvasStyles).not.toContain('.mm-branch-node.mm-completed:hover');
    expect(canvasStyles).not.toContain('.mindmap-node-underline.mm-completed:hover');
  });
});
