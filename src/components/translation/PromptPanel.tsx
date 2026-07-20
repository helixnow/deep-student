import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DsButton } from '@/components/ui/DsButton';
import { Textarea } from '../ui/shad/Textarea';
import { Input } from '../ui/shad/Input';
import { Badge } from '../ui/shad/Badge';
import { AppSelect } from '../ui/app-menu';
import { SegmentedControl } from '../ui/SegmentedControl';
import { Switch } from '../ui/shad/Switch';
import { Label } from '../ui/shad/Label';
import { showGlobalNotification } from '../UnifiedNotification';
import {
  FloppyDisk,
  ArrowCounterClockwise,
  Plus,
  X,
  Check,
  BookOpen,
  PencilSimple,
  BookmarkSimple,
} from '@phosphor-icons/react';
import { CustomScrollArea } from '../custom-scroll-area';
import { cn } from '@/lib/utils';

interface PromptPanelProps {
  customPrompt: string;
  setCustomPrompt: (prompt: string) => void;
  onSavePrompt: () => void;
  onRestoreDefaultPrompt: () => void;
  isOpen: boolean;
  setIsOpen: (isOpen: boolean) => void;
  formality: 'formal' | 'casual' | 'auto';
  setFormality: (formality: 'formal' | 'casual' | 'auto') => void;
  domain?: string;
  setDomain?: (domain: string) => void;
  glossary?: Array<[string, string]>;
  setGlossary?: (glossary: Array<[string, string]>) => void;
  mobileFullscreen?: boolean;
  isAutoTranslate?: boolean;
  setIsAutoTranslate?: (val: boolean) => void;
  isSyncScroll?: boolean;
  setIsSyncScroll?: (val: boolean) => void;
}

const DOMAIN_OPTIONS = [
  { value: 'general', labelKey: 'translation:prompt_editor.domain_general' },
  { value: 'academic', labelKey: 'translation:prompt_editor.domain_academic' },
  { value: 'technical', labelKey: 'translation:prompt_editor.domain_technical' },
  { value: 'literary', labelKey: 'translation:prompt_editor.domain_literary' },
  { value: 'legal', labelKey: 'translation:prompt_editor.domain_legal' },
  { value: 'medical', labelKey: 'translation:prompt_editor.domain_medical' },
  { value: 'casual', labelKey: 'translation:prompt_editor.domain_casual' },
];

/** 预设 Prompt 模板：labelKey 为按钮文案，promptKey 为实际提示词（LLM 指令，中英 locale 同文） */
const PRESET_TEMPLATES = [
  { id: 'general', labelKey: 'translation:prompt_panel.templates.general', promptKey: 'translation:prompt_editor.default_prompt' },
  { id: 'academic', labelKey: 'translation:prompt_panel.templates.academic', promptKey: 'translation:prompt_panel.template_prompts.academic' },
  { id: 'conversational', labelKey: 'translation:prompt_panel.templates.conversational', promptKey: 'translation:prompt_panel.template_prompts.conversational' },
  { id: 'technical', labelKey: 'translation:prompt_panel.templates.technical', promptKey: 'translation:prompt_panel.template_prompts.technical' },
  { id: 'literary', labelKey: 'translation:prompt_panel.templates.literary', promptKey: 'translation:prompt_panel.template_prompts.literary' },
];

const CUSTOM_TEMPLATES_STORAGE_KEY = 'translation.promptTemplates.v1';
const EXIT_ANIMATION_MS = 150; // 与 --dropdown-close-dur 对齐

interface CustomTemplate {
  id: string;
  name: string;
  prompt: string;
}

function readCustomTemplates(): CustomTemplate[] {
  try {
    const raw = window.localStorage.getItem(CUSTOM_TEMPLATES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is CustomTemplate =>
        !!item && typeof item.id === 'string' && typeof item.name === 'string' && typeof item.prompt === 'string',
    );
  } catch {
    return [];
  }
}

function writeCustomTemplates(templates: CustomTemplate[]) {
  try {
    window.localStorage.setItem(CUSTOM_TEMPLATES_STORAGE_KEY, JSON.stringify(templates));
  } catch {
    // localStorage 不可用时静默降级（模板仅在本次会话内有效）
  }
}

/** 分区外壳：小标题 + 说明 + 内容，适配内联紧凑布局 */
const PanelSection: React.FC<{
  title: string;
  hint?: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, hint, badge, children }) => (
  <section className="space-y-2">
    <div className="space-y-0.5">
      <div className="flex items-center gap-1.5">
        <h3 className="text-xs font-medium text-muted-foreground/70 uppercase tracking-wide">{title}</h3>
        {badge}
      </div>
      {hint && <p className="text-xs text-muted-foreground/60">{hint}</p>}
    </div>
    {children}
  </section>
);

/** 为每个术语生成稳定 key（兼容历史数据中的重复项） */
function buildGlossaryKeys(glossary: Array<[string, string]>): string[] {
  const seen = new Map<string, number>();
  return glossary.map(([src, tgt]) => {
    const base = `${src}\u0000${tgt}`;
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    return `${base}\u0000${occurrence}`;
  });
}

/** 术语表编辑器：去重添加、行内编辑、增删动画 */
const GlossaryEditor: React.FC<{
  glossary: Array<[string, string]>;
  setGlossary: (glossary: Array<[string, string]>) => void;
}> = ({ glossary, setGlossary }) => {
  const { t } = useTranslation(['translation']);
  const [newSrc, setNewSrc] = useState('');
  const [newTgt, setNewTgt] = useState('');
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<[string, string]>(['', '']);
  const [removingKeys, setRemovingKeys] = useState<Set<string>>(new Set());
  const removalTimersRef = useRef<number[]>([]);

  // 延迟删除期间 props 可能滞后，用 ref + 已删除 key 累积集保证最终一致
  const glossaryRef = useRef(glossary);
  glossaryRef.current = glossary;
  const firedRemovalsRef = useRef<Set<string>>(new Set());
  const pendingRemovalCountRef = useRef(0);

  const entryKeys = useMemo(() => buildGlossaryKeys(glossary), [glossary]);

  useEffect(() => {
    return () => {
      removalTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    };
  }, []);

  const handleAdd = () => {
    const src = newSrc.trim();
    const tgt = newTgt.trim();
    if (!src || !tgt) return;
    const existingIndex = glossary.findIndex(([s]) => s === src);
    if (existingIndex >= 0) {
      // 同名术语去重：直接更新译法，避免重复项进入后端
      const next = glossary.map(
        (entry, i): [string, string] => (i === existingIndex ? [src, tgt] : entry),
      );
      setGlossary(next);
      showGlobalNotification('success', t('translation:prompt_panel.glossary.duplicate_updated', { term: src }));
    } else {
      setGlossary([...glossary, [src, tgt]]);
    }
    setNewSrc('');
    setNewTgt('');
  };

  const handleRemove = (key: string) => {
    // 先播放退出动画，再真正从列表移除
    setRemovingKeys((prev) => new Set(prev).add(key));
    pendingRemovalCountRef.current += 1;
    const timer = window.setTimeout(() => {
      firedRemovalsRef.current.add(key);
      const latest = glossaryRef.current;
      const latestKeys = buildGlossaryKeys(latest);
      setGlossary(latest.filter((_, i) => !firedRemovalsRef.current.has(latestKeys[i])));
      pendingRemovalCountRef.current -= 1;
      if (pendingRemovalCountRef.current <= 0) {
        // 全部删除已落地后清空累积集，避免未来重新添加的同名同译术语被误过滤
        firedRemovalsRef.current.clear();
        pendingRemovalCountRef.current = 0;
      }
      setRemovingKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }, EXIT_ANIMATION_MS);
    removalTimersRef.current.push(timer);
  };

  const startEdit = (key: string, src: string, tgt: string) => {
    setEditingKey(key);
    setEditDraft([src, tgt]);
  };

  const commitEdit = () => {
    if (editingKey === null) return;
    const src = editDraft[0].trim();
    const tgt = editDraft[1].trim();
    if (!src || !tgt) return;
    const next = glossary
      .map((entry, i): [string, string] => (entryKeys[i] === editingKey ? [src, tgt] : entry))
      // 若改名后与其他已有术语撞名，移除旧的同名项（保留正在编辑的这条）
      .filter((entry, i) => entryKeys[i] === editingKey || entry[0] !== src);
    setGlossary(next);
    setEditingKey(null);
  };

  const cancelEdit = () => setEditingKey(null);

  const handleAddKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAdd();
    }
  };

  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelEdit();
    }
  };

  const compactInputClass = 'h-8 min-h-0 lg:min-h-0 px-2.5 text-sm';

  return (
    <div className="space-y-2">
      {/* 新增行 */}
      <div className="flex items-center gap-2 min-w-0">
        <Input
          value={newSrc}
          onChange={(e) => setNewSrc(e.target.value)}
          onKeyDown={handleAddKeyDown}
          placeholder={t('translation:prompt_editor.glossary_source')}
          className={cn('flex-1 min-w-0', compactInputClass)}
        />
        <span className="text-muted-foreground/40 text-xs shrink-0">→</span>
        <Input
          value={newTgt}
          onChange={(e) => setNewTgt(e.target.value)}
          onKeyDown={handleAddKeyDown}
          placeholder={t('translation:prompt_editor.glossary_target')}
          className={cn('flex-1 min-w-0', compactInputClass)}
        />
        <DsButton
          variant="ghost"
          size="icon"
          onClick={handleAdd}
          disabled={!newSrc.trim() || !newTgt.trim()}
          aria-label={t('translation:prompt_editor.glossary_add')}
          className="w-8 h-8 shrink-0 text-primary hover:bg-primary/10"
        >
          <Plus size={16} />
        </DsButton>
      </div>

      {/* 已添加的术语 */}
      {glossary.length === 0 ? (
        <p className="text-xs text-muted-foreground/40 italic text-center py-2">
          {t('translation:prompt_panel.glossary.empty')}
        </p>
      ) : (
        <div className="space-y-1">
          {glossary.map(([src, tgt], index) => {
            const entryKey = entryKeys[index];
            const isEditing = editingKey === entryKey;
            const isRemoving = removingKeys.has(entryKey);
            return (
              <div
                key={entryKey}
                className={cn(
                  'flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-muted/20 hover:bg-[var(--interactive-hover)] group',
                  'ui-rise-in transition-[opacity,transform] ease-[var(--dropdown-ease,cubic-bezier(0.22,1,0.36,1))] duration-[var(--dropdown-close-dur,150ms)]',
                  isRemoving && 'opacity-0 scale-[0.98] pointer-events-none',
                )}
              >
                {isEditing ? (
                  <>
                    <Input
                      value={editDraft[0]}
                      onChange={(e) => setEditDraft([e.target.value, editDraft[1]])}
                      onKeyDown={handleEditKeyDown}
                      autoFocus
                      className={cn('flex-1 min-w-0', compactInputClass, 'h-7')}
                    />
                    <span className="text-muted-foreground/40 text-xs shrink-0">→</span>
                    <Input
                      value={editDraft[1]}
                      onChange={(e) => setEditDraft([editDraft[0], e.target.value])}
                      onKeyDown={handleEditKeyDown}
                      className={cn('flex-1 min-w-0', compactInputClass, 'h-7')}
                    />
                    <DsButton
                      variant="ghost"
                      size="icon"
                      onClick={commitEdit}
                      disabled={!editDraft[0].trim() || !editDraft[1].trim()}
                      aria-label={t('translation:prompt_panel.glossary.confirm_edit')}
                      className="w-6 h-6 shrink-0 text-primary hover:bg-primary/10"
                    >
                      <Check size={14} />
                    </DsButton>
                    <DsButton
                      variant="ghost"
                      size="icon"
                      onClick={cancelEdit}
                      aria-label={t('translation:prompt_panel.glossary.cancel_edit')}
                      className="w-6 h-6 shrink-0 text-muted-foreground/60 hover:text-foreground"
                    >
                      <X size={14} />
                    </DsButton>
                  </>
                ) : (
                  <>
                    <span className="flex-1 text-sm truncate font-mono">{src}</span>
                    <span className="text-muted-foreground/40 text-xs shrink-0">→</span>
                    <span className="flex-1 text-sm truncate font-mono text-primary/80">{tgt}</span>
                    <DsButton
                      variant="ghost"
                      size="icon"
                      onClick={() => startEdit(entryKey, src, tgt)}
                      aria-label={t('translation:prompt_panel.glossary.edit')}
                      className="w-6 h-6 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(pointer:coarse)]:opacity-70 p-0.5 shrink-0 text-muted-foreground/60 hover:text-foreground"
                    >
                      <PencilSimple size={14} />
                    </DsButton>
                    <DsButton
                      variant="ghost"
                      size="icon"
                      onClick={() => handleRemove(entryKey)}
                      aria-label={t('translation:prompt_panel.glossary.remove')}
                      className="w-6 h-6 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(pointer:coarse)]:opacity-70 p-0.5 shrink-0 hover:bg-destructive/10 hover:text-destructive"
                    >
                      <X size={14} />
                    </DsButton>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

/** Prompt 模板选择：预设 + localStorage 自定义模板 */
const PromptTemplates: React.FC<{
  customPrompt: string;
  setCustomPrompt: (prompt: string) => void;
}> = ({ customPrompt, setCustomPrompt }) => {
  const { t } = useTranslation(['translation']);
  const [customTemplates, setCustomTemplates] = useState<CustomTemplate[]>(() => readCustomTemplates());
  const [isNaming, setIsNaming] = useState(false);
  const [templateName, setTemplateName] = useState('');

  const normalizedPrompt = customPrompt.trim();

  const presetItems = useMemo(
    () =>
      PRESET_TEMPLATES.map((preset) => ({
        id: preset.id,
        label: t(preset.labelKey),
        prompt: t(preset.promptKey),
      })),
    [t],
  );

  const applyTemplate = (prompt: string) => setCustomPrompt(prompt);

  const handleSaveTemplate = () => {
    const name = templateName.trim();
    if (!name || !normalizedPrompt) return;
    const next = [
      ...customTemplates.filter((tpl) => tpl.name !== name),
      { id: `tpl-${Date.now()}`, name, prompt: customPrompt },
    ];
    setCustomTemplates(next);
    writeCustomTemplates(next);
    setTemplateName('');
    setIsNaming(false);
    showGlobalNotification('success', t('translation:prompt_panel.templates.saved'));
  };

  const handleDeleteTemplate = (id: string) => {
    const next = customTemplates.filter((tpl) => tpl.id !== id);
    setCustomTemplates(next);
    writeCustomTemplates(next);
  };

  const chipClass = (active: boolean) =>
    cn(
      'h-7 px-2.5 text-xs ui-state-colors',
      active
        ? '!bg-primary/10 !text-primary !border-primary/40'
        : 'text-muted-foreground hover:text-foreground',
    );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {presetItems.map((preset) => {
          const active = normalizedPrompt === preset.prompt.trim();
          return (
            <DsButton
              key={preset.id}
              variant="outline"
              size="sm"
              aria-pressed={active}
              onClick={() => applyTemplate(preset.prompt)}
              className={chipClass(active)}
            >
              {preset.label}
            </DsButton>
          );
        })}
        {customTemplates.map((tpl) => {
          const active = normalizedPrompt === tpl.prompt.trim();
          return (
            <span key={tpl.id} className="inline-flex items-center gap-0.5 ui-rise-in">
              <DsButton
                variant="outline"
                size="sm"
                aria-pressed={active}
                onClick={() => applyTemplate(tpl.prompt)}
                className={chipClass(active)}
              >
                <BookmarkSimple size={12} className="mr-1" />
                {tpl.name}
              </DsButton>
              <DsButton
                variant="ghost"
                size="icon"
                onClick={() => handleDeleteTemplate(tpl.id)}
                aria-label={t('translation:prompt_panel.templates.delete', { name: tpl.name })}
                className="w-5 h-5 text-muted-foreground/50 hover:bg-destructive/10 hover:text-destructive"
              >
                <X size={11} />
              </DsButton>
            </span>
          );
        })}
      </div>

      {isNaming ? (
        <div className="flex items-center gap-2 ui-rise-in">
          <Input
            value={templateName}
            onChange={(e) => setTemplateName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleSaveTemplate();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setIsNaming(false);
                setTemplateName('');
              }
            }}
            autoFocus
            placeholder={t('translation:prompt_panel.templates.name_placeholder')}
            className="flex-1 min-w-0 h-8 min-h-0 lg:min-h-0 px-2.5 text-sm"
          />
          <DsButton
            variant="ghost"
            size="icon"
            onClick={handleSaveTemplate}
            disabled={!templateName.trim() || !normalizedPrompt}
            aria-label={t('translation:prompt_panel.templates.confirm_save')}
            className="w-8 h-8 shrink-0 text-primary hover:bg-primary/10"
          >
            <Check size={16} />
          </DsButton>
          <DsButton
            variant="ghost"
            size="icon"
            onClick={() => {
              setIsNaming(false);
              setTemplateName('');
            }}
            aria-label={t('translation:prompt_panel.templates.cancel_save')}
            className="w-8 h-8 shrink-0 text-muted-foreground/60 hover:text-foreground"
          >
            <X size={16} />
          </DsButton>
        </div>
      ) : (
        <DsButton
          variant="ghost"
          size="sm"
          onClick={() => setIsNaming(true)}
          disabled={!normalizedPrompt}
          className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
        >
          <BookmarkSimple size={13} className="mr-1" />
          {t('translation:prompt_panel.templates.save_as')}
        </DsButton>
      )}
    </div>
  );
};

/** 提示词编辑内容（移动/桌面共用的紧凑分组布局） */
const PromptEditorContent: React.FC<{
  customPrompt: string;
  setCustomPrompt: (prompt: string) => void;
  onSavePrompt: () => void;
  onRestoreDefaultPrompt: () => void;
  formality: 'formal' | 'casual' | 'auto';
  setFormality: (formality: 'formal' | 'casual' | 'auto') => void;
  domain?: string;
  setDomain?: (domain: string) => void;
  glossary?: Array<[string, string]>;
  setGlossary?: (glossary: Array<[string, string]>) => void;
  isAutoTranslate?: boolean;
  setIsAutoTranslate?: (val: boolean) => void;
  isSyncScroll?: boolean;
  setIsSyncScroll?: (val: boolean) => void;
  className?: string;
}> = ({
  customPrompt,
  setCustomPrompt,
  onSavePrompt,
  onRestoreDefaultPrompt,
  formality,
  setFormality,
  domain,
  setDomain,
  glossary,
  setGlossary,
  isAutoTranslate,
  setIsAutoTranslate,
  isSyncScroll,
  setIsSyncScroll,
  className,
}) => {
  const { t } = useTranslation(['translation', 'common']);

  return (
    <div className={cn('space-y-5 flex flex-col', className)}>
      {/* 翻译选项开关 */}
      {(setIsAutoTranslate || setIsSyncScroll) && (
        <PanelSection title={t('translation:options_title')}>
          <div className="space-y-3">
            {setIsAutoTranslate && (
              <div className="flex items-center justify-between">
                <Label htmlFor="prompt-panel-auto-translate" className="text-sm cursor-pointer">
                  {t('translation:auto_mode')}
                </Label>
                <Switch
                  id="prompt-panel-auto-translate"
                  checked={!!isAutoTranslate}
                  onCheckedChange={setIsAutoTranslate}
                />
              </div>
            )}
            {setIsSyncScroll && (
              <div className="flex items-center justify-between">
                <Label htmlFor="prompt-panel-sync-scroll" className="text-sm cursor-pointer">
                  {t('translation:sync_scroll')}
                </Label>
                <Switch
                  id="prompt-panel-sync-scroll"
                  checked={!!isSyncScroll}
                  onCheckedChange={setIsSyncScroll}
                />
              </div>
            )}
          </div>
        </PanelSection>
      )}

      {/* 翻译风格（语气） */}
      <PanelSection
        title={t('translation:prompt_panel.style_title')}
        hint={t('translation:prompt_panel.style_hint')}
      >
        <SegmentedControl
          ariaLabel={t('translation:prompt_editor.formality')}
          value={formality}
          onValueChange={setFormality}
          size="compact"
          options={[
            { value: 'auto', label: t('translation:prompt_editor.formality_auto') },
            { value: 'formal', label: t('translation:prompt_editor.formality_formal') },
            { value: 'casual', label: t('translation:prompt_editor.formality_casual') },
          ]}
        />
      </PanelSection>

      {/* 领域 */}
      {setDomain && (
        <PanelSection
          title={t('translation:prompt_editor.domain')}
          hint={t('translation:prompt_panel.domain_hint')}
        >
          <AppSelect
            value={domain || 'general'}
            onValueChange={(v) => setDomain(v)}
            width={160}
            size="sm"
            options={DOMAIN_OPTIONS.map((d) => ({
              value: d.value,
              label: t(d.labelKey),
            }))}
          />
        </PanelSection>
      )}

      {/* 术语表 */}
      {setGlossary && glossary && (
        <PanelSection
          title={t('translation:prompt_editor.glossary_title')}
          hint={t('translation:prompt_editor.glossary_hint')}
          badge={
            <>
              <BookOpen size={13} className="text-muted-foreground/60" />
              {glossary.length > 0 && <Badge variant="default">{glossary.length}</Badge>}
            </>
          }
        >
          <GlossaryEditor glossary={glossary} setGlossary={setGlossary} />
        </PanelSection>
      )}

      {/* 自定义提示词 + 模板 */}
      <PanelSection
        title={t('translation:prompt_editor.custom_prompt_label')}
        hint={t('translation:prompt_panel.prompt_hint')}
      >
        <div className="space-y-2">
          <PromptTemplates customPrompt={customPrompt} setCustomPrompt={setCustomPrompt} />
          <Textarea
            value={customPrompt}
            onChange={(e) => setCustomPrompt(e.target.value)}
            placeholder={t('translation:prompt_editor.placeholder')}
            className="flex-1 min-h-[100px] resize-none w-full"
          />
        </div>
      </PanelSection>

      <div className="flex gap-2 justify-end">
        <DsButton variant="outline" size="sm" onClick={onRestoreDefaultPrompt}>
          <ArrowCounterClockwise size={16} className="mr-2" />
          {t('translation:prompt_editor.restore_default')}
        </DsButton>
        <DsButton variant="default" size="sm" onClick={onSavePrompt}>
          <FloppyDisk size={16} className="mr-2" />
          {t('translation:prompt_editor.save')}
        </DsButton>
      </div>
    </div>
  );
};

export const PromptPanel: React.FC<PromptPanelProps> = ({
  customPrompt,
  setCustomPrompt,
  onSavePrompt,
  onRestoreDefaultPrompt,
  isOpen: _isOpen,
  setIsOpen,
  formality,
  setFormality,
  domain,
  setDomain,
  glossary,
  setGlossary,
  mobileFullscreen = false,
  isAutoTranslate,
  setIsAutoTranslate,
  isSyncScroll,
  setIsSyncScroll,
}) => {
  const { t } = useTranslation(['translation', 'common']);

  // 「恢复默认」立即持久化：父级 setCustomPrompt 提交后（onSavePrompt 闭包已捕获新值）再触发保存。
  // 用 ref 取最新一版 onSavePrompt，避免存下点击时刻捕获旧 prompt 的闭包。
  const onSavePromptRef = useRef(onSavePrompt);
  onSavePromptRef.current = onSavePrompt;
  const [restoreTick, setRestoreTick] = useState(0);
  useEffect(() => {
    if (restoreTick === 0) return;
    onSavePromptRef.current();
  }, [restoreTick]);

  const handleRestoreDefault = useCallback(() => {
    onRestoreDefaultPrompt();
    setRestoreTick((tick) => tick + 1);
  }, [onRestoreDefaultPrompt]);

  const handleSaveAndClose = useCallback(() => {
    onSavePrompt();
    setIsOpen(false);
  }, [onSavePrompt, setIsOpen]);

  const editorContent = (
    <PromptEditorContent
      customPrompt={customPrompt}
      setCustomPrompt={setCustomPrompt}
      onSavePrompt={handleSaveAndClose}
      onRestoreDefaultPrompt={handleRestoreDefault}
      formality={formality}
      setFormality={setFormality}
      domain={domain}
      setDomain={setDomain}
      glossary={glossary}
      setGlossary={setGlossary}
      isAutoTranslate={isAutoTranslate}
      setIsAutoTranslate={setIsAutoTranslate}
      isSyncScroll={isSyncScroll}
      setIsSyncScroll={setIsSyncScroll}
    />
  );

  if (mobileFullscreen) {
    return (
      <div className="h-full flex flex-col bg-background">
        {/* 头部：标题 + 关闭按钮（可见的退出路径，与滑动返回互补） */}
        <div className="flex items-center justify-between pl-4 pr-2 h-12 border-b border-border/30 shrink-0">
          <span className="text-sm font-medium text-foreground/80">
            {t('translation:prompt_editor.title')}
          </span>
          <DsButton
            variant="ghost"
            size="icon"
            onClick={() => setIsOpen(false)}
            className="h-10 w-10 text-muted-foreground/60 hover:text-foreground"
            aria-label={t('common:close')}
          >
            <X size={18} />
          </DsButton>
        </div>
        <CustomScrollArea
          className="flex-1"
          viewportClassName="p-4 pb-[calc(1rem+var(--mobile-safe-area-bottom,0px))]"
        >
          {editorContent}
        </CustomScrollArea>
      </div>
    );
  }

  // 桌面端：设置整页视图内容（由 TranslationMain 以占满主区的独立页承载）
  return (
    <div className="h-full flex flex-col bg-background">
      {/* 头部 */}
      <div className="flex items-center justify-between px-4 h-12 border-b border-border/30 shrink-0">
        <span className="text-sm font-medium text-foreground/80">
          {t('translation:prompt_editor.title')}
        </span>
        <DsButton
          variant="ghost"
          size="icon"
          onClick={() => setIsOpen(false)}
          className="h-7 w-7 text-muted-foreground/60 hover:text-foreground"
          aria-label={t('common:close')}
        >
          <X size={16} />
        </DsButton>
      </div>

      {/* 内容区 */}
      <CustomScrollArea className="flex-1" viewportClassName="p-4">
        {editorContent}
      </CustomScrollArea>
    </div>
  );
};
