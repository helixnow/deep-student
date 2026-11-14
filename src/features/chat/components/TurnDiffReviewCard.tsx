// 1. React 核心
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
// 2. 第三方库（按字母序）
import { ArrowCounterClockwise, ArrowClockwise, CaretDown, CaretRight, FileCode } from '@phosphor-icons/react';
// 3. @/ 路径别名
import { cn } from '@/utils/cn';

// ============================================================================
// 类型定义
// ============================================================================

export type TurnDiffChangeKind = 'modified' | 'created' | 'deleted';

export interface TurnFileDiffEntry {
  id: string;
  path: string;
  kind: TurnDiffChangeKind;
  beforeContent: string | null;
  afterContent: string | null;
  additions: number;
  deletions: number;
  reverted?: boolean;
}

export interface UnifiedDiffLine {
  type: 'context' | 'add' | 'del';
  prefix: ' ' | '+' | '-';
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

export interface UnifiedDiffSummary {
  additions: number;
  deletions: number;
  lines: UnifiedDiffLine[];
  unifiedText: string;
}

export interface TurnDiffRecordInput {
  id?: string;
  path: string;
  kind?: TurnDiffChangeKind;
  beforeContent: string | null;
  afterContent: string | null;
  reverted?: boolean;
}

export interface TurnDiffTotals {
  totalFiles: number;
  activeFiles: number;
  revertedFiles: number;
  additions: number;
  deletions: number;
  activeAdditions: number;
  activeDeletions: number;
  allReverted: boolean;
}

// ============================================================================
// 纯逻辑：Unified Diff 行统计与生成
// ============================================================================

function splitLines(text: string | null | undefined): string[] {
  if (text === null || text === undefined || text === '') {
    return [];
  }
  const normalized = text.includes('\r') ? text.replace(/\r\n/g, '\n') : text;
  const parts = normalized.split('\n');
  if (parts.length > 1 && parts[parts.length - 1] === '') {
    return parts.slice(0, -1);
  }
  return parts;
}

/**
 * 计算修改前后的增删行数统计与简化 Unified Diff 行列表。
 */
export function computeUnifiedDiffSummary(
  before: string | null | undefined,
  after: string | null | undefined,
): UnifiedDiffSummary {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const m = beforeLines.length;
  const n = afterLines.length;

  const lines: UnifiedDiffLine[] = [];
  let additions = 0;
  let deletions = 0;

  if (m === 0 && n === 0) {
    return { additions: 0, deletions: 0, lines: [], unifiedText: '' };
  }

  // LCS 动态规划（限制在合理矩阵尺寸内以确保 O(m*n) 实时响应）
  if (m * n <= 160_000) {
    const dp: Uint16Array[] = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
    for (let i = m - 1; i >= 0; i -= 1) {
      for (let j = n - 1; j >= 0; j -= 1) {
        if (beforeLines[i] === afterLines[j]) {
          dp[i][j] = dp[i + 1][j + 1] + 1;
        } else {
          const down = dp[i + 1][j];
          const right = dp[i][j + 1];
          dp[i][j] = down >= right ? down : right;
        }
      }
    }

    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (beforeLines[i] === afterLines[j]) {
        lines.push({
          type: 'context',
          prefix: ' ',
          content: beforeLines[i],
          oldLineNumber: i + 1,
          newLineNumber: j + 1,
        });
        i += 1;
        j += 1;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        lines.push({
          type: 'del',
          prefix: '-',
          content: beforeLines[i],
          oldLineNumber: i + 1,
        });
        deletions += 1;
        i += 1;
      } else {
        lines.push({
          type: 'add',
          prefix: '+',
          content: afterLines[j],
          newLineNumber: j + 1,
        });
        additions += 1;
        j += 1;
      }
    }

    while (i < m) {
      lines.push({
        type: 'del',
        prefix: '-',
        content: beforeLines[i],
        oldLineNumber: i + 1,
      });
      deletions += 1;
      i += 1;
    }

    while (j < n) {
      lines.push({
        type: 'add',
        prefix: '+',
        content: afterLines[j],
        newLineNumber: j + 1,
      });
      additions += 1;
      j += 1;
    }
  } else {
    for (let i = 0; i < m; i += 1) {
      lines.push({
        type: 'del',
        prefix: '-',
        content: beforeLines[i],
        oldLineNumber: i + 1,
      });
      deletions += 1;
    }
    for (let j = 0; j < n; j += 1) {
      lines.push({
        type: 'add',
        prefix: '+',
        content: afterLines[j],
        newLineNumber: j + 1,
      });
      additions += 1;
    }
  }

  const unifiedText = lines.map((line) => `${line.prefix} ${line.content}`).join('\n');

  return {
    additions,
    deletions,
    lines,
    unifiedText,
  };
}

// ============================================================================
// 纯逻辑控制器：TurnDiffLedger
// ============================================================================

export class TurnDiffLedger {
  private entries: TurnFileDiffEntry[] = [];

  public constructor(initialEntries: readonly TurnFileDiffEntry[] = []) {
    this.entries = initialEntries.map((entry) => ({
      ...entry,
      reverted: Boolean(entry.reverted),
    }));
  }

  public recordChange(input: TurnDiffRecordInput): TurnFileDiffEntry {
    const normalizedPath = input.path.trim();
    const existingIndex = this.entries.findIndex(
      (item) => (input.id && item.id === input.id) || item.path === normalizedPath,
    );

    const baselineBefore =
      existingIndex >= 0 ? this.entries[existingIndex].beforeContent : input.beforeContent;
    const nextAfter = input.afterContent;

    const inferredKind: TurnDiffChangeKind =
      input.kind ??
      (baselineBefore === null && nextAfter !== null
        ? 'created'
        : baselineBefore !== null && nextAfter === null
          ? 'deleted'
          : 'modified');

    const diffSummary = computeUnifiedDiffSummary(baselineBefore, nextAfter);

    const nextEntry: TurnFileDiffEntry = {
      id:
        input.id ??
        (existingIndex >= 0
          ? this.entries[existingIndex].id
          : `diff-${this.entries.length + 1}-${normalizedPath}`),
      path: normalizedPath,
      kind: inferredKind,
      beforeContent: baselineBefore,
      afterContent: nextAfter,
      additions: diffSummary.additions,
      deletions: diffSummary.deletions,
      reverted: Boolean(input.reverted),
    };

    if (existingIndex >= 0) {
      this.entries[existingIndex] = nextEntry;
    } else {
      this.entries.push(nextEntry);
    }

    return { ...nextEntry };
  }

  public getEntries(): TurnFileDiffEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  public getEntry(idOrPath: string): TurnFileDiffEntry | undefined {
    const found = this.entries.find(
      (entry) => entry.id === idOrPath || entry.path === idOrPath,
    );
    return found ? { ...found } : undefined;
  }

  public getTotals(): TurnDiffTotals {
    let additions = 0;
    let deletions = 0;
    let activeAdditions = 0;
    let activeDeletions = 0;
    let revertedFiles = 0;

    for (const entry of this.entries) {
      additions += entry.additions;
      deletions += entry.deletions;
      if (entry.reverted) {
        revertedFiles += 1;
      } else {
        activeAdditions += entry.additions;
        activeDeletions += entry.deletions;
      }
    }

    const totalFiles = this.entries.length;
    const activeFiles = totalFiles - revertedFiles;

    return {
      totalFiles,
      activeFiles,
      revertedFiles,
      additions,
      deletions,
      activeAdditions,
      activeDeletions,
      allReverted: totalFiles > 0 && revertedFiles === totalFiles,
    };
  }

  public revertFile(
    idOrPath: string,
  ): { entry: TurnFileDiffEntry; restoredContent: string | null } | null {
    const idx = this.entries.findIndex(
      (entry) => entry.id === idOrPath || entry.path === idOrPath,
    );
    if (idx < 0) return null;

    this.entries[idx] = {
      ...this.entries[idx],
      reverted: true,
    };
    const updated = { ...this.entries[idx] };
    return {
      entry: updated,
      restoredContent: updated.beforeContent,
    };
  }

  public redoFile(
    idOrPath: string,
  ): { entry: TurnFileDiffEntry; appliedContent: string | null } | null {
    const idx = this.entries.findIndex(
      (entry) => entry.id === idOrPath || entry.path === idOrPath,
    );
    if (idx < 0) return null;

    this.entries[idx] = {
      ...this.entries[idx],
      reverted: false,
    };
    const updated = { ...this.entries[idx] };
    return {
      entry: updated,
      appliedContent: updated.afterContent,
    };
  }

  public restoreFile(
    idOrPath: string,
  ): { entry: TurnFileDiffEntry; appliedContent: string | null } | null {
    return this.redoFile(idOrPath);
  }

  public revertAll(): Array<{ entry: TurnFileDiffEntry; restoredContent: string | null }> {
    this.entries = this.entries.map((entry) => ({
      ...entry,
      reverted: true,
    }));
    return this.entries.map((entry) => ({
      entry: { ...entry },
      restoredContent: entry.beforeContent,
    }));
  }

  public redoAll(): Array<{ entry: TurnFileDiffEntry; appliedContent: string | null }> {
    this.entries = this.entries.map((entry) => ({
      ...entry,
      reverted: false,
    }));
    return this.entries.map((entry) => ({
      entry: { ...entry },
      appliedContent: entry.afterContent,
    }));
  }

  public restoreAll(): Array<{ entry: TurnFileDiffEntry; appliedContent: string | null }> {
    return this.redoAll();
  }
}

// ============================================================================
// Props 定义
// ============================================================================

export interface TurnDiffReviewCardProps {
  /** 本轮修改的文件/笔记/讲义条目 */
  entries: TurnFileDiffEntry[];
  /** 单文件回滚回调（返回 false 或 Promise reject 时自动回滚 UI 状态） */
  onRevertFile?: (
    entryId: string,
    entry: TurnFileDiffEntry,
  ) => boolean | void | Promise<boolean | void>;
  /** 单文件重做恢复回调（仅传入真实写回回调或纯本地演示模式时展示 Redo） */
  onRedoFile?: (
    entryId: string,
    entry: TurnFileDiffEntry,
  ) => boolean | void | Promise<boolean | void>;
  /** 整轮一键回滚回调（返回 false 或 Promise reject 时自动回滚 UI 状态） */
  onRevertAll?: (
    entries: TurnFileDiffEntry[],
  ) => boolean | void | Promise<boolean | void>;
  /** 整轮一键恢复回调（仅传入真实写回回调或纯本地演示模式时展示 Redo） */
  onRedoAll?: (
    entries: TurnFileDiffEntry[],
  ) => boolean | void | Promise<boolean | void>;
  /** 默认是否展开文件 Diff 详情（默认 true） */
  defaultExpanded?: boolean;
  /** 外层类名 */
  className?: string;
}

// ============================================================================
// 辅助函数
// ============================================================================

const KIND_LABELS: Record<TurnDiffChangeKind, string> = {
  modified: '已修改',
  created: '新建',
  deleted: '已删除',
};

interface CachedDiffRecord {
  before: string | null;
  after: string | null;
  summary: UnifiedDiffSummary;
}

function getOrComputeCachedDiff(
  cache: Map<string, CachedDiffRecord>,
  entry: Pick<TurnFileDiffEntry, 'id' | 'beforeContent' | 'afterContent'>,
): UnifiedDiffSummary {
  const existing = cache.get(entry.id);
  if (
    existing &&
    existing.before === entry.beforeContent &&
    existing.after === entry.afterContent
  ) {
    return existing.summary;
  }
  const summary = computeUnifiedDiffSummary(entry.beforeContent, entry.afterContent);
  cache.set(entry.id, {
    before: entry.beforeContent,
    after: entry.afterContent,
    summary,
  });
  return summary;
}

function normalizeInputEntries(
  rawEntries: readonly TurnFileDiffEntry[],
  cache: Map<string, CachedDiffRecord>,
): TurnFileDiffEntry[] {
  return rawEntries.map((entry) => {
    if (
      entry.additions === 0 &&
      entry.deletions === 0 &&
      (entry.beforeContent || entry.afterContent)
    ) {
      const computed = getOrComputeCachedDiff(cache, entry);
      return {
        ...entry,
        additions: computed.additions,
        deletions: computed.deletions,
        reverted: Boolean(entry.reverted),
      };
    }
    return { ...entry, reverted: Boolean(entry.reverted) };
  });
}

// ============================================================================
// 组件实现：TurnDiffReviewCard
// ============================================================================

export const TurnDiffReviewCard: React.FC<TurnDiffReviewCardProps> = ({
  entries,
  onRevertFile,
  onRedoFile,
  onRevertAll,
  onRedoAll,
  defaultExpanded = true,
  className,
}) => {
  const diffCacheRef = useRef<Map<string, CachedDiffRecord>>(new Map());
  const latestPropEntriesRef = useRef<TurnFileDiffEntry[]>(entries);
  latestPropEntriesRef.current = entries;

  const [localEntries, setLocalEntries] = useState<TurnFileDiffEntry[]>(() =>
    normalizeInputEntries(entries, diffCacheRef.current),
  );
  const localEntriesRef = useRef<TurnFileDiffEntry[]>(localEntries);
  localEntriesRef.current = localEntries;

  const [expandedIds, setExpandedIds] = useState<Set<string>>(() =>
    defaultExpanded ? new Set(entries.map((entry) => entry.id)) : new Set(),
  );

  // 无受控后端回调时为纯本地演示模式；有受控后端时仅在显式提供 onRedoFile / onRedoAll 时才允许 Redo
  const isUncontrolledDemo = !onRevertFile && !onRevertAll && !onRedoFile && !onRedoAll;
  const canRedoSingle = Boolean(onRedoFile) || isUncontrolledDemo;
  const canRedoAll = Boolean(onRedoAll) || isUncontrolledDemo;

  useEffect(() => {
    const normalized = normalizeInputEntries(entries, diffCacheRef.current);
    localEntriesRef.current = normalized;
    setLocalEntries(normalized);
  }, [entries]);

  // 缓存每个 entry 的 Unified Diff 计算结果，折叠/悬停/回滚状态切换时不重复跑 LCS 动态规划
  const diffSummariesById = useMemo(() => {
    const map = new Map<string, UnifiedDiffSummary>();
    const activeIds = new Set<string>();
    for (const entry of localEntries) {
      activeIds.add(entry.id);
      map.set(entry.id, getOrComputeCachedDiff(diffCacheRef.current, entry));
    }
    for (const cachedId of diffCacheRef.current.keys()) {
      if (!activeIds.has(cachedId)) {
        diffCacheRef.current.delete(cachedId);
      }
    }
    return map;
  }, [localEntries]);

  const totals = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    let revertedCount = 0;

    for (const entry of localEntries) {
      additions += entry.additions;
      deletions += entry.deletions;
      if (entry.reverted) {
        revertedCount += 1;
      }
    }

    const allReverted = localEntries.length > 0 && revertedCount === localEntries.length;
    return {
      totalFiles: localEntries.length,
      revertedCount,
      additions,
      deletions,
      allReverted,
    };
  }, [localEntries]);

  const handleToggleExpand = useCallback((entryId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(entryId)) {
        next.delete(entryId);
      } else {
        next.add(entryId);
      }
      return next;
    });
  }, []);

  const handleRevertSingle = useCallback(
    async (entryId: string) => {
      const snapshot = localEntriesRef.current;
      const target = snapshot.find((item) => item.id === entryId);
      if (!target || target.reverted) return;

      const updatedEntry: TurnFileDiffEntry = { ...target, reverted: true };
      const nextEntries = snapshot.map((item) =>
        item.id === entryId ? updatedEntry : item,
      );
      localEntriesRef.current = nextEntries;
      setLocalEntries(nextEntries);

      if (!onRevertFile) return;

      const rollbackSingle = () => {
        const rolledBack = localEntriesRef.current.map((item) =>
          item.id === entryId ? { ...item, reverted: false } : item,
        );
        localEntriesRef.current = rolledBack;
        setLocalEntries(rolledBack);
      };

      try {
        const outcome = await onRevertFile(entryId, updatedEntry);
        if (outcome === false) {
          rollbackSingle();
        }
      } catch {
        rollbackSingle();
      }
    },
    [onRevertFile],
  );

  const handleRedoSingle = useCallback(
    async (entryId: string) => {
      if (!canRedoSingle) return;
      const snapshot = localEntriesRef.current;
      const target = snapshot.find((item) => item.id === entryId);
      if (!target || !target.reverted) return;

      const updatedEntry: TurnFileDiffEntry = { ...target, reverted: false };
      const nextEntries = snapshot.map((item) =>
        item.id === entryId ? updatedEntry : item,
      );
      localEntriesRef.current = nextEntries;
      setLocalEntries(nextEntries);

      if (!onRedoFile) return;

      const rollbackRedo = () => {
        const rolledBack = localEntriesRef.current.map((item) =>
          item.id === entryId ? { ...item, reverted: true } : item,
        );
        localEntriesRef.current = rolledBack;
        setLocalEntries(rolledBack);
      };

      try {
        const outcome = await onRedoFile(entryId, updatedEntry);
        if (outcome === false) {
          rollbackRedo();
        }
      } catch {
        rollbackRedo();
      }
    },
    [canRedoSingle, onRedoFile],
  );

  const handleRevertAll = useCallback(async () => {
    const snapshot = localEntriesRef.current;
    if (snapshot.length === 0) return;

    const prevRevertedMap = new Map(
      snapshot.map((item) => [item.id, Boolean(item.reverted)]),
    );
    const updatedEntries = snapshot.map((item) => ({ ...item, reverted: true }));
    localEntriesRef.current = updatedEntries;
    setLocalEntries(updatedEntries);

    if (!onRevertAll) return;

    const rollbackAll = () => {
      const propRevertedIds = new Set(
        latestPropEntriesRef.current.filter((e) => e.reverted).map((e) => e.id),
      );
      const rolledBack = localEntriesRef.current.map((item) => ({
        ...item,
        reverted: propRevertedIds.has(item.id) || (prevRevertedMap.get(item.id) ?? false),
      }));
      localEntriesRef.current = rolledBack;
      setLocalEntries(rolledBack);
    };

    try {
      const outcome = await onRevertAll(updatedEntries);
      if (outcome === false) {
        rollbackAll();
      }
    } catch {
      rollbackAll();
    }
  }, [onRevertAll]);

  const handleRedoAll = useCallback(async () => {
    if (!canRedoAll) return;
    const snapshot = localEntriesRef.current;
    if (snapshot.length === 0) return;

    const prevRevertedMap = new Map(
      snapshot.map((item) => [item.id, Boolean(item.reverted)]),
    );
    const updatedEntries = snapshot.map((item) => ({ ...item, reverted: false }));
    localEntriesRef.current = updatedEntries;
    setLocalEntries(updatedEntries);

    if (!onRedoAll) return;

    const rollbackRedoAll = () => {
      const rolledBack = localEntriesRef.current.map((item) => ({
        ...item,
        reverted: prevRevertedMap.get(item.id) ?? true,
      }));
      localEntriesRef.current = rolledBack;
      setLocalEntries(rolledBack);
    };

    try {
      const outcome = await onRedoAll(updatedEntries);
      if (outcome === false) {
        rollbackRedoAll();
      }
    } catch {
      rollbackRedoAll();
    }
  }, [canRedoAll, onRedoAll]);

  if (localEntries.length === 0) {
    return null;
  }

  return (
    <section
      data-testid="turn-diff-review-card"
      aria-label="本轮修改审阅"
      className={cn(
        'rounded-lg border border-border/35 bg-card/60 text-foreground',
        className,
      )}
    >
      {/* 顶部汇总栏 */}
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border/35 px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <span
            data-testid="turn-diff-status-dot"
            className={cn(
              'h-1.5 w-1.5 shrink-0 rounded-full',
              totals.allReverted ? 'bg-muted-foreground/60' : 'bg-success',
            )}
          />
          <span className="text-xs font-medium text-foreground">
            本轮修改审阅
          </span>
          <span
            data-testid="turn-diff-file-count"
            className="font-mono tabular-nums text-xs text-muted-foreground"
          >
            {totals.totalFiles} 个文件
          </span>
          <span
            data-testid="turn-diff-total-additions"
            className="font-mono tabular-nums text-xs text-success"
          >
            +{totals.additions}
          </span>
          <span
            data-testid="turn-diff-total-deletions"
            className="font-mono tabular-nums text-xs text-destructive"
          >
            -{totals.deletions}
          </span>
          {totals.allReverted && (
            <span
              data-testid="turn-diff-all-reverted-badge"
              className="rounded border border-border/35 bg-muted/50 px-1.5 py-0.5 text-xs text-muted-foreground"
            >
              已回滚 (Reverted)
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          {totals.allReverted ? (
            canRedoAll ? (
              <button
                type="button"
                data-testid="turn-diff-redo-all"
                onClick={() => void handleRedoAll()}
                className="inline-flex items-center gap-1 rounded border border-border/35 bg-background/80 px-2 py-1 text-xs text-foreground transition-colors hover:bg-muted"
              >
                <ArrowClockwise size={12} />
                <span>恢复本轮全部修改 (Redo)</span>
              </button>
            ) : null
          ) : (
            <button
              type="button"
              data-testid="turn-diff-revert-all"
              onClick={() => void handleRevertAll()}
              className="inline-flex items-center gap-1 rounded border border-border/35 bg-background/80 px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
            >
              <ArrowCounterClockwise size={12} />
              <span>一键回滚本轮修改</span>
            </button>
          )}
        </div>
      </header>

      {/* 文件变更列表 */}
      <div className="divide-y divide-border/35">
        {localEntries.map((entry) => {
          const isExpanded = expandedIds.has(entry.id);
          const diffSummary = diffSummariesById.get(entry.id) ?? {
            additions: entry.additions,
            deletions: entry.deletions,
            lines: [],
            unifiedText: '',
          };

          return (
            <div
              key={entry.id}
              data-testid={`turn-diff-entry-${entry.id}`}
              data-reverted={entry.reverted ? 'true' : 'false'}
              className="flex flex-col"
            >
              {/* 单文件头部 */}
              <div className="flex items-center justify-between gap-2 px-3 py-2">
                <button
                  type="button"
                  data-testid={`turn-diff-toggle-${entry.id}`}
                  aria-expanded={isExpanded}
                  onClick={() => handleToggleExpand(entry.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs hover:text-foreground"
                >
                  {isExpanded ? (
                    <CaretDown size={12} className="shrink-0 text-muted-foreground" />
                  ) : (
                    <CaretRight size={12} className="shrink-0 text-muted-foreground" />
                  )}
                  <span
                    className={cn(
                      'h-1.5 w-1.5 shrink-0 rounded-full',
                      entry.reverted
                        ? 'bg-muted-foreground/50'
                        : entry.kind === 'created'
                          ? 'bg-success'
                          : entry.kind === 'deleted'
                            ? 'bg-destructive'
                            : 'bg-primary',
                    )}
                  />
                  <FileCode size={13} className="shrink-0 text-muted-foreground" />
                  <span
                    className={cn(
                      'truncate font-mono',
                      entry.reverted && 'line-through text-muted-foreground',
                    )}
                  >
                    {entry.path}
                  </span>
                  <span className="shrink-0 rounded border border-border/35 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                    {KIND_LABELS[entry.kind]}
                  </span>
                  <span className="shrink-0 font-mono tabular-nums text-success">
                    +{entry.additions}
                  </span>
                  <span className="shrink-0 font-mono tabular-nums text-destructive">
                    -{entry.deletions}
                  </span>
                </button>

                <div className="flex shrink-0 items-center gap-2">
                  {entry.reverted ? (
                    <>
                      <span
                        data-testid={`turn-diff-reverted-status-${entry.id}`}
                        className="rounded border border-border/35 bg-muted/40 px-1.5 py-0.5 text-xs text-muted-foreground"
                      >
                        已回滚 (Reverted)
                      </span>
                      {canRedoSingle && (
                        <button
                          type="button"
                          data-testid={`turn-diff-redo-file-${entry.id}`}
                          onClick={() => void handleRedoSingle(entry.id)}
                          className="inline-flex items-center gap-1 rounded border border-border/35 px-2 py-0.5 text-xs text-foreground transition-colors hover:bg-muted"
                        >
                          <ArrowClockwise size={11} />
                          <span>恢复 (Redo)</span>
                        </button>
                      )}
                    </>
                  ) : (
                    <button
                      type="button"
                      data-testid={`turn-diff-revert-file-${entry.id}`}
                      onClick={() => void handleRevertSingle(entry.id)}
                      className="inline-flex items-center gap-1 rounded border border-border/35 px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                    >
                      <ArrowCounterClockwise size={11} />
                      <span>回滚此文件</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Unified Diff 预览区 */}
              {isExpanded && diffSummary.lines.length > 0 && (
                <div
                  data-testid={`turn-diff-preview-${entry.id}`}
                  className={cn(
                    'border-t border-border/35 bg-background/50 px-3 py-2 font-mono text-xs',
                    entry.reverted && 'opacity-50',
                  )}
                >
                  <div className="space-y-0.5 overflow-x-auto">
                    {diffSummary.lines.map((line, lineIdx) => (
                      <div
                        key={lineIdx}
                        data-testid={`turn-diff-line-${entry.id}-${lineIdx}`}
                        data-diff-type={line.type}
                        className={cn(
                          'flex items-baseline gap-2 rounded-sm px-1.5 py-0.5 whitespace-pre',
                          line.type === 'add' && 'bg-success/10 text-success',
                          line.type === 'del' && 'bg-destructive/10 text-destructive',
                          line.type === 'context' && 'text-muted-foreground',
                        )}
                      >
                        <span className="w-6 shrink-0 select-none text-right font-mono tabular-nums text-[11px] opacity-60">
                          {line.oldLineNumber ?? line.newLineNumber ?? ''}
                        </span>
                        <span className="w-3 shrink-0 select-none font-mono tabular-nums">
                          {line.prefix}
                        </span>
                        <span className="min-w-0 flex-1 font-mono">{line.content}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
};

export default TurnDiffReviewCard;
