/**
 * Skills Management - 技能编辑器
 *
 * 支持创建和编辑技能，包含基本信息和内容两个标签页
 * 支持 embeddedMode 用于移动端三屏布局
 */

import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { NotionDialog } from '../ui/NotionDialog';
import { Input } from '../ui/shad/Input';
import { NotionButton } from '@/components/ui/NotionButton';
import { Switch } from '../ui/shad/Switch';
import { Label } from '../ui/shad/Label';
import { Textarea } from '../ui/shad/Textarea';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../ui/shad/Tabs';
import TagInput from '../ui/shad/TagInput';
import { CustomScrollArea } from '../custom-scroll-area';
import { FileText, Gear, X, Wrench } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { unifiedConfirm } from '@/utils/unifiedDialogs';
import { showGlobalNotification } from '../UnifiedNotification';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import type { SkillDefinition, SkillLocation, SkillType, ToolSchema } from '@/features/chat/skills/types';
import { SKILL_DEFAULT_PRIORITY } from '@/features/chat/skills/types';
import { EmbeddedToolsEditor } from './EmbeddedToolsEditor';
import { SkillPackageSummary } from './SkillPackageSummary';

// ============================================================================
// 类型定义
// ============================================================================

export interface SkillEditorModalProps {
  /** 是否打开 */
  open: boolean;
  /** 关闭回调 */
  onOpenChange: (open: boolean) => void;
  /** 编辑模式时传入已有技能 */
  skill?: SkillDefinition;
  /** 技能来源位置 */
  location: SkillLocation;
  /** 保存回调 */
  onSave: (data: SkillFormData) => Promise<void>;
  /** 嵌入模式：不使用 Dialog 包裹（用于移动端） */
  embeddedMode?: boolean;
  /**
   * 嵌入模式下暴露「带脏检查的关闭」入口（供页面顶栏返回箭头调用）。
   * 挂载时填充、卸载时清空。
   */
  requestCloseRef?: React.MutableRefObject<(() => void) | null>;
}

export interface SkillFormData {
  /** 技能 ID（仅创建时需要） */
  id: string;
  /** 名称 */
  name: string;
  /** 描述 */
  description: string;
  /** 版本 */
  version?: string;
  /** 作者 */
  author?: string;
  /** 优先级 */
  priority: number;
  /** 禁用自动激活 */
  disableAutoInvoke: boolean;
  /** 技能类型 */
  skillType: SkillType;
  /** 关联技能（结构化） */
  relatedSkills?: string[];
  /** 依赖技能（结构化） */
  dependencies?: string[];
  /** Legacy allowed-tools metadata; preserved for package compatibility only. */
  allowedTools?: string[];
  /** Markdown 内容 */
  content: string;
  /** 内嵌工具定义（渐进披露架构） */
  embeddedTools?: ToolSchema[];
}

// ============================================================================
// 验证函数
// ============================================================================

interface ValidationErrors {
  id?: string;
  name?: string;
  description?: string;
}

function normalizeSkillIdList(ids?: string[]): string[] {
  const next: string[] = [];
  for (const id of ids ?? []) {
    const normalized = id.trim();
    if (!normalized) continue;
    if (!next.includes(normalized)) {
      next.push(normalized);
    }
  }
  return next;
}

function serializeFormData(data: SkillFormData): string {
  return JSON.stringify({
    ...data,
    relatedSkills: normalizeSkillIdList(data.relatedSkills),
    dependencies: normalizeSkillIdList(data.dependencies),
    allowedTools: normalizeSkillIdList(data.allowedTools),
  });
}

function validateForm(
  data: SkillFormData,
  isEdit: boolean,
  isBuiltinSkill: boolean,
  t: (key: string, ...args: unknown[]) => string
): ValidationErrors {
  const errors: ValidationErrors = {};

  const trimmedId = data.id.trim();
  const trimmedName = data.name.trim();
  const trimmedDesc = data.description.trim();

  // ID 验证（仅创建模式，与后端目录/元数据要求保持一致）
  if (!isEdit) {
    if (!trimmedId) {
      errors.id = t('skills:validation.id_required');
    } else if (!/^[a-z0-9-]+$/.test(trimmedId)) {
      errors.id = t('skills:validation.id_invalid');
    } else if (trimmedId.length > 64) {
      errors.id = t('skills:validation.id_invalid');
    }
  }

  // 名称验证
  // 支持中英文等自然语言名称，仅限制长度并过滤保留字
  if (!trimmedName) {
    errors.name = t('skills:validation.name_required');
  } else if (trimmedName.length > 64) {
    errors.name = t('skills:validation.name_too_long');
  } else if (!isBuiltinSkill) {
    if (/(deep-student|deepstudent)/i.test(trimmedName)) {
      errors.name = t('skills:validation.name_reserved');
    }
  }

  // 描述验证（后端上限 1024）
  if (!trimmedDesc) {
    errors.description = t('skills:validation.description_required');
  } else if (trimmedDesc.length > 1024) {
    errors.description = t('skills:validation.description_too_long');
  }

  return errors;
}

// ============================================================================
// 组件
// ============================================================================

export const SkillEditorModal: React.FC<SkillEditorModalProps> = ({
  open,
  onOpenChange,
  skill,
  location,
  onSave,
  embeddedMode = false,
  requestCloseRef,
}) => {
  const { t } = useTranslation(['skills', 'common']);
  const isEdit = Boolean(skill);
  const dialogHeight = 'min(88vh, 760px)';
  const dialogMaxHeight = 'min(90vh, 800px)';

  // 表单状态
  const [formData, setFormData] = useState<SkillFormData>(() => ({
    id: skill?.id ?? '',
    name: skill?.name ?? '',
    description: skill?.description ?? '',
    version: skill?.version ?? '',
    author: skill?.author ?? '',
    priority: skill?.priority ?? SKILL_DEFAULT_PRIORITY,
    disableAutoInvoke: skill?.disableAutoInvoke ?? false,
    skillType: skill?.skillType ?? 'standalone',
    relatedSkills: normalizeSkillIdList(skill?.relatedSkills),
    dependencies: normalizeSkillIdList(skill?.dependencies),
    allowedTools: normalizeSkillIdList(skill?.allowedTools),
    content: skill?.content ?? '',
    embeddedTools: skill?.embeddedTools ?? [],
  }));

  const [errors, setErrors] = useState<ValidationErrors>({});
  const [isSaving, setIsSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<string>('basic');
  const initialSnapshotRef = useRef<string>(serializeFormData(formData));

  // Refs for auto-grow textareas in embedded mode
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const contentRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow textarea helper
  const autoGrow = useCallback((textarea: HTMLTextAreaElement | null) => {
    if (!textarea || !embeddedMode) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [embeddedMode]);

  // Auto-grow on content change
  useEffect(() => {
    if (embeddedMode) {
      autoGrow(descriptionRef.current);
    }
  }, [formData.description, embeddedMode, autoGrow]);

  useEffect(() => {
    if (embeddedMode) {
      autoGrow(contentRef.current);
    }
  }, [formData.content, embeddedMode, autoGrow]);

  // 当 skill prop 变化时，同步更新表单数据（修复编辑时数据不更新的问题）
  useEffect(() => {
    const nextFormData: SkillFormData = {
      id: skill?.id ?? '',
      name: skill?.name ?? '',
      description: skill?.description ?? '',
      version: skill?.version ?? '',
      author: skill?.author ?? '',
      priority: skill?.priority ?? SKILL_DEFAULT_PRIORITY,
      disableAutoInvoke: skill?.disableAutoInvoke ?? false,
      skillType: skill?.skillType ?? 'standalone',
      relatedSkills: normalizeSkillIdList(skill?.relatedSkills),
      dependencies: normalizeSkillIdList(skill?.dependencies),
      allowedTools: normalizeSkillIdList(skill?.allowedTools),
      content: skill?.content ?? '',
      embeddedTools: skill?.embeddedTools ?? [],
    };
    setFormData(nextFormData);
    initialSnapshotRef.current = serializeFormData(nextFormData);
    setErrors({});
    setActiveTab('basic');
  }, [skill]);

  const isDirty = useMemo(() => serializeFormData(formData) !== initialSnapshotRef.current, [formData]);

  // 更新字段
  const updateField = useCallback(<K extends keyof SkillFormData>(
    field: K,
    value: SkillFormData[K]
  ) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    // 清除该字段的错误
    if (errors[field as keyof ValidationErrors]) {
      setErrors((prev) => ({ ...prev, [field]: undefined }));
    }
  }, [errors]);

  // 判断是否为内置技能
  const isBuiltinSkill = skill?.isBuiltin === true;

  // 处理保存
  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();

    // 验证（内置技能放宽 name 格式验证）
    const validationErrors = validateForm(formData, isEdit, isBuiltinSkill, t as any);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      // 如果基本信息有错误，切换到基本信息标签
      if (validationErrors.id || validationErrors.name || validationErrors.description) {
        setActiveTab('basic');
      }
      return;
    }

    const trimmedPayload = {
      ...formData,
      id: formData.id.trim(),
      name: formData.name.trim(),
      description: formData.description.trim(),
      version: formData.version?.trim(),
      author: formData.author?.trim(),
      skillType: formData.skillType,
      relatedSkills: normalizeSkillIdList(formData.relatedSkills),
      dependencies: normalizeSkillIdList(formData.dependencies),
      allowedTools: normalizeSkillIdList(formData.allowedTools),
      content: formData.content.trim(),
      embeddedTools: formData.embeddedTools,
    };

    setIsSaving(true);
    try {
      await onSave(trimmedPayload);
      initialSnapshotRef.current = serializeFormData(trimmedPayload);
      onOpenChange(false);
    } catch (error) {
      console.error('[SkillEditor] 保存失败:', error);
      // 操作闭环：保存失败必须有可见反馈（成功通知由 onSave 内部发出）
      showGlobalNotification(
        'error',
        t('skills:management.save_failed'),
        String(error),
      );
    } finally {
      setIsSaving(false);
    }
  }, [formData, isEdit, isBuiltinSkill, onSave, onOpenChange, t]);

  // 处理取消
  const handleCancel = useCallback(() => {
    if (isDirty && !unifiedConfirm(t('skills:editor.unsaved_changes_confirm'))) {
      return;
    }
    onOpenChange(false);
  }, [isDirty, onOpenChange, t]);

  // 保持最新的取消逻辑，供返回键 / 页面顶栏返回箭头调用（注册保持稳定）
  const handleCancelRef = useRef(handleCancel);
  handleCancelRef.current = handleCancel;

  // 嵌入模式（移动端子屏）：
  // 1. Android 返回键 = 带脏检查的取消。注册在 MobileSlidingLayout 的
  //    overlay handler 之后（同优先级后注册者先执行），否则滑动布局会先
  //    收回右屏、绕过未保存更改确认。
  // 2. 向页面暴露 requestCloseRef，顶栏返回箭头复用同一取消逻辑。
  useEffect(() => {
    if (!embeddedMode || !open) return;
    const unregister = registerBackHandler(() => {
      handleCancelRef.current();
      return true;
    }, BACK_PRIORITY.overlay);
    if (requestCloseRef) {
      requestCloseRef.current = () => handleCancelRef.current();
    }
    return () => {
      unregister();
      if (requestCloseRef) {
        requestCloseRef.current = null;
      }
    };
  }, [embeddedMode, open, requestCloseRef]);

  const handleModalOpenChange = useCallback((nextOpen: boolean) => {
    if (!nextOpen && isDirty && !unifiedConfirm(t('skills:editor.unsaved_changes_confirm'))) {
      return;
    }
    onOpenChange(nextOpen);
  }, [isDirty, onOpenChange, t]);

  // 根据名称生成建议 ID
  const suggestId = useCallback(() => {
    if (isEdit) return;
    const suggested = formData.name
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9_-]/g, '')
      .slice(0, 32);
    if (suggested && !formData.id) {
      updateField('id', suggested);
    }
  }, [formData.name, formData.id, isEdit, updateField]);

  // 表单内容
  const formContent = (
    <form
      onSubmit={handleSubmit}
      className={cn(
        'flex h-full flex-col min-h-0 overflow-hidden bg-gradient-to-b from-background via-background to-background/98',
        embeddedMode && 'h-full'
      )}
    >
      {/* 头部：标题 + 关闭按钮 */}
      {!embeddedMode && (
        <div className="flex-none flex items-center justify-between px-4 pt-4 pb-2">
          <h2 className="text-lg font-semibold text-foreground">
            {isEdit
              ? t('skills:management.edit')
              : t('skills:management.create')}
          </h2>
          <NotionButton
            type="button"
            variant="ghost"
            size="icon"
            onClick={handleCancel}
 className="w-8 h-8 rounded-full text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]"
          >
            <X size={18} />
          </NotionButton>
        </div>
      )}

      {/* 标签页 */}
      <Tabs
        value={activeTab}
        onValueChange={setActiveTab}
        className="flex-1 flex flex-col min-h-0"
      >
        <div className="flex-none px-4 pt-3 border-b border-border/20 bg-gradient-to-b from-background/80 to-background">
          <TabsList className="bg-muted/20 border border-border/30 rounded-xl px-1.5 py-1 h-auto gap-2 shadow-sm">
            <TabsTrigger
              value="basic"
              className="max-lg:min-h-11 data-[state=active]:bg-background data-[state=active]:shadow-sm data-[state=active]:border-border/50 data-[state=active]:text-foreground border border-transparent rounded-lg px-3 py-2 transition-colors font-medium text-muted-foreground text-sm hover:text-foreground/80"
            >
              <Gear size={14} className="mr-1.5" />
              {t('skills:editor.tab_basic')}
            </TabsTrigger>
            <TabsTrigger
              value="content"
              className="max-lg:min-h-11 data-[state=active]:bg-background data-[state=active]:shadow-sm data-[state=active]:border-border/50 data-[state=active]:text-foreground border border-transparent rounded-lg px-3 py-2 transition-colors font-medium text-muted-foreground text-sm hover:text-foreground/80"
            >
              <FileText size={14} className="mr-1.5" />
              {t('skills:editor.tab_content')}
            </TabsTrigger>
            <TabsTrigger
              value="tools"
              className="max-lg:min-h-11 data-[state=active]:bg-background data-[state=active]:shadow-sm data-[state=active]:border-border/50 data-[state=active]:text-foreground border border-transparent rounded-lg px-3 py-2 transition-colors font-medium text-muted-foreground text-sm hover:text-foreground/80"
            >
              <Wrench size={14} className="mr-1.5" />
              {t('skills:editor.tab_tools')}
              {formData.embeddedTools && formData.embeddedTools.length > 0 && (
                <span className="ml-1.5 text-[10px] bg-primary/20 text-primary px-1.5 py-0.5 rounded-full">
                  {formData.embeddedTools.length}
                </span>
              )}
            </TabsTrigger>
          </TabsList>
        </div>

        <CustomScrollArea
          className="flex-1 min-h-0"
          viewportClassName="pr-2 pb-10"
        >
          <div className="p-4">
            {/* 基本信息标签 */}
            <TabsContent value="basic" className="mt-0 space-y-4 focus-visible:outline-none">
              {/* ID 字段（仅创建模式） */}
              {!isEdit && (
                <div className="space-y-2">
                  <Label className="text-xs font-medium text-muted-foreground/80 uppercase tracking-wider">
                    {t('skills:editor.id')} *
                  </Label>
                  <Input
                    value={formData.id}
                    onChange={(e) => updateField('id', (e.target as HTMLInputElement).value)}
                    placeholder={t('skills:editor.id_placeholder')}
                    className={cn(
                      'bg-muted/30 border-transparent hover:border-border/50 focus:border-primary/30 focus:bg-background transition-colors h-10',
                      errors.id && 'border-destructive'
                    )}
/>
                  {errors.id && (
                    <p className="text-xs text-destructive">{errors.id}</p>
                  )}
                  <p className="text-[10px] text-muted-foreground/60">
                    {t('skills:editor.id_hint')}
                  </p>
                </div>
              )}

              {/* 名称 */}
              <div className="space-y-2">
                <Label className="text-xs font-medium text-muted-foreground/80 uppercase tracking-wider">
                  {t('skills:editor.name')} *
                </Label>
                {skill && (
                  <SkillPackageSummary skill={skill} variant="editor" />
                )}
                <Input
                  value={formData.name}
                  onChange={(e) => updateField('name', (e.target as HTMLInputElement).value)}
                  onBlur={suggestId}
                  placeholder={t('skills:editor.name_placeholder')}
                  className={cn(
                    'bg-muted/30 border-transparent hover:border-border/50 focus:border-primary/30 focus:bg-background transition-colors h-10',
                    errors.name && 'border-destructive'
                  )}
/>
                {errors.name && (
                  <p className="text-xs text-destructive">{errors.name}</p>
                )}
              </div>

              {/* 描述 */}
              <div className="space-y-2">
                <Label className="text-xs font-medium text-muted-foreground/80 uppercase tracking-wider">
                  {t('skills:editor.description')} *
                </Label>
                <Textarea
                  ref={descriptionRef}
                  value={formData.description}
                  onChange={(e) => {
                    updateField('description', (e.target as HTMLTextAreaElement).value);
                    if (embeddedMode) autoGrow(e.target as HTMLTextAreaElement);
                  }}
                  placeholder={t('skills:editor.description_placeholder')}
                  rows={embeddedMode ? undefined : 2}
                  className={cn(
                    'bg-muted/30 border-transparent hover:border-border/50 focus:border-primary/30 focus:bg-background transition-colors',
                    embeddedMode ? 'overflow-hidden resize-none min-h-[80px]' : 'resize-none',
                    errors.description && 'border-destructive'
                  )}
/>
                {errors.description && (
                  <p className="text-xs text-destructive">{errors.description}</p>
                )}
                <p className="text-[10px] text-muted-foreground/60 text-right">
                  {formData.description.length}/1024
                </p>
              </div>

              {/* 版本和作者 */}
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label className="text-xs font-medium text-muted-foreground/80 uppercase tracking-wider">
                    {t('skills:editor.version')}
                  </Label>
                  <Input
                    value={formData.version}
                    onChange={(e) => updateField('version', (e.target as HTMLInputElement).value)}
                    placeholder="1.0.0"
                    className="bg-muted/30 border-transparent hover:border-border/50 focus:border-primary/30 focus:bg-background transition-colors h-10"
/>
                </div>
                <div className="space-y-2">
                  <Label className="text-xs font-medium text-muted-foreground/80 uppercase tracking-wider">
                    {t('skills:editor.author')}
                  </Label>
                  <Input
                    value={formData.author}
                    onChange={(e) => updateField('author', (e.target as HTMLInputElement).value)}
                    placeholder={t('skills:editor.author_placeholder')}
                    className="bg-muted/30 border-transparent hover:border-border/50 focus:border-primary/30 focus:bg-background transition-colors h-10"
/>
                </div>
              </div>

              {/* 优先级 */}
              <div className="space-y-2">
                <Label className="text-xs font-medium text-muted-foreground/80 uppercase tracking-wider">
                  {t('skills:editor.priority')}
                </Label>
                <Input
                  type="number"
                  min={1}
                  max={10}
                  value={formData.priority}
                  onChange={(e) => {
                    const value = parseInt((e.target as HTMLInputElement).value, 10);
                    if (!isNaN(value)) {
                      updateField('priority', Math.max(1, Math.min(10, value)));
                    }
                  }}
                  className="bg-muted/30 border-transparent hover:border-border/50 focus:border-primary/30 focus:bg-background transition-colors h-10 w-24"
/>
                <p className="text-[10px] text-muted-foreground/60">
                  {t('skills:editor.priority_hint')}
                </p>
              </div>

              {/* 组合关系 */}
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label className="text-xs font-medium text-muted-foreground/80 uppercase tracking-wider">
                    {t('skills:editor.skill_type')}
                  </Label>
                  <div className="grid grid-cols-2 gap-2">
                    <NotionButton
                      type="button"
                      variant={formData.skillType === 'standalone' ? 'default' : 'ghost'}
                      onClick={() => updateField('skillType', 'standalone')}
                      className="w-full"
                    >
                      {t('skills:editor.skill_type_standalone')}
                    </NotionButton>
                    <NotionButton
                      type="button"
                      variant={formData.skillType === 'composite' ? 'default' : 'ghost'}
                      onClick={() => updateField('skillType', 'composite')}
                      className="w-full"
                    >
                      {t('skills:editor.skill_type_composite')}
                    </NotionButton>
                  </div>
                  <p className="text-[10px] text-muted-foreground/60">
                    {t('skills:editor.skill_type_hint')}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label className="text-xs font-medium text-muted-foreground/80 uppercase tracking-wider">
                    {t('skills:editor.dependencies')}
                  </Label>
                  <TagInput
                    value={formData.dependencies ?? []}
                    onChange={(next) => updateField('dependencies', next)}
                    placeholder={t('skills:editor.skill_list_placeholder')}
/>
                  <p className="text-[10px] text-muted-foreground/60">
                    {t('skills:editor.dependencies_hint')}
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-xs font-medium text-muted-foreground/80 uppercase tracking-wider">
                  {t('skills:editor.related_skills')}
                </Label>
                <TagInput
                  value={formData.relatedSkills ?? []}
                  onChange={(next) => updateField('relatedSkills', next)}
                  placeholder={t('skills:editor.skill_list_placeholder')}
/>
                <p className="text-[10px] text-muted-foreground/60">
                  {t('skills:editor.related_skills_hint')}
                </p>
              </div>

              {/* 禁用自动激活 */}
              <div className="flex items-center justify-between p-4 rounded-xl border border-border/40 hover:border-border/60 transition-colors">
                <div className="space-y-1">
                  <Label className="text-sm font-medium cursor-pointer">
                    {t('skills:editor.disable_auto_invoke')}
                  </Label>
                  <p className="text-xs text-muted-foreground/70">
                    {t('skills:editor.disable_auto_invoke_hint')}
                  </p>
                </div>
                <Switch
                  checked={formData.disableAutoInvoke}
                  onCheckedChange={(checked) => updateField('disableAutoInvoke', checked)}
/>
              </div>
            </TabsContent>

            {/* 内容标签 */}
            <TabsContent value="content" className="mt-0 focus-visible:outline-none h-full flex flex-col">
              <div className="space-y-2 flex-1 flex flex-col min-h-0">
                <Label className="text-xs font-medium text-muted-foreground/80 uppercase tracking-wider flex-none">
                  {t('skills:editor.content')}
                </Label>
                <Textarea
                  ref={contentRef}
                  value={formData.content}
                  onChange={(e) => {
                    updateField('content', (e.target as HTMLTextAreaElement).value);
                    if (embeddedMode) autoGrow(e.target as HTMLTextAreaElement);
                  }}
                  placeholder={t('skills:editor.content_placeholder')}
                  className={cn(
                    'bg-muted/30 border-transparent hover:border-border/50 focus:border-primary/30 focus:bg-background transition-colors font-mono text-sm',
                    embeddedMode ? 'overflow-hidden resize-none min-h-[200px]' : 'resize-none flex-1 min-h-[300px]'
                  )}
/>
                <p className="text-[10px] text-muted-foreground/60 flex-none">
                  {t('skills:editor.content_hint')}
                </p>
              </div>
            </TabsContent>

            {/* 绑定工具标签 */}
            <TabsContent value="tools" className="mt-0 focus-visible:outline-none">
              <EmbeddedToolsEditor
                tools={formData.embeddedTools || []}
                onChange={(tools) => updateField('embeddedTools', tools)}
/>
            </TabsContent>
          </div>
        </CustomScrollArea>
      </Tabs>

      {/* 底部按钮 */}
      <div
        data-wb-blur-surface
        className="flex-none px-4 pt-3 border-t border-border/40 flex items-center justify-end gap-2 bg-gradient-to-t from-background via-background/95 to-background/80 backdrop-blur supports-[backdrop-filter]:backdrop-blur-md"
        style={{
          paddingBottom: embeddedMode
            ? 'calc(var(--android-safe-area-bottom, env(safe-area-inset-bottom, 0px)) + 16px)'
            : '14px',
        }}
      >
        <NotionButton
          type="button"
          variant="ghost"
          onClick={handleCancel}
          disabled={isSaving}
          className="hover:bg-[var(--interactive-hover)] text-muted-foreground hover:text-foreground"
        >
          {t('common:actions.cancel')}
        </NotionButton>
        <NotionButton
          type="submit"
          disabled={isSaving}
          className="min-w-[100px] shadow-md hover:shadow-lg transition-colors"
        >
          {isSaving
            ? t('common:actions.saving')
            : t('common:actions.save')}
        </NotionButton>
      </div>
    </form>
  );

  // 嵌入模式：直接返回表单内容
  if (embeddedMode) {
    return (
      <div className="h-full flex flex-col bg-background">
        {formContent}
      </div>
    );
  }

  // 模态框模式：使用 Dialog 包裹
  return (
    <NotionDialog
      open={open}
      onOpenChange={handleModalOpenChange}
      closeOnOverlay={false}
      showClose={false}
      maxWidth="max-w-[640px]"
      className="p-0 overflow-hidden"
    >
      {formContent}
    </NotionDialog>
  );
};

export default SkillEditorModal;
