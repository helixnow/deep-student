import React from 'react';
import { useTranslation } from 'react-i18next';
import { NotionButton } from '@/components/ui/NotionButton';
import { Textarea } from '../ui/shad/Textarea';
import { AppSelect } from '../ui/app-menu';
import { Switch } from '../ui/shad/Switch';
import { Label } from '../ui/shad/Label';
import { CommonTooltip } from '../shared/CommonTooltip';
import {
    ArrowLeftRight,
    RotateCcw,
    Trash2,
    Sparkles,
    Settings2,
} from 'lucide-react';
import UnifiedDragDropZone, { FILE_TYPES } from '../shared/UnifiedDragDropZone';

interface SourcePanelProps {
    isMaximized: boolean;
    isSourceCollapsed: boolean;
    setIsSourceCollapsed: (collapsed: boolean) => void;
    srcLang: string;
    setSrcLang: (lang: string) => void;
    tgtLang: string;
    setTgtLang: (lang: string) => void;
    sourceText: string;
    setSourceText: (text: string) => void;
    sourceMaxChars?: number;
    isSourceOverLimit?: boolean;
    isTranslating: boolean;
    isAutoTranslate: boolean;
    setIsAutoTranslate: (val: boolean) => void;
    onSwapLanguages: () => void;
    onFilesDropped: (files: File[]) => void;
    setShowPromptEditor: (show: boolean) => void;
    onClear: () => void;
    onTranslate: () => void;
    onCancelTranslation: () => void;
    sourceCharCount: number;
    LANGUAGES: { code: string; label: string }[];
    // 移动端需要的同步滚动控制
    isSyncScroll?: boolean;
    setIsSyncScroll?: (val: boolean) => void;
}

export const SourcePanel = React.forwardRef<HTMLTextAreaElement, SourcePanelProps>(({
    isMaximized,
    isSourceCollapsed,
    setIsSourceCollapsed,
    srcLang,
    setSrcLang,
    tgtLang,
    setTgtLang,
    sourceText,
    setSourceText,
    sourceMaxChars,
    isSourceOverLimit,
    isTranslating,
    isAutoTranslate,
    setIsAutoTranslate,
    onSwapLanguages,
    onFilesDropped,
    setShowPromptEditor,
    onClear,
    onTranslate,
    onCancelTranslation,
    sourceCharCount,
    LANGUAGES,
    isSyncScroll,
    setIsSyncScroll,
}, ref) => {
    const { t } = useTranslation(['translation', 'common']);

    return (
        <div className="flex flex-col h-full min-h-0 flex-1 basis-1/2 min-w-0 transition-all duration-300 border-b lg:border-b-0 lg:border-r relative group/source">
            {/* Source Toolbar */}
            <div className="flex flex-col border-b bg-background/50 backdrop-blur z-10">
                {/* 次顶栏：语言选择器 + 翻译按钮(移动端) / 自动翻译开关(桌面端) */}
                <div className="flex items-center justify-between px-3 sm:px-4 py-2 h-12 gap-1 sm:gap-2">
                    <div className="flex items-center gap-1 sm:gap-2 flex-1 min-w-0">
                        <AppSelect
                            value={srcLang}
                            onValueChange={setSrcLang}
                            variant="ghost"
                            size="sm"
                            width={90}
                            className="font-medium text-primary flex-1 max-w-[90px] sm:max-w-[140px] sm:flex-none [&>span]:truncate"
                            options={LANGUAGES.map((lang) => ({
                                value: lang.code,
                                label: t(lang.label),
                            }))}
                        />

                        <NotionButton
                            variant="ghost"
                            size="icon"
                            onClick={onSwapLanguages}
                            disabled={isTranslating || srcLang === 'auto'}
                            className="h-7 w-7 sm:h-8 sm:w-8 rounded-full hover:bg-muted/80 shrink-0"
                        >
                            <ArrowLeftRight className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-muted-foreground" />
                        </NotionButton>

                        <AppSelect
                            value={tgtLang}
                            onValueChange={setTgtLang}
                            variant="ghost"
                            size="sm"
                            width={90}
                            className="font-medium text-primary flex-1 max-w-[90px] sm:max-w-[140px] sm:flex-none [&>span]:truncate"
                            options={LANGUAGES.filter(lang => lang.code !== 'auto').map((lang) => ({
                                value: lang.code,
                                label: t(lang.label),
                            }))}/>
                    </div>

                    {/* 移动端：翻译按钮（无容器风格） */}
                    <div className="sm:hidden shrink-0">
                        {isTranslating ? (
                            <NotionButton
                                variant="ghost"
                                size="sm"
                                onClick={onCancelTranslation}
                                className="h-8 px-2 text-muted-foreground"
                            >
                                <RotateCcw className="w-4 h-4 mr-1 animate-spin" />
                                {t('common:cancel')}
                            </NotionButton>
                        ) : (
                            <NotionButton
                                variant="ghost"
                                size="sm"
                                onClick={onTranslate}
                                disabled={!sourceText.trim()}
                                className="h-8 px-2 text-primary font-medium"
                            >
                                <Sparkles className="w-4 h-4 mr-1" />
                                {t('translation:actions.translate')}
                            </NotionButton>
                        )}
                    </div>

                    {/* 桌面端：自动翻译开关 */}
                    {!isSourceCollapsed && (
                        <div className="hidden sm:flex items-center gap-2 shrink-0">
                            <Switch
                                id="auto-translate-desktop"
                                checked={isAutoTranslate}
                                onCheckedChange={setIsAutoTranslate}
                                className="scale-75 data-[state=checked]:bg-primary"
                            />
                            <Label htmlFor="auto-translate-desktop" className="text-xs font-medium text-muted-foreground cursor-pointer whitespace-nowrap">
                                {t('translation:auto_mode')}
                            </Label>
                        </div>
                    )}
                </div>
            </div>

            {/* Source Content */}
            <div className="flex-1 min-h-0 flex flex-col relative overflow-hidden">
                <UnifiedDragDropZone
                    zoneId="translate-upload"
                    onFilesDropped={onFilesDropped}
                    acceptedFileTypes={[FILE_TYPES.IMAGE, FILE_TYPES.DOCUMENT]}
                    maxFiles={1}
                    maxFileSize={50 * 1024 * 1024}
                    className="flex-1 min-h-0 flex flex-col"
                >
                    <Textarea
                        ref={ref}
                        value={sourceText}
                        onChange={(e) => setSourceText(e.target.value)}
                        placeholder={t('translation:source_section.placeholder')}
                        maxLength={sourceMaxChars}
                        className="flex-1 min-h-0 resize-none font-mono px-4 pt-6 pb-16 text-base leading-relaxed !border-0 !shadow-none !rounded-none !bg-transparent focus:!ring-0 focus:!ring-offset-0 focus-visible:!ring-0 focus-visible:!ring-offset-0 focus:!outline-none focus-visible:!outline-none selection:bg-primary/20"
                    />
                </UnifiedDragDropZone>

                {/* Floating Bottom Controls (Source) - 仅桌面端显示 */}
                <div className="absolute bottom-4 left-4 right-4 hidden sm:flex items-center justify-between pointer-events-none">
                    {/* 桌面端：翻译设置触发按钮 */}
                    <div className="pointer-events-auto opacity-0 group-hover/source:opacity-100 transition-opacity duration-200">
                        <NotionButton
                            variant="ghost"
                            size="sm"
                            onClick={() => setShowPromptEditor(true)}
                            className="bg-background/80 backdrop-blur-sm border shadow-sm"
                        >
                            <Settings2 className="w-3.5 h-3.5 mr-1.5" />
                            {t('translation:prompt_editor.title')}
                        </NotionButton>
                    </div>

                    {/* 桌面端：字数统计和清除按钮 */}
                    <div className="pointer-events-auto flex items-center gap-3 bg-background/80 backdrop-blur-sm p-1.5 rounded-lg border shadow-sm opacity-0 group-hover/source:opacity-100 transition-opacity duration-200 shrink-0 ml-2">
                        <span className={`text-xs px-2 border-r ${
                          isSourceOverLimit
                            ? 'text-destructive font-medium'
                            : sourceMaxChars && sourceCharCount > sourceMaxChars * 0.9
                              ? 'text-yellow-600 dark:text-yellow-400'
                              : 'text-muted-foreground'
                        }`}>
                            {sourceCharCount}{sourceMaxChars ? `/${sourceMaxChars.toLocaleString()}` : ''} {t('translation:stats.characters')}
                        </span>
                        <CommonTooltip content={t('translation:actions.clear')}>
                            <NotionButton
                                variant="ghost"
                                size="icon"
                                onClick={onClear}
                                disabled={!sourceText}
                                className="h-6 w-6 text-muted-foreground hover:text-destructive"
                            >
                                <Trash2 className="w-3.5 h-3.5" />
                            </NotionButton>
                        </CommonTooltip>
                    </div>
                </div>
            </div>

            {/* Translate Action Bar (Bottom of Source Panel) - 仅桌面端显示 */}
            <div className="hidden sm:flex p-3 border-t bg-background/50 backdrop-blur items-center justify-end">
                {isTranslating ? (
                    <NotionButton
                        variant="default"
                        onClick={onCancelTranslation}
                        className="min-w-[120px]"
                    >
                        <RotateCcw className="w-3.5 h-3.5 mr-2 animate-spin" />
                        {t('common:cancel')}
                    </NotionButton>
                ) : (
                    <NotionButton
                        variant="primary"
                        onClick={onTranslate}
                        disabled={!sourceText.trim()}
                        className="min-w-[120px]"
                    >
                        <Sparkles className="w-3.5 h-3.5 mr-2" />
                        {t('translation:actions.translate')}
                    </NotionButton>
                )}
            </div>
        </div>
    );
});

SourcePanel.displayName = 'SourcePanel';
