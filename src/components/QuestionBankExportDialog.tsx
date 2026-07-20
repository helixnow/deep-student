/**
 * 智能题目集导出面板
 *
 * P2-2 功能：支持多种格式导出题目
 *
 * 🆕 2026-01 新增
 * 🔄 2026-01 增强：添加 CSV 高级导出选项（字段选择、编码选择、答题记录）
 * 🔄 2026-07 改造：项目禁用模态框 —— `open` / `onOpenChange` 接口保持不变，
 *    内部渲染为占满宿主容器的内联面板（absolute inset-0，无遮罩弹窗）。
 *    字段选择改为 chip 多选，编码/格式改为分段控件，实时预览导出列，
 *    导出完成后内联展示保存路径与"打开所在文件夹"入口。
 */

import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { NotionButton } from '@/components/ui/NotionButton';
import { Label } from '@/components/ui/shad/Label';
import {
  Download,
  FileJs,
  FileText,
  Table,
  CircleNotch,
  CheckCircle,
  ArrowLeft,
  FolderOpen,
  Check,
  X,
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
   * inline 模式（移动端）：步骤条式向导（选格式 → 选项 → 导出），顶栏返回
   * 逐级回退步骤，Android 返回键同路径；桌面端为单页内联面板。
   * 两种形态都渲染宿主容器内的内联区块（absolute inset-0），不使用模态浮层。
   */
  inline?: boolean;
}

interface ExportOptions {
  includeAnswer: boolean;
  includeExplanation: boolean;
  includeStatus: boolean;
  includeStats: boolean;
}

/** 导出完成信息（用于内联成功态展示保存路径） */
interface ExportOutcome {
  path: string;
  count: number;
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
  json: <FileJs size={16} />,
  txt: <FileText size={16} />,
  csv: <Table size={16} />,
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

/** 通用 chip 多选按钮（选中态带对勾） */
const FieldChip: React.FC<{
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ selected, disabled, onClick, children }) => (
  <button
    type="button"
    disabled={disabled}
    onClick={onClick}
    aria-pressed={selected}
    className={cn(
      'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs ui-state-colors',
      selected
        ? 'border-primary/50 bg-primary/10 font-medium text-primary'
        : 'border-border/60 bg-transparent text-muted-foreground hover:bg-[var(--interactive-hover)] hover:text-foreground',
      disabled && 'cursor-not-allowed opacity-60'
    )}
  >
    {selected && <Check size={11} weight="bold" />}
    {children}
  </button>
);

/** 分段控件（格式 / 编码共用） */
const SegmentedControl = <T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: Array<{ value: T; label: React.ReactNode }>;
  onChange: (value: T) => void;
  ariaLabel: string;
}) => (
  <div
    className="inline-flex w-full rounded-md border border-border/60 bg-muted/30 p-0.5"
    role="group"
    aria-label={ariaLabel}
  >
    {options.map((opt) => (
      <button
        key={opt.value}
        type="button"
        onClick={() => onChange(opt.value)}
        aria-pressed={value === opt.value}
        className={cn(
          'flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-[5px] px-2 py-1.5 text-xs ui-state-colors [@media(pointer:coarse)]:min-h-10',
          value === opt.value
            ? 'bg-background font-medium text-foreground shadow-sm'
            : 'text-muted-foreground hover:text-foreground'
        )}
      >
        {opt.label}
      </button>
    ))}
  </div>
);

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
  // 导出成功后内联展示保存路径（替代原先 1.5s 自动关闭的模态行为）
  const [exportOutcome, setExportOutcome] = useState<ExportOutcome | null>(null);

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

  // inline 模式步骤：0 选格式 → 1 导出选项 → 2 确认导出
  const [inlineStep, setInlineStep] = useState(0);
  const inlineStepRef = useRef(0);
  inlineStepRef.current = inlineStep;
  const exportOutcomeRef = useRef<ExportOutcome | null>(null);
  exportOutcomeRef.current = exportOutcome;

  useEffect(() => {
    if (open) {
      setInlineStep(0);
      setExportOutcome(null);
    }
  }, [open]);

  // inline 面板返回：先逐级回退步骤，再关闭面板（顶栏返回与 Android 返回键同路径）；
  // 成功态下直接关闭（此时步骤条已隐藏，回退步骤对用户不可见）
  const handleInlineBack = useCallback(() => {
    if (exportOutcomeRef.current) {
      onOpenChange(false);
      return;
    }
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
  const handleCsvFieldToggle = useCallback((field: string) => {
    setCsvFields((prev) => {
      const next = new Set(prev);
      if (next.has(field)) {
        next.delete(field);
      } else {
        next.add(field);
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

  // 实时预览导出列（随格式/字段/选项变化）
  const previewColumns = useMemo((): string[] => {
    const fieldLabel = (key: string) => t(`exam_sheet:questionBank.export.fields.${key}`, key);
    if (format === 'csv' && examId) {
      return CSV_EXPORTABLE_FIELDS
        .filter((f) => csvFields.has(f.key))
        .map((f) => fieldLabel(f.key));
    }
    const header = (key: string) => t(`exam_sheet:questionBank.export.csvHeaders.${key}`);
    return [
      header('label'),
      header('question'),
      header('type'),
      header('options'),
      ...(options.includeAnswer ? [header('answer')] : []),
      ...(options.includeExplanation ? [header('explanation')] : []),
      header('difficulty'),
      header('tags'),
      ...(options.includeStatus ? [header('status')] : []),
      ...(options.includeStats ? [header('attempts'), header('correctCount')] : []),
    ];
  }, [format, examId, csvFields, options, t]);

  // CSV 高级导出（通过后端）；返回导出结果（用户取消保存框时返回 null）
  const handleCsvBackendExport = useCallback(async (): Promise<ExportOutcome | null> => {
    if (!examId) {
      showGlobalNotification('error', t('exam_sheet:questionBank.export.noExamId'));
      return null;
    }

    const baseName = examName?.replace(/[/\\?%*:|"<>]/g, '-') || 'question-bank';
    const timestamp = new Date().toISOString().slice(0, 10);
    const defaultFileName = `${baseName}-${timestamp}.csv`;

    // 选择保存路径
    const savePath = await fileManager.pickSavePath({
      title: t('exam_sheet:questionBank.export.selectPath'),
      defaultFileName,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });

    if (!savePath) {
      return null;
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

    return {
      path: result.file_path || savePath,
      count: result.exported_count,
    };
  }, [examId, examName, csvFields, csvIncludeAnswerRecords, csvEncoding, t]);

  const handleExport = useCallback(async () => {
    if (isExporting) return;
    setIsExporting(true);

    try {
      // CSV 格式且有 examId 时使用后端导出（支持更多选项）
      if (format === 'csv' && examId) {
        try {
          const outcome = await handleCsvBackendExport();
          if (outcome) {
            setExportOutcome(outcome);
          }
        } catch (error: unknown) {
          console.error('[QuestionBankExportDialog] CSV export failed:', error);
          showGlobalNotification('error', t('exam_sheet:questionBank.export.csvFailed', {
            error: String(error),
          }));
        }
        return;
      }

      let content: string;
      let filename: string;

      const baseName = examName?.replace(/[/\\?%*:|"<>]/g, '-') || 'question-bank';
      const timestamp = new Date().toISOString().slice(0, 10);

      switch (format) {
        case 'json':
          content = generateJsonExport();
          filename = `${baseName}-${timestamp}.json`;
          break;
        case 'txt':
          content = generateTxtExport();
          filename = `${baseName}-${timestamp}.md`;
          break;
        case 'csv':
          content = generateCsvExport();
          filename = `${baseName}-${timestamp}.csv`;
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

      if (!result.canceled && result.path) {
        setExportOutcome({ path: result.path, count: questions.length });
        showGlobalNotification('success', t('exam_sheet:questionBank.export.success'));
      }
    } catch (err: unknown) {
      console.error('[QuestionBankExportDialog] Export failed:', err);
      showGlobalNotification('error', t('exam_sheet:questionBank.export.failed'));
    } finally {
      setIsExporting(false);
    }
  }, [isExporting, format, examName, examId, questions.length, generateJsonExport, generateTxtExport, generateCsvExport, handleCsvBackendExport, t]);

  // 打开导出文件所在文件夹（桌面端 plugin-opener）
  const handleRevealInFolder = useCallback(async () => {
    if (!exportOutcome) return;
    try {
      const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
      await revealItemInDir(exportOutcome.path);
    } catch (error: unknown) {
      console.error('[QuestionBankExportDialog] reveal in folder failed:', error);
      showGlobalNotification('error', t('exam_sheet:questionBank.export.openFolderFailed'));
    }
  }, [exportOutcome, t]);

  // ==================== 共享内容分区（桌面单页 / 移动向导共用） ====================

  // 格式选择分区（分段控件 + 当前格式说明）
  const formatSection = (
    <div className="space-y-2">
      <Label>{t('exam_sheet:questionBank.export.format')}</Label>
      <SegmentedControl
        value={format}
        onChange={(value) => setFormat(value as ExportFormat)}
        ariaLabel={t('exam_sheet:questionBank.export.format')}
        options={(['json', 'txt', 'csv'] as ExportFormat[]).map((f) => ({
          value: f,
          label: (
            <>
              {formatIcons[f]}
              <span className="truncate">{formatLabels[f]}</span>
            </>
          ),
        }))}
      />
      <p className="text-xs text-muted-foreground">{t(FORMAT_DESC_KEYS[format])}</p>
    </div>
  );

  // JSON/TXT（以及无 examId 的 CSV）内容选项：chip 多选
  const simpleOptionChips = (
    <div className="flex flex-wrap gap-1.5">
      {([
        ['includeAnswer', t('exam_sheet:questionBank.export.includeAnswer')],
        ['includeExplanation', t('exam_sheet:questionBank.export.includeExplanation')],
        ['includeStatus', t('exam_sheet:questionBank.export.includeStatus')],
        ['includeStats', t('exam_sheet:questionBank.export.includeStats')],
      ] as Array<[keyof ExportOptions, string]>).map(([key, label]) => (
        <FieldChip
          key={key}
          selected={options[key]}
          onClick={() => handleOptionChange(key, !options[key])}
        >
          {label}
        </FieldChip>
      ))}
    </div>
  );

  // 导出选项分区
  const optionsSection = (
    <div className="space-y-3">
      <Label>{t('exam_sheet:questionBank.export.options')}</Label>

      {/* JSON/TXT 格式（以及缺少 examId 的 CSV）的内容选项 */}
      {(format !== 'csv' || !examId) && simpleOptionChips}

      {/* CSV 格式的高级选项 */}
      {format === 'csv' && examId && (
        <div className="space-y-4">
          {/* 编码选择：分段控件 */}
          <div className="space-y-2">
            <Label className="text-sm">
              {t('exam_sheet:questionBank.export.encoding')}
            </Label>
            <SegmentedControl
              value={csvEncoding}
              onChange={(value) => setCsvEncoding(value as CsvEncoding)}
              ariaLabel={t('exam_sheet:questionBank.export.encoding')}
              options={CSV_ENCODING_OPTIONS.map((opt) => ({ value: opt.value, label: opt.label }))}
            />
            <p className="text-xs text-muted-foreground">
              {t(`exam_sheet:questionBank.export.encodingDesc.${csvEncoding}`)}
            </p>
          </div>

          {/* 包含答题记录 */}
          <FieldChip
            selected={csvIncludeAnswerRecords}
            onClick={() => handleIncludeAnswerRecordsChange(!csvIncludeAnswerRecords)}
          >
            {t('exam_sheet:questionBank.export.includeAnswerRecords')}
          </FieldChip>

          {/* 字段选择：chip 多选 */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm">
                {t('exam_sheet:questionBank.export.advancedFields')}
              </Label>
              <div className="flex items-center gap-2 text-xs">
                <span className="text-muted-foreground">
                  {t('exam_sheet:questionBank.export.selectedFields', { count: csvFields.size })}
                </span>
                <NotionButton variant="ghost" size="sm" onClick={() => handleSelectAllCsvFields(true)} className="!h-auto !p-0 text-primary hover:underline">
                  {t('common:contextMenu.selectAll')}
                </NotionButton>
                <NotionButton variant="ghost" size="sm" onClick={() => handleSelectAllCsvFields(false)} className="!h-auto !p-0 text-muted-foreground hover:text-foreground">
                  {t('common:deselect_all')}
                </NotionButton>
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {CSV_EXPORTABLE_FIELDS.map((field) => (
                <FieldChip
                  key={field.key}
                  selected={csvFields.has(field.key)}
                  disabled={field.key === 'content'} // content 是必需的
                  onClick={() => handleCsvFieldToggle(field.key)}
                >
                  {t(`exam_sheet:questionBank.export.fields.${field.key}`, field.key)}
                </FieldChip>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {t('exam_sheet:questionBank.export.fieldsHint')}
            </p>
          </div>
        </div>
      )}
    </div>
  );

  // 实时导出列预览分区
  const columnsPreviewSection = (
    <div className="space-y-2">
      <Label className="text-sm">{t('exam_sheet:questionBank.export.columnsPreview')}</Label>
      <div className="flex flex-wrap items-center gap-1 rounded-md border border-border/50 bg-muted/20 p-2">
        {previewColumns.map((col, index) => (
          <span
            key={`${col}-${index}`}
            className="rounded bg-background px-1.5 py-0.5 text-[11px] text-foreground shadow-sm ui-rise-in"
          >
            {col}
          </span>
        ))}
      </div>
    </div>
  );

  // 导出成功态：保存路径 + 打开所在文件夹
  const successSection = exportOutcome && (
    <div className="space-y-4 ui-rise-in">
      <div className="space-y-2 text-center">
        <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-success/10 ui-zoom-fade-in">
          <CheckCircle size={22} weight="fill" className="text-success" />
        </div>
        <h3 className="text-base font-semibold">{t('exam_sheet:questionBank.export.success')}</h3>
        <p className="text-sm text-muted-foreground">
          {t('exam_sheet:questionBank.export.exportedCount', { count: exportOutcome.count })}
        </p>
      </div>
      <div className="space-y-1 rounded-md border border-border/50 bg-muted/30 p-3">
        <div className="text-xs text-muted-foreground">{t('exam_sheet:questionBank.export.savedTo')}</div>
        <div className="break-all font-mono text-xs text-foreground">{exportOutcome.path}</div>
      </div>
      <div className="flex justify-center">
        <NotionButton variant="outline" size="sm" onClick={() => void handleRevealInFolder()}>
          <FolderOpen size={16} className="mr-1.5" />
          {t('exam_sheet:questionBank.export.openFolder')}
        </NotionButton>
      </div>
    </div>
  );

  // 导出主按钮（两种形态共用）
  const exportButton = (
    <NotionButton onClick={() => void handleExport()} disabled={isExporting || questions.length === 0}>
      {isExporting ? (
        <CircleNotch size={16} className="mr-2 animate-spin" />
      ) : (
        <Download size={16} className="mr-2" />
      )}
      {t('exam_sheet:questionBank.export.button')}
    </NotionButton>
  );

  if (!open) return null;

  // ==================== inline 模式：全屏内联导出面板（移动端向导） ====================
  if (inline) {
    const stepLabels = [
      t('exam_sheet:questionBank.export.format'),
      t('exam_sheet:questionBank.export.options'),
      t('exam_sheet:questionBank.export.button'),
    ];

    return (
      <div
        className="absolute inset-0 z-30 flex flex-col bg-background ui-rise-in"
        role="region"
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
          {!exportOutcome && (
            <span className="flex-shrink-0 pr-2 text-xs tabular-nums text-muted-foreground">
              {inlineStep + 1}/{stepLabels.length}
            </span>
          )}
        </div>

        {/* 步骤条（成功态隐藏） */}
        {!exportOutcome && (
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
        )}

        {/* 内容区：全高滚动（key 触发步骤切换滑动过渡） */}
        <div
          key={exportOutcome ? 'success' : inlineStep}
          className="min-h-0 flex-1 overflow-y-auto px-4 py-4 ui-slide-fade-in [--ui-enter-x:24px]"
        >
          {exportOutcome ? (
            successSection
          ) : (
            <>
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
                  {columnsPreviewSection}
                </div>
              )}
            </>
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
          {exportOutcome ? (
            <NotionButton onClick={() => onOpenChange(false)}>
              {t('exam_sheet:questionBank.export.done')}
            </NotionButton>
          ) : (
            <>
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
            </>
          )}
        </div>
      </div>
    );
  }

  // ==================== 桌面端：单页内联面板（占满宿主容器，无模态浮层） ====================
  return (
    <div
      className="absolute inset-0 z-30 flex flex-col bg-background ui-rise-in"
      role="region"
      aria-label={t('exam_sheet:questionBank.export.title')}
    >
      {/* 顶栏：标题 + 关闭 */}
      <div className="flex h-12 flex-shrink-0 items-center gap-2 border-b border-border/60 px-4">
        <Download size={16} className="flex-shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {t('exam_sheet:questionBank.export.title')}
        </span>
        <NotionButton
          variant="ghost"
          size="icon"
          iconOnly
          onClick={() => onOpenChange(false)}
          disabled={isExporting}
          aria-label={t('common:close')}
          className="text-muted-foreground"
        >
          <X size={16} />
        </NotionButton>
      </div>

      {/* 内容区 */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto w-full max-w-md space-y-6 py-2">
          {exportOutcome ? (
            successSection
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                {t('exam_sheet:questionBank.export.description', { count: questions.length })}
              </p>
              {formatSection}
              {optionsSection}
              {columnsPreviewSection}
            </>
          )}
        </div>
      </div>

      {/* 底部操作栏 */}
      <div className="flex flex-shrink-0 items-center justify-end gap-2 border-t border-border/60 px-4 py-3">
        {exportOutcome ? (
          <NotionButton onClick={() => onOpenChange(false)}>
            {t('exam_sheet:questionBank.export.done')}
          </NotionButton>
        ) : (
          <>
            <NotionButton variant="ghost" onClick={() => onOpenChange(false)} disabled={isExporting}>
              {t('common:cancel')}
            </NotionButton>
            {exportButton}
          </>
        )}
      </div>
    </div>
  );
};

export default QuestionBankExportDialog;
