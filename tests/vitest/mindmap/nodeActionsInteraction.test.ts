import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const branchNodeSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/features/mindmap/components/mindmap/nodes/BranchNode.tsx'),
  'utf8',
);
const contextMenuSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/features/mindmap/components/mindmap/CanvasContextMenu.tsx'),
  'utf8',
);

describe('mind map node actions interaction contract', () => {
  it('keeps action buttons outside React Flow drag and pan gestures', () => {
    expect(branchNodeSource).toContain('"mm-node-actions nodrag nopan"');
    expect(branchNodeSource).toContain('onPointerDown={(e) => e.stopPropagation()}');
  });

  it('still wires the more button to the node context menu', () => {
    expect(branchNodeSource).toContain('onClick={handleOpenMenu}');
    expect(branchNodeSource).toContain('data.onOpenMenu(data.nodeId');
  });

  it('keeps portal menus fixed even though mindmap-container is position-relative', () => {
    expect(contextMenuSource.match(/position: 'fixed'/g)).toHaveLength(3);
  });
});
