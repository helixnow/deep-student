/**
 * Chat V2 - 论文保存进度块渲染组件
 *
 * 渲染 paper_save 工具的细粒度下载/导入进度。
 * 解析后端通过 emit_chunk 发射的 NDJSON 进度快照，
 * 显示每篇论文的阶段、下载进度条、文件大小等信息。
 *
 * 进度 NDJSON 格式（每行一个 JSON 快照）：
 * {"papers":[{"i":0,"t":"Title","s":"downloading","pct":45,"dl":2300000,"total":5100000}]}
 */

import React, { useMemo, useState, useCallback } from 'react';
import { cn } from '@/utils/cn';
import {
  FileDown,
  CheckCircle,
  AlertCircle,
  Loader2,
  Search,
  HardDrive,
  FileText,
  Database,
  Copy,
  RotateCcw,
  ChevronDown,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import type { BlockComponentProps } from '../../registry';

// ============================================================================
// 类型
// ============================================================================

interface SourceCandidate {
  label: string;
  url: string;
}

interface PaperProgressItem {
  i: number;
  t: string;
  s: 'resolving' | 'downloading' | 'deduplicating' | 'storing' | 'processing' | 'indexing' | 'done' | 'error';
  pct: number;
  dl?: number;
  total?: number;
  fid?: string;
  dedup?: boolean;
  err?: string;
  src?: string;
  srcs?: SourceCandidate[];
}

interface ProgressSnapshot {
  papers: PaperProgressItem[];
}

// ============================================================================
// 阶段配置
// ============================================================================

const STAGE_CONFIG: Record<string, { label: string; icon: React.ElementType; weight: number }> = {
  resolving:     { label: '解析地址',   icon: Search,     weight: 5 },
  downloading:   { label: '下载中',     icon: FileDown,   weight: 60 },
  deduplicating: { label: '去重检查',   icon: Copy,       weight: 5 },
  storing:       { label: '存储中',     icon: HardDrive,  weight: 10 },
  processing:    { label: '文本提取',   icon: FileText,   weight: 10 },
  indexing:      { label: '建立索引',   icon: Database,   weight: 10 },
  done:          { label: '完成',       icon: CheckCircle, weight: 0 },
  error:         { label: '失败',       icon: AlertCircle, weight: 0 },
};

const STAGE_ORDER = ['resolving', 'downloading', 'deduplicating', 'storing', 'processing', 'indexing', 'done'];

/** 计算总进度百分比（基于阶段权重 + 下载细粒度） */
function computeOverallPercent(paper: PaperProgressItem): number {
  if (paper.s === 'done') return 100;
  if (paper.s === 'error') return 0;

  const stageIdx = STAGE_ORDER.indexOf(paper.s);
  if (stageIdx < 0) return 0;

  // 累加已完成阶段的权重
  let acc = 0;
  for (let j = 0; j < stageIdx; j++) {
    acc += STAGE_CONFIG[STAGE_ORDER[j]]?.weight ?? 0;
  }

  // 当前阶段内的进度
  const currentWeight = STAGE_CONFIG[paper.s]?.weight ?? 0;
  if (paper.s === 'downloading') {
    acc += (paper.pct / 100) * currentWeight;
  } else {
    acc += currentWeight * 0.5; // 非下载阶段取中点
  }

  return Math.round(acc);
}

/** 格式化文件大小 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ============================================================================
// 单篇论文进度行
// ============================================================================

const PaperRow: React.FC<{ paper: PaperProgressItem }> = ({ paper }) => {
  const config = STAGE_CONFIG[paper.s] || STAGE_CONFIG.resolving;
  const Icon = config.icon;
  const overallPct = computeOverallPercent(paper);
  const isDone = paper.s === 'done';
  const isError = paper.s === 'error';
  const isDownloading = paper.s === 'downloading';
  const isActive = !isDone && !isError;

  const [retryState, setRetryState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [retryError, setRetryError] = useState<string | null>(null);
  const [showSources, setShowSources] = useState(false);
  const [selectedSourceIdx, setSelectedSourceIdx] = useState<number | null>(null);

  const sources = paper.srcs ?? [];
  const hasMultipleSources = sources.length > 1;

  const handleRetry = useCallback(async (sourceUrl?: string) => {
    const url = sourceUrl ?? sources[0]?.url;
    if (!url) return;

    setRetryState('loading');
    setRetryError(null);
    setShowSources(false);

    try {
      await invoke('vfs_download_paper', {
        params: { url, title: paper.t },
      });
      setRetryState('success');
    } catch (e) {
      setRetryState('error');
      setRetryError(typeof e === 'string' ? e : (e as Error)?.message ?? '下载失败');
    }
  }, [sources, paper.t]);

  return (
    <div className="flex flex-col gap-1.5 py-2 first:pt-0 last:pb-0">
      {/* 标题行 */}
      <div className="flex items-center justify-between gap-2 min-w-0">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <Icon
            className={cn(
              'w-3.5 h-3.5 shrink-0',
              isDone && 'text-green-500',
              isError && 'text-destructive',
              isActive && 'text-primary',
              isActive && paper.s !== 'downloading' && 'animate-pulse',
              retryState === 'success' && 'text-green-500',
            )}
          />
          <span
            className={cn(
              'text-sm truncate',
              isDone && 'text-muted-foreground',
              isError && 'text-destructive',
              isActive && 'text-foreground',
              retryState === 'success' && 'text-muted-foreground',
            )}
            title={paper.t}
          >
            {paper.t}
          </span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0 text-xs text-muted-foreground">
          {/* 当前源标签 */}
          {isActive && paper.src && (
            <span className="text-muted-foreground/60" title={`下载源: ${paper.src}`}>
              {paper.src}
            </span>
          )}

          {/* 去重标识 */}
          {paper.dedup && (
            <span className="text-amber-500" title="已存在于资料库">
              去重
            </span>
          )}

          {/* 下载大小 */}
          {isDownloading && paper.dl != null && (
            <span>
              {formatBytes(paper.dl)}
              {paper.total != null && ` / ${formatBytes(paper.total)}`}
            </span>
          )}

          {/* 阶段标签 */}
          {isActive && (
            <span className="text-primary">{config.label}</span>
          )}

          {/* 完成 */}
          {(isDone || retryState === 'success') && (
            <span className="text-green-500">已保存</span>
          )}

          {/* 错误 + 重试按钮 */}
          {isError && retryState !== 'success' && (
            <>
              <span className="text-destructive truncate max-w-[100px]" title={paper.err}>
                {paper.err || '失败'}
              </span>
              {retryState === 'loading' ? (
                <Loader2 className="w-3 h-3 animate-spin text-primary" />
              ) : (
                <div className="relative flex items-center gap-0.5">
                  <button
                    onClick={() => handleRetry()}
                    className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-primary hover:bg-primary/10 transition-colors"
                    title="重试下载"
                    disabled={sources.length === 0}
                  >
                    <RotateCcw className="w-3 h-3" />
                    <span>重试</span>
                  </button>
                  {hasMultipleSources && (
                    <button
                      onClick={() => setShowSources(v => !v)}
                      className="flex items-center px-0.5 py-0.5 rounded text-muted-foreground hover:bg-muted/60 transition-colors"
                      title="切换下载源"
                    >
                      <ChevronDown className={cn('w-3 h-3 transition-transform', showSources && 'rotate-180')} />
                    </button>
                  )}
                </div>
              )}
            </>
          )}

          {/* 重试失败 */}
          {retryState === 'error' && (
            <span className="text-destructive" title={retryError ?? undefined}>重试失败</span>
          )}
        </div>
      </div>

      {/* 源切换下拉 */}
      {showSources && sources.length > 0 && (
        <div className="ml-5 flex flex-wrap gap-1">
          {sources.map((src, si) => (
            <button
              key={si}
              onClick={() => {
                setSelectedSourceIdx(si);
                handleRetry(src.url);
              }}
              className={cn(
                'px-2 py-0.5 text-xs rounded border transition-colors',
                selectedSourceIdx === si
                  ? 'border-primary text-primary bg-primary/10'
                  : 'border-border/50 text-muted-foreground hover:border-primary/50 hover:text-foreground',
              )}
              title={src.url}
            >
              {src.label}
            </button>
          ))}
        </div>
      )}

      {/* 进度条 */}
      <div
        className={cn(
          'h-1.5 rounded-full overflow-hidden',
          isError && retryState !== 'success' ? 'bg-destructive/20' : 'bg-muted/40',
        )}
      >
        <div
          className={cn(
            'h-full rounded-full transition-all duration-500 ease-out',
            (isDone || retryState === 'success') && 'bg-green-500',
            isError && retryState !== 'success' && 'bg-destructive',
            isActive && 'bg-primary',
            retryState === 'loading' && 'bg-primary animate-pulse',
          )}
          style={{ width: `${isDone || retryState === 'success' ? 100 : isError ? 100 : overallPct}%` }}
        />
      </div>
    </div>
  );
};

// ============================================================================
// 主组件
// ============================================================================

const PaperSaveBlock: React.FC<BlockComponentProps> = ({ block }) => {
  // 从 block.content 解析最后一行 NDJSON 获取当前进度快照
  const snapshot = useMemo<ProgressSnapshot | null>(() => {
    const raw = block.content;
    if (!raw) return null;

    // 找最后一个非空行
    const lines = raw.trimEnd().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        return JSON.parse(line) as ProgressSnapshot;
      } catch {
        continue;
      }
    }
    return null;
  }, [block.content]);

  // 完成后显示 toolOutput 中的最终结果
  const isComplete = block.status === 'success';
  const isError = block.status === 'error';

  // 如果既没有进度数据也没有完成，显示占位
  if (!snapshot && !isComplete && !isError) {
    return (
      <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin text-primary" />
        <span>准备下载论文…</span>
      </div>
    );
  }

  const papers = snapshot?.papers ?? [];
  const doneCount = papers.filter(p => p.s === 'done').length;
  const errorCount = papers.filter(p => p.s === 'error').length;
  const totalCount = papers.length;

  return (
    <div
      className={cn(
        'rounded-lg border overflow-hidden',
        'bg-card dark:bg-card/80',
        isError ? 'border-destructive/30' : 'border-border/50',
      )}
    >
      {/* 头部 */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border/30">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-md bg-primary/10 dark:bg-primary/20">
            <FileDown className="w-4 h-4 text-primary" />
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-medium text-foreground">
              论文下载
            </span>
            <span className="text-xs text-muted-foreground">
              {isComplete
                ? `${doneCount}/${totalCount} 篇完成${errorCount > 0 ? `，${errorCount} 篇失败` : ''}`
                : isError
                  ? (totalCount > 0 ? `${doneCount}/${totalCount} 篇完成，${errorCount} 篇失败` : '下载失败')
                  : `下载中 ${doneCount}/${totalCount}`}
            </span>
          </div>
        </div>

        {/* 全局状态图标 */}
        <div className="flex items-center gap-1.5">
          {isComplete && errorCount === 0 && (
            <CheckCircle className="w-4 h-4 text-green-500" />
          )}
          {isComplete && errorCount > 0 && (
            <AlertCircle className="w-4 h-4 text-amber-500" />
          )}
          {!isComplete && !isError && (
            <Loader2 className="w-4 h-4 text-primary animate-spin" />
          )}
          {isError && (
            <AlertCircle className="w-4 h-4 text-destructive" />
          )}
        </div>
      </div>

      {/* 论文列表 */}
      {papers.length > 0 && (
        <div className="px-3 py-2 divide-y divide-border/20">
          {papers.map((paper) => (
            <PaperRow key={paper.i} paper={paper} />
          ))}
        </div>
      )}

      {/* 错误信息 */}
      {isError && !snapshot && (
        <div className="p-3 text-sm text-destructive">
          {block.error || '论文下载失败'}
        </div>
      )}
    </div>
  );
};

export { PaperSaveBlock };
