import { unifiedAlert, unifiedConfirm } from '@/utils/unifiedDialogs';
/**
 * 批阅模式管理组件
 *
 * 支持增删改查所有批阅模式，包括预置模式
 * 风格：Notion-like
 */
import React, { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { NotionButton } from '@/components/ui/NotionButton';
import { Input } from '../ui/shad/Input';
import { Textarea } from '../ui/shad/Textarea';
import {
  Plus,
  Trash2,
  Copy,
  ChevronLeft,
  Check,
  RotateCcw,
  MoreHorizontal,
  GripVertical,
  AlertCircle
} from 'lucide-react';
import type {
  GradingMode,
  ScoreDimension,
  CreateModeInput,
  SaveBuiltinOverrideInput
} from '@/essay-grading/essayGradingApi';
import { CustomScrollArea } from '../custom-scroll-area';
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

interface GradingModeManagerProps {
  modes: GradingMode[];
  currentModeId: string;
  onModeSelect: (modeId: string) => void;
  onModesChange: () => void; // 模式变更后刷新列表
  onClose: () => void;
}

type ViewMode = 'list' | 'edit' | 'create';

export const GradingModeManager: React.FC<GradingModeManagerProps> = ({
  modes,
  currentModeId,
  onModeSelect,
  onModesChange,
  onClose,
}) => {
  const { t } = useTranslation(['essay_grading', 'settings', 'common']);
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [editingMode, setEditingMode] = useState<GradingMode | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // 表单状态
  const [formData, setFormData] = useState<{
    name: string;
    description: string;
    system_prompt: string;
    score_dimensions: ScoreDimension[];
    total_max_score: number;
  }>({
    name: '',
    description: '',
    system_prompt: '',
    score_dimensions: [],
    total_max_score: 100,
  });

  // 清除消息
  useEffect(() => {
    if (successMessage) {
      const timer = setTimeout(() => setSuccessMessage(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [successMessage]);

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
  }, []);

  // 开始编辑模式
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

  // 复制预置模式为自定义模式
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
        // 创建新模式
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
          // 编辑预置模式 -> 保存为覆盖
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
          // 更新自定义模式
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

      onModesChange();
      setViewMode('list');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('settings:gradingMode.errorOperationFailed'));
    } finally {
      setIsLoading(false);
    }
  }, [viewMode, formData, editingMode, onModesChange]);

  // 重置预置模式为默认配置
  const handleResetBuiltin = useCallback(async (mode: GradingMode) => {
    if (!mode.is_builtin) return;

    // TODO: replace unifiedConfirm with async AlertDialog
    if (!unifiedConfirm(t('settings:gradingMode.confirmReset', { name: mode.name }))) {
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      await resetBuiltinMode(mode.id);
      setSuccessMessage(t('settings:gradingMode.successReset'));
      onModesChange();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('settings:gradingMode.errorResetFailed'));
    } finally {
      setIsLoading(false);
    }
  }, [onModesChange]);

  // 删除模式
  const handleDelete = useCallback(async (mode: GradingMode) => {
    if (mode.is_builtin) {
      setError(t('settings:gradingMode.errorBuiltinCannotDelete'));
      return;
    }

    // TODO: replace unifiedConfirm with async AlertDialog
    if (!unifiedConfirm(t('settings:gradingMode.confirmDelete', { name: mode.name }))) {
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      await deleteCustomMode(mode.id);
      setSuccessMessage(t('settings:gradingMode.successDeleted'));
      onModesChange();

      // 如果删除的是当前选中的模式，切换到默认模式
      if (mode.id === currentModeId) {
        const defaultMode = modes.find(m => m.is_builtin);
        if (defaultMode) {
          onModeSelect(defaultMode.id);
        }
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('settings:gradingMode.errorDeleteFailed'));
    } finally {
      setIsLoading(false);
    }
  }, [modes, currentModeId, onModeSelect, onModesChange]);

  // 添加评分维度
  const handleAddDimension = useCallback(() => {
    setFormData(prev => ({
      ...prev,
      score_dimensions: [
        ...prev.score_dimensions,
        { name: '', max_score: 10, description: null },
      ],
    }));
  }, []);

  // 删除评分维度
  const handleRemoveDimension = useCallback((index: number) => {
    setFormData(prev => ({
      ...prev,
      score_dimensions: prev.score_dimensions.filter((_, i) => i !== index),
    }));
  }, []);

  // 更新评分维度
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

  // 计算总分
  const calculatedTotal = formData.score_dimensions.reduce(
    (sum, dim) => sum + (dim.max_score || 0),
    0
  );

  // ========== 列表视图 ==========
  if (viewMode === 'list') {
    return (
      <div className="h-full flex flex-col animate-in fade-in slide-in-from-right-4 duration-300">
        {/* 头部 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border/30">
          <NotionButton variant="ghost" size="sm" onClick={onClose} className="text-sm font-medium text-muted-foreground hover:text-foreground">
            <ChevronLeft className="w-4 h-4" />
            <span>{t('settings:gradingMode.backToSettings')}</span>
          </NotionButton>
        </div>

        <div className="flex items-center justify-between px-4 py-4">
          <h2 className="text-lg font-semibold tracking-tight text-foreground">
            {t('essay_grading:mode.manage')}
          </h2>
          <NotionButton
            size="sm"
            onClick={handleStartCreate}
            className="h-8 text-xs bg-primary/10 text-primary hover:bg-primary/20 border-none"
            disabled={isLoading}
          >
            <Plus className="w-3.5 h-3.5 mr-1" />
            {t('essay_grading:mode.create')}
          </NotionButton>
        </div>

        {/* 消息提示 */}
        {error && (
          <div className="mx-4 mb-3 p-3 bg-destructive/10 text-destructive rounded-md flex items-center gap-2 text-sm">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            {error}
          </div>
        )}
        {successMessage && (
          <div className="mx-4 mb-3 p-3 bg-green-500/10 text-green-600 rounded-md flex items-center gap-2 text-sm">
            <Check className="w-4 h-4 flex-shrink-0" />
            {successMessage}
          </div>
        )}

        {/* 模式列表 */}
        <CustomScrollArea className="flex-1" viewportClassName="px-4 pb-4">
          <div className="space-y-1">
            {modes.map(mode => (
              <div
                key={mode.id}
                className={cn(
                  "group relative flex items-start gap-2.5 p-3 rounded-lg transition-all duration-200 border cursor-pointer",
                  mode.id === currentModeId
                    ? "bg-primary/5 border-primary/20 shadow-sm"
                    : "border-transparent hover:bg-muted/50 hover:border-border/30"
                )}
                onClick={() => handleStartEdit(mode)}
              >
                {/* 模式信息（点击进入编辑） */}
                <div className="flex-1 min-w-0 pr-6">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={cn(
                      "font-medium text-sm truncate",
                      mode.id === currentModeId ? "text-primary" : "text-foreground"
                    )}>
                      {mode.name}
                    </span>
                    {mode.is_builtin && (
                      <Badge variant="secondary" className="text-[10px] px-1 h-4 font-normal text-muted-foreground bg-muted/80">
                        {t('settings:gradingMode.badgeBuiltin')}
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground/70 line-clamp-2 leading-relaxed">
                    {mode.description}
                  </p>
                  <div className="flex items-center gap-3 mt-2 text-[10px] text-muted-foreground/50">
                    <span className="bg-muted/30 px-1.5 py-0.5 rounded">{t('settings:gradingMode.maxScore', { score: mode.total_max_score })}</span>
                    <span className="bg-muted/30 px-1.5 py-0.5 rounded">{t('settings:gradingMode.dimensionCount', { count: mode.score_dimensions.length })}</span>
                  </div>
                </div>

                {/* 右侧：更多操作菜单 */}
                <div className="absolute right-2 top-3 opacity-0 group-hover:opacity-100 transition-opacity focus-within:opacity-100">
                  <AppMenu>
                    <AppMenuTrigger asChild>
                      <NotionButton variant="ghost" size="icon" iconOnly className="!h-6 !w-6 text-muted-foreground/50 hover:text-foreground hover:bg-muted" aria-label="more" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
                        <MoreHorizontal className="w-4 h-4" />
                      </NotionButton>
                    </AppMenuTrigger>
                    <AppMenuContent align="end" width={128}>
                      <AppMenuItem icon={<Copy className="w-4 h-4" />} onClick={() => handleCopyMode(mode)}>
                        {t('settings:gradingMode.menuCopy')}
                      </AppMenuItem>
                      {mode.is_builtin ? (
                        <>
                          <AppMenuSeparator />
                          <AppMenuItem icon={<RotateCcw className="w-4 h-4" />} onClick={() => handleResetBuiltin(mode)}>
                            {t('settings:gradingMode.menuReset')}
                          </AppMenuItem>
                        </>
                      ) : (
                        <>
                          <AppMenuSeparator />
                          <AppMenuItem icon={<Trash2 className="w-4 h-4" />} onClick={() => handleDelete(mode)} destructive>
                            {t('settings:gradingMode.menuDelete')}
                          </AppMenuItem>
                        </>
                      )}
                    </AppMenuContent>
                  </AppMenu>
                </div>
              </div>
            ))}
          </div>
        </CustomScrollArea>
      </div>
    );
  }

  // ========== 编辑/创建视图 ==========
  return (
    <div className="h-full flex flex-col animate-in fade-in slide-in-from-right-4 duration-300">
      {/* 头部 */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border/30">
        <NotionButton variant="ghost" size="icon" iconOnly onClick={() => setViewMode('list')} className="!h-8 !w-8 text-muted-foreground hover:text-foreground hover:bg-muted/50 -ml-2" aria-label="back">
          <ChevronLeft className="w-4 h-4" />
        </NotionButton>
        <h2 className="text-base font-medium">
          {viewMode === 'create'
            ? t('essay_grading:mode.create')
            : t('essay_grading:mode.edit')
          }
        </h2>
        <div className="ml-auto flex items-center gap-2">
           <NotionButton
            variant="ghost"
            size="sm"
            onClick={handleSave}
            disabled={isLoading}
            className="text-primary hover:text-primary hover:bg-primary/10 h-8 px-3"
          >
             {isLoading ? t('settings:gradingMode.saving') : t('settings:gradingMode.done')}
          </NotionButton>
        </div>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="mx-4 mt-3 p-3 bg-destructive/10 text-destructive rounded-md flex items-center gap-2 text-sm">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* 表单内容 */}
      <CustomScrollArea className="flex-1" viewportClassName="p-4 space-y-6">
        {/* 基本信息 - Notion 风格无边框 Input */}
        <div className="space-y-4">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide px-1">
              {t('settings:gradingMode.labelBasicInfo')}
            </label>
            <Input
              value={formData.name}
              onChange={e => setFormData(prev => ({ ...prev, name: e.target.value }))}
              placeholder={t('settings:gradingMode.placeholderModeName')}
              className="text-lg font-medium px-1 border-0 border-b border-border/30 rounded-none shadow-none focus-visible:ring-0 focus-visible:border-primary bg-transparent"
            />
            <Input
              value={formData.description}
              onChange={e => setFormData(prev => ({ ...prev, description: e.target.value }))}
              placeholder={t('settings:gradingMode.placeholderDescription')}
              className="text-sm px-1 border-0 border-b border-border/30 rounded-none shadow-none focus-visible:ring-0 focus-visible:border-primary bg-transparent text-muted-foreground focus:text-foreground"
            />
          </div>
        </div>

        {/* 评分维度 */}
        <div className="space-y-2">
          <div className="flex items-center justify-between px-1">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
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
                className="group flex items-center gap-2 p-2 rounded-md hover:bg-muted/40 transition-colors border border-transparent hover:border-border/30"
              >
                <GripVertical className="w-4 h-4 text-muted-foreground/30 group-hover:text-muted-foreground cursor-grab opacity-0 group-hover:opacity-100 transition-opacity" />
                <Input
                  value={dim.name}
                  onChange={e => handleUpdateDimension(index, 'name', e.target.value)}
                  placeholder={t('settings:gradingMode.placeholderDimensionName')}
                  className="flex-1 min-w-0 h-7 text-sm border-0 bg-transparent focus-visible:ring-0 px-0 font-medium"
                />
                <div className="flex items-center gap-1 flex-shrink-0">
                  <span className="text-xs text-muted-foreground/50">{t('settings:gradingMode.labelScore')}</span>
                  <input
                    type="number"
                    value={dim.max_score}
                    onChange={e => handleUpdateDimension(index, 'max_score', Number(e.target.value))}
                    className="w-[3.5rem] h-7 text-sm text-right border-0 bg-muted/30 focus-visible:ring-0 rounded-sm px-1.5 text-foreground [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    min={0}
                    style={{ maxWidth: '3.5rem' }}
                  />
                </div>
                <NotionButton variant="ghost" size="icon" iconOnly onClick={() => handleRemoveDimension(index)} className="!h-7 !w-7 text-muted-foreground/30 hover:text-destructive hover:bg-destructive/10 opacity-0 group-hover:opacity-100" aria-label="remove">
                  <Trash2 className="w-3.5 h-3.5" />
                </NotionButton>
              </div>
            ))}
          </div>

          <NotionButton variant="ghost" size="sm" onClick={handleAddDimension} className="!justify-start !px-1 !py-2 !h-auto text-sm text-muted-foreground hover:text-primary w-full group">
            <div className="h-5 w-5 rounded-full border border-dashed border-muted-foreground/50 group-hover:border-primary flex items-center justify-center">
              <Plus className="w-3 h-3" />
            </div>
            {t('settings:gradingMode.addDimension')}
          </NotionButton>
        </div>

        {/* 总分设置 */}
        <div className="px-1 pt-2">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide block mb-2">
            {t('settings:gradingMode.labelTotalScore')}
          </label>
          <div className="flex items-center gap-3 bg-muted/20 p-3 rounded-lg border border-border/30">
            <div className="flex-1">
              <div className="text-sm font-medium">{t('settings:gradingMode.maxScoreLimit')}</div>
              <div className="text-xs text-muted-foreground">{t('settings:gradingMode.maxScoreLimitDesc')}</div>
            </div>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                value={formData.total_max_score}
                onChange={e => setFormData(prev => ({
                  ...prev,
                  total_max_score: Number(e.target.value)
                }))}
                className="w-16 h-8 text-sm text-center bg-background"
                min={1}
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
        <div className="px-1 pt-2">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide block mb-2">
            {t('essay_grading:system_prompt_label')}
          </label>
          <div className="relative group">
            <div
              className="relative min-h-[200px] rounded-lg bg-muted/20 border border-border/30 focus-within:ring-1 focus-within:ring-primary/30"
            >
              <Textarea
                value={formData.system_prompt}
                onChange={e => {
                  setFormData(prev => ({ ...prev, system_prompt: e.target.value }));
                  // Auto resize
                  const target = e.target;
                  target.style.height = 'auto';
                  target.style.height = `${target.scrollHeight}px`;
                }}
                ref={el => {
                   // Initial resize on mount/update
                   if (el) {
                     el.style.height = 'auto';
                     el.style.height = `${el.scrollHeight}px`;
                   }
                }}
                placeholder={t('settings:gradingMode.placeholderSystemPrompt')}
                className="w-full h-auto min-h-[200px] text-sm font-mono leading-relaxed bg-transparent border-none resize-none p-3 focus-visible:ring-0 shadow-none overflow-hidden"
              />
            </div>
            <div className="absolute right-2 bottom-2 text-[10px] text-muted-foreground/50 bg-background/50 px-1 rounded backdrop-blur-sm pointer-events-none">
              {t('settings:gradingMode.markdownSupported')}
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground mt-2 leading-relaxed">
            {t('settings:gradingMode.systemPromptHintPrefix')} <code className="bg-muted/50 px-1 rounded text-[10px]">{'{{essay}}'}</code> {t('settings:gradingMode.systemPromptHintSuffix')}
          </p>
        </div>
      </CustomScrollArea>
    </div>
  );
};
