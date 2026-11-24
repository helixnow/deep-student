import { describe, expect, it } from 'vitest';
import type { NoteBacklinkDto, NoteOutgoingLinkDto } from '../backlinksBackend';
import {
  buildLocalGraph,
  ghostNodeId,
  layoutLocalGraph,
  LOCAL_GRAPH_CENTER_NEIGHBOR_LIMIT,
  LOCAL_GRAPH_RING_1_RADIUS,
  LOCAL_GRAPH_RING_2_RADIUS,
  type LocalGraphData,
  type LocalGraphNeighborhood,
} from '../graph/localGraph';

function backlink(sourceId: string, sourceTitle = sourceId): NoteBacklinkDto {
  return { sourceId, sourceTitle, heading: null, alias: null, position: 0, sourceUpdatedAt: '2026-08-24T00:00:00Z' };
}

function outgoing(
  targetId: string | null,
  targetTitle: string,
  linkType: NoteOutgoingLinkDto['linkType'] = 'wikilink',
): NoteOutgoingLinkDto {
  return {
    targetId,
    targetTitle,
    heading: null,
    alias: null,
    position: 0,
    linkType,
    resolved: targetId !== null,
  };
}

function fetcherFromMap(map: Record<string, LocalGraphNeighborhood>) {
  return async (noteId: string): Promise<LocalGraphNeighborhood> => (
    map[noteId] ?? { backlinks: [], outgoing: [] }
  );
}

describe('buildLocalGraph', () => {
  it('builds a one-hop graph with incoming, outgoing, and ghost targets', async () => {
    const data = await buildLocalGraph({ id: 'center', title: '中心' }, 1, fetcherFromMap({
      center: {
        backlinks: [backlink('in1', '入链一')],
        outgoing: [outgoing('out1', '出链一'), outgoing(null, '未解析目标')],
      },
    }));

    expect(data.truncated).toBe(false);
    expect(data.nodes).toHaveLength(4);
    expect(data.nodes.find((node) => node.id === 'center')).toMatchObject({ degree: 0, exists: true });
    expect(data.nodes.find((node) => node.id === 'in1')).toMatchObject({ degree: 1, exists: true });
    expect(data.nodes.find((node) => node.id === 'out1')).toMatchObject({ degree: 1, exists: true });
    expect(data.nodes.find((node) => node.id === ghostNodeId('未解析目标')))
      .toMatchObject({ degree: 1, exists: false, title: '未解析目标' });
    // 有向去重：in1 -> center、center -> out1、center -> 未解析目标，共 3 条有向边且保留真实方向
    expect(data.edges).toHaveLength(3);
    expect(data.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'in1', target: 'center', kind: 'unknown' }),
        expect.objectContaining({ source: 'center', target: 'out1', kind: 'wikilink' }),
        expect.objectContaining({ source: 'center', target: ghostNodeId('未解析目标'), kind: 'wikilink' }),
      ]),
    );
  });

  it('expands to two hops but keeps ghosts only around the center', async () => {
    const data = await buildLocalGraph({ id: 'center', title: 'C' }, 2, fetcherFromMap({
      center: { backlinks: [], outgoing: [outgoing('mid', 'Mid')] },
      mid: {
        backlinks: [backlink('center', 'C')],
        outgoing: [outgoing('far', 'Far'), outgoing(null, 'ghost target')],
      },
    }));

    const ids = data.nodes.map((node) => node.id).sort();
    // 二度展开引入 far；mid 的幽灵目标被丢弃（只有中心引入幽灵）
    expect(ids).toEqual(['center', 'far', 'mid']);
    expect(data.nodes.find((node) => node.id === 'far')).toMatchObject({ degree: 2 });
    // center -> mid 与 mid -> far；同一条有向边 center -> mid 在 mid.backlinks 被有向去重
    expect(data.edges).toHaveLength(2);
    expect(data.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'center', target: 'mid' }),
        expect.objectContaining({ source: 'mid', target: 'far' }),
      ]),
    );
    expect(data.truncated).toBe(false);
  });

  it('depth 1 never fetches beyond the center note', async () => {
    const fetched: string[] = [];
    await buildLocalGraph({ id: 'center', title: 'C' }, 1, async (noteId) => {
      fetched.push(noteId);
      return { backlinks: [], outgoing: [outgoing('a', 'A'), outgoing('b', 'B')] };
    });
    expect(fetched).toEqual(['center']);
  });

  it('marks the graph truncated when the center neighbor budget is exceeded', async () => {
    const many = Array.from(
      { length: LOCAL_GRAPH_CENTER_NEIGHBOR_LIMIT + 5 },
      (_, index) => outgoing(`n${index}`, `N${index}`),
    );
    const data = await buildLocalGraph({ id: 'center', title: 'C' }, 1, fetcherFromMap({
      center: { backlinks: [], outgoing: many },
    }));
    expect(data.truncated).toBe(true);
    expect(data.nodes).toHaveLength(1 + LOCAL_GRAPH_CENTER_NEIGHBOR_LIMIT);
  });

  it('types edges by link kind: noteref colored, backlink-only unknown, bidirectional borrowed', async () => {
    const data = await buildLocalGraph({ id: 'center', title: 'C' }, 1, fetcherFromMap({
      center: {
        // in-only：入链行不带 linkType → unknown
        backlinks: [backlink('in-only'), backlink('both')],
        outgoing: [
          // both：双向链接，入链行先入队，类型借用反向出链行
          outgoing('both', 'Both', 'noteref'),
          outgoing('wiki', 'Wiki', 'wikilink'),
          outgoing('ref', 'Ref', 'noteref'),
          outgoing(null, 'Ghost Ref', 'noteref'),
        ],
      },
    }));

    const kindByPair = new Map(data.edges.map((edge) => [`${edge.source}->${edge.target}`, edge.kind]));
    expect(kindByPair.get('in-only->center')).toBe('unknown');
    expect(kindByPair.get('center->in-only')).toBeUndefined();
    expect(kindByPair.get('center->both')).toBe('noteref');
    expect(kindByPair.get('both->center')).toBe('unknown');
    expect(kindByPair.get('center->wiki')).toBe('wikilink');
    expect(kindByPair.get('center->ref')).toBe('noteref');
    expect(kindByPair.get(`center->${ghostNodeId('Ghost Ref')}`)).toBe('noteref');
  });

  it('upgrades an unknown backlink edge when depth-2 expansion sees the source outgoing row', async () => {
    const data = await buildLocalGraph({ id: 'center', title: 'C' }, 2, fetcherFromMap({
      // 深度 1 时 mid -> center 只从入链行可见（unknown）
      center: { backlinks: [backlink('mid', 'Mid')], outgoing: [] },
      // 展开 mid 后其出链行补全 mid -> center 这条有向边的类型
      mid: { backlinks: [], outgoing: [outgoing('center', 'C', 'noteref')] },
    }));

    const edge = data.edges.find((candidate) => (
      candidate.source === 'mid' && candidate.target === 'center'
    ));
    expect(edge?.kind).toBe('noteref');
    expect(data.hasCycle).toBe(false);
  });

  it('detects directed reference cycles while keeping pure DAGs cycle-free (S1-06)', async () => {
    const cyclic = await buildLocalGraph({ id: 'bayes', title: 'S106_贝叶斯定理' }, 2, fetcherFromMap({
      bayes: { backlinks: [backlink('cond', 'S106_条件概率')], outgoing: [outgoing('norm', 'S106_全概率')] },
      norm: { backlinks: [backlink('bayes', 'S106_贝叶斯定理')], outgoing: [outgoing('cond', 'S106_条件概率')] },
      cond: { backlinks: [backlink('norm', 'S106_全概率')], outgoing: [outgoing('bayes', 'S106_贝叶斯定理')] },
    }));
    expect(cyclic.hasCycle).toBe(true);
    expect(new Set(cyclic.cycleNodeIds)).toEqual(new Set(['bayes', 'norm', 'cond']));
    expect(cyclic.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'cond', target: 'bayes' }),
        expect.objectContaining({ source: 'bayes', target: 'norm' }),
        expect.objectContaining({ source: 'norm', target: 'cond' }),
      ]),
    );
  });

  it('survives expansion failures of individual neighbors', async () => {
    const data = await buildLocalGraph({ id: 'center', title: 'C' }, 2, async (noteId) => {
      if (noteId === 'bad') throw new Error('note vanished');
      if (noteId === 'center') {
        return { backlinks: [], outgoing: [outgoing('bad', 'Bad'), outgoing('good', 'Good')] };
      }
      return { backlinks: [], outgoing: [outgoing('deep', 'Deep')] };
    });
    const ids = data.nodes.map((node) => node.id).sort();
    expect(ids).toEqual(['bad', 'center', 'deep', 'good']);
  });
});

describe('layoutLocalGraph', () => {
  it('is deterministic: center at origin, ring radii by degree', () => {
    const data: LocalGraphData = {
      nodes: [
        { id: 'c', title: 'C', degree: 0, exists: true },
        { id: 'a', title: 'A', degree: 1, exists: true },
        { id: 'b', title: 'B', degree: 1, exists: true },
        { id: 'z', title: 'Z', degree: 2, exists: true },
      ],
      edges: [
        { id: 'e-0', source: 'c', target: 'a', kind: 'wikilink' },
        { id: 'e-1', source: 'c', target: 'b', kind: 'noteref' },
        { id: 'e-2', source: 'a', target: 'z', kind: 'unknown' },
      ],
      truncated: false,
    };

    const first = layoutLocalGraph(data);
    const second = layoutLocalGraph(data);
    expect(second).toEqual(first);

    const byId = new Map(first.map((node) => [node.id, node]));
    expect(byId.get('c')).toMatchObject({ x: 0, y: 0 });
    const radius = (node: { x: number; y: number }) => Math.hypot(node.x, node.y);
    expect(radius(byId.get('a')!)).toBeCloseTo(LOCAL_GRAPH_RING_1_RADIUS, 6);
    expect(radius(byId.get('b')!)).toBeCloseTo(LOCAL_GRAPH_RING_1_RADIUS, 6);
    expect(radius(byId.get('z')!)).toBeCloseTo(LOCAL_GRAPH_RING_2_RADIUS, 6);
  });

  it('keeps a two-hop child inside its parent sector', () => {
    const data: LocalGraphData = {
      nodes: [
        { id: 'c', title: 'C', degree: 0, exists: true },
        { id: 'p1', title: 'P1', degree: 1, exists: true },
        { id: 'p2', title: 'P2', degree: 1, exists: true },
        { id: 'child', title: 'Child', degree: 2, exists: true },
      ],
      edges: [
        { id: 'e-0', source: 'c', target: 'p1', kind: 'wikilink' },
        { id: 'e-1', source: 'c', target: 'p2', kind: 'wikilink' },
        { id: 'e-2', source: 'p2', target: 'child', kind: 'wikilink' },
      ],
      truncated: false,
    };
    const byId = new Map(layoutLocalGraph(data).map((node) => [node.id, node]));
    const angle = (node: { x: number; y: number }) => Math.atan2(node.y, node.x);
    // 单个子节点直接落在父节点的角度上（外环）
    expect(angle(byId.get('child')!)).toBeCloseTo(angle(byId.get('p2')!), 6);
  });
});
