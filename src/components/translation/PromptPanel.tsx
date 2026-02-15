import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NotionButton } from '@/components/ui/NotionButton';
import { Textarea } from '../ui/shad/Textarea';
import { AppSelect } from '../ui/app-menu';
import { Switch } from '../ui/shad/Switch';
import { Label } from '../ui/shad/Label';
import { Sparkles, Save, RotateCcw, Plus, X, BookOpen } from 'lucide-react';
import { CustomScrollArea } from '../custom-scroll-area';

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

/** 术语表编辑器 */
const GlossaryEditor: React.FC<{
  glossary: Array<[string, string]>;
  setGlossary: (glossary: Array<[string, string]>) => void;
}> = ({ glossary, setGlossary }) => {
  const { t } = useTranslation(['translation']);
  const [newSrc, setNewSrc] = useState('');
  const [newTgt, setNewTgt] = useState('');

  const handleAdd = () => {
    if (!newSrc.trim() || !newTgt.trim()) return;
    setGlossary([...glossary, [newSrc.trim(), newTgt.trim()]]);
    setNewSrc('');
    setNewTgt('');
  };

  const handleRemove = (index: number) => {
    setGlossary(glossary.filter((_, i) => i !== index));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAdd();
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <BookOpen className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="text-sm font-medium text-muted-foreground">
            {t('translation:prompt_editor.glossary_title')}
          </span>
          {glossary.length > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-medium">
              {glossary.length}
            </span>
          )}
        </div>
      </div>
      <p className="text-xs text-muted-foreground/70">
        {t('translation:prompt_editor.glossary_hint')}
      </p>

      {/* 新增行 */}
      <div className="flex items-center gap-2">
        <input
          value={newSrc}
          onChange={(e) => setNewSrc(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('translation:prompt_editor.glossary_source')}
          className="flex-1 h-8 px-2.5 text-sm bg-muted/30 border border-transparent rounded-md focus:border-primary/50 focus:bg-background focus:outline-none transition-colors placeholder:text-muted-foreground/40"
        />
        <span className="text-muted-foreground/40 text-xs shrink-0">→</span>
        <input
          value={newTgt}
          onChange={(e) => setNewTgt(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('translation:prompt_editor.glossary_target')}
          className="flex-1 h-8 px-2.5 text-sm bg-muted/30 border border-transparent rounded-md focus:border-primary/50 focus:bg-background focus:outline-none transition-colors placeholder:text-muted-foreground/40"
        />
        <NotionButton
          variant="ghost"
          size="icon"
          onClick={handleAdd}
          disabled={!newSrc.trim() || !newTgt.trim()}
          className="h-8 w-8 shrink-0 text-primary hover:bg-primary/10"
        >
          <Plus className="w-4 h-4" />
        </NotionButton>
      </div>

      {/* 已添加的术语 */}
      {glossary.length === 0 ? (
        <p className="text-xs text-muted-foreground/40 italic text-center py-2">
          {t('translation:prompt_editor.glossary_empty')}
        </p>
      ) : (
        <div className="space-y-1">
          {glossary.map(([src, tgt], index) => (
            <div
              key={`${src}::${tgt}::${index}`}
              className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-muted/20 hover:bg-muted/40 transition-colors group"
            >
              <span className="flex-1 text-sm truncate font-mono">{src}</span>
              <span className="text-muted-foreground/40 text-xs shrink-0">→</span>
              <span className="flex-1 text-sm truncate font-mono text-primary/80">{tgt}</span>
              <NotionButton
                variant="ghost"
                size="icon"
                onClick={() => handleRemove(index)}
                className="h-6 w-6 opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-destructive/10 hover:text-destructive transition-all shrink-0"
              >
                <X className="w-3.5 h-3.5" />
              </NotionButton>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

/** 提示词编辑内容（共用） */
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
  className,
}) => {
  const { t } = useTranslation(['translation', 'common']);

  return (
    <div className={`space-y-4 flex flex-col ${className || ''}`}>
      {/* 领域 + 语气 */}
      <div className="flex items-center gap-3 flex-wrap">
        {setDomain && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground whitespace-nowrap">
              {t('translation:prompt_editor.domain')}:
            </span>
            <AppSelect
              value={domain || 'general'}
              onValueChange={(v) => setDomain(v)}
              width={120}
              size="sm"
              options={DOMAIN_OPTIONS.map((d) => ({
                value: d.value,
                label: t(d.labelKey),
              }))}
            />
          </div>
        )}
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground whitespace-nowrap">
            {t('translation:prompt_editor.formality')}:
          </span>
          <AppSelect
            value={formality}
            onValueChange={(v) => setFormality(v as 'formal' | 'casual' | 'auto')}
            width={110}
            size="sm"
            options={[
              { value: 'auto', label: t('translation:prompt_editor.formality_auto') },
              { value: 'formal', label: t('translation:prompt_editor.formality_formal') },
              { value: 'casual', label: t('translation:prompt_editor.formality_casual') },
            ]}
          />
        </div>
      </div>

      {/* 术语表 */}
      {setGlossary && glossary && (
        <GlossaryEditor glossary={glossary} setGlossary={setGlossary} />
      )}

      {/* 自定义提示词 */}
      <div className="space-y-1.5">
        <span className="text-sm font-medium text-muted-foreground">
          {t('translation:prompt_editor.custom_prompt_label')}
        </span>
        <Textarea
          value={customPrompt}
          onChange={(e) => setCustomPrompt(e.target.value)}
          placeholder={t('translation:prompt_editor.placeholder')}
          className="flex-1 min-h-[100px] resize-none w-full"
        />
      </div>

      <div className="flex gap-2 justify-end">
        <NotionButton
          variant="outline"
          size="sm"
          onClick={onRestoreDefaultPrompt}
        >
          <RotateCcw className="w-4 h-4 mr-2" />
          {t('translation:prompt_editor.restore_default')}
        </NotionButton>
        <NotionButton
          variant="default"
          size="sm"
          onClick={onSavePrompt}
        >
          <Save className="w-4 h-4 mr-2" />
          {t('translation:prompt_editor.save')}
        </NotionButton>
      </div>
    </div>
  );
};

export const PromptPanel: React.FC<PromptPanelProps> = ({
  customPrompt,
  setCustomPrompt,
  onSavePrompt,
  onRestoreDefaultPrompt,
  isOpen,
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

  if (mobileFullscreen) {
    return (
      <div className="h-full flex flex-col bg-background">
        <CustomScrollArea className="flex-1" viewportClassName="p-4">
          {/* 翻译选项开关 */}
          <div className="space-y-4 mb-6 pb-4 border-b">
            <h3 className="text-sm font-medium text-muted-foreground">{t('translation:options_title')}</h3>

            {setIsAutoTranslate && (
              <div className="flex items-center justify-between">
                <Label htmlFor="auto-translate-settings" className="text-sm cursor-pointer">
                  {t('translation:auto_mode')}
                </Label>
                <Switch
                  id="auto-translate-settings"
                  checked={isAutoTranslate}
                  onCheckedChange={setIsAutoTranslate}
                  className="data-[state=checked]:bg-primary"
                />
              </div>
            )}

            {setIsSyncScroll && (
              <div className="flex items-center justify-between">
                <Label htmlFor="sync-scroll-settings" className="text-sm cursor-pointer">
                  {t('translation:sync_scroll')}
                </Label>
                <Switch
                  id="sync-scroll-settings"
                  checked={isSyncScroll}
                  onCheckedChange={setIsSyncScroll}
                  className="data-[state=checked]:bg-primary"
                />
              </div>
            )}
          </div>

          {/* 翻译设置 */}
          <div className="mb-4">
            <h3 className="text-sm font-medium text-muted-foreground mb-3">{t('translation:prompt_editor.title')}</h3>
          </div>
          <PromptEditorContent
            customPrompt={customPrompt}
            setCustomPrompt={setCustomPrompt}
            onSavePrompt={() => {
              onSavePrompt();
              setIsOpen(false);
            }}
            onRestoreDefaultPrompt={onRestoreDefaultPrompt}
            formality={formality}
            setFormality={setFormality}
            domain={domain}
            setDomain={setDomain}
            glossary={glossary}
            setGlossary={setGlossary}
            className="h-full"
          />
        </CustomScrollArea>
      </div>
    );
  }

  // 桌面端：抽屉式渲染（参考作文批改 SettingsDrawer）
  return (
    <div className="h-full flex flex-col bg-background border-l border-border/40">
      {/* 头部 */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/30 shrink-0">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground/80">
          <Sparkles className="w-4 h-4" />
          <span>{t('translation:prompt_editor.title')}</span>
        </div>
        <NotionButton
          variant="ghost"
          size="icon"
          onClick={() => setIsOpen(false)}
          className="h-7 w-7 text-muted-foreground/60 hover:text-foreground"
        >
          <X className="w-4 h-4" />
        </NotionButton>
      </div>

      {/* 内容区 */}
      <CustomScrollArea className="flex-1" viewportClassName="p-4">
        {/* 翻译选项开关 */}
        {(setIsAutoTranslate || setIsSyncScroll) && (
          <div className="space-y-4 mb-6 pb-4 border-b border-border/30">
            <h3 className="text-xs font-medium text-muted-foreground/70 uppercase tracking-wide">
              {t('translation:options_title')}
            </h3>

            {setIsAutoTranslate && (
              <div className="flex items-center justify-between">
                <Label htmlFor="auto-translate-drawer" className="text-sm cursor-pointer">
                  {t('translation:auto_mode')}
                </Label>
                <Switch
                  id="auto-translate-drawer"
                  checked={isAutoTranslate}
                  onCheckedChange={setIsAutoTranslate}
                  className="data-[state=checked]:bg-primary"
                />
              </div>
            )}

            {setIsSyncScroll && (
              <div className="flex items-center justify-between">
                <Label htmlFor="sync-scroll-drawer" className="text-sm cursor-pointer">
                  {t('translation:sync_scroll')}
                </Label>
                <Switch
                  id="sync-scroll-drawer"
                  checked={isSyncScroll}
                  onCheckedChange={setIsSyncScroll}
                  className="data-[state=checked]:bg-primary"
                />
              </div>
            )}
          </div>
        )}

        <PromptEditorContent
          customPrompt={customPrompt}
          setCustomPrompt={setCustomPrompt}
          onSavePrompt={() => {
            onSavePrompt();
            setIsOpen(false);
          }}
          onRestoreDefaultPrompt={onRestoreDefaultPrompt}
          formality={formality}
          setFormality={setFormality}
          domain={domain}
          setDomain={setDomain}
          glossary={glossary}
          setGlossary={setGlossary}
        />
      </CustomScrollArea>
    </div>
  );
};
