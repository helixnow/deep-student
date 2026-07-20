/**
 * InlineSettingsPanel - 作文批改内联设置面板（无抽屉 / 无遮罩 / 无模态，纯文档流内联渲染）
 *
 * 信息架构（高频在上，低频折叠）：
 * 1. 评分标准：批阅模式（含分制/维度摘要卡）+ 文体 + 学段，一屏尽览；批改中锁定
 * 2. 批改模型
 * 3. [折叠] 自定义提示词：保存后就地成功反馈
 * 4. [折叠] 模式管理：编辑/复制/新建/重置/删除（内联二段式确认）+ 内联编辑表单
 *
 * 定位/显隐由父级 GradingMain 负责（移动端顶部高度过渡区块、桌面端右侧宽度过渡内联列），
 * 本组件只渲染可滚动的面板内容；折叠区采用 grid-template-rows 过渡实现顺滑展开/收起。
 */
import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Textarea } from '../ui/shad/Textarea';
import { Input } from '../ui/shad/Input';
import {
  ArrowCounterClockwise,
  FloppyDisk,
  GearSix,
  X,
  CaretRight,
  Plus,
  Trash,
  Copy,
  Check,
  DotsSixVertical,
  WarningCircle,
  Pencil,
} from '@phosphor-icons/react';
import { UnifiedModelSelector } from '../shared/UnifiedModelSelector';
import { CustomScrollArea } from '../custom-scroll-area';
import { NotionButton } from '@/components/ui/NotionButton';
import type {
  GradingMode,
  ModelInfo,
  ScoreDimension,
  CreateModeInput,
  SaveBuiltinOverrideInput,
} from '@/essay-grading/essayGradingApi';
import {
  createCustomMode,
  updateCustomMode,
  deleteCustomMode,
  saveBuiltinOverride,
  resetBuiltinMode,
} from '@/essay-grading/essayGradingApi';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/shad/Badge';
import { showGlobalNotification } from '@/components/UnifiedNotification';

interface InlineSettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  // 批阅模式
  modeId: string;
  setModeId: (id: string) => void;
  modes: GradingMode[];
  // 模型选择
  modelId: string;
  setModelId: (id: string) => void;
  models: ModelInfo[];
  // 自定义提示词
  customPrompt: string;
  setCustomPrompt: (prompt: string) => void;
  onSavePrompt: () => void;
  onRestoreDefaultPrompt: () => void;
  // 状态
  isGrading?: boolean;
  onModesChange?: () => void;
  // 文体/年级（父级透传时渲染选择 UI）
  essayType?: string;
  setEssayType?: (v: string) => void;
  gradeLevel?: string;
  setGradeLevel?: (v: string) => void;
}

type SettingsViewMode = 'view' | 'edit' | 'create';
type ConfirmableAction = 'delete' | 'reset';

interface FormData {
  name: string;
  description: string;
  system_prompt: string;
  score_dimensions: ScoreDimension[];
  total_max_score: number;
}

const EMPTY_FORM: FormData = {
  name: '',
  description: '',
  system_prompt: '',
  score_dimensions: [],
  total_max_score: 100,
};

const ESSAY_TYPE_OPTIONS = ['narrative', 'argumentative', 'expository', 'other'] as const;
const GRADE_LEVEL_OPTIONS = ['middle_school', 'high_school', 'college', 'other'] as const;

/** 滚动容器选择器（OverlayScrollbars 视口 / 原生降级） */
const SCROLL_VIEWPORT_SELECTOR = '[data-overlayscrollbars-viewport], .scroll-area--native';

/** 选择芯片（模式/文体/年级共用视觉） */
const choiceChipClassName = (active: boolean) =>
  cn(
    '!px-2.5 !py-1 !h-auto text-xs ui-state-colors',
    active
      ? 'bg-primary/10 text-primary border border-primary/30'
      : 'bg-muted/50 text-foreground/70 border border-transparent hover:bg-[var(--interactive-hover)] hover:text-foreground'
  );

/** 内联折叠区：chevron 旋转 + grid-template-rows 高度过渡（motion-reduce 降级为直接切换） */
const CollapsibleSection: React.FC<{
  title: string;
  isOpen: boolean;
  onToggle: () => void;
  badge?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, isOpen, onToggle, badge, children }) => (
  <section>
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={isOpen}
      className="flex w-full items-center justify-between gap-2 px-4 py-3 text-xs font-medium uppercase tracking-wide text-muted-foreground/70 transition-colors duration-150 hover:text-foreground motion-reduce:transition-none"
    >
      <span className="flex items-center gap-2">
        {title}
        {badge}
      </span>
      <CaretRight
        size={12}
        className={cn(
          'transition-transform duration-200 motion-reduce:transition-none',
          isOpen && 'rotate-90'
        )}
      />
    </button>
    <div
      className={cn(
        'grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none',
        isOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
      )}
      aria-hidden={!isOpen}
    >
      {/* 折叠后延迟置为 invisible：既保留收起动画，又让隐藏内容退出焦点链与无障碍树 */}
      <div
        className={cn(
          'min-h-0 overflow-hidden transition-[visibility] motion-reduce:transition-none',
          isOpen ? 'visible' : 'invisible [transition-delay:200ms]'
        )}
      >
        <div className="pb-4">{children}</div>
      </div>
    </div>
  </section>
);

export const InlineSettingsPanel: React.FC<InlineSettingsPanelProps> = ({
  isOpen,
  onClose,
  modeId,
  setModeId,
  modes,
  modelId,
  setModelId,
  models,
  customPrompt,
  setCustomPrompt,
  onSavePrompt,
  onRestoreDefaultPrompt,
  isGrading = false,
  onModesChange,
  essayType,
  setEssayType,
  gradeLevel,
  setGradeLevel,
}) => {
  const { t } = useTranslation(['essay_grading', 'settings']);
  const [viewMode, setViewMode] = useState<SettingsViewMode>('view');
  const [editingMode, setEditingMode] = useState<GradingMode | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showValidation, setShowValidation] = useState(false);
  const [formData, setFormData] = useState<FormData>(EMPTY_FORM);
  // 折叠区展开状态
  const [editorExpanded, setEditorExpanded] = useState(false);
  const [promptExpanded, setPromptExpanded] = useState(false);
  // 二段式确认（删除/重置），3 秒自动复位
  const [pendingConfirm, setPendingConfirm] = useState<ConfirmableAction | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 提示词保存的就地成功反馈
  const [promptJustSaved, setPromptJustSaved] = useState(false);
  const promptSavedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 维度拖拽排序
  const [dragArmedIndex, setDragArmedIndex] = useState<number | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const systemPromptTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  const currentMode = modes.find(m => m.id === modeId);
  const defaultModel = models.find(m => m.is_default);
  const isEditing = viewMode === 'edit' || viewMode === 'create';

  const clearConfirmTimer = useCallback(() => {
    if (confirmTimerRef.current) {
      clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }
  }, []);

  // 面板关闭时重置所有瞬态：编辑态/表单/校验/确认/折叠区
  useEffect(() => {
    if (isOpen) return;
    setViewMode('view');
    setEditingMode(null);
    setFormData(EMPTY_FORM);
    setError(null);
    setShowValidation(false);
    setEditorExpanded(false);
    setPromptExpanded(false);
    setPendingConfirm(null);
    setPromptJustSaved(false);
    setDragArmedIndex(null);
    setDragIndex(null);
    setDragOverIndex(null);
    clearConfirmTimer();
  }, [isOpen, clearConfirmTimer]);

  // 卸载时清理定时器
  useEffect(() => () => {
    clearConfirmTimer();
    if (promptSavedTimerRef.current) clearTimeout(promptSavedTimerRef.current);
  }, [clearConfirmTimer]);

  // 切换当前模式时复位待确认状态，避免误删新选中的模式
  useEffect(() => {
    setPendingConfirm(null);
    clearConfirmTimer();
  }, [modeId, clearConfirmTimer]);

  // 系统提示词 textarea 自适应高度（保持外层滚动位置）
  useEffect(() => {
    const textarea = systemPromptTextareaRef.current;
    if (!textarea || !isEditing) return;
    const scrollParent = textarea.closest(SCROLL_VIEWPORT_SELECTOR) as HTMLElement | null;
    const savedScroll = scrollParent ? scrollParent.scrollTop : 0;
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
    if (scrollParent) scrollParent.scrollTop = savedScroll;
  }, [formData.system_prompt, isEditing]);

  // ========== 模式编辑操作 ==========

  const handleStartEdit = useCallback((mode: GradingMode) => {
    setFormData({
      name: mode.name,
      description: mode.description,
      system_prompt: mode.system_prompt,
      score_dimensions: [...mode.score_dimensions],
      total_max_score: mode.total_max_score,
    });
    setEditingMode(mode);
    setViewMode('edit');
    setError(null);
    setShowValidation(false);
    setEditorExpanded(true);
  }, []);

  const handleStartCreate = useCallback(() => {
    setFormData({
      name: '',
      description: '',
      system_prompt: '',
      score_dimensions: [
        { name: t('settings:gradingMode.defaultDimensionContent'), max_score: 40, description: null },
        { name: t('settings:gradingMode.defaultDimensionStructure'), max_score: 30, description: null },
        { name: t('settings:gradingMode.defaultDimensionLanguage'), max_score: 30, description: null },
      ],
      total_max_score: 100,
    });
    setEditingMode(null);
    setViewMode('create');
    setError(null);
    setShowValidation(false);
    setEditorExpanded(true);
  }, [t]);

  const handleCopyMode = useCallback((mode: GradingMode) => {
    setFormData({
      name: `${mode.name} ${t('settings:gradingMode.copySuffix')}`,
      description: mode.description,
      system_prompt: mode.system_prompt,
      score_dimensions: [...mode.score_dimensions],
      total_max_score: mode.total_max_score,
    });
    setEditingMode(null);
    setViewMode('create');
    setError(null);
    setShowValidation(false);
    setEditorExpanded(true);
  }, [t]);

  const handleCancelEdit = useCallback(() => {
    setViewMode('view');
    setEditingMode(null);
    setError(null);
    setShowValidation(false);
  }, []);

  // ========== 表单校验 ==========

  const calculatedTotal = formData.score_dimensions.reduce(
    (sum, dim) => sum + (dim.max_score || 0),
    0
  );

  const nameInvalid = !formData.name.trim();
  const dimensionIssues = formData.score_dimensions.map(dim => ({
    name: !dim.name.trim(),
    score: !(Number(dim.max_score) > 0),
  }));
  const dimensionsInvalid = dimensionIssues.some(issue => issue.name || issue.score);
  const totalInvalid = !(Number(formData.total_max_score) > 0);
  const formInvalid = nameInvalid || dimensionsInvalid || totalInvalid;
  const totalMismatch = formData.score_dimensions.length > 0
    && Number(formData.total_max_score) !== calculatedTotal;

  const validationMessage = !showValidation
    ? null
    : nameInvalid
      ? t('settings:gradingMode.errorNameRequired')
      : dimensionsInvalid
        ? t('essay_grading:settings_panel.validation.dimension_invalid')
        : totalInvalid
          ? t('essay_grading:settings_panel.validation.total_positive')
          : null;

  const handleSave = useCallback(async () => {
    if (formInvalid) {
      setShowValidation(true);
      return;
    }

    setIsLoading(true);
    setError(null);

    const payload = {
      name: formData.name.trim(),
      description: formData.description.trim(),
      system_prompt: formData.system_prompt,
      score_dimensions: formData.score_dimensions.map(dim => ({
        ...dim,
        name: dim.name.trim(),
      })),
      total_max_score: formData.total_max_score,
    };

    try {
      if (viewMode === 'create') {
        const input: CreateModeInput = payload;
        await createCustomMode(input);
        showGlobalNotification('success', t('settings:gradingMode.successCreated'));
      } else if (viewMode === 'edit' && editingMode) {
        if (editingMode.is_builtin) {
          const input: SaveBuiltinOverrideInput = {
            builtin_id: editingMode.id,
            ...payload,
          };
          await saveBuiltinOverride(input);
          showGlobalNotification('success', t('settings:gradingMode.successSaved'));
        } else {
          await updateCustomMode({ id: editingMode.id, ...payload });
          showGlobalNotification('success', t('settings:gradingMode.successUpdated'));
        }
      }

      onModesChange?.();
      setViewMode('view');
      setEditingMode(null);
      setShowValidation(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('settings:gradingMode.errorOperationFailed'));
    } finally {
      setIsLoading(false);
    }
  }, [formInvalid, viewMode, formData, editingMode, onModesChange, t]);

  // ========== 重置 / 删除（二段式内联确认） ==========

  const executeResetBuiltin = useCallback(async (mode: GradingMode) => {
    setIsLoading(true);
    setError(null);
    try {
      await resetBuiltinMode(mode.id);
      showGlobalNotification('success', t('settings:gradingMode.successReset'));
      onModesChange?.();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('settings:gradingMode.errorResetFailed'));
    } finally {
      setIsLoading(false);
    }
  }, [onModesChange, t]);

  const executeDelete = useCallback(async (mode: GradingMode) => {
    setIsLoading(true);
    setError(null);
    try {
      await deleteCustomMode(mode.id);
      showGlobalNotification('success', t('settings:gradingMode.successDeleted'));
      onModesChange?.();

      if (mode.id === modeId) {
        const defaultMode = modes.find(m => m.is_builtin);
        if (defaultMode) setModeId(defaultMode.id);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('settings:gradingMode.errorDeleteFailed'));
    } finally {
      setIsLoading(false);
    }
  }, [modes, modeId, setModeId, onModesChange, t]);

  /** 第一次点击进入待确认态（3 秒自动复位），第二次点击执行 */
  const handleConfirmableClick = useCallback((action: ConfirmableAction, mode: GradingMode) => {
    if (pendingConfirm === action) {
      clearConfirmTimer();
      setPendingConfirm(null);
      if (action === 'delete') void executeDelete(mode);
      else void executeResetBuiltin(mode);
      return;
    }
    clearConfirmTimer();
    setPendingConfirm(action);
    confirmTimerRef.current = setTimeout(() => {
      setPendingConfirm(null);
      confirmTimerRef.current = null;
    }, 3000);
  }, [pendingConfirm, clearConfirmTimer, executeDelete, executeResetBuiltin]);

  // ========== 评分维度操作 ==========

  const handleAddDimension = useCallback(() => {
    setFormData(prev => ({
      ...prev,
      score_dimensions: [
        ...prev.score_dimensions,
        { name: '', max_score: 10, description: null },
      ],
    }));
  }, []);

  const handleRemoveDimension = useCallback((index: number) => {
    setFormData(prev => ({
      ...prev,
      score_dimensions: prev.score_dimensions.filter((_, i) => i !== index),
    }));
  }, []);

  const handleUpdateDimension = useCallback((
    index: number,
    field: keyof ScoreDimension,
    value: string | number
  ) => {
    let processedValue = value;
    if (field === 'max_score') {
      processedValue = Math.max(0, Number(value));
    }
    setFormData(prev => ({
      ...prev,
      score_dimensions: prev.score_dimensions.map((dim, i) =>
        i === index ? { ...dim, [field]: processedValue } : dim
      ),
    }));
  }, []);

  const handleReorderDimension = useCallback((from: number, to: number) => {
    if (from === to) return;
    setFormData(prev => {
      const dims = [...prev.score_dimensions];
      const [moved] = dims.splice(from, 1);
      dims.splice(to, 0, moved);
      return { ...prev, score_dimensions: dims };
    });
  }, []);

  const clearDragState = useCallback(() => {
    setDragArmedIndex(null);
    setDragIndex(null);
    setDragOverIndex(null);
  }, []);

  // ========== 其他交互 ==========

  const handleModeSwitch = useCallback((newModeId: string) => {
    setModeId(newModeId);
    if (viewMode !== 'view') {
      setViewMode('view');
      setEditingMode(null);
      setError(null);
      setShowValidation(false);
    }
  }, [setModeId, viewMode]);

  // 保存提示词：就地成功反馈，不关闭面板
  const handleSavePrompt = useCallback(() => {
    onSavePrompt();
    setPromptJustSaved(true);
    if (promptSavedTimerRef.current) clearTimeout(promptSavedTimerRef.current);
    promptSavedTimerRef.current = setTimeout(() => {
      setPromptJustSaved(false);
      promptSavedTimerRef.current = null;
    }, 2000);
  }, [onSavePrompt]);

  const errorBanner = error ? (
    <div
      role="alert"
      className="ui-drop-in mb-3 flex items-start gap-2 rounded-md bg-destructive/10 p-2.5 text-xs leading-relaxed text-destructive"
    >
      <WarningCircle size={14} className="mt-0.5 flex-shrink-0" />
      {error}
    </div>
  ) : null;

  return (
    <div className="h-full flex flex-col bg-background">
      {/* 头部 */}
      <div className="flex h-[41px] flex-shrink-0 items-center justify-between border-b border-border/30 px-4">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground/80">
          <GearSix size={14} />
          <span>{t('essay_grading:settings.title')}</span>
        </div>
        <NotionButton
          variant="ghost"
          size="icon"
          iconOnly
          onClick={onClose}
          className="h-7 w-7 text-muted-foreground/60 hover:bg-[var(--interactive-hover)] hover:text-foreground"
          aria-label={t('essay_grading:settings_panel.close')}
          title={t('essay_grading:settings_panel.close')}
        >
          <X size={16} />
        </NotionButton>
      </div>

      {/* 内容区 */}
      <CustomScrollArea className="flex-1" viewportClassName="pb-4">
        <div className="divide-y divide-border/30">

          {/* ====== 1. 评分标准：批阅模式 + 文体 + 学段（高频，一屏尽览） ====== */}
          <section className="px-4 pb-4 pt-4">
            <div className="mb-3 flex items-baseline justify-between gap-2">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
                {t('essay_grading:workbench.settings.section_criteria')}
              </h3>
              {isGrading && (
                <span className="text-[10px] text-muted-foreground/60">
                  {t('essay_grading:workbench.settings.locked_while_grading')}
                </span>
              )}
            </div>

            <div className="space-y-4">
              {/* 批阅模式 */}
              <div className="space-y-1.5">
                <div className="text-xs text-muted-foreground/60">
                  {t('essay_grading:settings_panel.section_mode')}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {modes.map((mode) => (
                    <NotionButton
                      key={mode.id}
                      variant="ghost"
                      size="sm"
                      onClick={() => handleModeSwitch(mode.id)}
                      disabled={isGrading}
                      aria-pressed={mode.id === modeId}
                      title={t('essay_grading:mode.max_score', { score: mode.total_max_score })}
                      className={choiceChipClassName(mode.id === modeId)}
                    >
                      {mode.name}
                    </NotionButton>
                  ))}
                </div>

                {/* 当前模式摘要卡（分制 + 维度） */}
                {currentMode && (
                  <div className="ui-state-colors mt-1.5 space-y-2 rounded-md border border-primary/30 bg-primary/10 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-foreground/90">{currentMode.name}</span>
                      {currentMode.is_builtin && (
                        <Badge variant="secondary" className="h-4 bg-muted/80 px-1 text-[10px] font-normal text-muted-foreground">
                          {t('settings:gradingMode.badgeBuiltin')}
                        </Badge>
                      )}
                      <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                        {t('settings:gradingMode.maxScore', { score: currentMode.total_max_score })}
                      </span>
                    </div>
                    {currentMode.description && (
                      <div className="text-xs leading-relaxed text-muted-foreground/80">
                        {currentMode.description}
                      </div>
                    )}
                    {currentMode.score_dimensions.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {currentMode.score_dimensions.map((dim, idx) => (
                          <span
                            key={idx}
                            className="inline-flex items-center rounded border border-border/40 bg-background/60 px-1.5 py-0.5 text-[11px] text-foreground/70"
                          >
                            {dim.name}
                            <span className="ml-1 tabular-nums text-muted-foreground/60">{dim.max_score}</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* 文体 */}
              {setEssayType && (
                <div className="space-y-1.5">
                  <div className="text-xs text-muted-foreground/60">
                    {t('essay_grading:essay_type.label')}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {ESSAY_TYPE_OPTIONS.map(option => (
                      <NotionButton
                        key={option}
                        variant="ghost"
                        size="sm"
                        onClick={() => setEssayType(option)}
                        disabled={isGrading}
                        aria-pressed={essayType === option}
                        className={choiceChipClassName(essayType === option)}
                      >
                        {t(`essay_grading:essay_type.${option}`)}
                      </NotionButton>
                    ))}
                  </div>
                </div>
              )}

              {/* 学段 */}
              {setGradeLevel && (
                <div className="space-y-1.5">
                  <div className="text-xs text-muted-foreground/60">
                    {t('essay_grading:grade_level.label')}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {GRADE_LEVEL_OPTIONS.map(option => (
                      <NotionButton
                        key={option}
                        variant="ghost"
                        size="sm"
                        onClick={() => setGradeLevel(option)}
                        disabled={isGrading}
                        aria-pressed={gradeLevel === option}
                        className={choiceChipClassName(gradeLevel === option)}
                      >
                        {t(`essay_grading:grade_level.${option}`)}
                      </NotionButton>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* ====== 2. 批改模型（高频） ====== */}
          {models.length > 0 && (
            <section className="px-4 pb-4 pt-4">
              <h3 className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
                {t('essay_grading:model.title')}
              </h3>
              <UnifiedModelSelector
                models={models}
                value={modelId || defaultModel?.id || ''}
                onChange={setModelId}
                disabled={isGrading}
                placeholder={t('essay_grading:model.select')}
              />
            </section>
          )}

          {/* ====== 3. 自定义提示词（低频，折叠） ====== */}
          <CollapsibleSection
            title={t('essay_grading:prompt_editor.title')}
            isOpen={promptExpanded}
            onToggle={() => setPromptExpanded(prev => !prev)}
          >
            <div className="space-y-3 px-4">
              <Textarea
                value={customPrompt}
                onChange={(e) => setCustomPrompt(e.target.value)}
                placeholder={t('essay_grading:prompt_editor.placeholder')}
                className="min-h-[200px] w-full resize-none border-border/40 text-sm focus:border-border/60"
              />
              <div className="flex items-center justify-end gap-2">
                <NotionButton
                  variant="ghost"
                  size="sm"
                  onClick={onRestoreDefaultPrompt}
                  className="text-xs text-muted-foreground/70 hover:bg-[var(--interactive-hover)] hover:text-foreground"
                >
                  <ArrowCounterClockwise size={14} />
                  {t('essay_grading:prompt_editor.restore_default')}
                </NotionButton>
                {/* 保存后就地反馈：勾选图标 + 文案短暂切换，不关闭面板 */}
                <NotionButton
                  variant="primary"
                  size="sm"
                  onClick={handleSavePrompt}
                  className={cn(
                    "ui-state-colors text-xs",
                    promptJustSaved
                      ? "bg-success/10 text-success hover:bg-success/10"
                      : "bg-primary/10 text-primary hover:bg-primary/20"
                  )}
                >
                  {promptJustSaved ? <Check size={14} /> : <FloppyDisk size={14} />}
                  {promptJustSaved
                    ? t('essay_grading:settings_panel.prompt_saved_short')
                    : t('essay_grading:prompt_editor.save')}
                </NotionButton>
              </div>
            </div>
          </CollapsibleSection>

          {/* ====== 4. 模式管理（低频，折叠） ====== */}
          <CollapsibleSection
            title={t('essay_grading:settings_panel.section_mode_editor')}
            isOpen={editorExpanded}
            onToggle={() => setEditorExpanded(prev => !prev)}
            badge={isEditing ? (
              <span className="inline-flex items-center rounded bg-primary/10 px-1 py-px text-[10px] font-normal normal-case tracking-normal text-primary">
                {t('essay_grading:settings_panel.editing_badge')}
              </span>
            ) : undefined}
          >
            {isEditing ? (
              /* ---------- 内联编辑表单 ---------- */
              <div>
                {/* 表单头：标题 + 取消/完成 + 校验与错误反馈 */}
                <div className="border-b border-border/30 bg-background px-4 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-medium text-foreground/80">
                      {viewMode === 'create'
                        ? t('essay_grading:settings_panel.create_mode')
                        : t('essay_grading:mode.edit')}
                    </span>
                    <div className="flex flex-shrink-0 items-center gap-1">
                      <NotionButton
                        variant="ghost"
                        size="sm"
                        onClick={handleCancelEdit}
                        className="h-7 px-2 text-xs text-muted-foreground/70 hover:bg-[var(--interactive-hover)] hover:text-foreground"
                      >
                        {t('essay_grading:actions.cancel')}
                      </NotionButton>
                      <NotionButton
                        variant="ghost"
                        size="sm"
                        onClick={handleSave}
                        disabled={isLoading}
                        className="h-7 px-2 text-xs text-primary hover:bg-primary/10 hover:text-primary"
                      >
                        {isLoading ? t('settings:gradingMode.saving') : t('settings:gradingMode.done')}
                      </NotionButton>
                    </div>
                  </div>
                  {validationMessage && (
                    <div role="alert" className="ui-drop-in mt-1.5 flex items-center gap-1.5 text-xs text-destructive">
                      <WarningCircle size={14} className="flex-shrink-0" />
                      {validationMessage}
                    </div>
                  )}
                  {error && (
                    <div role="alert" className="ui-drop-in mt-1.5 flex items-center gap-1.5 text-xs text-destructive">
                      <WarningCircle size={14} className="flex-shrink-0" />
                      {error}
                    </div>
                  )}
                </div>

                <div className="ui-rise-in space-y-5 px-4 pt-3">
                  {/* 基本信息 */}
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-muted-foreground/60">
                      {t('settings:gradingMode.labelBasicInfo')}
                    </label>
                    <Input
                      value={formData.name}
                      onChange={e => setFormData(prev => ({ ...prev, name: e.target.value }))}
                      placeholder={t('settings:gradingMode.placeholderModeName')}
                      className={cn(
                        "h-8 border-border/30 bg-transparent px-2 text-sm font-medium focus-visible:ring-1 focus-visible:ring-primary/30",
                        showValidation && nameInvalid && "border-destructive/50 focus-visible:ring-destructive/30"
                      )}
                    />
                    <Textarea
                      value={formData.description}
                      onChange={e => setFormData(prev => ({ ...prev, description: e.target.value }))}
                      placeholder={t('settings:gradingMode.placeholderDescription')}
                      rows={2}
                      className="w-full resize-none rounded-md border border-border/30 bg-transparent px-2 py-1.5 text-sm leading-relaxed text-muted-foreground focus:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/30"
                    />
                  </div>

                  {/* 评分维度 */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-medium text-muted-foreground/60">
                        {t('settings:gradingMode.labelDimensions')}
                      </label>
                      <span className="rounded-full bg-muted/50 px-2 py-0.5 text-xs tabular-nums text-muted-foreground">
                        {t('settings:gradingMode.currentTotal', { total: calculatedTotal })}
                      </span>
                    </div>
                    <div className="space-y-1">
                      {formData.score_dimensions.map((dim, index) => {
                        const issue = dimensionIssues[index];
                        const isDropTarget = dragOverIndex === index && dragIndex !== null && dragIndex !== index;
                        return (
                          <div
                            key={index}
                            draggable={dragArmedIndex === index}
                            onDragStart={e => {
                              if (dragArmedIndex !== index) {
                                e.preventDefault();
                                return;
                              }
                              e.dataTransfer.effectAllowed = 'move';
                              e.dataTransfer.setData('text/plain', String(index));
                              setDragIndex(index);
                            }}
                            onDragOver={e => {
                              if (dragIndex === null) return;
                              e.preventDefault();
                              e.dataTransfer.dropEffect = 'move';
                              if (dragOverIndex !== index) setDragOverIndex(index);
                            }}
                            onDrop={e => {
                              e.preventDefault();
                              if (dragIndex !== null) handleReorderDimension(dragIndex, index);
                              clearDragState();
                            }}
                            onDragEnd={clearDragState}
                            className={cn(
                              "ui-rise-in group flex items-center gap-1.5 rounded-md p-1.5 transition-colors duration-150 hover:bg-[var(--interactive-hover)] motion-reduce:transition-none",
                              dragIndex === index && "opacity-40",
                              isDropTarget && "bg-primary/5 ring-1 ring-primary/30"
                            )}
                          >
                            <button
                              type="button"
                              onPointerDown={() => setDragArmedIndex(index)}
                              onPointerUp={() => setDragArmedIndex(null)}
                              onPointerCancel={() => setDragArmedIndex(null)}
                              aria-label={t('essay_grading:settings_panel.drag_reorder')}
                              title={t('essay_grading:settings_panel.drag_reorder')}
                              className="flex-shrink-0 cursor-grab text-muted-foreground/30 opacity-0 transition-opacity duration-150 hover:text-muted-foreground active:cursor-grabbing group-focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none [@media(pointer:coarse)]:opacity-70"
                            >
                              <DotsSixVertical size={14} />
                            </button>
                            <Input
                              value={dim.name}
                              onChange={e => handleUpdateDimension(index, 'name', e.target.value)}
                              placeholder={t('settings:gradingMode.placeholderDimensionName')}
                              className={cn(
                                "h-7 min-w-0 flex-1 border-0 bg-transparent px-1 text-sm font-medium focus-visible:ring-0",
                                showValidation && issue.name && "rounded-sm ring-1 ring-destructive/50"
                              )}
                            />
                            <div className="flex flex-shrink-0 items-center gap-1">
                              <span className="text-[10px] text-muted-foreground/50">{t('settings:gradingMode.labelScore')}</span>
                              <Input
                                type="number"
                                value={dim.max_score}
                                onChange={e => handleUpdateDimension(index, 'max_score', Number(e.target.value))}
                                className={cn(
                                  "h-7 w-[3.5rem] rounded-sm border-0 bg-muted/30 px-1.5 text-right text-sm text-foreground focus-visible:ring-0 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
                                  showValidation && issue.score && "ring-1 ring-destructive/50"
                                )}
                                min={0}
                                style={{ maxWidth: '3.5rem' }}
                              />
                            </div>
                            <NotionButton
                              variant="ghost"
                              size="icon"
                              iconOnly
                              onClick={() => handleRemoveDimension(index)}
                              className="!h-6 !w-6 flex-shrink-0 text-muted-foreground/30 opacity-0 hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 [@media(pointer:coarse)]:opacity-70"
                              aria-label={t('essay_grading:settings_panel.remove_dimension')}
                              title={t('essay_grading:settings_panel.remove_dimension')}
                            >
                              <Trash size={12} />
                            </NotionButton>
                          </div>
                        );
                      })}
                    </div>
                    <NotionButton
                      variant="ghost"
                      size="sm"
                      onClick={handleAddDimension}
                      className="group !h-auto w-full !justify-start !px-1 !py-1.5 text-xs text-muted-foreground hover:text-primary"
                    >
                      <div className="flex h-4 w-4 items-center justify-center rounded-full border border-dashed border-muted-foreground/50 group-hover:border-primary">
                        <Plus size={10} />
                      </div>
                      {t('settings:gradingMode.addDimension')}
                    </NotionButton>
                  </div>

                  {/* 总分设置 */}
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-muted-foreground/60">
                      {t('settings:gradingMode.labelTotalScore')}
                    </label>
                    <div className="space-y-2 rounded-lg border border-border/30 bg-muted/20 p-2.5">
                      <div className="flex items-center gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-medium">{t('settings:gradingMode.maxScoreLimit')}</div>
                          <div className="truncate text-[10px] text-muted-foreground">{t('settings:gradingMode.maxScoreLimitDesc')}</div>
                        </div>
                        <Input
                          type="number"
                          value={formData.total_max_score}
                          onChange={e => setFormData(prev => ({
                            ...prev,
                            total_max_score: Number(e.target.value)
                          }))}
                          className={cn(
                            "h-7 w-[4rem] flex-shrink-0 rounded-md border border-[hsl(var(--border))] bg-background text-center text-sm text-foreground [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
                            showValidation && totalInvalid && "border-destructive/50"
                          )}
                          min={1}
                          style={{ maxWidth: '4rem' }}
                        />
                      </div>
                      {/* 总分与维度之和不一致：内联警告 + 一键同步 */}
                      {totalMismatch && (
                        <div className="ui-drop-in flex items-center justify-between gap-2 rounded-md bg-warning/10 px-2 py-1.5">
                          <span className="flex min-w-0 items-center gap-1.5 text-xs text-warning">
                            <WarningCircle size={14} className="flex-shrink-0" />
                            <span className="min-w-0">
                              {t('essay_grading:settings_panel.validation.total_mismatch', {
                                total: formData.total_max_score,
                                sum: calculatedTotal,
                              })}
                            </span>
                          </span>
                          <NotionButton
                            variant="ghost"
                            size="sm"
                            onClick={() => setFormData(prev => ({ ...prev, total_max_score: calculatedTotal }))}
                            className="!h-auto flex-shrink-0 !px-1.5 !py-0.5 text-[11px] text-primary hover:bg-primary/10"
                          >
                            {t('essay_grading:settings_panel.validation.sync_total', { sum: calculatedTotal })}
                          </NotionButton>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* 系统提示词 */}
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-muted-foreground/60">
                      {t('essay_grading:system_prompt_label')}
                    </label>
                    <div className="relative">
                      <Textarea
                        value={formData.system_prompt}
                        onChange={e => setFormData(prev => ({ ...prev, system_prompt: e.target.value }))}
                        ref={el => {
                          systemPromptTextareaRef.current = el;
                          if (el && !el.style.height) {
                            el.style.height = 'auto';
                            el.style.height = `${el.scrollHeight}px`;
                          }
                        }}
                        placeholder={t('settings:gradingMode.placeholderSystemPrompt')}
                        className="min-h-[160px] w-full resize-none overflow-hidden border-border/30 p-3 font-mono text-sm leading-relaxed focus-visible:ring-1 focus-visible:ring-primary/30"
                      />
                      <div data-wb-blur-surface className="pointer-events-none absolute bottom-2 right-2 rounded bg-background/50 px-1 text-[10px] text-muted-foreground/50 backdrop-blur-sm">
                        {t('settings:gradingMode.markdownSupported')}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              /* ---------- CRUD 操作入口 ---------- */
              <div className="space-y-1 px-4">
                {errorBanner}
                <NotionButton
                  variant="ghost"
                  size="sm"
                  onClick={() => currentMode && handleStartEdit(currentMode)}
                  disabled={!currentMode}
                  className="!h-8 w-full !justify-start !px-2 text-xs text-foreground/80 hover:bg-[var(--interactive-hover)] hover:text-foreground"
                >
                  <Pencil size={14} className="text-muted-foreground/60" />
                  {t('essay_grading:settings_panel.edit_current')}
                </NotionButton>
                <NotionButton
                  variant="ghost"
                  size="sm"
                  onClick={() => currentMode && handleCopyMode(currentMode)}
                  disabled={!currentMode}
                  className="!h-8 w-full !justify-start !px-2 text-xs text-foreground/80 hover:bg-[var(--interactive-hover)] hover:text-foreground"
                >
                  <Copy size={14} className="text-muted-foreground/60" />
                  {t('essay_grading:settings_panel.copy_current')}
                </NotionButton>
                <NotionButton
                  variant="ghost"
                  size="sm"
                  onClick={handleStartCreate}
                  className="!h-8 w-full !justify-start !px-2 text-xs text-foreground/80 hover:bg-[var(--interactive-hover)] hover:text-foreground"
                >
                  <Plus size={14} className="text-muted-foreground/60" />
                  {t('essay_grading:settings_panel.create_mode')}
                </NotionButton>
                {currentMode?.is_builtin && (
                  <NotionButton
                    variant={pendingConfirm === 'reset' ? 'destructive' : 'ghost'}
                    size="sm"
                    onClick={() => handleConfirmableClick('reset', currentMode)}
                    disabled={isLoading}
                    className={cn(
                      "!h-8 w-full !justify-start !px-2 text-xs",
                      pendingConfirm !== 'reset' && "text-foreground/80 hover:bg-[var(--interactive-hover)] hover:text-foreground"
                    )}
                  >
                    <ArrowCounterClockwise size={14} className={pendingConfirm === 'reset' ? undefined : "text-muted-foreground/60"} />
                    {pendingConfirm === 'reset'
                      ? t('essay_grading:settings_panel.confirm_reset')
                      : t('settings:gradingMode.menuReset')}
                  </NotionButton>
                )}
                {currentMode && !currentMode.is_builtin && (
                  <NotionButton
                    variant={pendingConfirm === 'delete' ? 'destructive' : 'ghost'}
                    size="sm"
                    onClick={() => handleConfirmableClick('delete', currentMode)}
                    disabled={isLoading}
                    className={cn(
                      "!h-8 w-full !justify-start !px-2 text-xs",
                      pendingConfirm !== 'delete' && "text-destructive/80 hover:bg-destructive/10 hover:text-destructive"
                    )}
                  >
                    <Trash size={14} />
                    {pendingConfirm === 'delete'
                      ? t('essay_grading:settings_panel.confirm_delete')
                      : t('settings:gradingMode.menuDelete')}
                  </NotionButton>
                )}
              </div>
            )}
          </CollapsibleSection>
        </div>
      </CustomScrollArea>
    </div>
  );
};
