/**
 * Chat V2 - AI 出题预览块（2026-09-09 D2）
 *
 * 渲染 `qbank_generate_questions` 工具的产出：对话内可勾选的题目草稿 + 一键入库。
 * 块类型由后端 `get_block_type_for_tool_static` 映射为 `qbank_questions`
 * （见 src-tauri/src/chat_v2/context.rs）。
 *
 * 数据来源：
 * - `block.toolOutput`：工具返回的 taskId / examId / drafts 快照
 * - 全局 store（`qbankGenerationStore`）：任务实时状态（后台任务完成后自动刷新）
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import {
  CheckCircle,
  CircleNotch,
  WarningCircle,
} from '@phosphor-icons/react';

import { DsButton } from '@/components/ui/DsButton';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { useQbankGenerationStore } from '@/stores/qbankGenerationStore';
import type {
  GeneratedQuestionDraft,
  QbankGenerationTask,
  SkippedReference,
} from '@/types/qbankGeneration';
import { buildCreateParams } from '@/utils/qbankDraftToParams';
import { blockRegistry, type BlockComponentProps } from '../../registry';

// ============================================================================
// 类型
// ============================================================================

/** qbank_generate_questions 工具输出（与 Rust 侧 json! 对齐） */
interface QbankQuestionsToolOutput {
  action?: string;
  taskId?: string;
  examId?: string;
  status?: string;
  drafts?: GeneratedQuestionDraft[];
  rejectedCount?: number;
  rejectionReasons?: string[];
  skippedReferences?: SkippedReference[];
  usedReferenceCount?: number;
  hint?: string;
}

interface CreatedQuestion {
  id: string;
}

// ============================================================================
// 组件
// ============================================================================

const QbankQuestionsBlock: React.FC<BlockComponentProps> = React.memo(({ block }) => {
  const { t } = useTranslation(['exam_sheet', 'common']);
  const output = useMemo(
    () => (block.toolOutput ?? {}) as QbankQuestionsToolOutput,
    [block.toolOutput],
  );
  const taskId = output.taskId;
  const examId = output.examId ?? '';

  const storeTask = useQbankGenerationStore((state) =>
    taskId ? state.tasks[taskId] : undefined,
  );
  const upsertTask = useQbankGenerationStore((state) => state.upsertTask);

  // 历史加载/刷新后 store 为空时，按 taskId 拉一次
  useEffect(() => {
    if (!taskId || storeTask) return;
    void invoke<QbankGenerationTask | null>('qbank_get_generation_task', { taskId })
      .then((view) => {
        if (view) upsertTask(view);
      })
      .catch((error) => {
        debugLog.warn('[QbankQuestionsBlock] 拉取任务失败:', error);
      });
  }, [taskId, storeTask, upsertTask]);

  const task = storeTask;
  const drafts = useMemo(
    () => task?.drafts ?? output.drafts ?? [],
    [task?.drafts, output.drafts],
  );
  const status = task?.status ?? (block.status === 'error' ? 'failed' : drafts.length > 0 ? 'completed' : 'running');
  const skipped = task?.skippedReferences ?? output.skippedReferences ?? [];
  const rejectedCount = task?.rejectedCount ?? output.rejectedCount ?? 0;
  const usedReferenceCount = task?.usedReferenceCount ?? output.usedReferenceCount ?? 0;
  const errorMessage = task?.error ?? block.error;

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [importing, setImporting] = useState(false);
  const [importedCount, setImportedCount] = useState(0);

  // 每个任务只初始化一次勾选，避免轮询刷新覆盖用户操作
  const selectedInitRef = useRef<string | null>(null);
  useEffect(() => {
    if (drafts.length === 0) return;
    const initKey = taskId ?? 'inline';
    if (selectedInitRef.current === initKey) return;
    selectedInitRef.current = initKey;
    setSelected(new Set(drafts.map((_, index) => index)));
  }, [drafts, taskId]);

  const toggleDraft = useCallback((index: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }, []);

  const handleImport = useCallback(async () => {
    if (selected.size === 0 || importing || !examId) return;
    setImporting(true);
    try {
      const paramsList = drafts
        .filter((_, index) => selected.has(index))
        .map((draft) => buildCreateParams(draft, examId));
      const created = await invoke<CreatedQuestion[]>('qbank_batch_create_questions', {
        paramsList,
      });
      setImportedCount(created.length);
      showGlobalNotification(
        'success',
        t('exam_sheet:aiGeneration.importSuccess', { count: created.length }),
      );
    } catch (error) {
      debugLog.error('[QbankQuestionsBlock] import failed:', error);
      showGlobalNotification(
        'error',
        error instanceof Error ? error.message : t('exam_sheet:aiGeneration.importFailed'),
      );
    } finally {
      setImporting(false);
    }
  }, [drafts, examId, importing, selected, t]);

  // ----- 渲染：进行中 -----
  if (status === 'queued' || status === 'running') {
    return (
      <div className="rounded-md border border-border p-3 text-sm">
        <div className="flex items-center gap-2 text-muted-foreground">
          <CircleNotch size={16} className="animate-spin text-primary" />
          {t('exam_sheet:aiGeneration.generating')}
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          {t('exam_sheet:aiGeneration.backgroundHint')}
        </p>
      </div>
    );
  }

  // ----- 渲染：失败 -----
  if (status === 'failed') {
    return (
      <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive">
        <WarningCircle size={16} className="mt-0.5 flex-shrink-0" />
        <div>{errorMessage || t('exam_sheet:aiGeneration.taskFailed', { error: '' })}</div>
      </div>
    );
  }

  // ----- 渲染：取消 -----
  if (status === 'cancelled') {
    return (
      <div className="rounded-md border border-border p-3 text-xs text-muted-foreground">
        {t('exam_sheet:aiGeneration.blockCancelled')}
      </div>
    );
  }

  // ----- 渲染：完成（可勾选 + 入库）-----
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <CheckCircle size={16} className="text-primary" />
        {t('exam_sheet:aiGeneration.blockTitle', { count: drafts.length })}
      </div>

      {rejectedCount > 0 && (
        <div className="text-xs text-warning">
          {t('exam_sheet:aiGeneration.rejectedSummary', { count: rejectedCount })}
        </div>
      )}

      {skipped.length > 0 && (
        <div className="rounded-md border border-warning/30 bg-warning/10 p-2 text-xs text-warning">
          {t('exam_sheet:aiGeneration.skippedReferences', { count: skipped.length })}
          <ul className="mt-1 list-inside list-disc space-y-0.5">
            {skipped.map((ref, index) => (
              <li key={index}>
                {ref.name}：
                {t(`exam_sheet:aiGeneration.skipReason.${ref.reason}`, ref.reason)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {usedReferenceCount > 0 && (
        <div className="text-xs text-muted-foreground">
          {t('exam_sheet:aiGeneration.usedReferences', { count: usedReferenceCount })}
        </div>
      )}

      <div className="max-h-80 space-y-1.5 overflow-auto pr-1">
        {drafts.map((draft, index) => (
          <label
            key={index}
            className="flex cursor-pointer items-start gap-2 rounded-md border border-border p-2 hover:bg-muted/30"
          >
            <input
              type="checkbox"
              checked={selected.has(index)}
              onChange={() => toggleDraft(index)}
              className="mt-1 h-4 w-4 flex-shrink-0 accent-primary"
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="rounded bg-muted px-1.5 py-px text-2xs text-muted-foreground">
                  {t(`exam_sheet:questionTypes.${draft.question_type}`, draft.question_type)}
                </span>
                {draft.difficulty && (
                  <span className="rounded bg-muted px-1.5 py-px text-2xs text-muted-foreground">
                    {t(
                      `exam_sheet:questionBank.difficulty.${draft.difficulty}`,
                      draft.difficulty,
                    )}
                  </span>
                )}
                {draft.tags?.slice(0, 3).map((tag) => (
                  <span
                    key={tag}
                    className="rounded bg-primary/10 px-1.5 py-px text-2xs text-primary"
                  >
                    {tag}
                  </span>
                ))}
              </div>
              <div className="mt-1 whitespace-pre-wrap break-words text-sm text-foreground">
                {draft.content}
              </div>
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
                  <span className="font-medium">
                    {t('exam_sheet:aiGeneration.answerLabel')}
                  </span>
                  {draft.answer}
                </div>
              )}
            </div>
          </label>
        ))}
      </div>

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {t('exam_sheet:aiGeneration.selectedCount', {
            selected: selected.size,
            total: drafts.length,
          })}
        </span>
        <div className="flex items-center gap-2">
          {importedCount > 0 && (
            <span className="text-primary">
              {t('exam_sheet:aiGeneration.blockImported', { count: importedCount })}
            </span>
          )}
          <DsButton
            variant="default"
            size="sm"
            disabled={selected.size === 0 || importing || !examId}
            onClick={() => void handleImport()}
          >
            {importing && <CircleNotch size={14} className="mr-1 animate-spin" />}
            {t('exam_sheet:aiGeneration.confirmImport', { count: selected.size })}
          </DsButton>
        </div>
      </div>
    </div>
  );
});

QbankQuestionsBlock.displayName = 'QbankQuestionsBlock';

// ============================================================================
// 自动注册
// ============================================================================

blockRegistry.register('qbank_questions', {
  type: 'qbank_questions',
  component: QbankQuestionsBlock,
  onAbort: 'keep-content',
});

export { QbankQuestionsBlock };
