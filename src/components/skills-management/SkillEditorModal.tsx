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
import { FileText, Settings, X, Wrench } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MOBILE_LAYOUT } from '@/config/mobileLayout';
import type { SkillDefinition, SkillLocation, SkillType, ToolSchema } from '@/chat-v2/skills/types';
import { SKILL_DEFAULT_PRIORITY } from '@/chat-v2/skills/types';
import { EmbeddedToolsEditor } from './EmbeddedToolsEditor';

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

/** Name 格式正则：只允许小写字母、数字、连字符（遵循 SKILL.md 规范） */
const NAME_PATTERN = /^[a-z0-9-]+$/;

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
      errors.id = t('skills:validation.id_required', '请输入技能 ID');
    } else if (!/^[a-z0-9-]+$/.test(trimmedId)) {
      errors.id = t('skills:validation.id_invalid', '技能 ID 只能包含小写字母、数字和连字符（a-z, 0-9, -）');
    } else if (trimmedId.length > 64) {
      errors.id = t('skills:validation.id_invalid', '技能 ID 不能超过 64 个字符');
    }
  }

  // 名称验证
  // ★ 内置技能使用中文名称，放宽验证规则（只检查长度）
  // ★ 用户创建的技能仍遵循 SKILL.md 规范
  if (!trimmedName) {
    errors.name = t('skills:validation.name_required', '请输入技能名称');
  } else if (trimmedName.length > 64) {
    errors.name = t('skills:validation.name_too_long', '名称不能超过 64 个字符');
  } else if (!isBuiltinSkill) {
    // 仅对用户创建/编辑的非内置技能应用严格格式验证
    if (!NAME_PATTERN.test(trimmedName)) {
      errors.name = t('skills:validation.name_format', '名称只能包含小写字母、数字和连字符（a-z, 0-9, -）');
    } else if (/(deep-student|deepstudent)/i.test(trimmedName)) {
      errors.name = t('skills:validation.name_reserved', '名称不能包含 deep-student 等保留字');
    }
  }

  // 描述验证（后端上限 1024）
  if (!trimmedDesc) {
    errors.description = t('skills:validation.description_required', '请输入技能描述');
  } else if (trimmedDesc.length > 1024) {
    errors.description = t('skills:validation.description_too_long', '描述不能超过 1024 个字符');
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
    content: skill?.content ?? '',
    embeddedTools: skill?.embeddedTools ?? [],
  }));

  const [errors, setErrors] = useState<ValidationErrors>({});
  const [isSaving, setIsSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<string>('basic');

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
    setFormData({
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
      content: skill?.content ?? '',
      embeddedTools: skill?.embeddedTools ?? [],
    });
    setErrors({});
    setActiveTab('basic');
  }, [skill]);

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
      content: formData.content.trim(),
      embeddedTools: formData.embeddedTools,
    };

    setIsSaving(true);
    try {
      await onSave(trimmedPayload);
      onOpenChange(false);
    } catch (error) {
      console.error('[SkillEditor] 保存失败:', error);
    } finally {
      setIsSaving(false);
    }
  }, [formData, isEdit, isBuiltinSkill, onSave, onOpenChange, t]);

  // 处理取消
  const handleCancel = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

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
              ? t('skills:management.edit', '编辑技能')
              : t('skills:management.create', '新建技能')}
          </h2>
          <NotionButton
            type="button"
            variant="ghost"
            size="icon"
            onClick={handleCancel}
            className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted/50"
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
              className="data-[state=active]:bg-background data-[state=active]:shadow-sm data-[state=active]:border-border/50 data-[state=active]:text-foreground border border-transparent rounded-lg px-3 py-2 transition-all font-medium text-muted-foreground text-sm hover:text-foreground/80"
            >
              <Settings size={14} className="mr-1.5" />
              {t('skills:editor.tab_basic', '基本信息')}
            </TabsTrigger>
            <TabsTrigger
              value="content"
              className="data-[state=active]:bg-background data-[state=active]:shadow-sm data-[state=active]:border-border/50 data-[state=active]:text-foreground border border-transparent rounded-lg px-3 py-2 transition-all font-medium text-muted-foreground text-sm hover:text-foreground/80"
            >
              <FileText size={14} className="mr-1.5" />
              {t('skills:editor.tab_content', '技能内容')}
            </TabsTrigger>
            <TabsTrigger
              value="tools"
              className="data-[state=active]:bg-background data-[state=active]:shadow-sm data-[state=active]:border-border/50 data-[state=active]:text-foreground border border-transparent rounded-lg px-3 py-2 transition-all font-medium text-muted-foreground text-sm hover:text-foreground/80"
            >
              <Wrench size={14} className="mr-1.5" />
              {t('skills:editor.tab_tools', '绑定工具')}
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
                    {t('skills:editor.id', '技能 ID')} *
                  </Label>
                  <Input
                    value={formData.id}
                    onChange={(e) => updateField('id', (e.target as HTMLInputElement).value)}
                    placeholder={t('skills:editor.id_placeholder', '例如：code-reviewer')}
                    className={cn(
                      'bg-muted/30 border-transparent hover:border-border/50 focus:border-primary/30 focus:bg-background transition-all h-10',
                      errors.id && 'border-destructive'
                    )}
                  />
                  {errors.id && (
                    <p className="text-xs text-destructive">{errors.id}</p>
                  )}
                  <p className="text-[10px] text-muted-foreground/60">
                    {t('skills:editor.id_hint', '只能包含字母、数字、连字符和下划线')}
                  </p>
                </div>
              )}

              {/* 名称 */}
              <div className="space-y-2">
                <Label className="text-xs font-medium text-muted-foreground/80 uppercase tracking-wider">
                  {t('skills:editor.name', '名称')} *
                </Label>
                <Input
                  value={formData.name}
                  onChange={(e) => updateField('name', (e.target as HTMLInputElement).value)}
                  onBlur={suggestId}
                  placeholder={t('skills:editor.name_placeholder', '小写字母/数字/连字符')}
                  className={cn(
                    'bg-muted/30 border-transparent hover:border-border/50 focus:border-primary/30 focus:bg-background transition-all h-10',
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
                  {t('skills:editor.description', '描述')} *
                </Label>
                <Textarea
                  ref={descriptionRef}
                  value={formData.description}
                  onChange={(e) => {
                    updateField('description', (e.target as HTMLTextAreaElement).value);
                    if (embeddedMode) autoGrow(e.target as HTMLTextAreaElement);
                  }}
                  placeholder={t('skills:editor.description_placeholder', '简要描述技能功能')}
                  rows={embeddedMode ? undefined : 2}
                  className={cn(
                    'bg-muted/30 border-transparent hover:border-border/50 focus:border-primary/30 focus:bg-background transition-all',
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
                    {t('skills:editor.version', '版本')}
                  </Label>
                  <Input
                    value={formData.version}
                    onChange={(e) => updateField('version', (e.target as HTMLInputElement).value)}
                    placeholder="1.0.0"
                    className="bg-muted/30 border-transparent hover:border-border/50 focus:border-primary/30 focus:bg-background transition-all h-10"
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-xs font-medium text-muted-foreground/80 uppercase tracking-wider">
                    {t('skills:editor.author', '作者')}
                  </Label>
                  <Input
                    value={formData.author}
                    onChange={(e) => updateField('author', (e.target as HTMLInputElement).value)}
                    placeholder={t('skills:editor.author_placeholder', '可选')}
                    className="bg-muted/30 border-transparent hover:border-border/50 focus:border-primary/30 focus:bg-background transition-all h-10"
                  />
                </div>
              </div>

              {/* 优先级 */}
              <div className="space-y-2">
                <Label className="text-xs font-medium text-muted-foreground/80 uppercase tracking-wider">
                  {t('skills:editor.priority', '优先级')}
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
                  className="bg-muted/30 border-transparent hover:border-border/50 focus:border-primary/30 focus:bg-background transition-all h-10 w-24"
                />
                <p className="text-[10px] text-muted-foreground/60">
                  {t('skills:editor.priority_hint', '1-10，数字越小优先级越高')}
                </p>
              </div>

              {/* 组合关系 */}
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label className="text-xs font-medium text-muted-foreground/80 uppercase tracking-wider">
                    {t('skills:editor.skill_type', '技能类型')}
                  </Label>
                  <div className="grid grid-cols-2 gap-2">
                    <NotionButton
                      type="button"
                      variant={formData.skillType === 'standalone' ? 'default' : 'ghost'}
                      onClick={() => updateField('skillType', 'standalone')}
                      className="w-full"
                    >
                      {t('skills:editor.skill_type_standalone', '独立')}
                    </NotionButton>
                    <NotionButton
                      type="button"
                      variant={formData.skillType === 'composite' ? 'default' : 'ghost'}
                      onClick={() => updateField('skillType', 'composite')}
                      className="w-full"
                    >
                      {t('skills:editor.skill_type_composite', '组合')}
                    </NotionButton>
                  </div>
                  <p className="text-[10px] text-muted-foreground/60">
                    {t('skills:editor.skill_type_hint', 'standalone=独立技能，composite=组合技能')}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label className="text-xs font-medium text-muted-foreground/80 uppercase tracking-wider">
                    {t('skills:editor.dependencies', '依赖技能')}
                  </Label>
                  <TagInput
                    value={formData.dependencies ?? []}
                    onChange={(next) => updateField('dependencies', next)}
                    placeholder={t('skills:editor.skill_list_placeholder', '用逗号分隔，例如 knowledge-retrieval, vfs-memory')}
                  />
                  <p className="text-[10px] text-muted-foreground/60">
                    {t('skills:editor.dependencies_hint', '硬依赖：激活此技能时自动加载')}
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-xs font-medium text-muted-foreground/80 uppercase tracking-wider">
                  {t('skills:editor.related_skills', '关联技能')}
                </Label>
                <TagInput
                  value={formData.relatedSkills ?? []}
                  onChange={(next) => updateField('relatedSkills', next)}
                  placeholder={t('skills:editor.skill_list_placeholder', '用逗号分隔，例如 knowledge-retrieval, vfs-memory')}
                />
                <p className="text-[10px] text-muted-foreground/60">
                  {t('skills:editor.related_skills_hint', '软关联：仅用于推荐，不会自动加载')}
                </p>
              </div>

              {/* 禁用自动激活 */}
              <div className="flex items-center justify-between p-4 rounded-xl border border-border/40 hover:border-border/60 transition-all">
                <div className="space-y-1">
                  <Label className="text-sm font-medium cursor-pointer">
                    {t('skills:editor.disable_auto_invoke', '禁用自动激活')}
                  </Label>
                  <p className="text-xs text-muted-foreground/70">
                    {t('skills:editor.disable_auto_invoke_hint', '开启后需手动激活此技能')}
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
                  {t('skills:editor.content', '指令内容')}
                </Label>
                <Textarea
                  ref={contentRef}
                  value={formData.content}
                  onChange={(e) => {
                    updateField('content', (e.target as HTMLTextAreaElement).value);
                    if (embeddedMode) autoGrow(e.target as HTMLTextAreaElement);
                  }}
                  placeholder={t('skills:editor.content_placeholder', '编写技能的详细指令...')}
                  className={cn(
                    'bg-muted/30 border-transparent hover:border-border/50 focus:border-primary/30 focus:bg-background transition-all font-mono text-sm',
                    embeddedMode ? 'overflow-hidden resize-none min-h-[200px]' : 'resize-none flex-1 min-h-[300px]'
                  )}
                />
                <p className="text-[10px] text-muted-foreground/60 flex-none">
                  {t('skills:editor.content_hint', '使用 Markdown 格式编写技能指令')}
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
        className="flex-none px-4 pt-3 border-t border-border/40 flex items-center justify-end gap-2 bg-gradient-to-t from-background via-background/95 to-background/80 backdrop-blur supports-[backdrop-filter]:backdrop-blur-md"
        style={{
          // 使用 CSS 变量作为 Android fallback
          paddingBottom: embeddedMode
            ? `calc(${MOBILE_LAYOUT.bottomTabBar.defaultHeight}px + var(--android-safe-area-bottom, env(safe-area-inset-bottom, 0px)) + 16px)`
            : '14px',
        }}
      >
        <NotionButton
          type="button"
          variant="ghost"
          onClick={handleCancel}
          disabled={isSaving}
          className="hover:bg-muted/50 text-muted-foreground hover:text-foreground"
        >
          {t('common:actions.cancel', '取消')}
        </NotionButton>
        <NotionButton
          type="submit"
          disabled={isSaving}
          className="min-w-[100px] shadow-md hover:shadow-lg transition-all"
        >
          {isSaving
            ? t('common:actions.saving', '保存中...')
            : t('common:actions.save', '保存')}
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
      onOpenChange={onOpenChange}
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
