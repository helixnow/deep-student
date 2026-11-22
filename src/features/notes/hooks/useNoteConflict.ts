import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { dstu } from '@/dstu';
import { computeDiffLines, type DiffLine } from './useAIEditState';

/**
 * 保存冲突上下文。mineContent 在事件到达时同步快照自 contentRef
 * （事件派发早于发起方的强制远端刷新，此刻编辑器里仍是用户版本）；
 * serverContent 为发起方随事件带来的远端胜出版本（旧发起方无此字段时
 * 「对比」降级为 dstu.getContent 拉取磁盘最新内容）。
 */
export interface NoteConflictAction {
  restoreMine: () => void;
  mineContent: string;
  serverContent?: string;
}

export type ConflictRemoteStatus = 'idle' | 'loading' | 'error';

export interface ConflictDiffStats {
  added: number;
  removed: number;
}

export interface UseNoteConflictOptions {
  noteId?: string;
  noteIdRef: React.RefObject<string | null>;
  contentRef: React.RefObject<string>;
  isUnmountedRef: React.RefObject<boolean>;
  onConflictDetected?: () => void;
  onConflictResolved?: () => void;
}

export interface UseNoteConflictResult {
  conflictAction: NoteConflictAction | null;
  conflictDiffOpen: boolean;
  setConflictDiffOpen: React.Dispatch<React.SetStateAction<boolean>>;
  conflictRemoteFetched: string | null;
  conflictRemoteStatus: ConflictRemoteStatus;
  conflictDiffRegionId: string;
  conflictDiffLines: DiffLine[] | null;
  conflictDiffStats: ConflictDiffStats | null;
  fetchConflictRemote: () => Promise<void>;
  resolveConflict: (mode: 'mine' | 'remote', action: { restoreMine: () => void }) => void;
}

export function useNoteConflict({
  noteId,
  noteIdRef,
  contentRef,
  isUnmountedRef,
  onConflictDetected,
  onConflictResolved,
}: UseNoteConflictOptions): UseNoteConflictResult {
  const [conflictAction, setConflictAction] = useState<NoteConflictAction | null>(null);
  /** 冲突「对比」内联 diff 区展开态（grid-rows 0fr→1fr） */
  const [conflictDiffOpen, setConflictDiffOpen] = useState(false);
  /** 降级拉取到的远端内容（payload 无 serverContent 时） */
  const [conflictRemoteFetched, setConflictRemoteFetched] = useState<string | null>(null);
  const [conflictRemoteStatus, setConflictRemoteStatus] = useState<ConflictRemoteStatus>('idle');
  const conflictDiffRegionId = useId();

  const onConflictDetectedRef = useRef(onConflictDetected);
  onConflictDetectedRef.current = onConflictDetected;
  const onConflictResolvedRef = useRef(onConflictResolved);
  onConflictResolvedRef.current = onConflictResolved;

  useEffect(() => {
    const onConflict = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          noteId?: string;
          restoreMine?: () => void;
          /** 可选：发起方随事件带来的远端胜出版本（向后兼容旧发起方） */
          serverContent?: string;
        }>
      ).detail;
      if (!detail?.restoreMine || detail.noteId !== noteIdRef.current) return;
      setConflictAction({
        restoreMine: detail.restoreMine,
        // 事件同步派发于发起方 refreshFromDisk(force) 之前，
        // 此刻 contentRef 仍是被冲突顶掉的用户版本。
        mineContent: contentRef.current,
        serverContent: typeof detail.serverContent === 'string' ? detail.serverContent : undefined,
      });
      setConflictDiffOpen(false);
      setConflictRemoteFetched(null);
      setConflictRemoteStatus('idle');
      onConflictDetectedRef.current?.();
    };
    window.addEventListener('notes:content-conflict', onConflict);
    return () => window.removeEventListener('notes:content-conflict', onConflict);
  }, [noteIdRef, contentRef]);

  // 切换笔记时清掉上一篇的冲突横幅/对比区，避免旧笔记的 restoreMine 挂在新笔记上。
  useEffect(() => {
    setConflictAction(null);
    setConflictDiffOpen(false);
    setConflictRemoteFetched(null);
    setConflictRemoteStatus('idle');
  }, [noteId]);

  /** 兼容旧发起方：payload 无 serverContent 时按需拉取磁盘最新版本 */
  const fetchConflictRemote = useCallback(async () => {
    const targetNoteId = noteIdRef.current;
    if (!targetNoteId) return;
    setConflictRemoteStatus('loading');
    const result = await dstu.getContent(`/${targetNoteId}`);
    if (isUnmountedRef.current || targetNoteId !== noteIdRef.current) return;
    if (result.ok && typeof result.value === 'string') {
      setConflictRemoteFetched(result.value);
      setConflictRemoteStatus('idle');
    } else {
      setConflictRemoteStatus('error');
    }
  }, [noteIdRef, isUnmountedRef]);

  // 「对比」首次展开且 payload 未携带远端内容时触发降级拉取
  useEffect(() => {
    if (!conflictDiffOpen || !conflictAction) return;
    if (conflictAction.serverContent !== undefined || conflictRemoteFetched !== null) return;
    if (conflictRemoteStatus !== 'idle') return;
    void fetchConflictRemote();
  }, [conflictDiffOpen, conflictAction, conflictRemoteFetched, conflictRemoteStatus, fetchConflictRemote]);

  const conflictRemoteContent = conflictAction
    ? (conflictAction.serverContent ?? conflictRemoteFetched)
    : null;

  // 方向：远端（当前编辑器内容）→ 我的版本。
  // + 行 = 我的版本独有、− 行 = 远端独有，与「恢复我的版本」将应用的变化一致。
  const conflictDiffLines = useMemo(() => {
    if (!conflictAction || conflictRemoteContent == null) return null;
    return computeDiffLines(conflictRemoteContent, conflictAction.mineContent);
  }, [conflictAction, conflictRemoteContent]);

  const conflictDiffStats = useMemo<ConflictDiffStats | null>(() => {
    if (!conflictDiffLines) return null;
    return {
      added: conflictDiffLines.filter((line) => line.type === 'added').length,
      removed: conflictDiffLines.filter((line) => line.type === 'removed').length,
    };
  }, [conflictDiffLines]);

  /** 冲突两个行动按钮的公共收尾：清横幅/对比区，「恢复我的版本」再执行回写 */
  const resolveConflict = useCallback(
    (mode: 'mine' | 'remote', action: { restoreMine: () => void }) => {
      setConflictAction(null);
      setConflictDiffOpen(false);
      setConflictRemoteFetched(null);
      setConflictRemoteStatus('idle');
      onConflictResolvedRef.current?.();
      if (mode === 'mine') action.restoreMine();
    },
    [],
  );

  return {
    conflictAction,
    conflictDiffOpen,
    setConflictDiffOpen,
    conflictRemoteFetched,
    conflictRemoteStatus,
    conflictDiffRegionId,
    conflictDiffLines,
    conflictDiffStats,
    fetchConflictRemote,
    resolveConflict,
  };
}
