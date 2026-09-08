/**
 * AI 出题面板（MVP）
 *
 * 流程：参数面板（题量/题型分布/难度/知识点/变式开关）→ 流式生成（展示原始输出）
 * → 预览草稿（逐题勾选/剔除）→ 确认入库（qbank_batch_create_questions，
 * source_type=ai_generated）。
 *
 * 设计依据：docs/dev/ai-question-generation-feasibility-2026-09-07.md §四 MVP。
 */

import React, { useState, useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { DsButton } from '@/components/ui/DsButton';
import { DsDialog, DsDialogHeader, DsDialogTitle, DsDialogBody, DsDialogFooter } from '@/components/ui/DsDialog';
import { AppSelect } from '@/components/ui/app-menu';
import { CircleNotch, Sparkle, WarningCircle, CheckCircle } from '@phosphor-icons/react';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { useQbankAiGeneration, type GeneratedQuestionDraft } from '@/hooks/useQbankAiGeneration';
import SmilesText from '@/components/SmilesText';
import type { QuestionType, Difficulty, Question, QuestionOption } from '@/api/questionBankApi';
import { debugLog } from '@/debug-panel/debugMasterSwitch';

// ============================================================================
// 题型选项
// ============================================================================

/** MVP 支持的题型（matching/ordering/numeric 结构复杂，后端校验明确拒绝） */
const QUESTION_TYPE_OPTIONS: QuestionType[] = [
  'single_choice',
  'multiple_choice',
  'true_false',
  'fill_blank',
  'short_answer',
  'essay',
  'calculation',
  'proof',
];

interface AiQuestionGenerationPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  examId: string;
  examName?: string;
  /** 入库成功后的回调（刷新题目列表） */
  onImportComplete?: () => void;
}

interface SpecRow {
  id: string;
  questionType: QuestionType;
  count: number;
}

let specRowSeq = 0;
const newSpecRow = (questionType: QuestionType = 'single_choice', count = 3): SpecRow => ({
  id: `spec_${Date.now()}_${specRowSeq++}`,
  questionType,
  count,
});

// ============================================================================
// 面板组件
// ============================================================================

export const AiQuestionGenerationPanel: React.FC<AiQuestionGenerationPanelProps> = ({
  open,
  onOpenChange,
  examId,
  examName,
  onImportComplete,
}) => {
  const { t, i18n } = useTranslation(['exam_sheet', 'common']);
  const { state, startGeneration, cancelGeneration, resetState } = useQbankAiGeneration();

  // 参数面板状态
  const [specs, setSpecs] = useState<SpecRow[]>([newSpecRow()]);
  const [difficulty, setDifficulty] = useState<string>('');
  const [topicHint, setTopicHint] = useState('');
  const [basedOnExisting, setBasedOnExisting] = useState(false);
  // 预览阶段每题的选中状态（key = 草稿在 drafts 中的下标）
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [importing, setImporting] = useState(false);

  const isGenerating = state.isGenerating;
  const hasDrafts = state.drafts.length > 0;
  const maxQuestions = useMemo(
    () => specs.reduce((sum, spec) => sum + (Number.isFinite(spec.count) ? spec.count : 0), 0),
    [specs],
  );

  // 面板打开时重置预览选择；关闭时若不在生成中则复位状态
  useEffect(() => {
    if (open) {
      setSelected(new Set());
    } else if (!isGenerating) {
      resetState();
      setSpecs([newSpecRow()]);
      setTopicHint('');
      setDifficulty('');
      setBasedOnExisting(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const updateSpec = (id: string, patch: Partial<SpecRow>) => {
    setSpecs((prev) => prev.map((spec) => (spec.id === id ? { ...spec, ...patch } : spec)));
  };

  const handleStart = async () => {
    if (maxQuestions <= 0 || maxQuestions > 50) return;
    try {
      await startGeneration(
        {
          exam_id: examId,
          model_config_id: null,
          max_questions: maxQuestions,
          specs: specs.map((spec) => ({
            question_type: spec.questionType,
            count: spec.count,
            difficulty: (difficulty || null) as Difficulty | null,
          })),
          difficulty: (difficulty || null) as Difficulty | null,
          topic_hint: topicHint.trim() || null,
          based_on_existing: basedOnExisting,
          language: i18n.resolvedLanguage || i18n.language || null,
        },
        (drafts) => {
          // 默认全部勾选
          setSelected(new Set(drafts.map((_, index) => index)));
        },
      );
    } catch (error) {
      // 错误已由 hook 的 state.error 呈现在面板内；吞掉 rejection 避免 unhandled
      debugLog.warn('[AiQuestionGenerationPanel] generation failed:', error);
    }
  };

  const toggleDraft = (index: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const handleConfirmImport = async () => {
    if (selected.size === 0 || importing) return;
    setImporting(true);
    try {
      const paramsList = state.drafts
        .filter((_, index) => selected.has(index))
        .map((draft) => buildCreateParams(draft, examId));
      const created = await invoke<Question[]>('qbank_batch_create_questions', {
        paramsList,
      });
      showGlobalNotification(
        'success',
        t('exam_sheet:aiGeneration.importSuccess', { count: created.length }),
      );
      onImportComplete?.();
      onOpenChange(false);
    } catch (error) {
      debugLog.error('[AiQuestionGenerationPanel] import failed:', error);
      showGlobalNotification(
        'error',
        error instanceof Error ? error.message : t('exam_sheet:aiGeneration.importFailed'),
      );
    } finally {
      setImporting(false);
    }
  };

  const difficultyOptions = useMemo(
    () => [
      { value: '', label: t('exam_sheet:aiGeneration.difficultyAuto') },
      { value: 'easy', label: t('exam_sheet:questionBank.difficulty.easy') },
      { value: 'medium', label: t('exam_sheet:questionBank.difficulty.medium') },
      { value: 'hard', label: t('exam_sheet:questionBank.difficulty.hard') },
      { value: 'very_hard', label: t('exam_sheet:questionBank.difficulty.very_hard') },
    ],
    [t],
  );

  return (
    <DsDialog
      open={open}
      onOpenChange={(next) => {
        if (isGenerating) return; // 生成中不允许关闭（先取消）
        onOpenChange(next);
      }}
      maxWidth="max-w-2xl"
    >
      <DsDialogHeader>
        <DsDialogTitle>{t('exam_sheet:aiGeneration.title')}</DsDialogTitle>
      </DsDialogHeader>

      <DsDialogBody>
        {/* 阶段一：参数面板 */}
        {!hasDrafts && !isGenerating && (
          <div className="space-y-4">
            <div>
              <div className="text-sm font-medium mb-2">
                {t('exam_sheet:aiGeneration.specsLabel')}
              </div>
              <div className="space-y-2">
                {specs.map((spec) => (
                  <div key={spec.id} className="flex items-center gap-2">
                    <div className="flex-1">
                      <AppSelect
                        value={spec.questionType}
                        onValueChange={(value) => updateSpec(spec.id, { questionType: value as QuestionType })}
                        options={QUESTION_TYPE_OPTIONS.map((type) => ({
                          value: type,
                          label: t(`exam_sheet:questionTypes.${type}`),
                        }))}
                      />
                    </div>
                    <input
                      type="number"
                      min={1}
                      max={20}
                      value={spec.count}
                      onChange={(e) => updateSpec(spec.id, { count: Math.max(1, Math.min(20, Number(e.target.value) || 1)) })}
                      className="w-16 h-8 rounded-md border border-border bg-transparent px-2 text-sm"
                      aria-label={t('exam_sheet:aiGeneration.countLabel')}
                    />
                    {specs.length > 1 && (
                      <DsButton
                        variant="ghost"
                        size="sm"
                        onClick={() => setSpecs((prev) => prev.filter((s) => s.id !== spec.id))}
                      >
                        {t('common:delete')}
                      </DsButton>
                    )}
                  </div>
                ))}
              </div>
              <DsButton
                variant="ghost"
                size="sm"
                className="mt-2"
                onClick={() => setSpecs((prev) => [...prev, newSpecRow('true_false', 2)])}
              >
                + {t('exam_sheet:aiGeneration.addSpec')}
              </DsButton>
            </div>

            <div>
              <div className="text-sm font-medium mb-2">
                {t('exam_sheet:aiGeneration.difficultyLabel')}
              </div>
              <AppSelect value={difficulty} onValueChange={setDifficulty} options={difficultyOptions} />
            </div>

            <div>
              <div className="text-sm font-medium mb-2">
                {t('exam_sheet:aiGeneration.topicHintLabel')}
              </div>
              <textarea
                value={topicHint}
                onChange={(e) => setTopicHint(e.target.value)}
                rows={3}
                maxLength={2000}
                placeholder={t('exam_sheet:aiGeneration.topicHintPlaceholder')}
                className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm resize-y"
              />
            </div>

            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={basedOnExisting}
                onChange={(e) => setBasedOnExisting(e.target.checked)}
                className="h-4 w-4 accent-primary"
              />
              {t('exam_sheet:aiGeneration.basedOnExisting')}
            </label>

            {maxQuestions > 50 && (
              <div className="flex items-center gap-2 text-sm text-destructive">
                <WarningCircle size={16} />
                {t('exam_sheet:aiGeneration.tooManyQuestions')}
              </div>
            )}
          </div>
        )}

        {/* 阶段二：生成中（展示流式原始输出） */}
        {isGenerating && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <CircleNotch size={16} className="animate-spin" />
              {t('exam_sheet:aiGeneration.generating')}
            </div>
            <pre className="max-h-72 overflow-auto rounded-md bg-muted/40 p-3 text-xs whitespace-pre-wrap break-all">
              {state.rawOutput || '...'}
            </pre>
            <div className="flex justify-end">
              <DsButton variant="ghost" size="sm" onClick={() => void cancelGeneration()}>
                {t('common:cancel')}
              </DsButton>
            </div>
          </div>
        )}

        {/* 阶段三：预览确认 */}
        {hasDrafts && !isGenerating && (
          <div className="space-y-3">
            {state.rejectedCount > 0 && (
              <div className="flex items-start gap-2 rounded-md bg-warning/10 border border-warning/30 p-2.5 text-xs text-warning">
                <WarningCircle size={16} className="mt-0.5 flex-shrink-0" />
                <div>
                  {t('exam_sheet:aiGeneration.rejectedSummary', { count: state.rejectedCount })}
                  <ul className="mt-1 space-y-0.5 list-disc list-inside">
                    {state.rejectionReasons.slice(0, 3).map((reason, index) => (
                      <li key={index}>{reason}</li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
            <div className="max-h-80 space-y-2 overflow-auto pr-1">
              {state.drafts.map((draft, index) => (
                <label
                  key={index}
                  className="flex items-start gap-2.5 rounded-md border border-border p-2.5 cursor-pointer hover:bg-muted/30"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(index)}
                    onChange={() => toggleDraft(index)}
                    className="mt-1 h-4 w-4 accent-primary flex-shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="rounded bg-muted px-1.5 py-px text-2xs text-muted-foreground">
                        {t(`exam_sheet:questionTypes.${draft.question_type}`, draft.question_type)}
                      </span>
                      {draft.difficulty && (
                        <span className="rounded bg-muted px-1.5 py-px text-2xs text-muted-foreground">
                          {t(`exam_sheet:questionBank.difficulty.${draft.difficulty}`, draft.difficulty)}
                        </span>
                      )}
                      {draft.tags?.slice(0, 3).map((tag) => (
                        <span key={tag} className="rounded bg-primary/10 px-1.5 py-px text-2xs text-primary">
                          {tag}
                        </span>
                      ))}
                    </div>
                    <div className="mt-1 text-sm text-foreground whitespace-pre-wrap break-words">
                      {draft.content}
                    </div>
                    {draft.smiles && (
                      <div className="mt-1.5 flex justify-center">
                        <SmilesText
                          smiles={draft.smiles}
                          caption={draft.smiles_caption ?? undefined}
                          width={220}
                          height={150}
                        />
                      </div>
                    )}
                    {draft.options && draft.options.length > 0 && (
                      <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                        {draft.options.map((opt) => (
                          <div key={opt.key}>
                            {opt.key}. {opt.content}
                          </div>
                        ))}
                      </div>
                    )}
                    {draft.answer && (
                      <div className="mt-1 text-xs text-muted-foreground">
                        <span className="font-medium">{t('exam_sheet:aiGeneration.answerLabel')}</span>
                        {draft.answer}
                      </div>
                    )}
                  </div>
                  {selected.has(index) && (
                    <CheckCircle size={16} className="mt-1 flex-shrink-0 text-primary" />
                  )}
                </label>
              ))}
            </div>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {t('exam_sheet:aiGeneration.selectedCount', {
                  selected: selected.size,
                  total: state.drafts.length,
                })}
              </span>
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => {
                  resetState();
                  setSpecs([newSpecRow()]);
                }}
              >
                {t('exam_sheet:aiGeneration.regenerate')}
              </button>
            </div>
          </div>
        )}
      </DsDialogBody>

      <DsDialogFooter>
        <div className="flex items-center justify-end gap-2">
          {!hasDrafts && !isGenerating && (
            <>
              <DsButton variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                {t('common:cancel')}
              </DsButton>
              <DsButton
                variant="default"
                size="sm"
                disabled={maxQuestions <= 0 || maxQuestions > 50}
                onClick={() => void handleStart()}
              >
                <Sparkle size={14} className="mr-1" />
                {t('exam_sheet:aiGeneration.start')}
              </DsButton>
            </>
          )}
          {hasDrafts && !isGenerating && (
            <>
              <DsButton variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                {t('common:cancel')}
              </DsButton>
              <DsButton
                variant="default"
                size="sm"
                disabled={selected.size === 0 || importing}
                onClick={() => void handleConfirmImport()}
              >
                {importing && <CircleNotch size={14} className="mr-1 animate-spin" />}
                {t('exam_sheet:aiGeneration.confirmImport', { count: selected.size })}
              </DsButton>
            </>
          )}
        </div>
      </DsDialogFooter>
    </DsDialog>
  );
};

// ============================================================================
// 草稿 → CreateQuestionParams 映射
// ============================================================================

/**
 * 把 AI 草稿映射为后端 CreateQuestionParams（snake_case 契约）。
 * 选择题 answer 归一为大写 key 串；判断题归一为小写 true/false。
 */
function buildCreateParams(draft: GeneratedQuestionDraft, examId: string) {
  let answer = draft.answer?.trim() ?? null;
  if (
    answer &&
    (draft.question_type === 'single_choice' ||
      draft.question_type === 'multiple_choice' ||
      draft.question_type === 'indefinite_choice')
  ) {
    answer = answer.toUpperCase();
  }
  if (answer && draft.question_type === 'true_false') {
    answer = answer.toLowerCase();
  }

  const options: QuestionOption[] | null =
    draft.options && draft.options.length > 0
      ? draft.options.map((opt) => ({ key: opt.key.trim(), content: opt.content }))
      : null;

  return {
    exam_id: examId,
    content: draft.content,
    question_type: draft.question_type,
    options,
    answer,
    structured_data: null,
    explanation: draft.explanation?.trim() || null,
    difficulty: draft.difficulty ?? null,
    tags: draft.tags && draft.tags.length > 0 ? draft.tags : null,
    question_label: null,
    card_id: null,
    source_type: 'ai_generated',
    source_ref: null,
    images: null,
    parent_id: null,
  };
}

export default AiQuestionGenerationPanel;
