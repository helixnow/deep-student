import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DstuNode } from '@/dstu';

const { getContent, search, watch, fetchBacklinksFromBackend } = vi.hoisted(() => ({
  getContent: vi.fn(),
  search: vi.fn(),
  watch: vi.fn(),
  fetchBacklinksFromBackend: vi.fn(),
}));

vi.mock('@/dstu', () => ({
  dstu: { getContent, search, watch },
}));

// 后端链接图命令默认不可用 → 面板走客户端扫描降级路径（原有断言不变）。
// 单独的用例把它 mock 成成功返回，验证后端优先路径。
vi.mock('../backlinksBackend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../backlinksBackend')>();
  return { ...actual, fetchBacklinksFromBackend };
});

import {
  BACKLINK_CANDIDATE_LIMIT,
  extractContextSnippet,
  NotesBacklinksPanel,
  UNLINKED_MENTION_CANDIDATE_LIMIT,
  useRequestedPanelTab,
} from '../NotesBacklinksPanel';

/** 每次完整加载的 search 次数：2 目标 × 8 变体 + note:// + 未链接提及标题查询 */
const SEARCHES_PER_LOAD = 18;

const notes: DstuNode[] = [
  {
    id: 'note_alpha', sourceId: 'note_alpha', path: '/math/note_alpha', name: 'Alpha', type: 'note', createdAt: 1, updatedAt: 1,
  },
  {
    id: 'note_beta', sourceId: 'note_beta', path: '/math/note_beta', name: 'Beta', type: 'note', createdAt: 2, updatedAt: 2,
  },
  {
    id: 'note_gamma', sourceId: 'note_gamma', path: '/math/note_gamma', name: 'Gamma', type: 'note', createdAt: 3, updatedAt: 3,
  },
  {
    id: 'note_delta', sourceId: 'note_delta', path: '/math/note_delta', name: 'Delta', type: 'note', createdAt: 4, updatedAt: 4,
  },
];

const contentByPath: Record<string, string> = {
  '/math/note_alpha': '[[Beta]] [[note_gamma|Gamma alias]] [[missing]]',
  '/math/note_beta': 'Points back to [[Alpha|Alpha alias]].',
  '/math/note_gamma': 'Points back to [[note_alpha]].',
  '/math/note_delta': 'No links here.',
};

function renderPanel(overrides: Partial<React.ComponentProps<typeof NotesBacklinksPanel>> = {}) {
  const onOpenResource = vi.fn();
  const onClose = vi.fn();
  return {
    onOpenResource,
    onClose,
    ...render(
      <NotesBacklinksPanel
        open
        activeResource={notes[0]}
        notes={notes}
        onOpenResource={onOpenResource}
        onClose={onClose}
        {...overrides}
      />,
    ),
  };
}

describe('extractContextSnippet', () => {
  it('keeps ~radius characters around the match and marks truncation', () => {
    const content = `${'a'.repeat(100)}[[Target]]${'b'.repeat(100)}`;
    const start = 100;
    const end = start + '[[Target]]'.length;
    const snippet = extractContextSnippet(content, start, end, 80);
    expect(snippet).not.toBeNull();
    expect(snippet!.before).toHaveLength(80);
    expect(snippet!.match).toBe('[[Target]]');
    expect(snippet!.after).toHaveLength(80);
    expect(snippet!.truncatedStart).toBe(true);
    expect(snippet!.truncatedEnd).toBe(true);
  });
});

describe('NotesBacklinksPanel', () => {
  beforeEach(() => {
    getContent.mockReset();
    search.mockReset();
    watch.mockReset();
    fetchBacklinksFromBackend.mockReset();
    fetchBacklinksFromBackend.mockRejectedValue(new Error('command unavailable'));
    localStorage.clear();
    getContent.mockImplementation(async (path: string) => ({ ok: true, value: contentByPath[path] }));
    search.mockImplementation(async (query: string) => ({
      ok: true,
      value: query === '[[note_alpha]]'
        ? [notes[2]]
        : query === '[[Alpha|'
          ? [notes[1]]
          : [],
    }));
    watch.mockImplementation(() => () => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('re-applies the same requested tab when its requestId changes', async () => {
    const Harness: React.FC<{ requestId: number }> = ({ requestId }) => {
      const [tab, switchTab] = useRequestedPanelTab(true, { tab: 'properties', requestId });
      return (
        <div>
          <output aria-label="active tab">{tab}</output>
          <button type="button" onClick={() => switchTab('links')}>Links</button>
        </div>
      );
    };
    const { rerender } = render(
      <Harness requestId={1} />,
    );

    expect(screen.getByLabelText('active tab')).toHaveTextContent('properties');

    fireEvent.click(screen.getByRole('button', { name: 'Links' }));
    expect(screen.getByLabelText('active tab')).toHaveTextContent('links');

    rerender(<Harness requestId={2} />);
    await waitFor(() => expect(screen.getByLabelText('active tab')).toHaveTextContent('properties'));
  });

  it('loads only the active note and narrow backlink candidates', async () => {
    const { rerender } = renderPanel({ open: false });
    expect(getContent).not.toHaveBeenCalled();

    rerender(
      <NotesBacklinksPanel
        open
        activeResource={notes[0]}
        notes={notes}
        onOpenResource={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByText('出链')).toBeInTheDocument();
    expect(getContent).toHaveBeenCalledTimes(3);
    expect(getContent).toHaveBeenCalledWith('/math/note_alpha');
    expect(getContent).toHaveBeenCalledWith('/math/note_beta');
    expect(getContent).toHaveBeenCalledWith('/math/note_gamma');
    expect(getContent).not.toHaveBeenCalledWith('/math/note_delta');
    expect(search).toHaveBeenCalledWith('[[note_alpha]]', {
      typeFilter: 'note',
      limit: BACKLINK_CANDIDATE_LIMIT + 1,
    });
    expect(search).toHaveBeenCalledWith('[[note_alpha|', {
      typeFilter: 'note',
      limit: BACKLINK_CANDIDATE_LIMIT + 1,
    });
    expect(search).toHaveBeenCalledWith('[[Alpha]]', {
      typeFilter: 'note',
      limit: BACKLINK_CANDIDATE_LIMIT + 1,
    });
    expect(search).toHaveBeenCalledWith('[[Alpha|', {
      typeFilter: 'note',
      limit: BACKLINK_CANDIDATE_LIMIT + 1,
    });
    expect(search).toHaveBeenCalledWith('[[Alpha#', {
      typeFilter: 'note',
      limit: BACKLINK_CANDIDATE_LIMIT + 1,
    });
    expect(search).toHaveBeenCalledWith('[[note_alpha#', {
      typeFilter: 'note',
      limit: BACKLINK_CANDIDATE_LIMIT + 1,
    });
    expect(search).toHaveBeenCalledWith('[[Alpha ', {
      typeFilter: 'note',
      limit: BACKLINK_CANDIDATE_LIMIT + 1,
    });
    expect(search).toHaveBeenCalledWith('[[ Alpha ', {
      typeFilter: 'note',
      limit: BACKLINK_CANDIDATE_LIMIT + 1,
    });
    await waitFor(() => expect(search).toHaveBeenCalledWith('Alpha', {
      typeFilter: 'note',
      limit: UNLINKED_MENTION_CANDIDATE_LIMIT + 1,
    }));
    expect(screen.getByText('Gamma alias')).toBeInTheDocument();
    expect(screen.getByText('[[missing]]')).toBeInTheDocument();
    expect(screen.getByText('反向链接')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: /出链/ }))
      .getByRole('button', { name: '打开 Beta' })).toHaveTextContent('Beta');
    expect(screen.queryByText('Alpha alias')).toBeNull();
  });

  it('prefers the backend note_links graph and skips the candidate search scan', async () => {
    fetchBacklinksFromBackend.mockResolvedValue([
      {
        sourceId: 'note_beta',
        sourceTitle: 'Beta',
        heading: null,
        alias: 'Alpha alias',
        // 'Points back to ' 为 15 个 ASCII 字符 → 链接的 UTF-8 字节偏移是 15
        position: 15,
        sourceUpdatedAt: '2026-07-01T00:00:00Z',
      },
    ]);

    renderPanel();

    const incoming = await screen.findByRole('region', { name: /反向链接/ });
    expect(fetchBacklinksFromBackend).toHaveBeenCalledWith('note_alpha');
    expect(within(incoming).getByRole('button', { name: '打开 Beta' })).toBeInTheDocument();
    // 后端命中上下文：按字节偏移还原 [[Alpha|Alpha alias]] 并以别名高亮
    expect(within(incoming).getByText('Alpha alias')).toBeInTheDocument();
    // 后端为权威结果：不再出现“已扫描/加载更多”降级提示
    expect(screen.queryByRole('button', { name: '加载更多来源' })).toBeNull();

    // 出链 / 未解析仍由本地解析当前笔记正文（编辑中的链接即时可见）
    const outgoing = screen.getByRole('region', { name: /出链/ });
    expect(within(outgoing).getByRole('button', { name: '打开 Beta' })).toBeInTheDocument();
    expect(screen.getByText('[[missing]]')).toBeInTheDocument();

    // 反链候选搜索被完全跳过；只有正文按需拉取（active + 命中来源）
    expect(search).not.toHaveBeenCalledWith('[[note_alpha]]', expect.anything());
    expect(getContent).toHaveBeenCalledWith('/math/note_alpha');
    expect(getContent).toHaveBeenCalledWith('/math/note_beta');
    expect(getContent).not.toHaveBeenCalledWith('/math/note_gamma');
  });

  it('shows inbound context snippets and a more-context toggle', async () => {
    renderPanel();
    await screen.findByText('反向链接');

    const incoming = screen.getByRole('region', { name: /反向链接/ });
    expect(within(incoming).getAllByText(/Points back to/).length).toBeGreaterThanOrEqual(1);
    // 上下文片段中的链接以可读文本（别名或目标）而非原始 [[...]] 高亮
    expect(within(incoming).getByText('Alpha alias')).toBeInTheDocument();
    expect(within(incoming).getByText('note_alpha')).toBeInTheDocument();

    fireEvent.click(within(incoming).getByRole('button', { name: '显示更多上下文' }));
    expect(within(incoming).getByRole('button', { name: '显示更少上下文' })).toBeInTheDocument();
    expect(localStorage.getItem('notes-backlinks-panel:more-context')).toBe('1');
  });

  it('opens a resolved linked note and refreshes all cached note contents on request', async () => {
    const { onOpenResource } = renderPanel();
    await screen.findByText('出链');

    fireEvent.click(within(screen.getByRole('region', { name: /出链/ }))
      .getByRole('button', { name: '打开 Gamma' }));
    await waitFor(() => expect(onOpenResource).toHaveBeenCalledWith(notes[2]));

    fireEvent.click(screen.getByRole('button', { name: '刷新链接' }));
    await waitFor(() => expect(getContent).toHaveBeenCalledTimes(6));
    await waitFor(() => expect(search).toHaveBeenCalledTimes(SEARCHES_PER_LOAD * 2));
  });

  it('limits note-content fetches to the bounded concurrency pool', async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const manyNotes = Array.from({ length: 12 }, (_, index): DstuNode => ({
      id: `note_${index}`,
      sourceId: `note_${index}`,
      path: `/math/note_${index}`,
      name: `Note ${index}`,
      type: 'note',
      createdAt: index,
      updatedAt: index,
    }));
    let inFlight = 0;
    let maxInFlight = 0;
    search.mockImplementation(async (query: string) => ({
      ok: true,
      value: query === '[[note_0]]' ? manyNotes.slice(1) : [],
    }));
    getContent.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gate;
      inFlight -= 1;
      return { ok: true, value: '' };
    });

    renderPanel({ activeResource: manyNotes[0], notes: manyNotes });

    await waitFor(() => expect(getContent).toHaveBeenCalledTimes(8));
    expect(maxInFlight).toBe(8);
    releaseGate();

    await screen.findByText('出链');
    expect(getContent).toHaveBeenCalledTimes(12);
  });

  it('bounds popular backlink loads at 256 and reports scanned candidate count', async () => {
    expect(BACKLINK_CANDIDATE_LIMIT).toBe(256);
    const activeNote: DstuNode = {
      id: 'note_active', sourceId: 'note_active', path: '/math/note_active', name: 'Active', type: 'note', createdAt: 0, updatedAt: 0,
    };
    const candidateNotes = Array.from({ length: BACKLINK_CANDIDATE_LIMIT + 1 }, (_, index): DstuNode => ({
      id: `note_candidate_${index}`,
      sourceId: `note_candidate_${index}`,
      path: `/math/note_candidate_${index}`,
      name: `Candidate ${index}`,
      type: 'note',
      createdAt: index + 1,
      updatedAt: index + 1,
    }));
    search.mockImplementation(async (query: string) => ({
      ok: true,
      value: query === '[[note_active]]' ? candidateNotes : [],
    }));
    getContent.mockImplementation(async (path: string) => ({
      ok: true,
      value: path === activeNote.path ? '' : '[[note_active]]',
    }));

    renderPanel({ activeResource: activeNote, notes: [activeNote, ...candidateNotes] });

    expect(await screen.findByText('出链')).toBeInTheDocument();
    expect(getContent).toHaveBeenCalledTimes(BACKLINK_CANDIDATE_LIMIT + 1);
    expect(getContent).not.toHaveBeenCalledWith(candidateNotes[0].path);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(String(BACKLINK_CANDIDATE_LIMIT));
    expect(status).toHaveTextContent('已扫描');

    // 增量加载：提升候选预算一页并重新扫描，补齐被截断的来源
    fireEvent.click(screen.getByRole('button', { name: '加载更多来源' }));
    await waitFor(() => expect(search).toHaveBeenCalledWith('[[note_active]]', {
      typeFilter: 'note',
      limit: BACKLINK_CANDIDATE_LIMIT * 2 + 1,
    }));
    await waitFor(() => expect(getContent).toHaveBeenCalledWith(candidateNotes[0].path));
    await waitFor(() => expect(screen.queryByRole('button', { name: '加载更多来源' })).toBeNull());
  });

  it('invalidates cached markdown from an updated-note event while the panel is open', async () => {
    let watchCallback: ((event: { type: string; node?: DstuNode }) => void) | null = null;
    watch.mockImplementation((_path: string, callback: (event: { type: string; node?: DstuNode }) => void) => {
      watchCallback = callback;
      return () => {};
    });
    const { rerender } = renderPanel();
    await screen.findByText('出链');
    expect(getContent).toHaveBeenCalledTimes(3);

    getContent.mockImplementation(async (path: string) => ({
      ok: true,
      value: path === notes[0].path
        ? '[[Beta]] [[note_gamma|Gamma alias]] [[missing]]\nUpdated'
        : contentByPath[path],
    }));
    watchCallback?.({ type: 'updated', node: { ...notes[0], updatedAt: 2 } });

    await waitFor(() => expect(search).toHaveBeenCalledTimes(SEARCHES_PER_LOAD * 2));
    expect(getContent).toHaveBeenCalledTimes(4);

    rerender(
      <NotesBacklinksPanel
        open={false}
        activeResource={notes[0]}
        notes={notes}
        onOpenResource={vi.fn()}
        onClose={vi.fn()}
      />,
    );
  });

  it('shows a retryable error when content loading fails and closes through the close control', async () => {
    getContent.mockResolvedValueOnce({ ok: false, error: new Error('offline') });
    const { onClose } = renderPanel();

    expect(await screen.findByRole('alert')).toHaveTextContent('offline');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await screen.findByText('出链');

    fireEvent.click(screen.getByRole('button', { name: '关闭链接' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('counts inbound links with padded targets and aliases', async () => {
    search.mockImplementation(async (query: string) => ({
      ok: true,
      value: query === '[[ Alpha '
        ? [notes[1], notes[3]]
        : query === '[[Alpha '
          ? [notes[2]]
          : [],
    }));
    getContent.mockImplementation(async (path: string) => ({
      ok: true,
      value: path === notes[1].path
        ? '[[ Alpha | both padded]]'
        : path === notes[2].path
          ? '[[Alpha | spaced alias]]'
          : path === notes[3].path
            ? '[[ Alpha ]]'
        : contentByPath[path],
    }));

    renderPanel();

    const incoming = await screen.findByRole('region', { name: /反向链接/ });
    expect(search).toHaveBeenCalledWith('[[ Alpha ', {
      typeFilter: 'note',
      limit: BACKLINK_CANDIDATE_LIMIT + 1,
    });
    expect(search).toHaveBeenCalledWith('[[Alpha ', {
      typeFilter: 'note',
      limit: BACKLINK_CANDIDATE_LIMIT + 1,
    });
    expect(getContent).toHaveBeenCalledWith(notes[1].path);
    expect(getContent).toHaveBeenCalledWith(notes[2].path);
    expect(getContent).toHaveBeenCalledWith(notes[3].path);
    expect(within(incoming).getByRole('button', { name: '打开 Beta' })).toBeInTheDocument();
    expect(within(incoming).getByRole('button', { name: '打开 Gamma' })).toBeInTheDocument();
    expect(within(incoming).getByRole('button', { name: '打开 Delta' })).toBeInTheDocument();
  });

  it('calls onCreateFromUnresolved and hides the unresolved section when empty', async () => {
    const onCreateFromUnresolved = vi.fn().mockResolvedValue(undefined);
    const onRefresh = vi.fn();
    renderPanel({ onCreateFromUnresolved, onRefresh });
    await screen.findByText('[[missing]]');
    expect(screen.getByRole('region', { name: /未解析链接/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '创建笔记「missing」' }));
    await waitFor(() => expect(onCreateFromUnresolved).toHaveBeenCalledWith('missing'));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('[[missing]]')).toBeNull();
    expect(screen.queryByRole('region', { name: /未解析链接/ })).toBeNull();
  });

  it('does not render create buttons when onCreateFromUnresolved is omitted', async () => {
    renderPanel();
    await screen.findByText('[[missing]]');
    expect(screen.queryByRole('button', { name: /创建笔记/ })).toBeNull();
  });

  it('shows partitioned empty copy for outgoing and incoming, and hides empty unresolved', async () => {
    getContent.mockImplementation(async (path: string) => ({
      ok: true,
      value: path === notes[3].path ? 'No links here.' : '',
    }));
    search.mockResolvedValue({ ok: true, value: [] });

    renderPanel({ activeResource: notes[3], notes });

    const outgoing = await screen.findByRole('region', { name: /出链/ });
    const incoming = screen.getByRole('region', { name: /反向链接/ });
    expect(within(outgoing).getByText('本篇还没有链接其他笔记，输入 [[ 即可创建双链')).toBeInTheDocument();
    expect(within(incoming).getByText('还没有其他笔记链接到这里')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /未解析链接/ })).toBeNull();
    expect(screen.queryByText('没有未解析的链接。')).toBeNull();
  });

  it('persists section collapse state in localStorage', async () => {
    renderPanel();
    await screen.findByText('出链');

    fireEvent.click(screen.getByRole('button', { name: /出链/ }));
    expect(localStorage.getItem('notes-backlinks-panel:section-collapse')).toContain('"outgoing":true');
  });

  it('lists unlinked mentions, filters linked sources, and opens via the convert entry', async () => {
    search.mockImplementation(async (query: string) => ({
      ok: true,
      value: query === 'Alpha'
        ? [notes[1], notes[3]]
        : query === '[[Alpha|'
          ? [notes[1]]
          : [],
    }));
    getContent.mockImplementation(async (path: string) => ({
      ok: true,
      value: path === notes[3].path
        ? 'Talks about Alpha in plain text.'
        : contentByPath[path],
    }));
    const { onOpenResource } = renderPanel();

    const mentions = await screen.findByRole('region', { name: /未链接提及/ });
    await waitFor(() => expect(search).toHaveBeenCalledWith('Alpha', {
      typeFilter: 'note',
      limit: UNLINKED_MENTION_CANDIDATE_LIMIT + 1,
    }));

    expect(await within(mentions).findByRole('button', { name: '打开 Delta' })).toBeInTheDocument();
    // Beta 已经链接到当前笔记，属于已链接来源，不出现在未链接提及中
    expect(within(mentions).queryByRole('button', { name: '打开 Beta' })).toBeNull();
    expect(within(mentions).getByText('Alpha')).toHaveClass('notes-backlinks-panel-context-mark');

    fireEvent.click(within(mentions).getByRole('button', { name: '在「Delta」中转为链接' }));
    await waitFor(() => expect(onOpenResource).toHaveBeenCalledWith(notes[3]));
  });

  it('shows the empty mentions state when nothing mentions the active title', async () => {
    renderPanel();
    const mentions = await screen.findByRole('region', { name: /未链接提及/ });
    expect(await within(mentions).findByText('没有找到未链接的提及')).toBeInTheDocument();
  });
});
