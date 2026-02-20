import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NotionButton } from '@/components/ui/NotionButton';
import { Textarea } from '../ui/shad/Textarea';
import { Switch } from '../ui/shad/Switch';
import { Label } from '../ui/shad/Label';
import { Badge } from '../ui/shad/Badge';
import { CommonTooltip } from '../shared/CommonTooltip';
import {
    Languages,
    Edit3,
    Volume2,
    Copy,
    Download,
    CheckCircle2,
    Star,
    Columns2,
} from 'lucide-react';
import { TranslationStreamRenderer } from '../../translation/TranslationStreamRenderer';
import { ComparisonView } from './ComparisonView';

interface TargetPanelProps {
    isMaximized: boolean;
    setIsMaximized: (maximized: boolean) => void;
    setIsSourceCollapsed: (collapsed: boolean) => void;
    sourceText: string;
    srcLang: string;
    tgtLang: string;
    translatedText: string;
    isTranslating: boolean;
    isSyncScroll: boolean;
    setIsSyncScroll: (val: boolean) => void;
    isEditingTranslation: boolean;
    editedTranslation: string;
    setEditedTranslation: (text: string) => void;
    onCancelEdit: () => void;
    onSaveEditedTranslation: () => void;
    translationQuality: number | null;
    onRateTranslation: (rating: number) => void;
    targetCharCount: number;
    onEditTranslation: () => void;
    onSpeak: () => void;
    isSpeaking: boolean;
    onCopyResult: () => void;
    onExportTranslation: () => void;
    charCount: number;
    wordCount: number;
}

export const TargetPanel = React.forwardRef<HTMLDivElement, TargetPanelProps>(({
    isMaximized,
    setIsMaximized,
    setIsSourceCollapsed,
    sourceText,
    srcLang,
    tgtLang,
    translatedText,
    isTranslating,
    isSyncScroll,
    setIsSyncScroll,
    isEditingTranslation,
    editedTranslation,
    setEditedTranslation,
    onCancelEdit,
    onSaveEditedTranslation,
    translationQuality,
    onRateTranslation,
    targetCharCount,
    onEditTranslation,
    onSpeak,
    isSpeaking,
    onCopyResult,
    onExportTranslation,
    charCount,
    wordCount,
}, ref) => {
    const { t } = useTranslation(['translation', 'common']);
    const [showComparison, setShowComparison] = useState(false);

    return (
        <div className="flex flex-col h-full min-h-0 flex-1 basis-1/2 min-w-0 transition-all duration-300 bg-muted/10 group/target">
            {/* Target Toolbar - 仅桌面端显示 */}
            <div className="hidden sm:flex items-center justify-between px-4 h-12 border-b bg-background/50 backdrop-blur z-10">
                <div className="flex items-center gap-2">
                    <Badge variant="outline" className="font-normal bg-background/50 backdrop-blur-sm border-primary/20 text-primary">
                        <Languages className="w-3.5 h-3.5 mr-1.5" />
                        {t('translation:target_section.title')}
                    </Badge>
                </div>

                <div className="flex items-center gap-1">
                    {/* Comparison View Toggle */}
                    <CommonTooltip content={t('translation:comparison.toggle', { defaultValue: '段落对照' })}>
                        <NotionButton
                            variant="ghost"
                            size="icon"
                            onClick={() => setShowComparison(!showComparison)}
                            disabled={isEditingTranslation}
                            className={`h-8 w-8 ${showComparison ? 'text-primary bg-primary/10' : 'text-muted-foreground hover:text-foreground'}`}
                        >
                            <Columns2 className="w-4 h-4" />
                        </NotionButton>
                    </CommonTooltip>

                    {/* Sync Scroll Toggle */}
                    <div className="flex items-center gap-2 mr-3 px-2 py-1 rounded-md hover:bg-muted/50 transition-colors">
                        <Switch
                            id="sync-scroll"
                            checked={isSyncScroll}
                            onCheckedChange={setIsSyncScroll}
                            className="data-[state=checked]:bg-primary"
                        />
                        <Label htmlFor="sync-scroll" className="text-xs font-medium text-muted-foreground cursor-pointer whitespace-nowrap">
                            {t('translation:sync_scroll')}
                        </Label>
                    </div>

                    <div className="w-px h-4 bg-border mx-2" />

                    <div className="flex items-center gap-0.5">
                        {translatedText && (
                            <>
                                <CommonTooltip content={t('translation:target_section.edit')}>
                                    <NotionButton
                                        variant="ghost"
                                        size="icon"
                                        onClick={onEditTranslation}
                                        disabled={isEditingTranslation}
                                        className="h-8 w-8 text-muted-foreground hover:text-foreground"
                                    >
                                        <Edit3 className="w-4 h-4" />
                                    </NotionButton>
                                </CommonTooltip>
                                <CommonTooltip content={isSpeaking ? t('translation:target_section.stop_listen') : t('translation:target_section.listen')}>
                                    <NotionButton
                                        variant="ghost"
                                        size="icon"
                                        onClick={onSpeak}
                                        disabled={!translatedText || isEditingTranslation}
                                        className={`h-8 w-8 ${isSpeaking ? 'text-primary bg-primary/10' : 'text-muted-foreground hover:text-foreground'}`}
                                    >
                                        <Volume2 className={`w-4 h-4 ${isSpeaking ? 'animate-pulse' : ''}`} />
                                    </NotionButton>
                                </CommonTooltip>
                                <CommonTooltip content={t('translation:target_section.copy')}>
                                    <NotionButton
                                        variant="ghost"
                                        size="icon"
                                        onClick={onCopyResult}
                                        className="h-8 w-8 text-muted-foreground hover:text-foreground"
                                    >
                                        <Copy className="w-4 h-4" />
                                    </NotionButton>
                                </CommonTooltip>
                                <CommonTooltip content={t('translation:target_section.export')}>
                                    <NotionButton
                                        variant="ghost"
                                        size="icon"
                                        onClick={onExportTranslation}
                                        className="h-8 w-8 text-muted-foreground hover:text-foreground"
                                    >
                                        <Download className="w-4 h-4" />
                                    </NotionButton>
                                </CommonTooltip>
                            </>
                        )}
                    </div>
                </div>
            </div>

            {/* Target Content */}
            <div className="flex-1 min-h-0 flex flex-col relative">
                {isEditingTranslation ? (
                    <div className="flex-1 min-h-0 flex flex-col p-4">
                        <Textarea
                            value={editedTranslation}
                            onChange={(e) => setEditedTranslation(e.target.value)}
                            className="flex-1 min-h-0 resize-none font-mono !bg-transparent !border-0 !shadow-none !rounded-none p-6 focus-visible:!ring-0"
                        />
                        <div className="flex items-center justify-between mt-3">
                            <span className="text-xs text-muted-foreground">
                                {editedTranslation.length} {t('translation:stats.characters')}
                            </span>
                            <div className="flex gap-2">
                                <NotionButton
                                    variant="outline"
                                    size="sm"
                                    onClick={onCancelEdit}
                                >
                                    {t('common:cancel')}
                                </NotionButton>
                                <NotionButton
                                    variant="default"
                                    size="sm"
                                    onClick={onSaveEditedTranslation}
                                >
                                    <CheckCircle2 className="w-4 h-4 mr-2" />
                                    {t('common:save')}
                                </NotionButton>
                            </div>
                        </div>
                    </div>
                ) : showComparison ? (
                    <div className="flex-1 min-h-0 flex flex-col" ref={ref}>
                        <ComparisonView
                            sourceText={sourceText}
                            translatedText={translatedText}
                            srcLang={srcLang}
                            tgtLang={tgtLang}
                            isTranslating={isTranslating}
                        />
                    </div>
                ) : (
                    <div className="flex-1 min-h-0 flex flex-col" ref={ref}>
                        {/* 使用独立流式渲染器 */}
                        <div className="flex-1 min-h-0 overflow-hidden">
                            <TranslationStreamRenderer
                                content={translatedText}
                                isStreaming={isTranslating}
                                placeholder={t('translation:target_section.placeholder')}
                                showStats={false}
                                charCount={charCount}
                                wordCount={wordCount}
                            />
                        </div>

                        {/* Floating Status Bar (Target) */}
                        {translatedText && (
                            <div className="absolute bottom-4 left-4 right-4 flex items-center justify-between pointer-events-none opacity-0 group-hover/target:opacity-100 transition-opacity duration-200">
                                <div className="pointer-events-auto bg-background/80 backdrop-blur-sm border rounded-full shadow-sm px-1 py-0.5 flex items-center">
                                    {[1, 2, 3, 4, 5].map((rating) => (
                                        <NotionButton
                                            key={rating}
                                            variant="ghost"
                                            size="icon"
                                            onClick={() => onRateTranslation(rating)}
                                            className="h-7 w-7 p-1.5 hover:bg-muted rounded-full"
                                        >
                                            <Star
                                                className={`w-3.5 h-3.5 transition-colors ${translationQuality && rating <= translationQuality
                                                    ? 'fill-yellow-500 text-yellow-500'
                                                    : 'text-muted-foreground hover:text-yellow-400'
                                                    }`}
                                            />
                                        </NotionButton>
                                    ))}
                                </div>
                                <div className="bg-background/80 backdrop-blur-sm border rounded-lg px-2 py-1 text-xs text-muted-foreground shadow-sm">
                                    {targetCharCount} {t('translation:stats.characters')}
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
});

TargetPanel.displayName = 'TargetPanel';
