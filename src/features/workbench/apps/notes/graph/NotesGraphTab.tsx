/**
 * 统一右侧栏「图谱」页：当前笔记的 1-2 度局部链接图。
 *
 * 数据链路（后端优先）：notes_get_backlinks / notes_get_outgoing_links
 * 读持久 note_links 图（见 backlinksBackend.ts）。后端不可用（VFS 未配置、
 * 纯 Web 环境）时回退为客户端解析当前笔记正文的出链 —— 单次内容读取，
 * 与背链面板的降级策略一致，此时仅有 1 度出链且 UI 有提示。
 *
 * 渲染层（@xyflow/react）经 React.lazy 懒加载，不进启动 chunk。
 */

import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { ArrowClockwise, CircleNotch, Graph } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { dstu, type DstuNode } from '@/dstu';
import { getWikiLinkRelationships } from '@/features/notes/wikilinks';
import {
  fetchBacklinksFromBackend,
  fetchOutgoingLinksFromBackend,
} from '../backlinksBackend';
import {
  buildLocalGraph,
  ghostNodeId,
  type LocalGraphData,
  type LocalGraphNodeDatum,
} from './localGraph';
import './NotesLocalGraph.css';

const NotesLocalGraphView = React.lazy(() => import('./NotesLocalGraphView'));

export type LocalGraphDepth = 1 | 2;

type GraphLoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: LocalGraphData; source: 'backend' | 'client' }
  | { status: 'error'; message: string };

const GRAPH_DEPTH_STORAGE_KEY = 'notes-local-graph:depth';
const GRAPH_WATCH_REFRESH_DEBOUNCE_MS = 400;

function readInitialDepth(): LocalGraphDepth {
  try {
    return window.localStorage.getItem(GRAPH_DEPTH_STORAGE_KEY) === '1' ? 1 : 2;
  } catch {
    return 2;
  }
}

function writeDepth(depth: LocalGraphDepth): void {
  try {
    window.localStorage.setItem(GRAPH_DEPTH_STORAGE_KEY, String(depth));
  } catch {
    // localStorage unavailable: keep the in-memory selection only.
  }
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'toUserMessage' in error) {
    const toUserMessage = (error as { toUserMessage?: unknown }).toUserMessage;
    if (typeof toUserMessage === 'function') {
      const message = toUserMessage.call(error);
      if (typeof message === 'string' && message.trim()) return message;
    }
  }
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}

/** 客户端降级：仅解析当前笔记正文的出链（含未解析幽灵目标）。 */
async function buildClientFallbackGraph(
  activeNote: DstuNode,
  notes: readonly DstuNode[],
): Promise<LocalGraphData> {
  const contentResult = await dstu.getContent(activeNote.path);
  if (!contentResult.ok) throw contentResult.error;
  const content = typeof contentResult.value === 'string'
    ? contentResult.value
    : await contentResult.value.text();

  const noteEntries = new Map(
    [...notes.filter((node) => node.type === 'note'), activeNote]
      .map((node) => [node.id, {
        title: node.name,
        content: node.id === activeNote.id ? content : '',
      }]),
  );
  const relationships = getWikiLinkRelationships(noteEntries);

  const nodesById = new Map<string, LocalGraphNodeDatum>();
  const edges: LocalGraphData['edges'] = [];
  nodesById.set(activeNote.id, {
    id: activeNote.id,
    title: activeNote.name,
    degree: 0,
    exists: true,
  });

  const titleById = new Map(notes.map((node) => [node.id, node.name]));
  for (const relationship of relationships.outboundByNoteId[activeNote.id] ?? []) {
    const targetId = relationship.targetId;
    if (!nodesById.has(targetId)) {
      nodesById.set(targetId, {
        id: targetId,
        title: titleById.get(targetId) ?? relationship.link.target,
        degree: 1,
        exists: true,
      });
      // 客户端降级只解析 [[..]] 双链正文，边类型恒为 wikilink
      edges.push({
        id: `e-${edges.length}`,
        source: activeNote.id,
        target: targetId,
        kind: 'wikilink',
      });
    }
  }
  for (const unresolved of relationships.unresolved) {
    if (unresolved.sourceId !== activeNote.id) continue;
    const id = ghostNodeId(unresolved.link.target);
    if (nodesById.has(id)) continue;
    nodesById.set(id, { id, title: unresolved.link.target, degree: 1, exists: false });
    edges.push({ id: `e-${edges.length}`, source: activeNote.id, target: id, kind: 'wikilink' });
  }

  return { nodes: Array.from(nodesById.values()), edges, truncated: false };
}

export interface NotesGraphTabProps {
  /** 图谱页是否可见（面板打开且当前页签为图谱） */
  open: boolean;
  activeResource: DstuNode | null;
  /** 工作区资源列表：解析节点标题 / 点击打开时定位真实节点 */
  notes: readonly DstuNode[];
  onOpenResource: (resource: DstuNode) => void | Promise<void>;
}

export const NotesGraphTab: React.FC<NotesGraphTabProps> = ({
  open,
  activeResource,
  notes,
  onOpenResource,
}) => {
  const { t } = useTranslation('workbench');
  const [depth, setDepth] = useState<LocalGraphDepth>(readInitialDepth);
  const [loadState, setLoadState] = useState<GraphLoadState>({ status: 'idle' });
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [openError, setOpenError] = useState<string | null>(null);
  const loadSequenceRef = useRef(0);
  const watchTimerRef = useRef<number | null>(null);

  const activeNote = activeResource?.type === 'note' ? activeResource : null;
  const activeNoteId = activeNote?.id ?? null;

  const changeDepth = useCallback((next: LocalGraphDepth) => {
    setDepth(next);
    writeDepth(next);
  }, []);

  const refresh = useCallback(() => {
    setRefreshVersion((value) => value + 1);
  }, []);

  // 图谱可见期间监听笔记更新：保存/改名后延迟刷新（防抖合并连续保存）
  useEffect(() => {
    if (!open || !activeNoteId) return undefined;
    const unwatch = dstu.watch('*', (event) => {
      if (event.type !== 'updated' || event.node?.type !== 'note') return;
      if (watchTimerRef.current !== null) window.clearTimeout(watchTimerRef.current);
      watchTimerRef.current = window.setTimeout(() => {
        watchTimerRef.current = null;
        setRefreshVersion((value) => value + 1);
      }, GRAPH_WATCH_REFRESH_DEBOUNCE_MS);
    });
    return () => {
      unwatch();
      if (watchTimerRef.current !== null) {
        window.clearTimeout(watchTimerRef.current);
        watchTimerRef.current = null;
      }
    };
  }, [activeNoteId, open]);

  useEffect(() => {
    const sequence = ++loadSequenceRef.current;
    if (!open || !activeNote) {
      setLoadState({ status: 'idle' });
      setOpenError(null);
      return undefined;
    }
    let disposed = false;
    const isCurrent = () => !disposed && sequence === loadSequenceRef.current;
    setLoadState({ status: 'loading' });
    setOpenError(null);

    void (async () => {
      try {
        let data: LocalGraphData | null = null;
        let source: 'backend' | 'client' = 'backend';
        try {
          data = await buildLocalGraph(
            { id: activeNote.id, title: activeNote.name },
            depth,
            async (noteId) => {
              const [backlinks, outgoing] = await Promise.all([
                fetchBacklinksFromBackend(noteId),
                fetchOutgoingLinksFromBackend(noteId),
              ]);
              return { backlinks, outgoing };
            },
          );
        } catch {
          data = null;
        }
        if (!isCurrent()) return;
        if (!data) {
          source = 'client';
          data = await buildClientFallbackGraph(activeNote, notes);
        }
        if (!isCurrent()) return;
        setLoadState({ status: 'ready', data, source });
      } catch (error) {
        if (!isCurrent()) return;
        setLoadState({
          status: 'error',
          message: getErrorMessage(
            error,
            t('notesWorkspace.graph.loadFailed', { defaultValue: '无法加载局部图谱。' }),
          ),
        });
      }
    })();

    return () => {
      disposed = true;
    };
    // activeNote 对象在纯内容保存时不会被替换，依赖其 id 而非引用
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeNoteId, activeNote?.name, depth, notes, open, refreshVersion, t]);

  const openGraphNode = useCallback(async (graphNode: LocalGraphNodeDatum) => {
    if (graphNode.id === activeNoteId) return;
    setOpenError(null);
    const known = notes.find((node) => node.type === 'note' && node.id === graphNode.id);
    const resource: DstuNode = known ?? {
      id: graphNode.id,
      sourceId: graphNode.id,
      path: `/${graphNode.id}`,
      name: graphNode.title,
      type: 'note',
      createdAt: 0,
      updatedAt: 0,
    };
    try {
      await onOpenResource(resource);
    } catch (error) {
      setOpenError(getErrorMessage(
        error,
        t('notesWorkspace.backlinks.openFailed'),
      ));
    }
  }, [activeNoteId, notes, onOpenResource, t]);

  if (!open) return null;

  if (!activeNote) {
    return (
      <div className="notes-backlinks-panel-message">
        <Graph size={22} aria-hidden="true" />
        {t('notesWorkspace.graph.noActiveNote', { defaultValue: '选择一篇笔记以查看图谱。' })}
      </div>
    );
  }

  const isEmptyGraph = loadState.status === 'ready'
    && loadState.data.nodes.length <= 1
    && loadState.data.edges.length === 0;

  // 纯双链图不出图例；只有真的存在引用链接（note://）时才需要区分两类边
  const hasNoterefEdges = loadState.status === 'ready'
    && loadState.data.edges.some((edge) => edge.kind === 'noteref');

  return (
    <div className="notes-graph-tab" data-notes-graph-tab>
      <div className="notes-graph-toolbar">
        <div
          className="notes-graph-depth"
          role="group"
          aria-label={t('notesWorkspace.graph.depthLabel', { defaultValue: '图谱深度' })}
        >
          <button
            type="button"
            data-active={depth === 1 ? 'true' : undefined}
            aria-pressed={depth === 1}
            onClick={() => changeDepth(1)}
          >
            {t('notesWorkspace.graph.depth1', { defaultValue: '1 度' })}
          </button>
          <button
            type="button"
            data-active={depth === 2 ? 'true' : undefined}
            aria-pressed={depth === 2}
            onClick={() => changeDepth(2)}
          >
            {t('notesWorkspace.graph.depth2', { defaultValue: '2 度' })}
          </button>
        </div>
        {hasNoterefEdges && (
          <div
            className="notes-graph-legend"
            data-notes-graph-legend
            role="note"
            aria-label={t('notesWorkspace.graph.legendLabel', { defaultValue: '边类型图例' })}
          >
            <span className="notes-graph-legend-item">
              <i className="notes-graph-legend-swatch is-wikilink" aria-hidden="true" />
              {t('notesWorkspace.graph.legendWikilink', { defaultValue: '双链' })}
            </span>
            <span className="notes-graph-legend-item">
              <i className="notes-graph-legend-swatch is-noteref" aria-hidden="true" />
              {t('notesWorkspace.graph.legendNoteref', { defaultValue: '引用' })}
            </span>
          </div>
        )}
        <button
          type="button"
          className="notes-backlinks-panel-icon-button"
          disabled={loadState.status === 'loading'}
          onClick={refresh}
          aria-label={t('notesWorkspace.graph.refresh', { defaultValue: '刷新图谱' })}
          title={t('notesWorkspace.graph.refresh', { defaultValue: '刷新图谱' })}
        >
          <ArrowClockwise size={15} aria-hidden="true" />
        </button>
      </div>

      <div className="notes-graph-body">
        {loadState.status === 'loading' || loadState.status === 'idle' ? (
          <div className="notes-backlinks-panel-message" role="status">
            <CircleNotch className="notes-backlinks-panel-spinner" size={16} aria-hidden="true" />
            {t('notesWorkspace.graph.loading', { defaultValue: '正在构建图谱…' })}
          </div>
        ) : loadState.status === 'error' ? (
          <div className="notes-backlinks-panel-message notes-backlinks-panel-message-error" role="alert">
            <span>{loadState.message}</span>
            <button type="button" onClick={refresh}>
              {t('notesWorkspace.backlinks.retry')}
            </button>
          </div>
        ) : isEmptyGraph ? (
          <div className="notes-backlinks-panel-message">
            <Graph size={22} aria-hidden="true" />
            {t('notesWorkspace.graph.empty', { defaultValue: '本篇还没有任何链接，输入 [[ 即可创建双链。' })}
          </div>
        ) : (
          <Suspense
            fallback={(
              <div className="notes-graph-lazy-loading" aria-hidden="true">
                <i /><i /><i />
              </div>
            )}
          >
            <NotesLocalGraphView
              data={loadState.data}
              onOpenNode={(node) => void openGraphNode(node)}
              ariaLabel={t('notesWorkspace.graph.canvasAria', {
                defaultValue: '「{{title}}」的局部链接图',
                title: activeNote.name,
              })}
            />
          </Suspense>
        )}
      </div>

      {loadState.status === 'ready' && (loadState.data.truncated || loadState.source === 'client') && (
        <p className="notes-graph-hint" role="status">
          {loadState.source === 'client'
            ? t('notesWorkspace.graph.clientFallback', {
              defaultValue: '图谱服务不可用，仅显示当前笔记的出链。',
            })
            : t('notesWorkspace.graph.truncated', {
              defaultValue: '连接较多，仅显示部分节点。',
            })}
        </p>
      )}
      {openError && <p className="notes-backlinks-panel-open-error" role="alert">{openError}</p>}
    </div>
  );
};

export default NotesGraphTab;
