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
import { Lightbulb } from '@phosphor-icons/react';
import { blockRegistry, type BlockComponentProps } from '../../registry';
import { SourceList } from './components/SourceList';
import {
  RetrievalBlockShell,
  RetrievalErrorNotice,
} from './components/RetrievalBlockShell';
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

/** 披露级徽章：值 → chatV2:blocks.insightRecall.level.* 键后缀 */
const LEVEL_BADGE_KEYS: Record<string, string> = {
  existence: 'existence',
  recall_prompt: 'recallPrompt',
  hint: 'hint',
  full: 'full',
  direct_answer: 'directAnswer',
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
  const isActive = isPending || isRunning;
  const isError = block.status === 'error';
  const isSuccess = block.status === 'success';
  const [isExpanded, setIsExpanded] = useState(true);

  const durationMs =
    block.startedAt && block.endedAt
      ? block.endedAt - block.startedAt
      : data?.durationMs;

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

  const statusText = useMemo(() => {
    if (isActive) return t('blocks.insightRecall.searching', '回忆中…');
    if (isError) return t('blocks.insightRecall.error', '召回失败');
    if (isSuccess && sources.length > 0) {
      return t('blocks.insightRecall.statsSimple', '{{count}} 条灵感', { count: sources.length });
    }
    if (isSuccess) return t('blocks.insightRecall.noResults', '没有找到相关的灵感卡');
    return null;
  }, [isActive, isError, isSuccess, sources.length, t]);

  const levelBadge = isSuccess && maxLevel ? (
    <span className="shrink-0 rounded-md bg-muted/60 px-1.5 py-0.5 text-2xs leading-none text-muted-foreground">
      {LEVEL_BADGE_KEYS[maxLevel] ? t(`blocks.insightRecall.level.${LEVEL_BADGE_KEYS[maxLevel]}`) : maxLevel}
    </span>
  ) : null;

  const hasBody = isError || (isSuccess && sources.length > 0);

  return (
    <RetrievalBlockShell
      icon={Lightbulb}
      title={t('blocks.insightRecall.title', '灵感召回')}
      statusText={statusText}
      badge={levelBadge}
      isActive={!!isActive}
      isError={isError}
      isSuccess={isSuccess}
      durationMs={durationMs}
      collapsible={hasBody}
      isExpanded={isExpanded}
      onToggleExpand={() => setIsExpanded((prev) => !prev)}
      footer={
        editing ? (
          <InsightConfirmDialog
            open={editing !== null}
            onOpenChange={(open) => {
              if (!open) setEditing(null);
            }}
            initial={editing}
            onSubmit={handleSubmit}
            submitLabel={t('blocks.insightRecall.saveCorrection', '保存纠正')}
          />
        ) : null
      }
    >
      {isError && (
        <RetrievalErrorNotice
          message={block.error || t('blocks.insightRecall.errorMessage', '灵感召回出错')}
        />
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
            <p className="text-xs text-muted-foreground">
              {t(
                'blocks.insightRecall.existenceHint',
                '以上只显示了卡片标题。想唤起具体内容，可以继续追问或让 AI 逐步揭示。'
              )}
            </p>
          )}
        </>
      )}
    </RetrievalBlockShell>
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
