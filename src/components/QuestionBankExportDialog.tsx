/**
 * 智能题目集导出对话框
 * 
 * P2-2 功能：支持多种格式导出题目
 * 
 * 🆕 2026-01 新增
 * 🔄 2026-01 增强：添加 CSV 高级导出选项（字段选择、编码选择、答题记录）
 */

import React, { useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/shad/Dialog';
import { NotionButton } from '@/components/ui/NotionButton';
import { Label } from '@/components/ui/shad/Label';
import { Checkbox } from '@/components/ui/shad/Checkbox';
import { AppSelect } from '@/components/ui/app-menu';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/shad/Collapsible';
import {
  Download,
  FileJson,
  FileText,
  FileSpreadsheet,
  Loader2,
  CheckCircle2,
  ChevronDown,
  Settings2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { fileManager } from '@/utils/fileManager';
import { showGlobalNotification } from './UnifiedNotification';
import type { Question } from '@/api/questionBankApi';

type ExportFormat = 'json' | 'txt' | 'csv';
type CsvEncoding = 'utf8' | 'gbk' | 'utf8_bom';

interface QuestionBankExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  questions: Question[];
  examName?: string;
  /** 题目集 ID（用于 CSV 高级导出） */
  examId?: string;
}

interface ExportOptions {
  includeAnswer: boolean;
  includeExplanation: boolean;
  includeStatus: boolean;
  includeStats: boolean;
}

// CSV 可导出字段定义
const CSV_EXPORTABLE_FIELDS = [
  { key: 'content', default: true },
  { key: 'question_type', default: true },
  { key: 'options', default: true },
  { key: 'answer', default: true },
  { key: 'explanation', default: true },
  { key: 'difficulty', default: true },
  { key: 'tags', default: true },
  { key: 'question_label', default: true },
  { key: 'user_answer', default: false },
  { key: 'is_correct', default: false },
  { key: 'attempt_count', default: false },
  { key: 'correct_count', default: false },
  { key: 'status', default: false },
  { key: 'is_favorite', default: false },
  { key: 'user_note', default: false },
  { key: 'created_at', default: false },
  { key: 'updated_at', default: false },
] as const;

// CSV 编码选项
const CSV_ENCODING_OPTIONS: Array<{ value: CsvEncoding; label: string }> = [
  { value: 'utf8', label: 'UTF-8' },
  { value: 'utf8_bom', label: 'UTF-8 BOM' },
  { value: 'gbk', label: 'GBK' },
];

const formatIcons: Record<ExportFormat, React.ReactNode> = {
  json: <FileJson className="w-5 h-5" />,
  txt: <FileText className="w-5 h-5" />,
  csv: <FileSpreadsheet className="w-5 h-5" />,
};

const formatLabels: Record<ExportFormat, string> = {
  json: 'JSON',
  txt: 'TXT/Markdown',
  csv: 'CSV',
};

// Format description keys - translated at render time via t()
const FORMAT_DESC_KEYS: Record<ExportFormat, string> = {
  json: 'exam_sheet:questionBank.export.formatDesc.json',
  txt: 'exam_sheet:questionBank.export.formatDesc.txt',
  csv: 'exam_sheet:questionBank.export.formatDesc.csv',
};

export const QuestionBankExportDialog: React.FC<QuestionBankExportDialogProps> = ({
  open,
  onOpenChange,
  questions,
  examName,
  examId,
}) => {
  const { t } = useTranslation(['exam_sheet', 'common']);

  const [format, setFormat] = useState<ExportFormat>('json');
  const [options, setOptions] = useState<ExportOptions>({
    includeAnswer: true,
    includeExplanation: true,
    includeStatus: true,
    includeStats: true,
  });
  const [isExporting, setIsExporting] = useState(false);
  const [exportSuccess, setExportSuccess] = useState(false);

  // CSV 高级选项状态
  const [csvEncoding, setCsvEncoding] = useState<CsvEncoding>('utf8_bom');
  const [csvFields, setCsvFields] = useState<Set<string>>(() => {
    const defaultFields = new Set<string>();
    CSV_EXPORTABLE_FIELDS.forEach((f) => {
      if (f.default) defaultFields.add(f.key);
    });
    return defaultFields;
  });
  const [csvIncludeAnswerRecords, setCsvIncludeAnswerRecords] = useState(false);
  const [showCsvAdvanced, setShowCsvAdvanced] = useState(false);

  // 当选择包含答题记录时，自动添加相关字段
  const handleIncludeAnswerRecordsChange = useCallback((checked: boolean) => {
    setCsvIncludeAnswerRecords(checked);
    if (checked) {
      setCsvFields((prev) => {
        const next = new Set(prev);
        ['user_answer', 'is_correct', 'attempt_count', 'correct_count', 'status'].forEach((f) => {
          next.add(f);
        });
        return next;
      });
    }
  }, []);

  // 切换 CSV 字段选择
  const handleCsvFieldToggle = useCallback((field: string, checked: boolean) => {
    setCsvFields((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(field);
      } else {
        next.delete(field);
      }
      return next;
    });
  }, []);

  // 全选/取消全选 CSV 字段
  const handleSelectAllCsvFields = useCallback((selectAll: boolean) => {
    if (selectAll) {
      setCsvFields(new Set(CSV_EXPORTABLE_FIELDS.map((f) => f.key)));
    } else {
      // 至少保留 content 字段
      setCsvFields(new Set(['content']));
    }
  }, []);

  const handleOptionChange = useCallback((key: keyof ExportOptions, value: boolean) => {
    setOptions(prev => ({ ...prev, [key]: value }));
  }, []);

  const generateJsonExport = useCallback(() => {
    const data = {
      name: examName || t('exam_sheet:questionBank.export.defaultName'),
      exportedAt: new Date().toISOString(),
      totalCount: questions.length,
      questions: questions.map(q => ({
        id: q.id,
        label: q.questionLabel,
        content: q.content,
        questionType: q.questionType,
        options: q.options,
        ...(options.includeAnswer && { answer: q.answer }),
        ...(options.includeExplanation && { explanation: q.explanation }),
        difficulty: q.difficulty,
        tags: q.tags,
        ...(options.includeStatus && { status: q.status }),
        ...(options.includeStats && {
          attemptCount: q.attemptCount,
          correctCount: q.correctCount,
          isCorrect: q.isCorrect,
        }),
      })),
    };
    return JSON.stringify(data, null, 2);
  }, [questions, examName, options, t]);

  const generateTxtExport = useCallback(() => {
    const lines: string[] = [];
    lines.push(`# ${examName || t('exam_sheet:questionBank.export.defaultName')}`);
    lines.push(`${t('exam_sheet:questionBank.export.exportTime')}：${new Date().toLocaleString()}`);
    lines.push(`${t('exam_sheet:questionBank.export.questionCount')}：${questions.length}`);
    lines.push('');
    lines.push('---');
    lines.push('');

    questions.forEach((q, index) => {
      lines.push(`## ${t('exam_sheet:questionBank.export.questionPrefix')} ${index + 1}${q.questionLabel ? ` (${q.questionLabel})` : ''}`);
      lines.push('');
      lines.push(`**${t('exam_sheet:questionBank.export.txtContent')}**`);
      lines.push(q.content);
      lines.push('');

      if (q.options && q.options.length > 0) {
        lines.push(`**${t('exam_sheet:questionBank.export.txtOptions')}**`);
        q.options.forEach(opt => {
          lines.push(`${opt.key}. ${opt.content}`);
        });
        lines.push('');
      }

      if (options.includeAnswer && q.answer) {
        lines.push(`**${t('exam_sheet:questionBank.export.txtAnswer')}**：${q.answer}`);
        lines.push('');
      }

      if (options.includeExplanation && q.explanation) {
        lines.push(`**${t('exam_sheet:questionBank.export.txtExplanation')}**`);
        lines.push(q.explanation);
        lines.push('');
      }

      if (q.difficulty) {
        const diffLabel = t(`exam_sheet:questionBank.difficulty.${q.difficulty}`, q.difficulty);
        lines.push(`**${t('exam_sheet:questionBank.export.txtDifficulty')}**：${diffLabel}`);
      }

      if (q.tags && q.tags.length > 0) {
        lines.push(`**${t('exam_sheet:questionBank.export.txtTags')}**：${q.tags.join(', ')}`);
      }

      if (options.includeStatus) {
        const statusLabel = t(`exam_sheet:questionBank.status.${q.status}`, q.status);
        lines.push(`**${t('exam_sheet:questionBank.export.txtStatus')}**：${statusLabel}`);
      }

      if (options.includeStats) {
        lines.push(`**${t('exam_sheet:questionBank.export.txtStats')}**：${t('exam_sheet:questionBank.export.txtStatsValue', { correct: q.correctCount, total: q.attemptCount })}`);
      }

      lines.push('');
      lines.push('---');
      lines.push('');
    });

    return lines.join('\n');
  }, [questions, examName, options, t]);

  const generateCsvExport = useCallback(() => {
    // M-028: 统一 CSV 字段转义，含逗号/换行/引号时自动包裹双引号
    const escapeCsvField = (field: string): string => {
      if (field.includes(',') || field.includes('"') || field.includes('\n') || field.includes('\r')) {
        return `"${field.replace(/"/g, '""')}"`;
      }
      return field;
    };

    const headers = [
      t('exam_sheet:questionBank.export.csvHeaders.label'),
      t('exam_sheet:questionBank.export.csvHeaders.question'),
      t('exam_sheet:questionBank.export.csvHeaders.type'),
      t('exam_sheet:questionBank.export.csvHeaders.options'),
      ...(options.includeAnswer ? [t('exam_sheet:questionBank.export.csvHeaders.answer')] : []),
      ...(options.includeExplanation ? [t('exam_sheet:questionBank.export.csvHeaders.explanation')] : []),
      t('exam_sheet:questionBank.export.csvHeaders.difficulty'),
      t('exam_sheet:questionBank.export.csvHeaders.tags'),
      ...(options.includeStatus ? [t('exam_sheet:questionBank.export.csvHeaders.status')] : []),
      ...(options.includeStats ? [t('exam_sheet:questionBank.export.csvHeaders.attempts'), t('exam_sheet:questionBank.export.csvHeaders.correctCount')] : []),
    ];

    const rows = questions.map(q => {
      const optionsStr = q.options?.map(o => `${o.key}.${o.content}`).join('; ') || '';
      const row = [
        escapeCsvField(q.questionLabel || ''),
        escapeCsvField(q.content),
        escapeCsvField(q.questionType || ''),
        escapeCsvField(optionsStr),
        ...(options.includeAnswer ? [escapeCsvField(q.answer || '')] : []),
        ...(options.includeExplanation ? [escapeCsvField(q.explanation || '')] : []),
        escapeCsvField(q.difficulty || ''),
        escapeCsvField(q.tags?.join('; ') || ''),
        ...(options.includeStatus ? [escapeCsvField(q.status || '')] : []),
        ...(options.includeStats ? [String(q.attemptCount), String(q.correctCount)] : []),
      ];
      return row.join(',');
    });

    return [headers.join(','), ...rows].join('\n');
  }, [questions, options, t]);

  // CSV 高级导出（通过后端）
  const handleCsvBackendExport = useCallback(async () => {
    if (!examId) {
      showGlobalNotification('error', t('exam_sheet:questionBank.export.noExamId', '缺少题目集 ID'));
      return;
    }

    const baseName = examName?.replace(/[/\\?%*:|"<>]/g, '-') || 'question-bank';
    const timestamp = new Date().toISOString().slice(0, 10);
    const defaultFileName = `${baseName}-${timestamp}.csv`;

    try {
      // 选择保存路径
      const savePath = await fileManager.pickSavePath({
        title: t('exam_sheet:questionBank.export.selectPath', '选择导出位置'),
        defaultFileName,
        filters: [{ name: 'CSV', extensions: ['csv'] }],
      });

      if (!savePath) {
        showGlobalNotification('info', t('common:cancelled', '已取消'));
        return;
      }

      // 调用后端导出
      const result = await invoke<{
        exported_count: number;
        file_path: string;
        file_size: number;
      }>('export_questions_csv', {
        request: {
          exam_id: examId,
          file_path: savePath,
          fields: Array.from(csvFields),
          filters: {},
          include_answers: csvIncludeAnswerRecords,
          encoding: csvEncoding,
        },
      });

      showGlobalNotification(
        'success',
        t('exam_sheet:questionBank.export.csvSuccess', '成功导出 {{count}} 道题目', {
          count: result.exported_count,
        })
      );
      
      setExportSuccess(true);
      setTimeout(() => {
        onOpenChange(false);
        setExportSuccess(false);
      }, 1500);
    } catch (error: unknown) {
      console.error('[QuestionBankExportDialog] CSV export failed:', error);
      showGlobalNotification('error', t('exam_sheet:questionBank.export.csvFailed', '导出失败：{{error}}', {
        error: String(error),
      }));
    }
  }, [examId, examName, csvFields, csvIncludeAnswerRecords, csvEncoding, onOpenChange, t]);

  const handleExport = useCallback(async () => {
    setIsExporting(true);
    setExportSuccess(false);

    try {
      // CSV 格式且有 examId 时使用后端导出（支持更多选项）
      if (format === 'csv' && examId) {
        await handleCsvBackendExport();
        return;
      }

      let content: string;
      let filename: string;
      let mimeType: string;

      const baseName = examName?.replace(/[/\\?%*:|"<>]/g, '-') || 'question-bank';
      const timestamp = new Date().toISOString().slice(0, 10);

      switch (format) {
        case 'json':
          content = generateJsonExport();
          filename = `${baseName}-${timestamp}.json`;
          mimeType = 'application/json';
          break;
        case 'txt':
          content = generateTxtExport();
          filename = `${baseName}-${timestamp}.md`;
          mimeType = 'text/markdown';
          break;
        case 'csv':
          content = generateCsvExport();
          filename = `${baseName}-${timestamp}.csv`;
          mimeType = 'text/csv';
          break;
        default:
          throw new Error(t('exam_sheet:questionBank.export.unknownFormat'));
      }

      const result = await fileManager.saveTextFile({
        title: t('exam_sheet:questionBank.export.selectPath', '选择导出位置'),
        defaultFileName: filename,
        filters: [{ name: format.toUpperCase(), extensions: [format === 'txt' ? 'md' : format] }],
        content,
      });

      if (!result.canceled) {
        setExportSuccess(true);
        setTimeout(() => {
          onOpenChange(false);
          setExportSuccess(false);
        }, 1500);
      }
    } catch (err: unknown) {
      console.error('[QuestionBankExportDialog] Export failed:', err);
      showGlobalNotification('error', t('exam_sheet:questionBank.export.failed', '导出失败'));
    } finally {
      setIsExporting(false);
    }
  }, [format, examName, examId, generateJsonExport, generateTxtExport, generateCsvExport, handleCsvBackendExport, onOpenChange, t]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download className="w-5 h-5" />
            {t('exam_sheet:questionBank.export.title', '导出题目')}
          </DialogTitle>
          <DialogDescription>
            {t('exam_sheet:questionBank.export.description', '将 {{count}} 道题目导出为文件', {
              count: questions.length,
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* 格式选择 */}
          <div className="space-y-3">
            <Label>{t('exam_sheet:questionBank.export.format', '导出格式')}</Label>
            <div className="space-y-2">
              {(['json', 'txt', 'csv'] as ExportFormat[]).map((f) => (
                <div
                  key={f}
                  className={cn(
                    'flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
                    format === f
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:bg-muted/50'
                  )}
                  onClick={() => setFormat(f)}
                >
                  <div className={cn(
                    'w-4 h-4 rounded-full border-2 flex items-center justify-center',
                    format === f ? 'border-primary' : 'border-muted-foreground/50'
                  )}>
                    {format === f && <div className="w-2 h-2 rounded-full bg-primary" />}
                  </div>
                  <div className="flex-shrink-0 text-muted-foreground">
                    {formatIcons[f]}
                  </div>
                  <div className="flex-1">
                    <span className="cursor-pointer font-medium text-sm">
                      {formatLabels[f]}
                    </span>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {t(FORMAT_DESC_KEYS[f])}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 导出选项 */}
          <div className="space-y-3">
            <Label>{t('exam_sheet:questionBank.export.options', '导出内容')}</Label>
            
            {/* JSON/TXT 格式的选项 */}
            {format !== 'csv' && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="include-answer"
                    checked={options.includeAnswer}
                    onCheckedChange={(c) => handleOptionChange('includeAnswer', !!c)}
                  />
                  <Label htmlFor="include-answer" className="cursor-pointer text-sm">
                    {t('exam_sheet:questionBank.export.includeAnswer', '包含答案')}
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="include-explanation"
                    checked={options.includeExplanation}
                    onCheckedChange={(c) => handleOptionChange('includeExplanation', !!c)}
                  />
                  <Label htmlFor="include-explanation" className="cursor-pointer text-sm">
                    {t('exam_sheet:questionBank.export.includeExplanation', '包含解析')}
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="include-status"
                    checked={options.includeStatus}
                    onCheckedChange={(c) => handleOptionChange('includeStatus', !!c)}
                  />
                  <Label htmlFor="include-status" className="cursor-pointer text-sm">
                    {t('exam_sheet:questionBank.export.includeStatus', '包含学习状态')}
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="include-stats"
                    checked={options.includeStats}
                    onCheckedChange={(c) => handleOptionChange('includeStats', !!c)}
                  />
                  <Label htmlFor="include-stats" className="cursor-pointer text-sm">
                    {t('exam_sheet:questionBank.export.includeStats', '包含答题统计')}
                  </Label>
                </div>
              </div>
            )}

            {/* CSV 格式的高级选项 */}
            {format === 'csv' && examId && (
              <div className="space-y-4">
                {/* 编码选择 */}
                <div className="space-y-2">
                  <Label className="text-sm">
                    {t('exam_sheet:questionBank.export.encoding', '文件编码')}
                  </Label>
                  <AppSelect value={csvEncoding} onValueChange={(v) => setCsvEncoding(v as CsvEncoding)}
                    options={CSV_ENCODING_OPTIONS.map((opt) => ({ value: opt.value, label: opt.label, description: t(`exam_sheet:questionBank.export.encodingDesc.${opt.value}`) }))}
                    variant="outline"
                  />
                </div>

                {/* 包含答题记录 */}
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="csv-include-answer-records"
                    checked={csvIncludeAnswerRecords}
                    onCheckedChange={(c) => handleIncludeAnswerRecordsChange(!!c)}
                  />
                  <Label htmlFor="csv-include-answer-records" className="cursor-pointer text-sm">
                    {t('exam_sheet:questionBank.export.includeAnswerRecords', '包含答题记录')}
                  </Label>
                </div>

                {/* 字段选择（可折叠） */}
                <Collapsible open={showCsvAdvanced} onOpenChange={setShowCsvAdvanced}>
                  <CollapsibleTrigger
                    className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <Settings2 className="w-4 h-4" />
                    <span>{t('exam_sheet:questionBank.export.advancedFields', '字段选择')}</span>
                    <ChevronDown className={cn(
                      'w-4 h-4 transition-transform',
                      showCsvAdvanced && 'rotate-180'
                    )} />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="pt-3">
                    <div className="rounded-lg border border-border p-3 space-y-3">
                      {/* 全选/取消全选 */}
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">
                          {t('exam_sheet:questionBank.export.selectedFields', '已选 {{count}} 个字段', {
                            count: csvFields.size,
                          })}
                        </span>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            className="text-primary hover:underline"
                            onClick={() => handleSelectAllCsvFields(true)}
                          >
                            {t('common:selectAll', '全选')}
                          </button>
                          <button
                            type="button"
                            className="text-muted-foreground hover:text-foreground"
                            onClick={() => handleSelectAllCsvFields(false)}
                          >
                            {t('common:deselectAll', '重置')}
                          </button>
                        </div>
                      </div>
                      {/* 字段列表 */}
                      <div className="grid grid-cols-2 gap-2">
                        {CSV_EXPORTABLE_FIELDS.map((field) => (
                          <div key={field.key} className="flex items-center gap-2">
                            <Checkbox
                              id={`csv-field-${field.key}`}
                              checked={csvFields.has(field.key)}
                              onCheckedChange={(c) => handleCsvFieldToggle(field.key, !!c)}
                              disabled={field.key === 'content'} // content 是必需的
                            />
                            <Label
                              htmlFor={`csv-field-${field.key}`}
                              className={cn(
                                'cursor-pointer text-xs',
                                field.key === 'content' && 'text-muted-foreground'
                              )}
                            >
                              {t(`exam_sheet:questionBank.export.fields.${field.key}`)}
                            </Label>
                          </div>
                        ))}
                      </div>
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              </div>
            )}

            {/* CSV 格式但没有 examId 时的提示 */}
            {format === 'csv' && !examId && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="include-answer"
                    checked={options.includeAnswer}
                    onCheckedChange={(c) => handleOptionChange('includeAnswer', !!c)}
                  />
                  <Label htmlFor="include-answer" className="cursor-pointer text-sm">
                    {t('exam_sheet:questionBank.export.includeAnswer', '包含答案')}
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="include-explanation"
                    checked={options.includeExplanation}
                    onCheckedChange={(c) => handleOptionChange('includeExplanation', !!c)}
                  />
                  <Label htmlFor="include-explanation" className="cursor-pointer text-sm">
                    {t('exam_sheet:questionBank.export.includeExplanation', '包含解析')}
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="include-status"
                    checked={options.includeStatus}
                    onCheckedChange={(c) => handleOptionChange('includeStatus', !!c)}
                  />
                  <Label htmlFor="include-status" className="cursor-pointer text-sm">
                    {t('exam_sheet:questionBank.export.includeStatus', '包含学习状态')}
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="include-stats"
                    checked={options.includeStats}
                    onCheckedChange={(c) => handleOptionChange('includeStats', !!c)}
                  />
                  <Label htmlFor="include-stats" className="cursor-pointer text-sm">
                    {t('exam_sheet:questionBank.export.includeStats', '包含答题统计')}
                  </Label>
                </div>
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <NotionButton variant="ghost" onClick={() => onOpenChange(false)} disabled={isExporting}>
            {t('common:cancel', '取消')}
          </NotionButton>
          <NotionButton onClick={handleExport} disabled={isExporting || questions.length === 0}>
            {isExporting ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : exportSuccess ? (
              <CheckCircle2 className="w-4 h-4 mr-2 text-green-500" />
            ) : (
              <Download className="w-4 h-4 mr-2" />
            )}
            {exportSuccess
              ? t('exam_sheet:questionBank.export.success', '导出成功')
              : t('exam_sheet:questionBank.export.button', '导出')}
          </NotionButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default QuestionBankExportDialog;
