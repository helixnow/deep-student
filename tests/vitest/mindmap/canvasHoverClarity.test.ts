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
  const rootNodeSource = readSource(
    'src/features/mindmap/components/mindmap/nodes/RootNode.tsx',
  );
  const branchNodeSource = readSource(
    'src/features/mindmap/components/mindmap/nodes/BranchNode.tsx',
  );
  const canvasStyles = readSource(
    'src/features/mindmap/styles/mindmap.css',
  );

  it('keeps hover styling scoped to the hovered branch without dimming all edges', () => {
    // 旧反模式：hoveredNodeId 驱动全边重样式 + 非路径边整体压暗（opacity 0.25）
    expect(canvasSource).not.toContain('hoveredNodeId');
    expect(canvasSource).not.toContain('opacity: 0.25');
    // 悬停路径高亮是刻意功能（悬停节点 → 根的路径提亮一档），
    // 但必须限定路径边（isHoverPath 守卫）且触屏（无 hover 语义）跳过
    expect(canvasSource).toContain('hoverPathEdgeKeys');
    expect(canvasSource).toContain('hoverPathEdgeKeys?.has(edgeKey)');
    expect(canvasSource).toContain('isHoverPath');
    expect(canvasSource).toMatch(/if \(isCoarsePointer\) return;/);
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
