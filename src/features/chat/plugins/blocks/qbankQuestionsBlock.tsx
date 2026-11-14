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
  CaretDown,
  CaretRight,
  CheckCircle,
  ListChecks,
  WarningCircle,
} from '@phosphor-icons/react';

import { cn } from '@/utils/cn';
import { DsButton } from '@/components/ui/DsButton';
import { Checkbox } from '@/components/ui/shad/Checkbox';
import { PulseDot } from '@/components/ui/PulseDot';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { useQbankGenerationStore } from '@/stores/qbankGenerationStore';
import type {
  GeneratedQuestionDraft,
  QbankGenerationTask,
  SkippedReference,
} from '@/types/qbankGeneration';
import { buildCreateParams } from '@/utils/qbankDraftToParams';
import type { QuestionDocumentV2 } from '@/api/questionBankApi';
import { blockRegistry, type BlockComponentProps } from '../../registry';
import { TextShimmer } from '../../components/ui/TextShimmer';
import { ToolActivitySweep } from '../../components/ui/ToolActivitySweep';
import { formatToolDurationShort } from '@/features/chat/utils/toolDuration';

// ============================================================================
// 类型
// ============================================================================

/** qbank_generate_questions 工具输出（与 Rust 侧 json! 对齐） */
interface QbankQuestionsToolOutput {
  job_id?: string;
  version?: number;
  document?: QuestionDocumentV2;
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
  const authoring = task?.authoringResult ?? output;
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
  const [isExpanded, setIsExpanded] = useState(true);

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
      if (!authoring.job_id) throw new Error(t('exam_sheet:aiGeneration.regenerateLegacy'));
      const created = await invoke<{committed:boolean;imported_count:number;question_ids:string[]}>('qbank_commit_authoring_draft', {
        jobId:authoring.job_id,expectedVersion:authoring.version,
        selectedLocalIds:drafts.filter((_,index)=>selected.has(index)).map(draft=>draft.local_id),
      });
      if (!created.committed) throw new Error(t('exam_sheet:uploader.commit_not_confirmed'));
      setImportedCount(created.imported_count);
      // 已打开的题目集（ExamContentView）只听这个事件刷新；字面量同 qbankDriver 的
      // QBANK_REFRESH_EVENT，不静态引入工作台 agent 驱动
      window.dispatchEvent(new CustomEvent('qbank:refresh', {
        detail: { source: 'user', action: 'import', entityIds: created.question_ids },
      }));
      showGlobalNotification(
        'success',
        t('exam_sheet:aiGeneration.importSuccess', { count: created.imported_count }),
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
  }, [authoring, drafts, examId, importing, selected, t]);

  const isActive = status === 'queued' || status === 'running';
  const isFailed = status === 'failed';
  const isCancelled = status === 'cancelled';
  const isCompleted = !isActive && !isFailed && !isCancelled;
  const durationMs =
    block.startedAt && block.endedAt ? block.endedAt - block.startedAt : undefined;

  const headerTitle = isActive
    ? t('exam_sheet:aiGeneration.generating')
    : isFailed
      ? t('exam_sheet:aiGeneration.taskFailed', { error: '' }).trim()
      : isCancelled
        ? t('exam_sheet:aiGeneration.blockCancelled')
        : t('exam_sheet:aiGeneration.blockTitle', { count: drafts.length });

  return (
    <div
      className={cn(
        'rounded-lg border overflow-hidden bg-card dark:bg-card/80',
        isFailed ? 'border-destructive/30' : 'border-border/50'
      )}
    >
      {/* 统一头部 */}
      <button
        type="button"
        onClick={() => setIsExpanded((prev) => !prev)}
        aria-expanded={isExpanded}
        className={cn(
          'flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left',
          'transition-colors hover:bg-muted/40 [@media(pointer:coarse)]:!min-h-11',
          isExpanded && 'border-b border-border/40'
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <ToolActivitySweep
            active={isActive}
            className="h-7 w-7 shrink-0 justify-center rounded-md bg-muted/70 dark:bg-muted/40"
          >
            <ListChecks size={16} className="text-muted-foreground" />
          </ToolActivitySweep>
          <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
            <ToolActivitySweep active={isActive} className="min-w-0 max-w-full leading-4">
              {isActive ? (
                <TextShimmer
                  className="block truncate text-xs font-medium leading-4 text-muted-foreground"
                  duration={1.5}
                  spread={3}
                >
                  {headerTitle}
                </TextShimmer>
              ) : (
                <span
                  className={cn(
                    'block truncate text-xs font-medium leading-4',
                    isFailed ? 'text-destructive' : 'text-muted-foreground'
                  )}
                >
                  {headerTitle}
                </span>
              )}
            </ToolActivitySweep>
            {isCompleted && (
              <span className="truncate text-xs leading-4 text-muted-foreground/80 tabular-nums">
                {t('exam_sheet:aiGeneration.selectedCount', {
                  selected: selected.size,
                  total: drafts.length,
                })}
              </span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {!isActive && durationMs !== undefined && durationMs >= 0 && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {formatToolDurationShort(durationMs)}
            </span>
          )}
          {isActive && <PulseDot className="h-1.5 w-1.5 text-primary" />}
          {isCompleted && <CheckCircle size={14} className="shrink-0 text-success" />}
          {isFailed && <WarningCircle size={14} className="shrink-0 text-destructive" />}
          {isExpanded ? (
            <CaretDown size={14} className="shrink-0 text-muted-foreground" />
          ) : (
            <CaretRight size={14} className="shrink-0 text-muted-foreground" />
          )}
        </div>
      </button>

      {/* 展开内容 */}
      {isExpanded && (
        <div className="space-y-2.5 p-3">
          {isActive && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <PulseDot className="h-1.5 w-1.5 shrink-0 text-primary" />
              <span>{t('exam_sheet:aiGeneration.backgroundHint')}</span>
            </div>
          )}

          {isFailed && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive">
              <WarningCircle size={16} className="mt-0.5 flex-shrink-0" />
              <div>{errorMessage || t('exam_sheet:aiGeneration.taskFailed', { error: '' })}</div>
            </div>
          )}

          {isCancelled && (
            <div className="text-xs text-muted-foreground">
              {t('exam_sheet:aiGeneration.blockCancelled')}
            </div>
          )}

          {isCompleted && (
            <>
              {rejectedCount > 0 && (
                <div className="text-xs text-warning tabular-nums">
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
                <div className="text-xs text-muted-foreground tabular-nums">
                  {t('exam_sheet:aiGeneration.usedReferences', { count: usedReferenceCount })}
                </div>
              )}

              <div className="max-h-80 space-y-1.5 overflow-auto pr-1">
                {(authoring.document?.materials || []).map(material => (
                  <section key={material.local_id || material.id} className="border-l-2 border-border/50 px-3 py-2 text-sm whitespace-pre-wrap">{material.content}</section>
                ))}
                {drafts.map((draft, index) => (
                  <label
                    key={index}
                    className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border/50 p-2.5 hover:bg-muted/30 [@media(pointer:coarse)]:min-h-11"
                  >
                    <Checkbox
                      checked={selected.has(index)}
                      onCheckedChange={() => toggleDraft(index)}
                      className="mt-0.5 flex-shrink-0"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="rounded-md bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
                          {t(`exam_sheet:questionTypes.${draft.question_type}`, draft.question_type)}
                        </span>
                        {draft.difficulty && (
                          <span className="rounded-md bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
                            {t(
                              `exam_sheet:questionBank.difficulty.${draft.difficulty}`,
                              draft.difficulty,
                            )}
                          </span>
                        )}
                        {draft.tags?.slice(0, 3).map((tag) => (
                          <span
                            key={tag}
                            className="rounded-md bg-primary/10 px-1.5 py-0.5 text-2xs text-primary"
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

              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span className="tabular-nums">
                  {t('exam_sheet:aiGeneration.selectedCount', {
                    selected: selected.size,
                    total: drafts.length,
                  })}
                </span>
                <div className="flex items-center gap-2">
                  {importedCount > 0 && (
                    <span className="text-primary tabular-nums">
                      {t('exam_sheet:aiGeneration.blockImported', { count: importedCount })}
                    </span>
                  )}
                  <DsButton
                    variant="default"
                    size="sm"
                    disabled={selected.size === 0 || importing || !examId}
                    onClick={() => void handleImport()}
                    className="[@media(pointer:coarse)]:!min-h-11"
                  >
                    {importing && <PulseDot className="mr-1.5 h-1.5 w-1.5 text-current" />}
                    {t('exam_sheet:aiGeneration.confirmImport', { count: selected.size })}
                  </DsButton>
                </div>
              </div>
            </>
          )}
        </div>
      )}
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
