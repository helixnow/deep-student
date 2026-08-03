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
    // 三个 portal 菜单（关联线 / 画布空白 / 节点）共用一份 fixed 定位样式
    expect(contextMenuSource.match(/position: 'fixed'/g)).toHaveLength(1);
    expect(contextMenuSource.match(/style=\{menuStyle\}/g)).toHaveLength(3);
  });

  it('keeps plain handles non-connectable by default to avoid accidental reparent', () => {
    // 普通锚点默认不可连接（防误触 reparent），仅 data.handlesConnectable 显式开启
    expect(branchNodeSource).toContain('isConnectable={handlesConnectable}');
    expect(branchNodeSource).not.toContain('isConnectable={true}');
  });

  it('applies the semantic underline class alongside the legacy one', () => {
    expect(branchNodeSource).toContain('mindmap-node-underline mm-node--underline');
  });

  it('resolves theme through the dark-mode aware hook instead of a memoized get', () => {
    expect(branchNodeSource).toContain('useMindMapTheme(styleId)');
    expect(branchNodeSource).not.toContain('useMemo(() => StyleRegistry.get');
  });
});
