/**
 * CSV 字段映射组件
 * 
 * 提供表格形式的字段映射界面，用户可以将 CSV 列映射到题目字段
 * 
 * Notion 风格 UI：
 * - 简洁的表格设计
 * - 下拉选择框
 * - 实时预览映射后的数据
 */

import React, { useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/shad/Table';
import { AppSelect } from '@/components/ui/app-menu';
import { Badge } from '@/components/ui/shad/Badge';
import { AlertCircle, CheckCircle2, Link2, Link2Off } from 'lucide-react';
import { cn } from '@/lib/utils';

// 可映射的目标字段 (labels resolved via i18n at render time)
export const QUESTION_FIELDS = [
  { key: 'content', required: true },
  { key: 'question_type', required: false },
  { key: 'options', required: false },
  { key: 'answer', required: false },
  { key: 'explanation', required: false },
  { key: 'difficulty', required: false },
  { key: 'tags', required: false },
  { key: 'question_label', required: false },
] as const;

export type QuestionFieldKey = typeof QUESTION_FIELDS[number]['key'];

export interface FieldMapping {
  [csvColumn: string]: QuestionFieldKey | '';
}

interface CsvFieldMapperProps {
  /** CSV 表头列名 */
  headers: string[];
  /** 预览行数据（前几行） */
  previewRows: string[][];
  /** 当前字段映射 */
  fieldMapping: FieldMapping;
  /** 映射变更回调 */
  onMappingChange: (mapping: FieldMapping) => void;
  /** 是否显示预览数据 */
  showPreview?: boolean;
  /** 是否只读模式 */
  readonly?: boolean;
}

export const CsvFieldMapper: React.FC<CsvFieldMapperProps> = ({
  headers,
  previewRows,
  fieldMapping,
  onMappingChange,
  showPreview = true,
  readonly = false,
}) => {
  const { t } = useTranslation(['exam_sheet', 'common']);

  // 检查哪些必需字段已映射
  const mappedFields = useMemo(() => {
    const mapped = new Set<string>();
    Object.values(fieldMapping).forEach((field) => {
      if (field) mapped.add(field);
    });
    return mapped;
  }, [fieldMapping]);

  // 检查 content 是否已映射（必需）
  const isContentMapped = mappedFields.has('content');

  // 获取某列的已选目标字段
  const getColumnTarget = useCallback(
    (header: string): QuestionFieldKey | '' => {
      return fieldMapping[header] || '';
    },
    [fieldMapping]
  );

  // 处理映射变更
  const handleMappingChange = useCallback(
    (csvColumn: string, targetField: QuestionFieldKey | '') => {
      // 如果选择了新的目标字段，需要清除其他列对该字段的映射
      const newMapping = { ...fieldMapping };
      
      if (targetField) {
        // 清除其他列对同一目标字段的映射
        Object.keys(newMapping).forEach((col) => {
          if (col !== csvColumn && newMapping[col] === targetField) {
            newMapping[col] = '';
          }
        });
      }
      
      newMapping[csvColumn] = targetField;
      onMappingChange(newMapping);
    },
    [fieldMapping, onMappingChange]
  );

  // 自动检测可能的映射（基于列名相似度）
  const suggestMapping = useCallback((header: string): QuestionFieldKey | '' => {
    const headerLower = header.toLowerCase().trim();
    
    // 常见中文和英文列名映射
    const mappings: Record<string, QuestionFieldKey> = {
      // content
      '题目': 'content',
      '题干': 'content',
      '问题': 'content',
      '内容': 'content',
      'content': 'content',
      'question': 'content',
      'text': 'content',
      // answer
      '答案': 'answer',
      '正确答案': 'answer',
      'answer': 'answer',
      'correct': 'answer',
      // explanation
      '解析': 'explanation',
      '解答': 'explanation',
      '说明': 'explanation',
      'explanation': 'explanation',
      'analysis': 'explanation',
      // options
      '选项': 'options',
      'options': 'options',
      'choices': 'options',
      // difficulty
      '难度': 'difficulty',
      'difficulty': 'difficulty',
      'level': 'difficulty',
      // tags
      '标签': 'tags',
      '分类': 'tags',
      '类别': 'tags',
      'tags': 'tags',
      'category': 'tags',
      // question_type
      '题型': 'question_type',
      '类型': 'question_type',
      'type': 'question_type',
      'question_type': 'question_type',
      // question_label
      '题号': 'question_label',
      '序号': 'question_label',
      'label': 'question_label',
      'number': 'question_label',
      'no': 'question_label',
    };
    
    return mappings[headerLower] || '';
  }, []);

  // 获取预览数据中某列的值
  const getPreviewValue = useCallback(
    (colIndex: number): string => {
      if (previewRows.length === 0) return '';
      const firstRow = previewRows[0];
      return firstRow[colIndex] || '';
    },
    [previewRows]
  );

  // 截断长文本
  const truncateText = (text: string, maxLength: number = 50): string => {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength) + '...';
  };

  return (
    <div className="space-y-4">
      {/* 映射状态提示 */}
      <div className="flex items-center gap-4 px-3 py-2 rounded-lg bg-muted/30">
        {isContentMapped ? (
          <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="w-4 h-4" />
            <span className="text-sm">
              {t('exam_sheet:csv.mapping_valid', '字段映射有效，可以开始导入')}
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
            <AlertCircle className="w-4 h-4" />
            <span className="text-sm">
              {t('exam_sheet:csv.mapping_required', '请至少映射「题干内容」字段')}
            </span>
          </div>
        )}
      </div>

      {/* 字段映射表格 */}
      <div className="rounded-lg border border-border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/30 hover:bg-muted/30">
              <TableHead className="w-[180px] font-medium">
                {t('exam_sheet:csv.csv_column', 'CSV 列')}
              </TableHead>
              <TableHead className="w-[180px] font-medium">
                {t('exam_sheet:csv.target_field', '映射字段')}
              </TableHead>
              {showPreview && (
                <TableHead className="font-medium">
                  {t('exam_sheet:csv.preview_value', '预览值')}
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {headers.map((header, index) => {
              const currentTarget = getColumnTarget(header);
              const suggestedTarget = suggestMapping(header);
              const previewValue = getPreviewValue(index);
              const isMapped = !!currentTarget;
              
              return (
                <TableRow 
                  key={header}
                  className={cn(
                    'transition-colors',
                    isMapped && 'bg-primary/5'
                  )}
                >
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {isMapped ? (
                        <Link2 className="w-4 h-4 text-primary" />
                      ) : (
                        <Link2Off className="w-4 h-4 text-muted-foreground/50" />
                      )}
                      <span className="font-mono text-sm">{header}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    {readonly ? (
                      <span className="text-sm">
                        {currentTarget
                          ? t(`exam_sheet:export.fields.${currentTarget}`, currentTarget)
                          : '-'}
                      </span>
                    ) : (
                      <AppSelect
                        value={currentTarget}
                        onValueChange={(value) => handleMappingChange(header, value as QuestionFieldKey | '')}
                        placeholder={t('exam_sheet:csv.select_field', '选择字段...')}
                        options={[
                          { value: '', label: t('exam_sheet:csv.no_mapping', '不映射') },
                          ...QUESTION_FIELDS.map((field) => {
                            const isSelected = currentTarget === field.key;
                            const isUsed = !isSelected && mappedFields.has(field.key);
                            const isSuggested = !currentTarget && suggestedTarget === field.key;
                            const fieldLabel = t(`exam_sheet:export.fields.${field.key}`, field.key);
                            const suffix = field.required ? ` (${t('common:required', '必需')})` : isSuggested && !isUsed ? ` (${t('exam_sheet:csv.suggested', '推荐')})` : '';
                            return {
                              value: field.key,
                              label: `${fieldLabel}${suffix}`,
                              disabled: isUsed,
                            };
                          }),
                        ]}
                        size="sm"
                        variant="outline"
                      />
                    )}
                  </TableCell>
                  {showPreview && (
                    <TableCell>
                      <span className="text-sm text-muted-foreground">
                        {truncateText(previewValue)}
                      </span>
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {/* 预览数据表格（可选） */}
      {showPreview && previewRows.length > 1 && (
        <div className="space-y-2">
          <h4 className="text-sm font-medium text-muted-foreground">
            {t('exam_sheet:csv.data_preview', '数据预览（前 {{count}} 行）', { count: previewRows.length })}
          </h4>
          <div className="rounded-lg border border-border overflow-auto max-h-[200px]">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/30 hover:bg-muted/30">
                  <TableHead className="w-10 text-center">#</TableHead>
                  {headers.map((header) => (
                    <TableHead key={header} className="min-w-[120px]">
                      {header}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {previewRows.map((row, rowIndex) => (
                  <TableRow key={rowIndex}>
                    <TableCell className="text-center text-muted-foreground text-xs">
                      {rowIndex + 1}
                    </TableCell>
                    {headers.map((header, colIndex) => (
                      <TableCell key={header} className="text-sm">
                        {truncateText(row[colIndex] || '', 40)}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
};

export default CsvFieldMapper;
