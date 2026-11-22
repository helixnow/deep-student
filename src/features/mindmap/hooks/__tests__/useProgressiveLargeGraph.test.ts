import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { Edge, Node } from '@xyflow/react';
import {
  computeLayoutNodesBounds,
  LARGE_GRAPH_BATCH_DELAY_MS,
  LARGE_GRAPH_INITIAL_BATCH,
  useProgressiveLargeGraph,
} from '../useProgressiveLargeGraph';

function makeGraph(count: number): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = Array.from({ length: count }, (_, i) => ({
    id: `n_${i}`,
    position: { x: i * 10, y: 0 },
    data: { label: `Node ${i}` },
  }));
  const edges: Edge[] = Array.from({ length: Math.max(0, count - 1) }, (_, i) => ({
    id: `e_${i}`,
    source: `n_${i}`,
    target: `n_${i + 1}`,
  }));
  return { nodes, edges };
}

describe('useProgressiveLargeGraph', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes small graphs through untouched with zero staging', () => {
    const { nodes, edges } = makeGraph(40);
    const { result } = renderHook(() =>
      useProgressiveLargeGraph(nodes, edges, { resetKey: 'root_1' }),
    );
    expect(result.current.isComplete).toBe(true);
    expect(result.current.nodes).toBe(nodes);
    expect(result.current.edges).toBe(edges);
  });

  it('stages >120 node graphs across frames and filters incident edges until complete', () => {
    const { nodes, edges } = makeGraph(250);
    const { result } = renderHook(() =>
      useProgressiveLargeGraph(nodes, edges, { resetKey: 'root_large' }),
    );

    expect(result.current.isComplete).toBe(false);
    expect(result.current.nodes).toHaveLength(LARGE_GRAPH_INITIAL_BATCH);
    expect(result.current.edges).toHaveLength(LARGE_GRAPH_INITIAL_BATCH - 1);

    for (let step = 0; step < 8; step += 1) {
      act(() => {
        vi.advanceTimersByTime(LARGE_GRAPH_BATCH_DELAY_MS + 20);
      });
    }

    expect(result.current.isComplete).toBe(true);
    expect(result.current.nodes).toBe(nodes);
    expect(result.current.edges).toBe(edges);
  });

  it('bypasses staging when disabled (e.g. export mode)', () => {
    const { nodes, edges } = makeGraph(250);
    const { result } = renderHook(() =>
      useProgressiveLargeGraph(nodes, edges, { enabled: false, resetKey: 'root_large' }),
    );
    expect(result.current.isComplete).toBe(true);
    expect(result.current.nodes).toBe(nodes);
  });

  it('computes full layout bounding box for immediate large-graph fitBounds', () => {
    const bounds = computeLayoutNodesBounds([
      { id: 'a', position: { x: -100, y: 20 }, width: 120, height: 40, data: {} },
      { id: 'b', position: { x: 400, y: 260 }, width: 160, height: 50, data: {} },
    ]);
    expect(bounds).toEqual({ x: -100, y: 20, width: 660, height: 290 });
    expect(computeLayoutNodesBounds([])).toBeNull();
  });
});
