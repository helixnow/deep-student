import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DstuNode } from '@/dstu';

const { getContent, watch, fetchBacklinks, fetchOutgoing, viewProps } = vi.hoisted(() => ({
  getContent: vi.fn(),
  watch: vi.fn(() => () => {}),
  fetchBacklinks: vi.fn(),
  fetchOutgoing: vi.fn(),
  viewProps: { current: null as null | {
    data: { nodes: Array<{ id: string; title: string; degree: number; exists: boolean }> };
    onOpenNode: (node: { id: string; title: string; degree: number; exists: boolean }) => void;
  } },
}));

vi.mock('@/dstu', () => ({
  dstu: { getContent, watch },
}));

vi.mock('../backlinksBackend', () => ({
  fetchBacklinksFromBackend: fetchBacklinks,
  fetchOutgoingLinksFromBackend: fetchOutgoing,
}));

// 懒加载的 ReactFlow 画布替换为轻量探针：记录 data、把节点渲染成按钮
vi.mock('../graph/NotesLocalGraphView', () => ({
  default: (props: NonNullable<typeof viewProps.current>) => {
    viewProps.current = props;
    return (
      <div data-testid="graph-view">
        {props.data.nodes.map((node) => (
          <button key={node.id} type="button" onClick={() => props.onOpenNode(node)}>
            {node.title}
          </button>
        ))}
      </div>
    );
  },
}));

import { NotesGraphTab } from '../graph/NotesGraphTab';

function node(overrides: Partial<DstuNode> = {}): DstuNode {
  return {
    id: 'note_center',
    sourceId: 'note_center',
    path: '/note_center',
    name: '中心笔记',
    type: 'note',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function backlinkRow(sourceId: string, sourceTitle: string) {
  return { sourceId, sourceTitle, heading: null, alias: null, position: 0, sourceUpdatedAt: 'x' };
}

function outgoingRow(targetId: string | null, targetTitle: string) {
  return {
    targetId,
    targetTitle,
    heading: null,
    alias: null,
    position: 0,
    linkType: 'wikilink',
    resolved: targetId !== null,
  };
}

describe('NotesGraphTab', () => {
  beforeEach(() => {
    getContent.mockReset();
    fetchBacklinks.mockReset();
    fetchOutgoing.mockReset();
    watch.mockClear();
    viewProps.current = null;
    window.localStorage.clear();
  });

  it('builds the local graph from backend links and opens a note on node click', async () => {
    fetchBacklinks.mockImplementation(async (noteId: string) => (
      noteId === 'note_center' ? [backlinkRow('note_in', '入链笔记')] : []
    ));
    fetchOutgoing.mockImplementation(async (noteId: string) => (
      noteId === 'note_center' ? [outgoingRow('note_out', '出链笔记')] : []
    ));
    const onOpenResource = vi.fn();
    const outNote = node({ id: 'note_out', sourceId: 'note_out', path: '/note_out', name: '出链笔记' });

    render(
      <NotesGraphTab
        open
        activeResource={node()}
        notes={[node(), outNote]}
        onOpenResource={onOpenResource}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('graph-view')).toBeInTheDocument());
    const ids = viewProps.current!.data.nodes.map((graphNode) => graphNode.id).sort();
    expect(ids).toEqual(['note_center', 'note_in', 'note_out']);

    fireEvent.click(screen.getByRole('button', { name: '出链笔记' }));
    await waitFor(() => expect(onOpenResource).toHaveBeenCalledWith(outNote));
    // 点中心节点不触发打开（已是当前笔记）
    fireEvent.click(screen.getByRole('button', { name: '中心笔记' }));
    expect(onOpenResource).toHaveBeenCalledTimes(1);
  });

  it('falls back to client-side outgoing links when the backend is unavailable', async () => {
    fetchBacklinks.mockRejectedValue(new Error('backend unavailable'));
    fetchOutgoing.mockRejectedValue(new Error('backend unavailable'));
    getContent.mockResolvedValue({ ok: true, value: '见 [[目标笔记]] 与 [[幽灵目标]]' });
    const target = node({ id: 'note_target', sourceId: 'note_target', path: '/note_target', name: '目标笔记' });

    render(
      <NotesGraphTab
        open
        activeResource={node()}
        notes={[node(), target]}
        onOpenResource={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('graph-view')).toBeInTheDocument());
    const titles = viewProps.current!.data.nodes.map((graphNode) => graphNode.title).sort();
    expect(titles).toEqual(['中心笔记', '幽灵目标', '目标笔记']);
    // 降级提示可见
    expect(screen.getByRole('status')).toHaveTextContent('图谱服务不可用');
  });

  it('shows a hint when no note is active and renders nothing while closed', () => {
    const { rerender } = render(
      <NotesGraphTab open activeResource={null} notes={[]} onOpenResource={vi.fn()} />,
    );
    expect(screen.getByText('选择一篇笔记以查看图谱。')).toBeInTheDocument();

    rerender(
      <NotesGraphTab open={false} activeResource={node()} notes={[node()]} onOpenResource={vi.fn()} />,
    );
    expect(screen.queryByText('选择一篇笔记以查看图谱。')).toBeNull();
    expect(fetchBacklinks).not.toHaveBeenCalled();
  });

  it('persists the depth toggle and refetches with the new depth', async () => {
    fetchBacklinks.mockResolvedValue([]);
    fetchOutgoing.mockImplementation(async (noteId: string) => (
      noteId === 'note_center' ? [outgoingRow('note_out', '出链笔记')] : []
    ));

    render(
      <NotesGraphTab
        open
        activeResource={node()}
        notes={[node()]}
        onOpenResource={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('graph-view')).toBeInTheDocument());
    // 默认 2 度：会展开 1 度节点（第二次取邻居）
    expect(fetchOutgoing).toHaveBeenCalledWith('note_out');

    fetchOutgoing.mockClear();
    fireEvent.click(screen.getByRole('button', { name: '1 度' }));
    expect(window.localStorage.getItem('notes-local-graph:depth')).toBe('1');
    await waitFor(() => expect(fetchOutgoing).toHaveBeenCalledWith('note_center'));
    expect(fetchOutgoing).not.toHaveBeenCalledWith('note_out');
  });
});
