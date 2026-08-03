/**
 * 组卷生成器组件
 * 
 * 功能：
 * - 组卷配置面板（题型选择、数量设置、难度筛选）
 * - 预览生成的试卷
 * - 导出为 PDF/Word（待实现）
 */

import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { MarkdownRenderer } from '@/features/chat/components/renderers';
import { DsButton } from '@/components/ui/DsButton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/shad/Card';
import { Badge } from '@/components/ui/shad/Badge';
import { Input } from '@/components/ui/shad/Input';
import { Label } from '@/components/ui/shad/Label';
import { Switch } from '@/components/ui/shad/Switch';
import { Checkbox } from '@/components/ui/shad/Checkbox';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import {
  FileText,
  Download,
  Eye,
  GearSix,
  Target,
  Tag,
  CircleNotch,
  DownloadSimple,
  Printer,
  CaretDown,
  CaretUp,
  CheckCircle,
} from '@phosphor-icons/react';
import { invoke } from '@tauri-apps/api/core';
import {
  useQuestionBankStore,
  PaperConfig,
  PaperExportFormat,
  GeneratedPaper,
  Question,
  PRACTICE_QUESTION_TYPES,
} from '@/stores/questionBankStore';
import { useTranslation } from 'react-i18next';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { CountStepperRow } from './CountStepperRow';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';

interface PaperGeneratorProps {
  examId: string;
  availableTags?: string[];
  onGenerate?: (paper: GeneratedPaper) => void;
  className?: string;
}

// 组卷可配置的题型（含 2026-07 新增 true_false/numeric/matching/ordering）
const QUESTION_TYPE_KEYS = PRACTICE_QUESTION_TYPES.filter((key) => key !== 'other');

const DIFFICULTY_KEYS = [
  { key: 'easy', color: 'bg-success/10 text-success' },
  { key: 'medium', color: 'bg-warning/10 text-warning' },
  { key: 'hard', color: 'bg-warning/10 text-warning' },
  { key: 'very_hard', color: 'bg-destructive/10 text-destructive' },
];

const EXPORT_FORMAT_KEYS: Array<{ key: PaperExportFormat; icon: React.ReactNode }> = [
  { key: 'preview', icon: <Eye size={16} /> },
  { key: 'pdf', icon: <DownloadSimple size={16} /> },
  { key: 'word', icon: <FileText size={16} /> },
  { key: 'markdown', icon: <FileText size={16} /> },
];

export const PaperGenerator: React.FC<PaperGeneratorProps> = ({
  examId,
  availableTags = [],
  onGenerate,
  className,
}) => {
  const { t } = useTranslation('practice');
  
  // Store
  const {
    generatedPaper,
    setGeneratedPaper,
    generatePaper,
    isLoadingPractice,
  } = useQuestionBankStore();
  
  // 配置状态
  const [title, setTitle] = useState(() => t('paper.defaultTitle'));
  const [typeSelection, setTypeSelection] = useState<Record<string, number>>({});
  const [selectedDifficulties, setSelectedDifficulties] = useState<string[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [shuffle, setShuffle] = useState(true);
  const [includeAnswers, setIncludeAnswers] = useState(true);
  const [includeExplanations, setIncludeExplanations] = useState(true);
  const [exportFormat, setExportFormat] = useState<PaperExportFormat>('preview');
  
  // UI 状态
  const [showPreview, setShowPreview] = useState(false);
  const [expandedQuestions, setExpandedQuestions] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!showPreview) return;
    return registerBackHandler(() => {
      setShowPreview(false);
      return true;
    }, BACK_PRIORITY.overlay);
  }, [showPreview]);
  const [generationError, setGenerationError] = useState<string | null>(null);
  
  // 计算总题数
  const totalQuestions = useMemo(() => {
    return Object.values(typeSelection).reduce((a, b) => a + b, 0);
  }, [typeSelection]);
  
  // 更新题型数量
  const handleTypeChange = useCallback((key: string, value: number) => {
    setTypeSelection((prev) => ({
      ...prev,
      [key]: value,
    }));
  }, []);
  
  // 切换难度选择
  const toggleDifficulty = useCallback((key: string) => {
    setSelectedDifficulties((prev) =>
      prev.includes(key)
        ? prev.filter((d) => d !== key)
        : [...prev, key]
    );
  }, []);
  
  // 切换标签选择
  const toggleTag = useCallback((tag: string) => {
    setSelectedTags((prev) =>
      prev.includes(tag)
        ? prev.filter((t) => t !== tag)
        : [...prev, tag]
    );
  }, []);
  
  // 生成试卷
  const handleGenerate = useCallback(async () => {
    const config: PaperConfig = {
      title,
      type_selection: typeSelection,
      difficulty_filter: selectedDifficulties.length > 0 ? selectedDifficulties : undefined,
      tags_filter: selectedTags.length > 0 ? selectedTags : undefined,
      shuffle,
      include_answers: includeAnswers,
      include_explanations: includeExplanations,
      export_format: exportFormat,
    };
    
    setGenerationError(null);
    try {
      const paper = await generatePaper(examId, config);
      setShowPreview(true);
      onGenerate?.(paper);
    } catch (err: unknown) {
      console.error('Failed to generate paper:', err);
      const message = getErrorMessage(err);
      setGenerationError(message);
      showGlobalNotification(
        'error',
        t('paper.generateFailed', { error: message }),
      );
    }
  }, [examId, title, typeSelection, selectedDifficulties, selectedTags, shuffle, includeAnswers, includeExplanations, exportFormat, generatePaper, onGenerate, t]);
  
  // 导出试卷：Markdown 直接落盘（复用 save 对话框 + save_text_to_file 后端命令）；
  // PDF/Word 暂未实现，给出明确提示而非静默无反应（修复此前点击导出无任何反馈的缺口）。
  const handleExport = useCallback(async () => {
    if (!generatedPaper) return;
    if (exportFormat !== 'markdown') {
      showGlobalNotification('info', t('paper.exportComingSoon'));
      return;
    }
    try {
      const answerLabel = t('paper.answer');
      const explanationLabel = t('paper.explanation');
      const lines: string[] = [`# ${generatedPaper.title}`, ''];
      generatedPaper.questions.forEach((q, i) => {
        lines.push(`## ${i + 1}. ${q.content}`, '');
        if (q.options && q.options.length > 0) {
          q.options.forEach((opt) => lines.push(`- ${opt.key}. ${opt.content}`));
          lines.push('');
        }
        if (includeAnswers && q.answer) {
          lines.push(`**${answerLabel}：** ${q.answer}`, '');
        }
        if (includeExplanations && q.explanation) {
          lines.push(`**${explanationLabel}：** ${q.explanation}`, '');
        }
      });
      const content = lines.join('\n');

      const { save } = await import('@tauri-apps/plugin-dialog');
      const path = await save({
        title: t('paper.exportTitle'),
        defaultPath: `${generatedPaper.title || 'paper'}.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      });
      if (!path) return;

      await invoke('save_text_to_file', { path, content });
      showGlobalNotification('success', t('paper.exportSuccess'));
    } catch (err: unknown) {
      console.error('Failed to export paper:', err);
      showGlobalNotification('error', t('paper.exportFailed'));
    }
  }, [generatedPaper, exportFormat, includeAnswers, includeExplanations, t]);
  
  // 切换题目展开
  const toggleQuestion = useCallback((id: string) => {
    setExpandedQuestions((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);
  
  // 预览界面
  if (showPreview && generatedPaper) {
    return (
      <div className={cn('ui-rise-in space-y-4', className)}>
        <Card className="bg-transparent border-transparent shadow-none">
          <CardHeader className="px-3 pb-4 sm:px-6">
            <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
              <CardTitle
                className="flex min-w-0 items-center gap-2 text-base"
                title={generatedPaper.title}
              >
                <FileText size={18} className="shrink-0 text-primary" />
                <span className="truncate">{generatedPaper.title}</span>
              </CardTitle>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Badge variant="secondary">
                  {generatedPaper.questions.length} {t('paper.questions')}
                </Badge>
                <DsButton
                  variant="outline"
                  size="sm"
                  onClick={() => setShowPreview(false)}
                >
                  {t('paper.back')}
                </DsButton>
                {exportFormat !== 'preview' && (
                  <DsButton size="sm" onClick={handleExport}>
                    <Download size={16} className="mr-1" />
                    {t('paper.export')}
                  </DsButton>
                )}
              </div>
            </div>
          </CardHeader>
        </Card>
        
        {/* 试卷内容 */}
        <CustomScrollArea className="max-h-[min(60vh,520px)]" fullHeight={false}>
          <div className="space-y-4 pr-0 sm:pr-4">
            {generatedPaper.questions.map((question, idx) => (
              <Card key={question.id} className="overflow-hidden [content-visibility:auto] [contain-intrinsic-size:auto_72px]">
                <DsButton variant="ghost" size="sm" className="!w-full !text-left !p-4 !h-auto !rounded-none hover:bg-[var(--interactive-hover)]" onClick={() => toggleQuestion(question.id)}>
                  <div className="flex items-start gap-3">
                    <Badge variant="outline" className="flex-shrink-0 font-mono">
                      {idx + 1}
                    </Badge>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm line-clamp-2">{question.content}</p>
                    </div>
                    {expandedQuestions.has(question.id) ? (
                      <CaretUp size={16} className="text-muted-foreground flex-shrink-0" />
                    ) : (
                      <CaretDown size={16} className="text-muted-foreground flex-shrink-0" />
                    )}
                  </div>
                </DsButton>
                
                {expandedQuestions.has(question.id) && (
                  <CardContent className="ui-rise-in pt-0 space-y-3">
                    {/* 选项 */}
                    {question.options && question.options.length > 0 && (
                      <div className="ml-0 space-y-2 sm:ml-8">
                        {question.options.map((opt) => (
                          <div key={opt.key} className="flex items-start gap-2 text-sm">
                            <span className="font-medium text-muted-foreground">{opt.key}.</span>
                            <span>{opt.content}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    
                    {/* 答案 */}
                    {includeAnswers && question.answer && (
                      <div className="ml-0 rounded-md border border-success/20 bg-success/5 p-3 sm:ml-8">
                        <div className="mb-1 flex items-center gap-1.5 text-sm font-medium text-success">
                          <CheckCircle size={16} />
                          {t('paper.answer')}
                        </div>
                        <div className="text-sm"><MarkdownRenderer content={question.answer} /></div>
                      </div>
                    )}
                    
                    {/* 解析 */}
                    {includeExplanations && question.explanation && (
                      <div className="ml-0 rounded-md border border-primary/20 bg-primary/5 p-3 sm:ml-8">
                        <div className="mb-1 text-sm font-medium text-primary">
                          {t('paper.explanation')}
                        </div>
                        <div className="text-sm text-muted-foreground"><MarkdownRenderer content={question.explanation} /></div>
                      </div>
                    )}
                  </CardContent>
                )}
              </Card>
            ))}
          </div>
        </CustomScrollArea>
      </div>
    );
  }
  
  // 配置界面（与其余练习模式配置面板统一：透明背景、无边框）
  return (
    <Card className={cn('bg-transparent border-transparent shadow-none', className)}>
      <CardHeader className="px-0 pb-4 sm:px-6">
        <CardTitle className="flex items-center gap-2 text-base">
          <FileText size={18} className="text-primary" />
          {t('paper.title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6 px-0 sm:px-6">
        {/* 试卷标题 */}
        <div className="space-y-2">
          <Label>{t('paper.paperTitle')}</Label>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('paper.titlePlaceholder')}
/>
        </div>
        
        {/* 题型选择 */}
        <div className="space-y-3">
          <Label className="flex items-center gap-1">
            <GearSix size={16} />
            {t('paper.typeSelection')}
          </Label>
          <div className="space-y-1.5">
            {QUESTION_TYPE_KEYS.map((key) => (
              <CountStepperRow
                key={key}
                label={t(`questionType.${key}`)}
                value={typeSelection[key] || 0}
                onChange={(value) => handleTypeChange(key, value)}
                max={20}
/>
            ))}
          </div>
          <div className="text-sm text-muted-foreground">
            {t('paper.totalSelected')} <span className="font-medium text-foreground tabular-nums">{totalQuestions}</span> {t('paper.questions')}
          </div>
        </div>
        
        {/* 难度筛选 */}
        <div className="space-y-3">
          <Label className="flex items-center gap-1">
            <Target size={16} />
            {t('paper.difficultyFilter')}
            <span className="text-muted-foreground text-xs">{t('paper.noRestriction')}</span>
          </Label>
          <div className="flex flex-wrap gap-2">
            {DIFFICULTY_KEYS.map(({ key, color }) => (
              <DsButton
                key={key}
                variant="ghost" size="sm"
                onClick={() => toggleDifficulty(key)}
                className={cn(
                  '!h-auto !rounded-md !px-3 !py-1.5 [@media(pointer:coarse)]:!min-h-11 text-sm font-medium',
                  selectedDifficulties.includes(key)
                    ? color
                    : 'bg-muted text-muted-foreground hover:bg-[var(--interactive-hover)]'
                )}
              >
                {t(`difficultyLevel.${key}`)}
              </DsButton>
            ))}
          </div>
        </div>
        
        {/* 标签筛选 */}
        {availableTags.length > 0 && (
          <div className="space-y-3">
            <Label className="flex items-center gap-1">
              <Tag size={16} />
              {t('paper.tagsFilter')}
              <span className="text-muted-foreground text-xs">{t('paper.noRestriction')}</span>
            </Label>
            <div className="flex flex-wrap gap-2">
              {availableTags.map((tag) => (
                <DsButton
                  key={tag}
                  variant="ghost" size="sm"
                  onClick={() => toggleTag(tag)}
                  className={cn(
                    '!h-auto !rounded-md !px-3 !py-1.5 [@media(pointer:coarse)]:!min-h-11 text-sm',
                    selectedTags.includes(tag)
                      ? 'bg-primary/10 text-primary'
                      : 'bg-muted text-muted-foreground hover:bg-[var(--interactive-hover)]'
                  )}
                >
                  {tag}
                </DsButton>
              ))}
            </div>
          </div>
        )}
        
        {/* 其他选项 */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <Label>{t('paper.shuffle')}</Label>
            <Switch checked={shuffle} onCheckedChange={setShuffle} />
          </div>
          <div className="flex items-center justify-between">
            <Label>{t('paper.includeAnswers')}</Label>
            <Switch checked={includeAnswers} onCheckedChange={setIncludeAnswers} />
          </div>
          <div className="flex items-center justify-between">
            <Label>{t('paper.includeExplanations')}</Label>
            <Switch checked={includeExplanations} onCheckedChange={setIncludeExplanations} />
          </div>
        </div>
        
        {/* 导出格式 */}
        <div className="space-y-2">
          <Label>{t('paper.exportFormat')}</Label>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {EXPORT_FORMAT_KEYS.map(({ key, icon }) => (
              <DsButton
                key={key}
                variant="ghost" size="sm"
                onClick={() => setExportFormat(key)}
                className={cn(
                  '!flex !flex-col !items-center !gap-1 !p-3 !h-auto !rounded-lg border',
                  exportFormat === key
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border hover:bg-[var(--interactive-hover)]'
                )}
              >
                {icon}
                <span className="text-xs">{t(`paper.format.${key}`)}</span>
              </DsButton>
            ))}
          </div>
        </div>

        {generationError && (
          <div
            role="alert"
            className="ui-rise-in flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            <span>{t('paper.generateFailed', { error: generationError })}</span>
          </div>
        )}
        
        <DsButton
          onClick={handleGenerate}
          disabled={isLoadingPractice || totalQuestions === 0}
          className="h-9 w-full text-sm"
        >
          {isLoadingPractice ? (
            <>
              <CircleNotch size={20} className="mr-2 animate-spin" />
              {t('paper.generating')}
            </>
          ) : (
            <>
              <FileText size={20} className="mr-2" />
              {t('paper.generate')}
            </>
          )}
        </DsButton>
      </CardContent>
    </Card>
  );
};

export default PaperGenerator;
