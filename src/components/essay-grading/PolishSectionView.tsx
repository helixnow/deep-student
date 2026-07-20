/**
 * 润色提升视图 — 原句 → 润色句 对比卡片
 * 带纯前端 token 级 LCS diff 高亮：删除红色删除线、新增绿色下划线
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { PolishItem } from '@/essay-grading/streamingMarkerParser';
import { ArrowRight, Sparkle, Copy, Check, Eye, EyeSlash } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { copyTextToClipboard } from '@/utils/clipboardUtils';

interface PolishSectionViewProps {
  items: PolishItem[];
  className?: string;
}

// ============================================================================
// Diff（token 级 LCS，纯前端实现）
// ============================================================================

/** 分词：拉丁词/数字为一个 token，CJK 逐字，空白与标点各自成 token */
function tokenize(text: string): string[] {
  return text.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*|\s+|[^\sA-Za-z0-9]/g) ?? [];
}

type DiffOp = { kind: 'equal' | 'del' | 'ins'; text: string };

/** token 数量上限，超过则放弃 diff（O(n*m) DP 防卡顿） */
const MAX_DIFF_CELLS = 250_000;

function diffTokens(a: string[], b: string[]): DiffOp[] | null {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n * m > MAX_DIFF_CELLS) return null;

  // LCS DP 表（(n+1) x (m+1)），用一维 Uint32Array 压内存
  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] = a[i] === b[j]
        ? dp[(i + 1) * width + j + 1] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }

  // 回溯，合并相邻同类 op
  const ops: DiffOp[] = [];
  const push = (kind: DiffOp['kind'], text: string) => {
    const last = ops[ops.length - 1];
    if (last && last.kind === kind) last.text += text;
    else ops.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push('equal', a[i]);
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      push('del', a[i]);
      i++;
    } else {
      push('ins', b[j]);
      j++;
    }
  }
  while (i < n) { push('del', a[i]); i++; }
  while (j < m) { push('ins', b[j]); j++; }
  return ops;
}

interface RenderedDiff {
  /** 原句视角：equal + del */
  original: React.ReactNode;
  /** 润色句视角：equal + ins */
  polished: React.ReactNode;
  /** 是否成功计算 diff（失败时回退纯文本） */
  ok: boolean;
}

function buildDiff(originalText: string, polishedText: string): RenderedDiff {
  const ops = diffTokens(tokenize(originalText), tokenize(polishedText));
  if (!ops) {
    return { original: originalText, polished: polishedText, ok: false };
  }
  const original = ops
    .filter((op) => op.kind !== 'ins')
    .map((op, idx) =>
      op.kind === 'del' ? (
        <span key={idx} className="text-red-500/90 line-through decoration-red-400/60 bg-red-500/5 rounded-sm">
          {op.text}
        </span>
      ) : (
        <span key={idx}>{op.text}</span>
      )
    );
  const polished = ops
    .filter((op) => op.kind !== 'del')
    .map((op, idx) =>
      op.kind === 'ins' ? (
        <span key={idx} className="text-emerald-600 dark:text-emerald-400 underline decoration-emerald-400/60 underline-offset-2 bg-emerald-500/5 rounded-sm">
          {op.text}
        </span>
      ) : (
        <span key={idx}>{op.text}</span>
      )
    );
  return { original, polished, ok: true };
}

// ============================================================================
// 组件
// ============================================================================

export const PolishSectionView: React.FC<PolishSectionViewProps> = ({ items, className }) => {
  const { t } = useTranslation(['essay_grading', 'common']);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [showDiff, setShowDiff] = useState(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const handleCopy = (text: string, index: number) => {
    copyTextToClipboard(text);
    setCopiedIndex(index);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopiedIndex(null), 2000);
  };

  const diffs = useMemo(
    () => items.map((item) => buildDiff(item.original, item.polished)),
    [items]
  );

  if (items.length === 0) {
    return (
      <div className={cn('flex flex-col items-center justify-center py-16 gap-2 select-none', className)}>
        <Sparkle size={28} className="text-muted-foreground/30" />
        <div className="text-sm font-medium text-muted-foreground/70">
          {t('essay_grading:sections.no_polish')}
        </div>
        <div className="text-xs text-muted-foreground/45">
          {t('essay_grading:sections.no_polish_desc')}
        </div>
      </div>
    );
  }

  return (
    <div className={cn('space-y-4', className)}>
      <div className="flex items-center gap-2 px-1">
        <div className="flex items-center gap-2 text-xs text-muted-foreground/60 min-w-0">
          <Sparkle size={14} className="shrink-0" />
          <span className="truncate">{t('essay_grading:sections.polish_desc')}</span>
        </div>
        <div className="flex-1" />
        <DsButton
          variant="ghost"
          size="sm"
          aria-pressed={showDiff}
          onClick={() => setShowDiff((v) => !v)}
          className={cn(
            'h-6 px-1.5 gap-1 text-xs shrink-0 transition-colors duration-150 motion-reduce:transition-none',
            showDiff ? 'text-primary hover:text-primary' : 'text-muted-foreground/50 hover:text-foreground'
          )}
        >
          {showDiff ? <Eye size={12} /> : <EyeSlash size={12} />}
          <span>{showDiff ? t('essay_grading:result_ui.polish_hide_diff') : t('essay_grading:result_ui.polish_show_diff')}</span>
        </DsButton>
      </div>
      {items.map((item, index) => {
        const diff = diffs[index];
        const copied = copiedIndex === index;
        return (
          <div
            key={index}
            className="rounded-xl border border-border/40 bg-card/50 overflow-hidden"
          >
            {/* 原句（删除部分红色删除线） */}
            <div className="px-4 py-3 border-b border-border/20">
              <div className="text-xs text-muted-foreground/50 mb-1">{t('essay_grading:sections.original')}</div>
              <div className="text-sm text-foreground/70 leading-relaxed whitespace-pre-wrap">
                {showDiff ? diff.original : item.original}
              </div>
            </div>
            {/* 润色句（新增部分绿色下划线） */}
            <div className="px-4 py-3 bg-emerald-50/30 dark:bg-emerald-950/10">
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                  <ArrowRight size={12} />
                  <span>{t('essay_grading:sections.polished')}</span>
                </div>
                {/* 常显复制按钮 + 就地反馈 */}
                <DsButton
                  variant="ghost"
                  size="sm"
                  aria-label={copied ? t('essay_grading:sections.copied') : t('common:copy')}
                  onClick={() => handleCopy(item.polished, index)}
                  className={cn(
                    'h-6 px-1.5 gap-1 text-xs transition-colors duration-200 motion-reduce:transition-none',
                    copied
                      ? 'text-success hover:text-success'
                      : 'text-muted-foreground/50 hover:text-foreground'
                  )}
                >
                  {copied ? <Check size={12} /> : <Copy size={12} />}
                  <span>{copied ? t('essay_grading:sections.copied') : t('common:copy')}</span>
                </DsButton>
              </div>
              <div className="text-sm text-foreground/85 leading-relaxed font-medium whitespace-pre-wrap">
                {showDiff ? diff.polished : item.polished}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};
