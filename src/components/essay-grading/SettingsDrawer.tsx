/**
 * SettingsDrawer - 作文批改统一设置抽屉
 *
 * 扁平化设计：直接在设置面板中切换和编辑批阅模式，
 * 无需层层跳转到"管理模式 → 上下文菜单 → 编辑表单"。
 *
 * 功能：
 * - 快速切换批阅模式
 * - 内联编辑当前模式（维度/分值/提示词）
 * - 复制/重置/删除等操作
 * - 新建自定义模式
 * - 模型选择
 * - 自定义提示词编辑器
 */
import React, { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Textarea } from '../ui/shad/Textarea';
import { Input } from '../ui/shad/Input';
import {
  RotateCcw,
  Save,
  Settings2,
  X,
  ChevronRight,
  Plus,
  Trash2,
  Copy,
  Check,
  MoreHorizontal,
  GripVertical,
  AlertCircle,
  Pencil,
} from 'lucide-react';
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
import {
  AppMenu,
  AppMenuContent,
  AppMenuItem,
  AppMenuSeparator,
  AppMenuTrigger,
} from '@/components/ui/app-menu';
import { Badge } from '@/components/ui/shad/Badge';
import { unifiedConfirm } from '@/utils/unifiedDialogs';

interface SettingsDrawerProps {
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
  // 布局变体
  variant?: 'drawer' | 'panel';
}

type SettingsViewMode = 'view' | 'edit' | 'create';

interface FormData {
  name: string;
  description: string;
  system_prompt: string;
  score_dimensions: ScoreDimension[];
  total_max_score: number;
}

export const SettingsDrawer: React.FC<SettingsDrawerProps> = ({
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
  variant = 'drawer',
}) => {
  const { t } = useTranslation(['essay_grading', 'settings', 'common']);
  const [viewMode, setViewMode] = useState<SettingsViewMode>('view');
  const [editingMode, setEditingMode] = useState<GradingMode | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // 表单状态
  const [formData, setFormData] = useState<FormData>({
    name: '',
    description: '',
    system_prompt: '',
    score_dimensions: [],
    total_max_score: 100,
  });

  // 获取当前选中的批阅模式
  const currentMode = modes.find(m => m.id === modeId);

  // 获取默认模型
  const defaultModel = models.find(m => m.is_default);

  const isEditing = viewMode === 'edit' || viewMode === 'create';

  // 清除成功消息
  useEffect(() => {
    if (successMessage) {
      const timer = setTimeout(() => setSuccessMessage(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [successMessage]);

  // ========== 模式编辑操作 ==========

  // 开始编辑当前模式
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
  }, []);

  // 开始创建新模式
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
  }, [t]);

  // 复制模式为新模式
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
  }, [t]);

  // 取消编辑
  const handleCancelEdit = useCallback(() => {
    setViewMode('view');
    setEditingMode(null);
    setError(null);
  }, []);

  // 保存模式
  const handleSave = useCallback(async () => {
    if (!formData.name.trim()) {
      setError(t('settings:gradingMode.errorNameRequired'));
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      if (viewMode === 'create') {
        const input: CreateModeInput = {
          name: formData.name.trim(),
          description: formData.description.trim(),
          system_prompt: formData.system_prompt,
          score_dimensions: formData.score_dimensions,
          total_max_score: formData.total_max_score,
        };
        await createCustomMode(input);
        setSuccessMessage(t('settings:gradingMode.successCreated'));
      } else if (viewMode === 'edit' && editingMode) {
        if (editingMode.is_builtin) {
          const input: SaveBuiltinOverrideInput = {
            builtin_id: editingMode.id,
            name: formData.name.trim(),
            description: formData.description.trim(),
            system_prompt: formData.system_prompt,
            score_dimensions: formData.score_dimensions,
            total_max_score: formData.total_max_score,
          };
          await saveBuiltinOverride(input);
          setSuccessMessage(t('settings:gradingMode.successSaved'));
        } else {
          await updateCustomMode({
            id: editingMode.id,
            name: formData.name.trim(),
            description: formData.description.trim(),
            system_prompt: formData.system_prompt,
            score_dimensions: formData.score_dimensions,
            total_max_score: formData.total_max_score,
          });
          setSuccessMessage(t('settings:gradingMode.successUpdated'));
        }
      }

      onModesChange?.();
      setViewMode('view');
      setEditingMode(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('settings:gradingMode.errorOperationFailed'));
    } finally {
      setIsLoading(false);
    }
  }, [viewMode, formData, editingMode, onModesChange, t]);

  // 重置预置模式
  const handleResetBuiltin = useCallback(async (mode: GradingMode) => {
    if (!mode.is_builtin) return;
    if (!unifiedConfirm(t('settings:gradingMode.confirmReset', { name: mode.name }))) return;

    setIsLoading(true);
    setError(null);

    try {
      await resetBuiltinMode(mode.id);
      setSuccessMessage(t('settings:gradingMode.successReset'));
      onModesChange?.();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('settings:gradingMode.errorResetFailed'));
    } finally {
      setIsLoading(false);
    }
  }, [onModesChange, t]);

  // 删除自定义模式
  const handleDelete = useCallback(async (mode: GradingMode) => {
    if (mode.is_builtin) {
      setError(t('settings:gradingMode.errorBuiltinCannotDelete'));
      return;
    }
    if (!unifiedConfirm(t('settings:gradingMode.confirmDelete', { name: mode.name }))) return;

    setIsLoading(true);
    setError(null);

    try {
      await deleteCustomMode(mode.id);
      setSuccessMessage(t('settings:gradingMode.successDeleted'));
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

  const calculatedTotal = formData.score_dimensions.reduce(
    (sum, dim) => sum + (dim.max_score || 0),
    0
  );

  // 切换模式时退出编辑状态
  const handleModeSwitch = useCallback((newModeId: string) => {
    setModeId(newModeId);
    if (viewMode !== 'view') {
      setViewMode('view');
      setEditingMode(null);
      setError(null);
    }
  }, [setModeId, viewMode]);

  return (
    <div className={cn(
      "h-full flex flex-col bg-background",
      variant === 'drawer' && "border-l border-border/40"
    )}>
      {/* 头部 */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/30">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground/80">
          <Settings2 className="w-4 h-4" />
          <span>{t('essay_grading:settings.title')}</span>
        </div>
        <NotionButton variant="ghost" size="icon" iconOnly onClick={onClose} className="h-7 w-7 text-muted-foreground/60 hover:text-foreground hover:bg-muted/50" aria-label="close">
          <X className="w-4 h-4" />
        </NotionButton>
      </div>

      {/* 内容区 */}
      <CustomScrollArea className="flex-1" viewportClassName="p-4">
        {/* 消息提示 */}
        {error && (
          <div className="mb-3 p-3 bg-destructive/10 text-destructive rounded-md flex items-center gap-2 text-sm">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            {error}
          </div>
        )}
        {successMessage && (
          <div className="mb-3 p-3 bg-green-500/10 text-green-600 rounded-md flex items-center gap-2 text-sm">
            <Check className="w-4 h-4 flex-shrink-0" />
            {successMessage}
          </div>
        )}

        {/* ====== 模式区块 ====== */}
        <div className="mb-6 pb-4 border-b border-border/30">
          {/* 区块头部：标题 + 操作按钮 */}
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-medium text-muted-foreground/70 uppercase tracking-wide">
              {isEditing
                ? (viewMode === 'create'
                  ? t('essay_grading:mode.create')
                  : t('essay_grading:mode.edit'))
                : t('essay_grading:mode.current')
              }
            </h3>
            <div className="flex items-center gap-1">
              {isEditing ? (
                /* 编辑态：取消 + 完成 */
                <>
                  <NotionButton variant="ghost" size="sm" onClick={handleCancelEdit} className="h-7 px-2 text-xs text-muted-foreground/70 hover:text-foreground hover:bg-muted/50">
                    {t('essay_grading:actions.cancel')}
                  </NotionButton>
                  <NotionButton
                    variant="ghost"
                    size="sm"
                    onClick={handleSave}
                    disabled={isLoading}
                    className="text-primary hover:text-primary hover:bg-primary/10 h-7 px-2 text-xs"
                  >
                    {isLoading ? t('settings:gradingMode.saving') : t('settings:gradingMode.done')}
                  </NotionButton>
                </>
              ) : (
                /* 查看态：编辑 + 更多操作 */
                <>
                  {currentMode && (
                    <NotionButton variant="ghost" size="sm" onClick={() => handleStartEdit(currentMode)} className="h-7 px-2 text-xs text-muted-foreground/70 hover:text-foreground hover:bg-muted/50">
                      <Pencil className="w-3 h-3" />
                      {t('settings:gradingMode.menuEdit')}
                    </NotionButton>
                  )}
                  {currentMode && (
                    <AppMenu>
                      <AppMenuTrigger asChild>
                        <NotionButton variant="ghost" size="icon" iconOnly className="h-7 w-7 text-muted-foreground/50 hover:text-foreground hover:bg-muted/50" aria-label="more">
                          <MoreHorizontal className="w-4 h-4" />
                        </NotionButton>
                      </AppMenuTrigger>
                      <AppMenuContent align="end" width={128}>
                        <AppMenuItem icon={<Copy className="w-4 h-4" />} onClick={() => handleCopyMode(currentMode)}>
                          {t('settings:gradingMode.menuCopy')}
                        </AppMenuItem>
                        {currentMode.is_builtin ? (
                          <>
                            <AppMenuSeparator />
                            <AppMenuItem icon={<RotateCcw className="w-4 h-4" />} onClick={() => handleResetBuiltin(currentMode)}>
                              {t('settings:gradingMode.menuReset')}
                            </AppMenuItem>
                          </>
                        ) : (
                          <>
                            <AppMenuSeparator />
                            <AppMenuItem icon={<Trash2 className="w-4 h-4" />} onClick={() => handleDelete(currentMode)} destructive>
                              {t('settings:gradingMode.menuDelete')}
                            </AppMenuItem>
                          </>
                        )}
                      </AppMenuContent>
                    </AppMenu>
                  )}
                </>
              )}
            </div>
          </div>

          {/* 模式快速切换按钮 + 新建 */}
          <div className="flex flex-wrap gap-1.5 mb-4">
            {modes.map((mode) => (
              <NotionButton
                key={mode.id}
                variant="ghost" size="sm"
                onClick={() => handleModeSwitch(mode.id)}
                className={cn(
                  "!px-2.5 !py-1 !h-auto text-xs",
                  mode.id === modeId
                    ? "bg-primary/10 text-primary border border-primary/30"
                    : "bg-muted/50 text-foreground/70 hover:bg-muted hover:text-foreground"
                )}
              >
                {mode.name}
              </NotionButton>
            ))}
            {!isEditing && (
              <NotionButton variant="ghost" size="sm" onClick={handleStartCreate} className="!px-2 !py-1 !h-auto text-xs text-muted-foreground/50 hover:text-primary hover:bg-primary/5 border border-dashed border-muted-foreground/30 hover:border-primary/30">
                <Plus className="w-3 h-3" />
                {t('essay_grading:mode.create')}
              </NotionButton>
            )}
          </div>

          {/* 模式内容：查看态 or 编辑态 */}
          {isEditing ? (
            /* ========== 内联编辑表单 ========== */
            <div className="space-y-5 animate-in fade-in duration-200">
              {/* 基本信息 */}
              <div className="space-y-2">
                <label className="text-xs font-medium text-muted-foreground/60">
                  {t('settings:gradingMode.labelBasicInfo')}
                </label>
                <Input
                  value={formData.name}
                  onChange={e => setFormData(prev => ({ ...prev, name: e.target.value }))}
                  placeholder={t('settings:gradingMode.placeholderModeName')}
                  className="text-sm font-medium px-2 h-8 border-border/30 bg-transparent focus-visible:ring-1 focus-visible:ring-primary/30"
                />
                <Input
                  value={formData.description}
                  onChange={e => setFormData(prev => ({ ...prev, description: e.target.value }))}
                  placeholder={t('settings:gradingMode.placeholderDescription')}
                  className="text-sm px-2 h-8 border-border/30 bg-transparent text-muted-foreground focus:text-foreground focus-visible:ring-1 focus-visible:ring-primary/30"
                />
              </div>

              {/* 评分维度 */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-muted-foreground/60">
                    {t('settings:gradingMode.labelDimensions')}
                  </label>
                  <span className="text-xs text-muted-foreground bg-muted/50 px-2 py-0.5 rounded-full">
                    {t('settings:gradingMode.currentTotal', { total: calculatedTotal })}
                  </span>
                </div>
                <div className="space-y-1">
                  {formData.score_dimensions.map((dim, index) => (
                    <div
                      key={index}
                      className="group flex items-center gap-1.5 p-1.5 rounded-md hover:bg-muted/40 transition-colors"
                    >
                      <GripVertical className="w-3.5 h-3.5 text-muted-foreground/30 cursor-grab opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
                      <Input
                        value={dim.name}
                        onChange={e => handleUpdateDimension(index, 'name', e.target.value)}
                        placeholder={t('settings:gradingMode.placeholderDimensionName')}
                        className="flex-1 min-w-0 h-7 text-sm border-0 bg-transparent focus-visible:ring-0 px-1 font-medium"
                      />
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <span className="text-[10px] text-muted-foreground/50">{t('settings:gradingMode.labelScore')}</span>
                        <input
                          type="number"
                          value={dim.max_score}
                          onChange={e => handleUpdateDimension(index, 'max_score', Number(e.target.value))}
                          className="w-[3.5rem] h-7 text-sm text-right border-0 bg-muted/30 focus-visible:ring-0 rounded-sm px-1.5 text-foreground [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                          min={0}
                          style={{ maxWidth: '3.5rem' }}
                        />
                      </div>
                      <NotionButton variant="ghost" size="icon" iconOnly onClick={() => handleRemoveDimension(index)} className="!h-6 !w-6 text-muted-foreground/30 hover:text-destructive hover:bg-destructive/10 opacity-0 group-hover:opacity-100 flex-shrink-0" aria-label="remove">
                        <Trash2 className="w-3 h-3" />
                      </NotionButton>
                    </div>
                  ))}
                </div>
                <NotionButton variant="ghost" size="sm" onClick={handleAddDimension} className="!justify-start !px-1 !py-1.5 !h-auto text-xs text-muted-foreground hover:text-primary w-full group">
                  <div className="h-4 w-4 rounded-full border border-dashed border-muted-foreground/50 group-hover:border-primary flex items-center justify-center">
                    <Plus className="w-2.5 h-2.5" />
                  </div>
                  {t('settings:gradingMode.addDimension')}
                </NotionButton>
              </div>

              {/* 总分设置 */}
              <div className="space-y-2">
                <label className="text-xs font-medium text-muted-foreground/60">
                  {t('settings:gradingMode.labelTotalScore')}
                </label>
                <div className="flex items-center gap-3 bg-muted/20 p-2.5 rounded-lg border border-border/30">
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium">{t('settings:gradingMode.maxScoreLimit')}</div>
                    <div className="text-[10px] text-muted-foreground truncate">{t('settings:gradingMode.maxScoreLimitDesc')}</div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <input
                      type="number"
                      value={formData.total_max_score}
                      onChange={e => setFormData(prev => ({
                        ...prev,
                        total_max_score: Number(e.target.value)
                      }))}
                      className="w-[4rem] h-7 text-sm text-center bg-background rounded-md border border-[hsl(var(--border))] text-foreground [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                      min={1}
                      style={{ maxWidth: '4rem' }}
                    />
                    {formData.total_max_score !== calculatedTotal && (
                      <NotionButton variant="ghost" size="sm" onClick={() => setFormData(prev => ({ ...prev, total_max_score: calculatedTotal }))} className="!h-auto !p-0 text-[10px] text-primary hover:underline whitespace-nowrap">
                        {t('settings:gradingMode.useCalculatedTotal', { total: calculatedTotal })}
                      </NotionButton>
                    )}
                  </div>
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
                    onChange={e => {
                      setFormData(prev => ({ ...prev, system_prompt: e.target.value }));
                      const target = e.target;
                      target.style.height = 'auto';
                      target.style.height = `${target.scrollHeight}px`;
                    }}
                    ref={el => {
                      if (el) {
                        el.style.height = 'auto';
                        el.style.height = `${el.scrollHeight}px`;
                      }
                    }}
                    placeholder={t('settings:gradingMode.placeholderSystemPrompt')}
                    className="w-full min-h-[160px] text-sm font-mono leading-relaxed border-border/30 resize-none p-3 focus-visible:ring-1 focus-visible:ring-primary/30"
                  />
                  <div className="absolute right-2 bottom-2 text-[10px] text-muted-foreground/50 bg-background/50 px-1 rounded backdrop-blur-sm pointer-events-none">
                    {t('settings:gradingMode.markdownSupported')}
                  </div>
                </div>
                <p className="text-[10px] text-muted-foreground leading-relaxed">
                  {t('settings:gradingMode.systemPromptHintPrefix')} <code className="bg-muted/50 px-1 rounded text-[10px]">{'{{essay}}'}</code> {t('settings:gradingMode.systemPromptHintSuffix')}
                </p>
              </div>
            </div>
          ) : currentMode ? (
            /* ========== 只读模式信息 ========== */
            <div className="space-y-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm text-foreground/90">{currentMode.name}</span>
                  {currentMode.is_builtin && (
                    <Badge variant="secondary" className="text-[10px] px-1 h-4 font-normal text-muted-foreground bg-muted/80">
                      {t('settings:gradingMode.badgeBuiltin')}
                    </Badge>
                  )}
                </div>
                <div className="text-xs text-muted-foreground/70 mt-1 leading-relaxed">{currentMode.description}</div>
              </div>
              <div className="text-xs">
                <span className="text-muted-foreground/60">{t('essay_grading:mode.total_score')}：</span>
                <span className="font-medium text-foreground/80">{currentMode.total_max_score}</span>
              </div>
              {currentMode.score_dimensions && currentMode.score_dimensions.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-xs text-muted-foreground/60">{t('essay_grading:mode.dimensions')}：</div>
                  <div className="flex flex-wrap gap-1.5">
                    {currentMode.score_dimensions.map((dim, idx) => (
                      <span
                        key={idx}
                        className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-muted/50 text-foreground/70"
                      >
                        {dim.name}
                        <span className="ml-1 text-muted-foreground/50">({dim.max_score})</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : null}
        </div>

        {/* 模型选择 */}
        {models.length > 0 && (
          <div className="mb-6 pb-4 border-b border-border/30">
            <h3 className="text-xs font-medium text-muted-foreground/70 uppercase tracking-wide mb-3">
              {t('essay_grading:model.title')}
            </h3>
            <UnifiedModelSelector
              models={models}
              value={modelId || defaultModel?.id || ''}
              onChange={setModelId}
              disabled={isGrading}
              placeholder={t('essay_grading:model.select')}
            />
          </div>
        )}

        {/* 提示词编辑器 - 编辑模式时隐藏以避免与系统提示词混淆 */}
        {!isEditing && (
          <div className="mb-4">
            <h3 className="text-xs font-medium text-muted-foreground/70 uppercase tracking-wide mb-3">
              {t('essay_grading:prompt_editor.title')}
            </h3>
            <div className="space-y-4 flex flex-col">
              <Textarea
                value={customPrompt}
                onChange={(e) => setCustomPrompt(e.target.value)}
                placeholder={t('essay_grading:prompt_editor.placeholder')}
                className="flex-1 min-h-[240px] resize-none w-full text-sm border-border/40 focus:border-border/60"
              />
              <div className="flex gap-2 justify-end">
                <NotionButton variant="ghost" size="sm" onClick={onRestoreDefaultPrompt} className="text-sm text-muted-foreground/70 hover:text-foreground hover:bg-muted/50">
                  <RotateCcw className="w-3.5 h-3.5" />
                  {t('essay_grading:prompt_editor.restore_default')}
                </NotionButton>
                <NotionButton variant="primary" size="sm" onClick={() => { onSavePrompt(); onClose(); }} className="text-sm bg-primary/10 text-primary hover:bg-primary/20">
                  <Save className="w-3.5 h-3.5" />
                  {t('essay_grading:prompt_editor.save')}
                </NotionButton>
              </div>
            </div>
          </div>
        )}
      </CustomScrollArea>
    </div>
  );
};

/**
 * 设置按钮触发器
 */
interface SettingsButtonProps {
  onClick: () => void;
  isOpen: boolean;
  className?: string;
}

export const SettingsButton: React.FC<SettingsButtonProps> = ({
  onClick,
  isOpen,
  className,
}) => {
  const { t } = useTranslation(['essay_grading']);

  return (
    <NotionButton
      variant="ghost" size="sm"
      onClick={onClick}
      className={cn(
        "h-8 px-3 text-sm",
        isOpen
          ? "bg-primary/10 text-primary"
          : "text-muted-foreground/70 hover:text-foreground hover:bg-muted/50",
        className
      )}
    >
      <Settings2 className="w-4 h-4" />
      <span className="hidden md:inline">{t('essay_grading:settings.title')}</span>
      <ChevronRight className={cn(
        "w-3.5 h-3.5 transition-transform",
        isOpen && "rotate-180"
      )} />
    </NotionButton>
  );
};
