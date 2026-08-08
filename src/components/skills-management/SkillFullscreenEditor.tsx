/**
 * Skills Management - 页面内全区技能编辑器
 *
 * 从卡片位置扩展到覆盖整个技能页面的内联编辑视图（absolute 于页面容器内，
 * 不逃出 OS 窗口），使用 CodeMirror 编辑指令内容
 */

import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion';
import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { EditorView } from '@codemirror/view';
import { vscodeDark, vscodeLight } from '@uiw/codemirror-theme-vscode';
import { Input } from '../ui/shad/Input';
import { DsButton } from '@/components/ui/DsButton';
import { Label } from '../ui/shad/Label';
import { Textarea } from '../ui/shad/Textarea';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../ui/shad/Tabs';
import TagInput from '../ui/shad/TagInput';
import { CustomScrollArea } from '../custom-scroll-area';
import { X } from '@phosphor-icons/react';
import { HorizontalResizable } from '../shared/Resizable';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { cn } from '@/lib/utils';
import { unifiedConfirm } from '@/utils/unifiedDialogs';
import { showGlobalNotification } from '../UnifiedNotification';
import type { SkillDefinition, SkillLocation, SkillType, ToolSchema } from '@/features/chat/skills/types';
import { SKILL_DEFAULT_PRIORITY } from '@/features/chat/skills/types';
import { EmbeddedToolsEditor } from './EmbeddedToolsEditor';
import { CodeMirrorScrollOverlay } from './CodeMirrorScrollOverlay';
import { SkillPackageSummary } from './SkillPackageSummary';
import './SkillFullscreenEditor.css';

// ============================================================================
// 类型定义
// ============================================================================

export interface SkillFormData {
  id: string;
  name: string;
  description: string;
  version?: string;
  author?: string;
  priority: number;
  disableAutoInvoke: boolean;
  skillType: SkillType;
  relatedSkills?: string[];
  dependencies?: string[];
  allowedTools?: string[];
  content: string;
  embeddedTools?: ToolSchema[];
}

export interface SkillFullscreenEditorProps {
  /** 是否打开 */
  open: boolean;
  /** 关闭回调 */
  onClose: () => void;
  /** 编辑模式时传入已有技能 */
  skill?: SkillDefinition;
  /** 技能来源位置 */
  location: SkillLocation;
  /** 保存回调 */
  onSave: (data: SkillFormData) => Promise<void>;
  /** 卡片原始位置（用于动画） */
  originRect?: DOMRect | null;
  /** 主题模式 */
  theme?: 'light' | 'dark';
}

interface ValidationErrors {
  id?: string;
  name?: string;
  description?: string;
}

// ============================================================================
// 验证函数
// ============================================================================

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

  if (!isEdit) {
    if (!trimmedId) {
      errors.id = t('skills:validation.id_required');
    } else if (!/^[a-z0-9-]+$/.test(trimmedId)) {
      errors.id = t('skills:validation.id_invalid');
    } else if (trimmedId.length > 64) {
      errors.id = t('skills:validation.id_invalid');
    }
  }

  if (!trimmedName) {
    errors.name = t('skills:validation.name_required');
  } else if (trimmedName.length > 64) {
    errors.name = t('skills:validation.name_too_long');
  } else if (!isBuiltinSkill) {
    if (/(deep-student|deepstudent)/i.test(trimmedName)) {
      errors.name = t('skills:validation.name_reserved');
    }
  }

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

export const SkillFullscreenEditor: React.FC<SkillFullscreenEditorProps> = ({
  open,
  onClose,
  skill,
  location,
  onSave,
  originRect,
  theme = 'dark',
}) => {
  const { t } = useTranslation(['skills', 'common']);
  const isEdit = Boolean(skill);
  const containerRef = useRef<HTMLDivElement>(null);
  const cmContainerRef = useRef<HTMLDivElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);

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
  // 动画完成状态 - 用于延迟渲染重量级组件
  const [isAnimationComplete, setIsAnimationComplete] = useState(false);

  // fallback: 如果 onLayoutAnimationComplete 未触发（无 layoutId 或 spring 未收敛），300ms 后强制渲染
  useEffect(() => {
    if (open && !isAnimationComplete) {
      const timer = setTimeout(() => setIsAnimationComplete(true), 300);
      return () => clearTimeout(timer);
    }
  }, [open, isAnimationComplete]);

  // 自动调整描述 Textarea 高度
  useEffect(() => {
    const textarea = descriptionRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${textarea.scrollHeight}px`;
    }
  }, [formData.description, open]);

  // 当 skill prop 变化时，同步更新表单数据
  useEffect(() => {
    if (open) {
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
        allowedTools: normalizeSkillIdList(skill?.allowedTools),
        content: skill?.content ?? '',
        embeddedTools: skill?.embeddedTools ?? [],
      });
      initialSnapshotRef.current = serializeFormData({
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
      });
      setErrors({});
      setActiveTab('basic');
      // 重置动画状态
      setIsAnimationComplete(false);
    }
  }, [skill, open]);

  const isDirty = useMemo(() => serializeFormData(formData) !== initialSnapshotRef.current, [formData]);

  // 更新字段
  const updateField = useCallback(<K extends keyof SkillFormData>(
    field: K,
    value: SkillFormData[K]
  ) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    if (errors[field as keyof ValidationErrors]) {
      setErrors((prev) => ({ ...prev, [field]: undefined }));
    }
  }, [errors]);

  const isBuiltinSkill = skill?.isBuiltin === true;

  // 处理保存
  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();

    const validationErrors = validateForm(formData, isEdit, isBuiltinSkill, t as any);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
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
      onClose();
    } catch (error) {
      console.error('[SkillFullscreenEditor] 保存失败:', error);
      // 操作闭环：保存失败必须有可见反馈（成功通知由 onSave 内部发出）
      showGlobalNotification(
        'error',
        t('skills:management.save_failed'),
        String(error),
      );
    } finally {
      setIsSaving(false);
    }
  }, [formData, isEdit, isBuiltinSkill, onSave, onClose, t]);

  const handleCloseRequest = useCallback(() => {
    if (isDirty && !unifiedConfirm(t('skills:editor.unsaved_changes_confirm'))) {
      return;
    }
    onClose();
  }, [isDirty, onClose, t]);

  useEventRegistry(open ? [
    {
      target: 'window',
      type: 'keydown',
      listener: ((e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          handleCloseRequest();
        }
      }) as EventListener,
    },
  ] : [], [open, handleCloseRequest]);

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

  // 当前编辑的技能 ID（用于 layoutId）
  const layoutId = skill?.id ? `skill-card-${skill.id}` : undefined

  // CodeMirror 扩展
  const extensions = useMemo(() => [markdown(), EditorView.lineWrapping], []);
  const editorTheme = theme === 'dark' ? vscodeDark : vscodeLight;

  return (
    <AnimatePresence mode="wait">
      {open && (
        <motion.div
          ref={containerRef}
          layoutId={layoutId}
          className="absolute inset-0 z-30 bg-background overflow-hidden"
          style={{ willChange: 'transform' }}
          initial={{ opacity: layoutId ? 1 : 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: layoutId ? 1 : 0 }}
          transition={{
            layout: { type: 'spring', stiffness: 350, damping: 28 },
            opacity: { duration: 0.1 },
          }}
          onLayoutAnimationComplete={() => setIsAnimationComplete(true)}
        >
          <form onSubmit={handleSubmit} className="h-full flex flex-col">
            {/* 顶部工具栏 */}
            <div className="flex-none flex items-center justify-between px-5 py-2 border-b border-border/20 bg-background sm:px-6 lg:px-7">
              <h2 className="text-sm font-medium text-foreground/80 truncate">
                {isEdit ? formData.name || skill?.id : t('skills:editor.new_skill')}
              </h2>
              <DsButton
                type="button"
                variant="ghost"
                size="icon"
                onClick={handleCloseRequest}
                aria-label={t('common:actions.close')}
              >
                <X size={18} />
              </DsButton>
            </div>
            <div className="flex-1 min-h-0">
            <HorizontalResizable
              initial={0.4}
              minLeft={0.3}
              minRight={0.4}
              className="h-full"
              left={
              <motion.div
                className="h-full w-full flex flex-col"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.1 }}
              >
                <CustomScrollArea className="flex-1">
                  <div className="space-y-4 px-5 py-5 sm:px-6 sm:py-6 lg:px-7 lg:py-7">
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
                        onChange={(e) => updateField('description', (e.target as HTMLTextAreaElement).value)}
                        placeholder={t('skills:editor.description_placeholder')}
                        className={cn(
                          'bg-muted/30 border-transparent hover:border-border/50 focus:border-primary/30 focus:bg-background transition-colors resize-none min-h-[80px] overflow-hidden',
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
                    <div className="grid gap-4 grid-cols-2">
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

                    {/* 优先级 + 技能类型 */}
                    <div className="grid gap-4 grid-cols-2">
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
                      <div className="space-y-2">
                        <Label className="text-xs font-medium text-muted-foreground/80 uppercase tracking-wider">
                          {t('skills:editor.skill_type')}
                        </Label>
                        <div className="grid grid-cols-2 gap-2">
                          <DsButton
                            type="button"
                            variant={formData.skillType === 'standalone' ? 'default' : 'ghost'}
                            onClick={() => updateField('skillType', 'standalone')}
                            className="w-full"
                          >
                            {t('skills:editor.skill_type_standalone')}
                          </DsButton>
                          <DsButton
                            type="button"
                            variant={formData.skillType === 'composite' ? 'default' : 'ghost'}
                            onClick={() => updateField('skillType', 'composite')}
                            className="w-full"
                          >
                            {t('skills:editor.skill_type_composite')}
                          </DsButton>
                        </div>
                        <p className="text-[10px] text-muted-foreground/60">
                          {t('skills:editor.skill_type_hint')}
                        </p>
                      </div>
                    </div>

                    {/* 依赖技能 */}
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

                    {/* 绑定工具 */}
                    <div className="pt-4 border-t border-border/20">
                      <EmbeddedToolsEditor
                        tools={formData.embeddedTools || []}
                        onChange={(tools) => updateField('embeddedTools', tools)}
/>
                    </div>
                  </div>
                </CustomScrollArea>

                {/* 左侧底部：操作按钮 */}
                <div className="flex-none px-5 py-4 border-t border-border/20 flex items-center gap-2 bg-background relative z-10 sm:px-6 lg:px-7">
                  <DsButton
                    type="button"
                    variant="ghost"
                    onClick={handleCloseRequest}
                    disabled={isSaving}
                    className="flex-1 hover:bg-[var(--interactive-hover)] text-muted-foreground hover:text-foreground"
                  >
                    {t('common:actions.cancel')}
                  </DsButton>
                  <DsButton
                    type="submit"
                    disabled={isSaving}
                    className="flex-1 shadow-md hover:shadow-lg transition-colors"
                  >
                    {isSaving
                      ? t('common:actions.saving')
                      : t('common:actions.save')}
                  </DsButton>
                </div>
              </motion.div>
              }
              right={
              <motion.div
                className="h-full w-full flex flex-col min-w-0"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.15 }}
              >
                <div ref={cmContainerRef} className="flex-1 min-h-0 overflow-hidden relative">
                  {isAnimationComplete ? (
                    <>
                      <CodeMirror
                        value={formData.content}
                        onChange={(value) => updateField('content', value)}
                        extensions={extensions}
                        theme={editorTheme}
                        height="100%"
                        className="h-full skill-codemirror-editor"
                        basicSetup={{
                          lineNumbers: true,
                          highlightActiveLineGutter: true,
                          highlightActiveLine: true,
                          foldGutter: true,
                          dropCursor: true,
                          allowMultipleSelections: true,
                          indentOnInput: true,
                          bracketMatching: true,
                          closeBrackets: true,
                          autocompletion: true,
                          rectangularSelection: true,
                          crosshairCursor: false,
                          highlightSelectionMatches: true,
                        }}
/>
                      <CodeMirrorScrollOverlay containerRef={cmContainerRef} />
                    </>
                  ) : (
                    // 动画期间显示轻量占位符
                    <div className="h-full flex items-center justify-center bg-muted/20">
                      <div className="text-muted-foreground/50 text-sm">
                        {t('common:loading')}
                      </div>
                    </div>
                  )}
                </div>
              </motion.div>
              }
/>
            </div>
          </form>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default SkillFullscreenEditor;
