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

  it('does not restyle every edge when the hovered node changes', () => {
    expect(canvasSource).not.toContain('hoveredNodeId');
    expect(canvasSource).not.toContain('onNodeMouseEnter');
    expect(canvasSource).not.toContain('onNodeMouseLeave');
    expect(canvasSource).not.toContain('opacity: 0.25');
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
