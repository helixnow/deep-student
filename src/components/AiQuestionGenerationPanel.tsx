/**
 * AI 出题面板（MVP）
 *
 * 流程：参数面板（题量/题型分布/难度/知识点/变式开关）→ 流式生成（展示原始输出）
 * → 预览草稿（逐题勾选/剔除）→ 确认入库（qbank_batch_create_questions，
 * source_type=ai_generated）。
 *
 * 设计依据：docs/dev/ai-question-generation-feasibility-2026-09-07.md §四 MVP。
 */

import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { DsButton } from '@/components/ui/DsButton';
import { DsDialog, DsDialogHeader, DsDialogTitle, DsDialogBody, DsDialogFooter } from '@/components/ui/DsDialog';
import { AppSelect, AppMenu, AppMenuTrigger, AppMenuContent, AppMenuItem } from '@/components/ui/app-menu';
import {
  CircleNotch,
  Sparkle,
  WarningCircle,
  CheckCircle,
  FileText,
  X,
  Plus,
  CaretDown,
} from '@phosphor-icons/react';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { useQbankAiGeneration, type GeneratedQuestionDraft } from '@/hooks/useQbankAiGeneration';
import SmilesText from '@/components/SmilesText';
import { OverlayLayerProvider } from '@/components/shared/OverlayLayer';
import { Z_INDEX } from '@/config/zIndex';
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

/** 参考文件上限（与后端 REFERENCE_FILES_MAX_COUNT 一致） */
const MAX_REFERENCE_FILES = 3;
/** 本地上传单文件上限（字节） */
const MAX_UPLOAD_FILE_BYTES = 20 * 1024 * 1024;
/** 本地上传接受的扩展名（文本类，DocumentParser 可解析） */
const UPLOAD_ACCEPT_EXTENSIONS = ['pdf', 'docx', 'doc', 'txt', 'md', 'csv'];

/** 已选参考文件（来源：资源库 file_id 或本地上传 base64） */
interface SelectedReference {
  id: string;
  name: string;
  source: 'library' | 'local';
  /** 仅本地上传时有值 */
  base64?: string;
}

/** 资源库文件列表项（VfsFile 的 camelCase 序列化，仅取展示所需字段） */
interface VfsFileMeta {
  id: string;
  fileName: string;
  size: number;
  fileType: string;
}

interface AiQuestionGenerationPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  examId: string;
  examName?: string;
  /** 入库成功后的回调（刷新题目列表） */
  onImportComplete?: () => void;
  /** 当前题目集现有题目的知识点（去重后），供点选注入 */
  availableTags?: string[];
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
  availableTags = [],
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
      setReferences([]);
      setSelectedKnowledgePoints([]);
      setKnowledgeInput('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // ===== 参考资料（C2）=====
  const [references, setReferences] = useState<SelectedReference[]>([]);
  const [libraryFiles, setLibraryFiles] = useState<VfsFileMeta[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryMenuOpen, setLibraryMenuOpen] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement>(null);

  // ===== 知识点（C2）=====
  const [selectedKnowledgePoints, setSelectedKnowledgePoints] = useState<string[]>([]);
  const [knowledgeInput, setKnowledgeInput] = useState('');

  // 打开资源库菜单时按需拉取文档类文件列表
  const loadLibraryFiles = useCallback(async () => {
    if (libraryLoading || libraryFiles.length > 0) return;
    setLibraryLoading(true);
    try {
      const files = await invoke<VfsFileMeta[]>('vfs_list_files', {
        fileType: 'document',
        limit: 100,
        offset: 0,
      });
      setLibraryFiles(files);
    } catch (error) {
      debugLog.error('[AiQuestionGenerationPanel] load library files failed:', error);
      showGlobalNotification('error', t('exam_sheet:aiGeneration.referenceLoadFailed'));
    } finally {
      setLibraryLoading(false);
    }
  }, [libraryFiles.length, libraryLoading, t]);

  const handleLibraryMenuOpenChange = useCallback(
    (nextOpen: boolean) => {
      setLibraryMenuOpen(nextOpen);
      if (nextOpen) void loadLibraryFiles();
    },
    [loadLibraryFiles],
  );

  const addLibraryReference = useCallback(
    (file: VfsFileMeta) => {
      setReferences((prev) => {
        if (prev.length >= MAX_REFERENCE_FILES) {
          showGlobalNotification('warning', t('exam_sheet:aiGeneration.referenceTooMany'));
          return prev;
        }
        if (prev.some((ref) => ref.id === file.id && ref.source === 'library')) {
          return prev;
        }
        return [...prev, { id: file.id, name: file.fileName, source: 'library' as const }];
      });
    },
    [t],
  );

  const handleUploadClick = useCallback(() => {
    uploadInputRef.current?.click();
  }, []);

  const handleUploadChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      event.target.value = ''; // 允许重复选择同一文件
      if (files.length === 0) return;

      for (const file of files) {
        if (references.length >= MAX_REFERENCE_FILES) {
          showGlobalNotification('warning', t('exam_sheet:aiGeneration.referenceTooMany'));
          break;
        }
        const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
        if (!UPLOAD_ACCEPT_EXTENSIONS.includes(ext)) {
          showGlobalNotification('warning', t('exam_sheet:aiGeneration.referenceUnsupported'));
          continue;
        }
        if (file.size > MAX_UPLOAD_FILE_BYTES) {
          showGlobalNotification('warning', t('exam_sheet:aiGeneration.referenceTooLarge'));
          continue;
        }
        try {
          const base64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
              const result = String(reader.result ?? '');
              // 去掉 Data URL 头（后端 DocumentParser 兼容两种，直接传纯 base64 更省体积）
              const commaIndex = result.indexOf(',');
              resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
            };
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
          });
          setReferences((prev) => [
            ...prev,
            { id: `local_${Date.now()}_${file.name}`, name: file.name, source: 'local' as const, base64 },
          ]);
        } catch (error) {
          debugLog.error('[AiQuestionGenerationPanel] read local file failed:', error);
          showGlobalNotification('error', t('exam_sheet:aiGeneration.referenceReadFailed'));
        }
      }
    },
    [references.length, t],
  );

  const removeReference = useCallback((id: string) => {
    setReferences((prev) => prev.filter((ref) => ref.id !== id));
  }, []);

  // ===== 知识点选择（C2）=====
  const toggleKnowledgePoint = useCallback((point: string) => {
    setSelectedKnowledgePoints((prev) =>
      prev.includes(point) ? prev.filter((p) => p !== point) : [...prev, point],
    );
  }, []);

  const addManualKnowledgePoint = useCallback(() => {
    const point = knowledgeInput.trim();
    if (!point) return;
    setSelectedKnowledgePoints((prev) => (prev.includes(point) ? prev : [...prev, point]));
    setKnowledgeInput('');
  }, [knowledgeInput]);

  const handleKnowledgeInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        addManualKnowledgePoint();
      }
    },
    [addManualKnowledgePoint],
  );

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
          reference_file_ids: references
            .filter((ref) => ref.source === 'library')
            .map((ref) => ref.id),
          reference_files_base64: references
            .filter((ref) => ref.source === 'local' && ref.base64)
            .map((ref) => ({ name: ref.name, base64: ref.base64 as string })),
          knowledge_points: selectedKnowledgePoints,
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
        {/* AppSelect 的下拉菜单经 portal 挂到 DsDialog 根（z-modal=3000），
            默认 z-index 110 会被对话框面板（modal+1=3001）盖住——题型/难度下拉
            表现为"点击无反应"。包一层 OverlayLayerProvider 让菜单抬到 3050。 */}
        <OverlayLayerProvider baseZ={Z_INDEX.modal}>
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

            {/* 参考资料（C2）：资源库选择 + 本地上传，上限 3 份 */}
            <div>
              <div className="text-sm font-medium mb-2">
                {t('exam_sheet:aiGeneration.referencesLabel')}
              </div>
              <div className="flex items-center gap-2">
                <AppMenu open={libraryMenuOpen} onOpenChange={handleLibraryMenuOpenChange}>
                  <AppMenuTrigger asChild>
                    <DsButton variant="outline" size="sm" disabled={references.length >= MAX_REFERENCE_FILES}>
                      <FileText size={14} className="mr-1" />
                      {t('exam_sheet:aiGeneration.referenceFromLibrary')}
                      <CaretDown size={12} className="ml-1 opacity-60" />
                    </DsButton>
                  </AppMenuTrigger>
                  <AppMenuContent align="start" width={280} maxHeight={280}>
                    {libraryLoading ? (
                      <div className="flex items-center justify-center gap-2 px-3 py-4 text-xs text-muted-foreground">
                        <CircleNotch size={14} className="animate-spin" />
                        {t('exam_sheet:aiGeneration.referenceCollecting')}
                      </div>
                    ) : libraryFiles.length === 0 ? (
                      <div className="px-3 py-4 text-xs text-muted-foreground text-center">
                        {t('exam_sheet:aiGeneration.referenceEmpty')}
                      </div>
                    ) : (
                      libraryFiles.map((file) => {
                        const selected = references.some(
                          (ref) => ref.source === 'library' && ref.id === file.id,
                        );
                        return (
                          <AppMenuItem
                            key={file.id}
                            icon={<FileText size={16} />}
                            checked={selected}
                            disabled={selected}
                            onClick={() => addLibraryReference(file)}
                          >
                            <span className="flex-1 truncate">{file.fileName}</span>
                          </AppMenuItem>
                        );
                      })
                    )}
                  </AppMenuContent>
                </AppMenu>
                <DsButton
                  variant="outline"
                  size="sm"
                  onClick={handleUploadClick}
                  disabled={references.length >= MAX_REFERENCE_FILES}
                >
                  <Plus size={14} className="mr-1" />
                  {t('exam_sheet:aiGeneration.referenceUpload')}
                </DsButton>
                <input
                  ref={uploadInputRef}
                  type="file"
                  multiple
                  accept=".pdf,.docx,.doc,.txt,.md,.csv"
                  className="hidden"
                  onChange={(e) => void handleUploadChange(e)}
                />
              </div>
              {references.length === 0 ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  {t('exam_sheet:aiGeneration.referenceEmpty')}
                </p>
              ) : (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {references.map((ref) => (
                    <span
                      key={ref.id}
                      className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 py-0.5 pl-2 pr-1 text-xs"
                    >
                      <span className="rounded bg-primary/10 px-1.5 text-2xs text-primary">
                        {ref.source === 'library'
                          ? t('exam_sheet:aiGeneration.referenceSourceLibrary')
                          : t('exam_sheet:aiGeneration.referenceSourceLocal')}
                      </span>
                      <span className="max-w-[160px] truncate">{ref.name}</span>
                      <button
                        type="button"
                        aria-label={`${t('common:delete')} ${ref.name}`}
                        className="rounded-full p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => removeReference(ref.id)}
                      >
                        <X size={10} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* 知识点选择（C2）：现有题目 tags 点选 + 手动输入 */}
            <div>
              <div className="text-sm font-medium mb-2">
                {t('exam_sheet:aiGeneration.knowledgePointsLabel')}
              </div>
              {availableTags.length === 0 && selectedKnowledgePoints.length === 0 && (
                <p className="mb-2 text-xs text-muted-foreground">
                  {t('exam_sheet:aiGeneration.knowledgePointsEmpty')}
                </p>
              )}
              {(availableTags.length > 0 || selectedKnowledgePoints.length > 0) && (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {availableTags.map((tag) => {
                    const active = selectedKnowledgePoints.includes(tag);
                    return (
                      <button
                        key={tag}
                        type="button"
                        onClick={() => toggleKnowledgePoint(tag)}
                        className={
                          active
                            ? 'rounded-full border border-primary/40 bg-primary/10 px-2.5 py-0.5 text-xs text-primary'
                            : 'rounded-full border border-border px-2.5 py-0.5 text-xs text-muted-foreground hover:border-primary/30 hover:text-foreground'
                        }
                      >
                        {tag}
                      </button>
                    );
                  })}
                  {/* 手动输入的知识点（可能不在 availableTags 里）也展示为可移除 chip */}
                  {selectedKnowledgePoints
                    .filter((point) => !availableTags.includes(point))
                    .map((point) => (
                      <span
                        key={point}
                        className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2.5 py-0.5 text-xs text-primary"
                      >
                        {point}
                        <button
                          type="button"
                          aria-label={`${t('common:delete')} ${point}`}
                          className="rounded-full p-0.5 hover:bg-destructive/10 hover:text-destructive"
                          onClick={() => toggleKnowledgePoint(point)}
                        >
                          <X size={10} />
                        </button>
                      </span>
                    ))}
                </div>
              )}
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={knowledgeInput}
                  onChange={(e) => setKnowledgeInput(e.target.value)}
                  onKeyDown={handleKnowledgeInputKeyDown}
                  maxLength={50}
                  placeholder={t('exam_sheet:aiGeneration.knowledgePointInputPlaceholder')}
                  className="h-8 flex-1 rounded-md border border-border bg-transparent px-2 text-sm"
                />
                <DsButton variant="ghost" size="sm" onClick={addManualKnowledgePoint} disabled={!knowledgeInput.trim()}>
                  {t('common:actions.add')}
                </DsButton>
              </div>
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
        </OverlayLayerProvider>
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
