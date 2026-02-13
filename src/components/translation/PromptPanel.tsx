import React from 'react';
import { useTranslation } from 'react-i18next';
import { NotionButton } from '@/components/ui/NotionButton';
import { Textarea } from '../ui/shad/Textarea';
import { AppSelect } from '../ui/app-menu';
import { Switch } from '../ui/shad/Switch';
import { Label } from '../ui/shad/Label';
import { ChevronDown, ChevronRight, ChevronLeft, Sparkles, Save, RotateCcw } from 'lucide-react';
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
  /** 移动端模式：全屏面板样式 */
  mobileFullscreen?: boolean;
  /** 移动端额外控制项 */
  isAutoTranslate?: boolean;
  setIsAutoTranslate?: (val: boolean) => void;
  isSyncScroll?: boolean;
  setIsSyncScroll?: (val: boolean) => void;
}

/** 提示词编辑内容（共用） */
const PromptEditorContent: React.FC<{
  customPrompt: string;
  setCustomPrompt: (prompt: string) => void;
  onSavePrompt: () => void;
  onRestoreDefaultPrompt: () => void;
  formality: 'formal' | 'casual' | 'auto';
  setFormality: (formality: 'formal' | 'casual' | 'auto') => void;
  className?: string;
}> = ({
  customPrompt,
  setCustomPrompt,
  onSavePrompt,
  onRestoreDefaultPrompt,
  formality,
  setFormality,
  className,
}) => {
  const { t } = useTranslation(['translation', 'common']);

  return (
    <div className={`space-y-4 flex flex-col ${className || ''}`}>
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground whitespace-nowrap">
          {t('translation:prompt_editor.formality')}:
        </span>
        <AppSelect
          value={formality}
          onValueChange={(v) => setFormality(v as any)}
          width={140}
          size="sm"
          options={[
            { value: 'auto', label: t('translation:prompt_editor.formality_auto') },
            { value: 'formal', label: t('translation:prompt_editor.formality_formal') },
            { value: 'casual', label: t('translation:prompt_editor.formality_casual') },
          ]}
        />
      </div>
      <Textarea
        value={customPrompt}
        onChange={(e) => setCustomPrompt(e.target.value)}
        placeholder={t('translation:prompt_editor.placeholder')}
        className="flex-1 min-h-[120px] resize-none w-full"
      />
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
  mobileFullscreen = false,
  isAutoTranslate,
  setIsAutoTranslate,
  isSyncScroll,
  setIsSyncScroll,
}) => {
  const { t } = useTranslation(['translation', 'common']);

  // 移动端全屏模式：独立滑动面板内容
  if (mobileFullscreen) {
    return (
      <div className="h-full flex flex-col bg-background">
        {/* 内容区 */}
        <CustomScrollArea className="flex-1" viewportClassName="p-4">
          {/* 翻译选项开关 */}
          <div className="space-y-4 mb-6 pb-4 border-b">
            <h3 className="text-sm font-medium text-muted-foreground">{t('translation:options_title')}</h3>

            {/* 自动翻译开关 */}
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

            {/* 同步滚动开关 */}
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

          {/* 提示词编辑器 */}
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
            className="h-full"
          />
        </CustomScrollArea>
      </div>
    );
  }

  // 桌面端：折叠/展开样式
  return (
    <div className="space-y-2 w-full">
      <NotionButton
        variant="ghost"
        size="sm"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full justify-start bg-background/80 backdrop-blur-sm border shadow-sm"
      >
        {isOpen ? <ChevronDown className="w-4 h-4 mr-2" /> : <ChevronRight className="w-4 h-4 mr-2" />}
        <Sparkles className="w-4 h-4 mr-2" />
        {t('translation:prompt_editor.title')}
      </NotionButton>
      {isOpen && (
        <div className="space-y-3 p-3 bg-background/95 backdrop-blur-sm border rounded-lg shadow-lg w-full">
          <PromptEditorContent
            customPrompt={customPrompt}
            setCustomPrompt={setCustomPrompt}
            onSavePrompt={onSavePrompt}
            onRestoreDefaultPrompt={onRestoreDefaultPrompt}
            formality={formality}
            setFormality={setFormality}
          />
        </div>
      )}
    </div>
  );
};
