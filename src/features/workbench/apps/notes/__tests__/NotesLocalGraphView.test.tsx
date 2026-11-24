import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@xyflow/react', () => ({
  Background: () => null,
  BackgroundVariant: { Dots: 'dots' },
  Handle: () => null,
  MarkerType: { ArrowClosed: 'arrowclosed' },
  Position: { Top: 'top', Bottom: 'bottom' },
  ReactFlow: ({
    nodes,
    edges,
    nodeTypes,
    onNodeClick,
  }: {
    nodes: Array<{ id: string; type: string; data: unknown }>;
    edges: Array<{ id: string; label?: string }>;
    nodeTypes: Record<string, React.FC<{ data: unknown }>>;
    onNodeClick: (event: unknown, node: { id: string; data: unknown }) => void;
  }) => {
    const NodeComp = nodeTypes.localGraphNode;
    return (
      <div data-testid="rf-canvas">
        {nodes.map((node) => (
          <div key={node.id} onClick={(e) => onNodeClick(e, node)}>
            <NodeComp data={node.data} />
          </div>
        ))}
        {edges.map((edge) => (
          <span key={edge.id} data-testid="rf-edge-label">{edge.label}</span>
        ))}
      </div>
    );
  },
}));

import { NotesLocalGraphView } from '../graph/NotesLocalGraphView';

describe('NotesLocalGraphView', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders interactive button nodes, active badge, edge labels, and opens neighbor nodes on click', () => {
    const onOpenNode = vi.fn();
    render(
      <NotesLocalGraphView
        ariaLabel="局部图谱"
        onOpenNode={onOpenNode}
        data={{
          nodes: [
            { id: 'note_center', title: '中心笔记', degree: 0, exists: true },
            { id: 'note_neighbor', title: '邻接笔记', degree: 1, exists: true },
          ],
          edges: [
            { id: 'e-0', source: 'note_center', target: 'note_neighbor', kind: 'wikilink' },
          ],
          truncated: false,
        }}
      />,
    );

    const activeBtn = screen.getByRole('button', { name: /中心笔记/ });
    expect(activeBtn).toHaveAttribute('aria-current', 'page');
    expect(activeBtn).toHaveAttribute('data-active', 'true');
    expect(activeBtn).toHaveTextContent(/当前|Current/);

    const neighborBtn = screen.getByRole('button', { name: '邻接笔记' });
    fireEvent.click(neighborBtn);
    expect(onOpenNode).toHaveBeenCalledWith({
      id: 'note_neighbor',
      title: '邻接笔记',
      degree: 1,
      exists: true,
    });

    expect(screen.getByTestId('rf-edge-label')).toHaveTextContent(/双链|Wikilink/);
  });
});
