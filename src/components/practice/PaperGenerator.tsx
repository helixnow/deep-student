/**
 * 组卷生成器组件
 * 
 * 功能：
 * - 组卷配置面板（题型选择、数量设置、难度筛选）
 * - 预览生成的试卷
 * - 导出为 PDF/Word（待实现）
 */

import React, { useState, useCallback, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { MarkdownRenderer } from '@/chat-v2/components/renderers';
import { NotionButton } from '@/components/ui/NotionButton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/shad/Card';
import { Badge } from '@/components/ui/shad/Badge';
import { Input } from '@/components/ui/shad/Input';
import { Label } from '@/components/ui/shad/Label';
import { Switch } from '@/components/ui/shad/Switch';
import { Slider } from '@/components/ui/shad/Slider';
import { Checkbox } from '@/components/ui/shad/Checkbox';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import {
  FileText,
  Download,
  Eye,
  Settings2,
  Target,
  Tag,
  Loader2,
  FileDown,
  Printer,
  ChevronDown,
  ChevronUp,
  CheckCircle,
} from 'lucide-react';
import { useQuestionBankStore, PaperConfig, PaperExportFormat, GeneratedPaper, Question } from '@/stores/questionBankStore';
import { useTranslation } from 'react-i18next';

interface PaperGeneratorProps {
  examId: string;
  availableTags?: string[];
  onGenerate?: (paper: GeneratedPaper) => void;
  className?: string;
}

const QUESTION_TYPE_KEYS = [
  'single_choice', 'multiple_choice', 'fill_blank', 'short_answer', 'essay', 'calculation', 'proof',
];

const DIFFICULTY_KEYS = [
  { key: 'easy', color: 'text-emerald-600 bg-emerald-500/10' },
  { key: 'medium', color: 'text-amber-600 bg-amber-500/10' },
  { key: 'hard', color: 'text-orange-600 bg-orange-500/10' },
  { key: 'very_hard', color: 'text-rose-600 bg-rose-500/10' },
];

const EXPORT_FORMAT_KEYS: Array<{ key: PaperExportFormat; icon: React.ReactNode }> = [
  { key: 'preview', icon: <Eye className="w-4 h-4" /> },
  { key: 'pdf', icon: <FileDown className="w-4 h-4" /> },
  { key: 'word', icon: <FileText className="w-4 h-4" /> },
  { key: 'markdown', icon: <FileText className="w-4 h-4" /> },
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
    isLoading,
  } = useQuestionBankStore();
  
  // 配置状态
  const [title, setTitle] = useState(() => t('paper.defaultTitle', '练习试卷'));
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
    
    try {
      const paper = await generatePaper(examId, config);
      setShowPreview(true);
      onGenerate?.(paper);
    } catch (err: unknown) {
      console.error('Failed to generate paper:', err);
    }
  }, [examId, title, typeSelection, selectedDifficulties, selectedTags, shuffle, includeAnswers, includeExplanations, exportFormat, generatePaper, onGenerate]);
  
  // 导出试卷（待实现）
  const handleExport = useCallback(() => {
    // TODO: 实现导出功能
    console.log('Export paper:', generatedPaper);
  }, [generatedPaper]);
  
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
      <div className={cn('space-y-4', className)}>
        <Card>
          <CardHeader className="pb-4">
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-lg">
                <FileText className="w-5 h-5 text-sky-500" />
                {generatedPaper.title}
              </CardTitle>
              <div className="flex items-center gap-2">
                <Badge variant="secondary">
                  {generatedPaper.questions.length} {t('paper.questions', '题')}
                </Badge>
                <NotionButton
                  variant="outline"
                  size="sm"
                  onClick={() => setShowPreview(false)}
                >
                  {t('paper.back', '返回配置')}
                </NotionButton>
                {exportFormat !== 'preview' && (
                  <NotionButton size="sm" onClick={handleExport}>
                    <Download className="w-4 h-4 mr-1" />
                    {t('paper.export', '导出')}
                  </NotionButton>
                )}
              </div>
            </div>
          </CardHeader>
        </Card>
        
        {/* 试卷内容 */}
        <CustomScrollArea className="h-[calc(100vh-280px)]">
          <div className="space-y-4 pr-4">
            {generatedPaper.questions.map((question, idx) => (
              <Card key={question.id} className="overflow-hidden">
                <button
                  className="w-full text-left p-4 hover:bg-muted/30 transition-colors"
                  onClick={() => toggleQuestion(question.id)}
                >
                  <div className="flex items-start gap-3">
                    <Badge variant="outline" className="flex-shrink-0 font-mono">
                      {idx + 1}
                    </Badge>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm line-clamp-2">{question.content}</p>
                    </div>
                    {expandedQuestions.has(question.id) ? (
                      <ChevronUp className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                    ) : (
                      <ChevronDown className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                    )}
                  </div>
                </button>
                
                {expandedQuestions.has(question.id) && (
                  <CardContent className="pt-0 space-y-3">
                    {/* 选项 */}
                    {question.options && question.options.length > 0 && (
                      <div className="space-y-2 ml-8">
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
                      <div className="ml-8 p-3 rounded-lg bg-emerald-500/5 border border-emerald-500/20">
                        <div className="flex items-center gap-1.5 text-sm font-medium text-emerald-600 mb-1">
                          <CheckCircle className="w-4 h-4" />
                          {t('paper.answer', '答案')}
                        </div>
                        <div className="text-sm"><MarkdownRenderer content={question.answer} /></div>
                      </div>
                    )}
                    
                    {/* 解析 */}
                    {includeExplanations && question.explanation && (
                      <div className="ml-8 p-3 rounded-lg bg-sky-500/5 border border-sky-500/20">
                        <div className="text-sm font-medium text-sky-600 mb-1">
                          {t('paper.explanation', '解析')}
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
  
  // 配置界面
  return (
    <Card className={cn('', className)}>
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2 text-lg">
          <FileText className="w-5 h-5 text-sky-500" />
          {t('paper.title', '组卷生成器')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* 试卷标题 */}
        <div className="space-y-2">
          <Label>{t('paper.paperTitle', '试卷标题')}</Label>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('paper.titlePlaceholder', '请输入试卷标题')}
          />
        </div>
        
        {/* 题型选择 */}
        <div className="space-y-3">
          <Label className="flex items-center gap-1">
            <Settings2 className="w-4 h-4" />
            {t('paper.typeSelection', '题型配置')}
          </Label>
          <div className="space-y-2">
            {QUESTION_TYPE_KEYS.map((key) => (
              <div key={key} className="flex items-center gap-3">
                <span className="text-sm w-20">{t(`questionType.${key}`)}</span>
                <Slider
                  value={[typeSelection[key] || 0]}
                  onValueChange={(v) => handleTypeChange(key, v[0])}
                  max={20}
                  step={1}
                  className="flex-1"
                />
                <span className="text-sm w-8 text-right font-medium">
                  {typeSelection[key] || 0}
                </span>
              </div>
            ))}
          </div>
          <div className="text-sm text-muted-foreground">
            {t('paper.totalSelected', '共选择')} <span className="font-medium text-foreground">{totalQuestions}</span> {t('paper.questions', '题')}
          </div>
        </div>
        
        {/* 难度筛选 */}
        <div className="space-y-3">
          <Label className="flex items-center gap-1">
            <Target className="w-4 h-4" />
            {t('paper.difficultyFilter', '难度筛选')}
            <span className="text-muted-foreground text-xs">{t('paper.noRestriction', '（不选则不限制）')}</span>
          </Label>
          <div className="flex flex-wrap gap-2">
            {DIFFICULTY_KEYS.map(({ key, color }) => (
              <button
                key={key}
                onClick={() => toggleDifficulty(key)}
                className={cn(
                  'px-3 py-1.5 rounded-full text-sm font-medium transition-colors',
                  selectedDifficulties.includes(key)
                    ? color
                    : 'bg-muted text-muted-foreground hover:bg-muted/80'
                )}
              >
                {t(`difficultyLevel.${key}`)}
              </button>
            ))}
          </div>
        </div>
        
        {/* 标签筛选 */}
        {availableTags.length > 0 && (
          <div className="space-y-3">
            <Label className="flex items-center gap-1">
              <Tag className="w-4 h-4" />
              {t('paper.tagsFilter', '标签筛选')}
              <span className="text-muted-foreground text-xs">{t('paper.noRestriction', '（不选则不限制）')}</span>
            </Label>
            <div className="flex flex-wrap gap-2">
              {availableTags.map((tag) => (
                <button
                  key={tag}
                  onClick={() => toggleTag(tag)}
                  className={cn(
                    'px-3 py-1.5 rounded-full text-sm transition-colors',
                    selectedTags.includes(tag)
                      ? 'bg-sky-500/20 text-sky-600'
                      : 'bg-muted text-muted-foreground hover:bg-muted/80'
                  )}
                >
                  {tag}
                </button>
              ))}
            </div>
          </div>
        )}
        
        {/* 其他选项 */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <Label>{t('paper.shuffle', '打乱题目顺序')}</Label>
            <Switch checked={shuffle} onCheckedChange={setShuffle} />
          </div>
          <div className="flex items-center justify-between">
            <Label>{t('paper.includeAnswers', '包含答案')}</Label>
            <Switch checked={includeAnswers} onCheckedChange={setIncludeAnswers} />
          </div>
          <div className="flex items-center justify-between">
            <Label>{t('paper.includeExplanations', '包含解析')}</Label>
            <Switch checked={includeExplanations} onCheckedChange={setIncludeExplanations} />
          </div>
        </div>
        
        {/* 导出格式 */}
        <div className="space-y-2">
          <Label>{t('paper.exportFormat', '导出格式')}</Label>
          <div className="grid grid-cols-4 gap-2">
            {EXPORT_FORMAT_KEYS.map(({ key, icon }) => (
              <button
                key={key}
                onClick={() => setExportFormat(key)}
                className={cn(
                  'flex flex-col items-center gap-1 p-3 rounded-lg border transition-colors',
                  exportFormat === key
                    ? 'border-sky-500 bg-sky-500/10 text-sky-600'
                    : 'border-border hover:bg-muted/50'
                )}
              >
                {icon}
                <span className="text-xs">{t(`paper.format.${key}`)}</span>
              </button>
            ))}
          </div>
        </div>
        
        <NotionButton
          onClick={handleGenerate}
          disabled={isLoading || totalQuestions === 0}
          className="w-full h-12 text-lg"
        >
          {isLoading ? (
            <>
              <Loader2 className="w-5 h-5 mr-2 animate-spin" />
              {t('paper.generating', '生成中...')}
            </>
          ) : (
            <>
              <FileText className="w-5 h-5 mr-2" />
              {t('paper.generate', '生成试卷')}
            </>
          )}
        </NotionButton>
      </CardContent>
    </Card>
  );
};

export default PaperGenerator;
