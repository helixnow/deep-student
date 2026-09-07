/**
 * Chat V2 - 灵感召回块渲染插件（Insight Recall v2 阶段二）
 *
 * 渲染 insight_recall 工具的召回/升级结果。
 * 披露纪律的 UI 表达：
 * - 每个来源带披露级别徽章（存在/回忆提示/提示/全文）；
 * - 存在级只有标题——UI 上明确提示"方法未展开"，把升级权交给对话；
 * - 点击来源打开灵感卡详情（可编辑纠正）。
 *
 * 自执行注册：import 即注册
 */

import React, { useMemo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { CircleNotch, Lightbulb, WarningCircle } from '@phosphor-icons/react';
import { blockRegistry, type BlockComponentProps } from '../../registry';
import { SourceList } from './components/SourceList';
import {
  convertBackendSources,
  type BackendSourceInfo,
  type RetrievalSource,
} from './components/types';
import { insightGet, insightCorrect } from '@/features/insights/api';
import type { InsightCard, InsightDraftInput } from '@/features/insights/types';
import { InsightConfirmDialog } from '@/features/insights/components/InsightConfirmDialog';

interface BackendInsightRecallResult {
  sources?: BackendSourceInfo[];
  count?: number;
  durationMs?: number;
  /** 沉默原因（无匹配/低置信/预算/禁用），仅诊断展示 */
  silence?: string;
  /** 升级模式：升级到的级别 */
  escalatedTo?: string;
}

const LEVEL_BADGE: Record<string, string> = {
  existence: '存在',
  recall_prompt: '回忆提示',
  hint: '提示',
  full: '全文',
  direct_answer: '直接答案',
};

const InsightRecallBlock: React.FC<BlockComponentProps> = React.memo(({ block, isStreaming }) => {
  const { t } = useTranslation('chatV2');
  const data = block.toolOutput as BackendInsightRecallResult | undefined;

  const sources = useMemo(() => {
    return convertBackendSources(data?.sources, 'insight', block.id);
  }, [data?.sources, block.id]);

  const [editing, setEditing] = useState<InsightCard | null>(null);

  // 点击来源 → 打开灵感卡详情（可纠正；纠正确认走生产 insight_correct 链路）
  const handleSourceClick = useCallback((source: RetrievalSource) => {
    const meta = (source.metadata ?? {}) as Record<string, unknown>;
    const insightId = [meta.insightId, meta.insight_id]
      .find((v): v is string => typeof v === 'string' && v.startsWith('ic_'));
    if (!insightId) return;
    void insightGet(insightId)
      .then((card) => {
        if (card) setEditing(card);
      })
      .catch((err) => {
        console.error('[InsightRecallBlock] load insight failed:', err);
      });
  }, []);

  const handleSubmit = useCallback(
    async (draft: InsightDraftInput) => {
      if (!editing) return;
      await insightCorrect(editing.id, {
        title: draft.title,
        situation: draft.situation,
        stuck_point: draft.stuck_point,
        turning_point: draft.turning_point,
        rule: draft.rule,
        validity_conditions: draft.validity_conditions,
        edit_note: 'chat insight block edit',
      });
    },
    [editing],
  );

  const isPending = block.status === 'pending';
  const isRunning = block.status === 'running' || isStreaming;
  const isError = block.status === 'error';
  const isSuccess = block.status === 'success';

  // 当前块中最高披露级别（用于头部徽章；按阶梯序取真最大值，非末条覆盖）
  const maxLevel = useMemo(() => {
    const ORDER = ['existence', 'recall_prompt', 'hint', 'full', 'direct_answer'];
    let best: string | null = null;
    for (const s of sources) {
      const lv = (s.metadata as Record<string, unknown> | undefined)?.disclosureLevel;
      if (typeof lv === 'string' && ORDER.indexOf(lv) > ORDER.indexOf(best ?? '')) {
        best = lv;
      }
    }
    return best;
  }, [sources]);

  return (
    <div
      className={cn(
        'rounded-lg border',
        'bg-muted/30 border-border/50',
        'dark:bg-muted/20 dark:border-border/30',
        'transition-colors'
      )}
    >
      {/* 头部 */}
      <div className={cn('flex items-center gap-2 px-3 py-2', 'border-b border-border/30')}>
        <div
          className={cn(
            'flex-shrink-0 flex items-center justify-center',
            'w-6 h-6 rounded bg-amber-500/10'
          )}
        >
          <Lightbulb size={16} className="text-amber-500" />
        </div>

        <span className="font-medium text-sm text-foreground">
          {t('blocks.insightRecall.title', '灵感召回')}
        </span>

        {isSuccess && maxLevel && (
          <span
            className={cn(
              'flex items-center gap-1 px-2 py-0.5 rounded-full',
              'bg-amber-500/10 text-amber-600 dark:text-amber-400 text-xs'
            )}
          >
            <Lightbulb size={12} />
            <span>{LEVEL_BADGE[maxLevel] ?? maxLevel}</span>
          </span>
        )}

        {(isPending || isRunning) && (
          <span className="flex items-center gap-1 ml-auto text-xs text-muted-foreground">
            <CircleNotch size={12} className="animate-spin" />
            <span>{t('blocks.insightRecall.searching', '回忆中…')}</span>
          </span>
        )}

        {isError && (
          <span className="flex items-center gap-1 ml-auto text-xs text-destructive">
            <WarningCircle size={12} />
            <span>{t('blocks.insightRecall.error', '召回失败')}</span>
          </span>
        )}

        {isSuccess && sources.length > 0 && (
          <span className="ml-auto text-xs text-muted-foreground">
            {t('blocks.insightRecall.statsSimple', '{{count}} 条灵感', { count: sources.length })}
          </span>
        )}
      </div>

      {/* 内容区域 */}
      <div className="p-3">
        {(isPending || isRunning) && (
          <div className="flex items-center justify-center py-6">
            <div className="flex items-center gap-2 text-muted-foreground">
              <CircleNotch size={20} className="animate-spin" />
              <span className="text-sm">{t('blocks.insightRecall.loading', '正在翻找你的灵感卡…')}</span>
            </div>
          </div>
        )}

        {isError && (
          <div className="flex items-center justify-center py-6">
            <div className="flex items-center gap-2 text-destructive">
              <WarningCircle size={20} />
              <span className="text-sm">
                {block.error || t('blocks.insightRecall.errorMessage', '灵感召回出错')}
              </span>
            </div>
          </div>
        )}

        {isSuccess && sources.length > 0 && (
          <>
            <SourceList
              sources={sources}
              maxVisible={3}
              defaultExpanded={false}
              onSourceClick={handleSourceClick}
            />
            {maxLevel === 'existence' && (
              <p className="mt-2 text-xs text-muted-foreground">
                {t(
                  'blocks.insightRecall.existenceHint',
                  '以上只显示了卡片标题。想唤起具体内容，可以继续追问或让 AI 逐步揭示。'
                )}
              </p>
            )}
          </>
        )}

        {isSuccess && sources.length === 0 && (
          <div className="flex items-center justify-center py-6 text-muted-foreground">
            <span className="text-sm">
              {t('blocks.insightRecall.noResults', '没有找到相关的灵感卡')}
            </span>
          </div>
        )}
      </div>

      {editing && (
        <InsightConfirmDialog
          open={editing !== null}
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          initial={editing}
          onSubmit={handleSubmit}
          submitLabel={t('blocks.insightRecall.saveCorrection', '保存纠正')}
        />
      )}
    </div>
  );
});

// ============================================================================
// 自动注册
// ============================================================================

blockRegistry.register('insight_recall', {
  type: 'insight_recall',
  component: InsightRecallBlock,
  onAbort: 'mark-error',
});

export { InsightRecallBlock };
