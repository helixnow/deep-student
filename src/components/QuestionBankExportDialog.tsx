/**
 * 智能题目集导出对话框
 * 
 * P2-2 功能：支持多种格式导出题目
 * 
 * 🆕 2026-01 新增
 * 🔄 2026-01 增强：添加 CSV 高级导出选项（字段选择、编码选择、答题记录）
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { NotionDialog, NotionDialogHeader, NotionDialogTitle, NotionDialogDescription, NotionDialogBody, NotionDialogFooter } from '@/components/ui/NotionDialog';
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
  FileJs,
  FileText,
  Table,
  CircleNotch,
  CheckCircle,
  CaretDown,
  GearSix,
  ArrowLeft,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { fileManager } from '@/utils/fileManager';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
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
  /**
   * inline 模式（移动端）：不渲染 NotionDialog 浮层，改为渲染宿主容器内的
   * 全屏内联导出面板（absolute inset-0，步骤条式：选格式 → 选项 → 导出）。
   * 顶栏返回逐级回退步骤，Android 返回键同路径；桌面端保持模态 Dialog。
   */
  inline?: boolean;
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
  { key: 'images', default: false },
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
  json: <FileJs size={20} />,
  txt: <FileText size={20} />,
  csv: <Table size={20} />,
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
  inline = false,
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

  // inline 模式步骤：0 选格式 → 1 导出选项 → 2 确认导出
  const [inlineStep, setInlineStep] = useState(0);
  const inlineStepRef = useRef(0);
  inlineStepRef.current = inlineStep;

  useEffect(() => {
    if (open) setInlineStep(0);
  }, [open]);

  // inline 面板返回：先逐级回退步骤，再关闭面板（顶栏返回与 Android 返回键同路径）
  const handleInlineBack = useCallback(() => {
    if (inlineStepRef.current > 0) {
      setInlineStep((s) => Math.max(0, s - 1));
    } else {
      onOpenChange(false);
    }
  }, [onOpenChange]);

  useEffect(() => {
    if (!inline || !open) return;
    return registerBackHandler(() => {
      handleInlineBack();
      return true;
    }, BACK_PRIORITY.overlay);
  }, [inline, open, handleInlineBack]);

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
      let value = field;
      const first = value.charAt(0);
      const dangerousPrefix = ['=', '+', '-', '@', '\t', '\r', '\n'].includes(first);
      if (dangerousPrefix) {
        value = `\t${value}`;
      }
      if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r') || dangerousPrefix) {
        return `"${value.replace(/"/g, '""')}"`;
      }
      return value;
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
        ...(options.includeStats ? [String(q.attemptCount ?? 0), String(q.correctCount ?? 0)] : []),
      ];
      return row.join(',');
    });

    return [headers.join(','), ...rows].join('\n');
  }, [questions, options, t]);

  // CSV 高级导出（通过后端）
  const handleCsvBackendExport = useCallback(async () => {
    if (!examId) {
      showGlobalNotification('error', t('exam_sheet:questionBank.export.noExamId'));
      return;
    }

    const baseName = examName?.replace(/[/\\?%*:|"<>]/g, '-') || 'question-bank';
    const timestamp = new Date().toISOString().slice(0, 10);
    const defaultFileName = `${baseName}-${timestamp}.csv`;

    try {
      // 选择保存路径
      const savePath = await fileManager.pickSavePath({
        title: t('exam_sheet:questionBank.export.selectPath'),
        defaultFileName,
        filters: [{ name: 'CSV', extensions: ['csv'] }],
      });

      if (!savePath) {
        showGlobalNotification('info', t('common:cancel'));
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
        t('exam_sheet:questionBank.export.csvSuccess', {
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
      showGlobalNotification('error', t('exam_sheet:questionBank.export.csvFailed', {
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
        title: t('exam_sheet:questionBank.export.selectPath'),
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
      showGlobalNotification('error', t('exam_sheet:questionBank.export.failed'));
    } finally {
      setIsExporting(false);
    }
  }, [format, examName, examId, generateJsonExport, generateTxtExport, generateCsvExport, handleCsvBackendExport, onOpenChange, t]);

  // ==================== 共享内容分区（Dialog 与 inline 面板复用） ====================

  // 格式选择分区
  const formatSection = (
          <div className="space-y-3">
            <Label>{t('exam_sheet:questionBank.export.format')}</Label>
            <div className="space-y-2">
              {(['json', 'txt', 'csv'] as ExportFormat[]).map((f) => (
                <div
                  key={f}
                  className={cn(
                    'flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
                    format === f
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:bg-[var(--interactive-hover)]'
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
  );

  // 导出选项分区
  const optionsSection = (
          <div className="space-y-3">
            <Label>{t('exam_sheet:questionBank.export.options')}</Label>
            
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
                    {t('exam_sheet:questionBank.export.includeAnswer')}
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="include-explanation"
                    checked={options.includeExplanation}
                    onCheckedChange={(c) => handleOptionChange('includeExplanation', !!c)}
/>
                  <Label htmlFor="include-explanation" className="cursor-pointer text-sm">
                    {t('exam_sheet:questionBank.export.includeExplanation')}
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="include-status"
                    checked={options.includeStatus}
                    onCheckedChange={(c) => handleOptionChange('includeStatus', !!c)}
/>
                  <Label htmlFor="include-status" className="cursor-pointer text-sm">
                    {t('exam_sheet:questionBank.export.includeStatus')}
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="include-stats"
                    checked={options.includeStats}
                    onCheckedChange={(c) => handleOptionChange('includeStats', !!c)}
/>
                  <Label htmlFor="include-stats" className="cursor-pointer text-sm">
                    {t('exam_sheet:questionBank.export.includeStats')}
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
                    {t('exam_sheet:questionBank.export.encoding')}
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
                    {t('exam_sheet:questionBank.export.includeAnswerRecords')}
                  </Label>
                </div>

                {/* 字段选择（可折叠） */}
                <Collapsible open={showCsvAdvanced} onOpenChange={setShowCsvAdvanced}>
                  <CollapsibleTrigger
                    className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <GearSix size={16} />
                    <span>{t('exam_sheet:questionBank.export.advancedFields')}</span>
                    <CaretDown className={cn(
                      'w-4 h-4 transition-transform',
                      showCsvAdvanced && 'rotate-180'
                    )} />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="pt-3">
                    <div className="rounded-lg border border-border p-3 space-y-3">
                      {/* 全选/取消全选 */}
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">
                          {t('exam_sheet:questionBank.export.selectedFields', {
                            count: csvFields.size,
                          })}
                        </span>
                        <div className="flex gap-2">
                          <NotionButton variant="ghost" size="sm" onClick={() => handleSelectAllCsvFields(true)} className="!h-auto !p-0 text-primary hover:underline">
                            {t('common:contextMenu.selectAll')}
                          </NotionButton>
                          <NotionButton variant="ghost" size="sm" onClick={() => handleSelectAllCsvFields(false)} className="!h-auto !p-0 text-muted-foreground hover:text-foreground">
                            {t('common:deselect_all')}
                          </NotionButton>
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
                              {t(
                                `exam_sheet:questionBank.export.fields.${field.key}`,
                                field.key
                              )}
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
                    {t('exam_sheet:questionBank.export.includeAnswer')}
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="include-explanation"
                    checked={options.includeExplanation}
                    onCheckedChange={(c) => handleOptionChange('includeExplanation', !!c)}
/>
                  <Label htmlFor="include-explanation" className="cursor-pointer text-sm">
                    {t('exam_sheet:questionBank.export.includeExplanation')}
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="include-status"
                    checked={options.includeStatus}
                    onCheckedChange={(c) => handleOptionChange('includeStatus', !!c)}
/>
                  <Label htmlFor="include-status" className="cursor-pointer text-sm">
                    {t('exam_sheet:questionBank.export.includeStatus')}
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="include-stats"
                    checked={options.includeStats}
                    onCheckedChange={(c) => handleOptionChange('includeStats', !!c)}
/>
                  <Label htmlFor="include-stats" className="cursor-pointer text-sm">
                    {t('exam_sheet:questionBank.export.includeStats')}
                  </Label>
                </div>
              </div>
            )}
          </div>
  );

  // 导出主按钮（两种形态共用）
  const exportButton = (
    <NotionButton onClick={handleExport} disabled={isExporting || questions.length === 0}>
      {isExporting ? (
        <CircleNotch size={16} className="mr-2 animate-spin" />
      ) : exportSuccess ? (
        <CheckCircle size={16} className="mr-2 text-green-500" />
      ) : (
        <Download size={16} className="mr-2" />
      )}
      {exportSuccess
        ? t('exam_sheet:questionBank.export.success')
        : t('exam_sheet:questionBank.export.button')}
    </NotionButton>
  );

  // ==================== inline 模式：全屏内联导出面板（移动端） ====================
  if (inline) {
    if (!open) return null;

    const stepLabels = [
      t('exam_sheet:questionBank.export.format'),
      t('exam_sheet:questionBank.export.options'),
      t('exam_sheet:questionBank.export.button'),
    ];

    return (
      <div
        className="absolute inset-0 z-30 flex flex-col bg-background"
        role="dialog"
        aria-label={t('exam_sheet:questionBank.export.title')}
      >
        {/* 顶栏：返回 + 标题 + 步骤位置 */}
        <div className="flex h-12 flex-shrink-0 items-center gap-1.5 border-b border-border/60 px-2">
          <NotionButton
            variant="ghost"
            size="icon"
            iconOnly
            onClick={handleInlineBack}
            aria-label={t('common:back')}
            className="!h-11 !w-11 text-muted-foreground"
          >
            <ArrowLeft size={20} />
          </NotionButton>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Download size={16} className="flex-shrink-0 text-muted-foreground" />
            <span className="truncate text-sm font-medium text-foreground">
              {t('exam_sheet:questionBank.export.title')}
            </span>
          </div>
          <span className="flex-shrink-0 pr-2 text-xs tabular-nums text-muted-foreground">
            {inlineStep + 1}/{stepLabels.length}
          </span>
        </div>

        {/* 步骤条 */}
        <div className="flex flex-shrink-0 items-center gap-1.5 border-b border-border/40 px-4 py-2.5">
          {stepLabels.map((label, index) => (
            <React.Fragment key={label}>
              {index > 0 && <div className="h-px w-4 flex-shrink-0 bg-border" aria-hidden />}
              <button
                type="button"
                onClick={() => {
                  // 只允许回到已完成的步骤，不允许跳步前进
                  if (index < inlineStep) setInlineStep(index);
                }}
                className={cn(
                  'flex min-h-[32px] items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition-colors motion-reduce:transition-none',
                  index === inlineStep
                    ? 'bg-primary/10 font-medium text-primary'
                    : index < inlineStep
                      ? 'text-foreground'
                      : 'text-muted-foreground/60',
                )}
                aria-current={index === inlineStep ? 'step' : undefined}
              >
                <span
                  className={cn(
                    'flex h-4 w-4 items-center justify-center rounded-full text-[10px] tabular-nums',
                    index === inlineStep
                      ? 'bg-primary text-primary-foreground'
                      : index < inlineStep
                        ? 'bg-muted text-foreground'
                        : 'bg-muted text-muted-foreground/60',
                  )}
                >
                  {index < inlineStep ? <CheckCircle size={10} weight="bold" /> : index + 1}
                </span>
                {label}
              </button>
            </React.Fragment>
          ))}
        </div>

        {/* 内容区：全高滚动 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {inlineStep === 0 && formatSection}
          {inlineStep === 1 && optionsSection}
          {inlineStep === 2 && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                {t('exam_sheet:questionBank.export.description', { count: questions.length })}
              </p>
              <div className="flex items-center gap-3 rounded-lg border border-border p-3">
                <div className="flex-shrink-0 text-muted-foreground">{formatIcons[format]}</div>
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground">{formatLabels[format]}</div>
                  <p className="mt-0.5 text-xs text-muted-foreground">{t(FORMAT_DESC_KEYS[format])}</p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* 底部操作栏（safe-area 兼容） */}
        <div
          className="flex flex-shrink-0 items-center justify-end gap-2 border-t border-border/60 px-4 pt-3"
          style={{
            paddingBottom:
              'calc(var(--mobile-safe-area-bottom, env(safe-area-inset-bottom, 0px)) + 12px)',
          }}
        >
          <NotionButton
            variant="ghost"
            onClick={handleInlineBack}
            disabled={isExporting}
          >
            {inlineStep === 0 ? t('common:cancel') : t('common:actions.previous')}
          </NotionButton>
          {inlineStep < 2 ? (
            <NotionButton onClick={() => setInlineStep((s) => Math.min(2, s + 1))}>
              {t('common:actions.next')}
            </NotionButton>
          ) : (
            exportButton
          )}
        </div>
      </div>
    );
  }

  // ==================== 桌面端：模态 Dialog ====================
  return (
    <NotionDialog open={open} onOpenChange={onOpenChange} maxWidth="max-w-md">
        <NotionDialogHeader>
          <NotionDialogTitle className="flex items-center gap-2">
            <Download size={20} />
            {t('exam_sheet:questionBank.export.title')}
          </NotionDialogTitle>
          <NotionDialogDescription>
            {t('exam_sheet:questionBank.export.description', {
              count: questions.length,
            })}
          </NotionDialogDescription>
        </NotionDialogHeader>
        <NotionDialogBody>

        <div className="space-y-6 py-4">
          {formatSection}
          {optionsSection}
        </div>

        </NotionDialogBody>
        <NotionDialogFooter>
          <NotionButton variant="ghost" onClick={() => onOpenChange(false)} disabled={isExporting}>
            {t('common:cancel')}
          </NotionButton>
          {exportButton}
        </NotionDialogFooter>
    </NotionDialog>
  );
};

export default QuestionBankExportDialog;
