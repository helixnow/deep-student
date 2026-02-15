/**
 * Chat V2 - SystemPromptEditor 系统 Prompt 编辑器
 *
 * 职责：编辑和管理系统 Prompt
 *
 * 功能：
 * 1. 多行文本编辑
 * 2. 模板选择
 * 3. 变量插入
 * 4. 字数统计
 * 5. 暗色/亮色主题支持
 */

import React, { useCallback, useState, useMemo, useRef } from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import {
  FileText,
  ChevronDown,
  Plus,
  Trash2,
  Copy,
  Check,
  Variable,
  RotateCcw,
} from 'lucide-react';

// ============================================================================
// Props 定义
// ============================================================================

/**
 * 系统 Prompt 模板
 */
export interface SystemPromptTemplate {
  /** 模板 ID */
  id: string;
  /** 模板名称 */
  name: string;
  /** 模板内容 */
  content: string;
  /** 模板描述 */
  description?: string;
  /** 是否为内置模板 */
  builtin?: boolean;
}

/**
 * 变量定义
 */
export interface PromptVariable {
  /** 变量名 */
  name: string;
  /** 显示名称 */
  label: string;
  /** 变量描述 */
  description?: string;
  /** 变量示例值 */
  example?: string;
}

export interface SystemPromptEditorProps {
  /** 当前值 */
  value: string;
  /** 值变化回调 */
  onChange: (value: string) => void;
  /** 可用模板列表 */
  templates?: SystemPromptTemplate[];
  /** 可插入的变量列表 */
  variables?: PromptVariable[];
  /** 占位符 */
  placeholder?: string;
  /** 最大长度 */
  maxLength?: number;
  /** 最小高度 */
  minHeight?: number;
  /** 最大高度 */
  maxHeight?: number;
  /** 是否禁用 */
  disabled?: boolean;
  /** 自定义类名 */
  className?: string;
  /** 保存模板回调 */
  onSaveTemplate?: (template: Omit<SystemPromptTemplate, 'id'>) => void;
  /** 删除模板回调 */
  onDeleteTemplate?: (templateId: string) => void;
}

// ============================================================================
// 默认变量
// ============================================================================

// ★ 文档28清理：移除 subject 变量
// 使用函数生成默认变量，支持 i18n
function getDefaultVariables(t: (key: string) => string): PromptVariable[] {
  return [
    {
      name: 'grade',
      label: t('systemPrompt.variables.grade.label'),
      description: t('systemPrompt.variables.grade.description'),
      example: t('systemPrompt.variables.grade.example'),
    },
    {
      name: 'datetime',
      label: t('systemPrompt.variables.datetime.label'),
      description: t('systemPrompt.variables.datetime.description'),
      example: '2024-01-01 12:00',
    },
    {
      name: 'language',
      label: t('systemPrompt.variables.language.label'),
      description: t('systemPrompt.variables.language.description'),
      example: t('systemPrompt.variables.language.example'),
    },
  ];
}

// ============================================================================
// 子组件：模板选择器
// ============================================================================

interface TemplateSelectorProps {
  templates: SystemPromptTemplate[];
  onSelect: (template: SystemPromptTemplate) => void;
  onDelete?: (templateId: string) => void;
  disabled?: boolean;
}

const TemplateSelector: React.FC<TemplateSelectorProps> = ({
  templates,
  onSelect,
  onDelete,
  disabled,
}) => {
  const { t } = useTranslation('chatV2');
  const [isOpen, setIsOpen] = useState(false);

  if (templates.length === 0) {
    return null;
  }

  return (
    <div className="relative">
      <NotionButton
        variant="outline"
        size="sm"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
      >
        <FileText className="w-4 h-4" />
        <span>{t('systemPrompt.templates')}</span>
        <ChevronDown
          className={cn(
            'w-4 h-4 transition-transform',
            isOpen && 'rotate-180'
          )}
        />
      </NotionButton>

      {isOpen && (
        <>
          {/* 遮罩 */}
          <div
            className="fixed inset-0 z-10"
            onClick={() => setIsOpen(false)}
          />

          {/* 下拉菜单 */}
          <div
            className={cn(
              'absolute top-full left-0 mt-1 z-20',
              'min-w-[240px] max-h-[300px] overflow-y-auto',
              'rounded-lg border border-border/50',
              'bg-popover shadow-lg',
              'py-1'
            )}
          >
            {templates.map((template) => (
              <div
                key={template.id}
                className={cn(
                  'flex items-center justify-between gap-2 px-3 py-2',
                  'hover:bg-muted/50 cursor-pointer'
                )}
                onClick={() => {
                  onSelect(template);
                  setIsOpen(false);
                }}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">
                    {template.name}
                  </div>
                  {template.description && (
                    <div className="text-xs text-muted-foreground truncate">
                      {template.description}
                    </div>
                  )}
                </div>
                {!template.builtin && onDelete && (
                  <NotionButton variant="ghost" size="icon" iconOnly onClick={(e) => { e.stopPropagation(); onDelete(template.id); }} className="!h-6 !w-6 hover:text-destructive hover:bg-destructive/10" aria-label="delete">
                    <Trash2 className="w-3.5 h-3.5" />
                  </NotionButton>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
};

// ============================================================================
// 子组件：变量插入器
// ============================================================================

interface VariableInserterProps {
  variables: PromptVariable[];
  onInsert: (variable: PromptVariable) => void;
  disabled?: boolean;
}

const VariableInserter: React.FC<VariableInserterProps> = ({
  variables,
  onInsert,
  disabled,
}) => {
  const { t } = useTranslation('chatV2');
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="relative">
      <NotionButton
        variant="outline"
        size="sm"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
      >
        <Variable className="w-4 h-4" />
        <span>{t('systemPrompt.insertVariable')}</span>
        <ChevronDown
          className={cn(
            'w-4 h-4 transition-transform',
            isOpen && 'rotate-180'
          )}
        />
      </NotionButton>

      {isOpen && (
        <>
          {/* 遮罩 */}
          <div
            className="fixed inset-0 z-10"
            onClick={() => setIsOpen(false)}
          />

          {/* 下拉菜单 */}
          <div
            className={cn(
              'absolute top-full left-0 mt-1 z-20',
              'min-w-[200px]',
              'rounded-lg border border-border/50',
              'bg-popover shadow-lg',
              'py-1'
            )}
          >
            {variables.map((variable) => (
              <div
                key={variable.name}
                className={cn(
                  'px-3 py-2 hover:bg-muted/50 cursor-pointer'
                )}
                onClick={() => {
                  onInsert(variable);
                  setIsOpen(false);
                }}
              >
                <div className="flex items-center gap-2">
                  <code className="text-xs px-1.5 py-0.5 bg-muted rounded">
                    {`{{${variable.name}}}`}
                  </code>
                  <span className="text-sm">{variable.label}</span>
                </div>
                {variable.description && (
                  <div className="text-xs text-muted-foreground mt-1">
                    {variable.description}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
};

// ============================================================================
// 主组件
// ============================================================================

/**
 * SystemPromptEditor 系统 Prompt 编辑器
 */
export const SystemPromptEditor: React.FC<SystemPromptEditorProps> = ({
  value,
  onChange,
  templates = [],
  variables: variablesProp,
  placeholder,
  maxLength = 4000,
  minHeight = 120,
  maxHeight = 400,
  disabled = false,
  className,
  onSaveTemplate,
  onDeleteTemplate,
}) => {
  const { t } = useTranslation('chatV2');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [copied, setCopied] = useState(false);

  // Resolve default variables with i18n
  const variables = useMemo(
    () => variablesProp ?? getDefaultVariables(t),
    [variablesProp, t]
  );

  // 字数统计
  const charCount = useMemo(() => value.length, [value]);
  const isOverLimit = charCount > maxLength;

  // 文本变化
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      onChange(e.target.value);
    },
    [onChange]
  );

  // 选择模板
  const handleSelectTemplate = useCallback(
    (template: SystemPromptTemplate) => {
      onChange(template.content);
    },
    [onChange]
  );

  // 插入变量
  const handleInsertVariable = useCallback(
    (variable: PromptVariable) => {
      const textarea = textareaRef.current;
      if (!textarea) return;

      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const variableText = `{{${variable.name}}}`;

      const newValue =
        value.substring(0, start) + variableText + value.substring(end);
      onChange(newValue);

      // 设置光标位置
      setTimeout(() => {
        textarea.focus();
        textarea.setSelectionRange(
          start + variableText.length,
          start + variableText.length
        );
      }, 0);
    },
    [value, onChange]
  );

  // 复制内容
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error: unknown) {
      console.error('Failed to copy:', error);
    }
  }, [value]);

  // 清空内容
  const handleClear = useCallback(() => {
    onChange('');
    textareaRef.current?.focus();
  }, [onChange]);

  return (
    <div
      className={cn(
        'rounded-lg border border-border/50',
        'bg-card dark:bg-card/80',
        'overflow-hidden',
        className
      )}
    >
      {/* 工具栏 */}
      <div
        className={cn(
          'flex items-center justify-between gap-2 px-3 py-2',
          'border-b border-border/50',
          'bg-muted/30'
        )}
      >
        <div className="flex items-center gap-2">
          {/* 模板选择 */}
          <TemplateSelector
            templates={templates}
            onSelect={handleSelectTemplate}
            onDelete={onDeleteTemplate}
            disabled={disabled}
          />

          {/* 变量插入 */}
          <VariableInserter
            variables={variables}
            onInsert={handleInsertVariable}
            disabled={disabled}
          />
        </div>

        <div className="flex items-center gap-1">
          {/* 复制按钮 */}
          <NotionButton variant="ghost" size="icon" iconOnly onClick={handleCopy} disabled={!value || disabled} aria-label={t('systemPrompt.copy')} title={t('systemPrompt.copy')}>
            {copied ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
          </NotionButton>

          {/* 清空按钮 */}
          <NotionButton variant="ghost" size="icon" iconOnly onClick={handleClear} disabled={!value || disabled} aria-label={t('systemPrompt.clear')} title={t('systemPrompt.clear')}>
            <RotateCcw className="w-4 h-4" />
          </NotionButton>
        </div>
      </div>

      {/* 编辑区域 */}
      <div className="relative">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          placeholder={placeholder || t('systemPrompt.placeholder')}
          disabled={disabled}
          className={cn(
            'w-full px-4 py-3',
            'bg-transparent',
            'resize-none',
            'focus:outline-none',
            'placeholder:text-muted-foreground',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            'text-sm leading-relaxed',
            isOverLimit && 'text-destructive'
          )}
          style={{
            minHeight: `${minHeight}px`,
            maxHeight: `${maxHeight}px`,
          }}
        />
      </div>

      {/* 底部状态栏 */}
      <div
        className={cn(
          'flex items-center justify-between px-3 py-2',
          'border-t border-border/50',
          'bg-muted/30',
          'text-xs text-muted-foreground'
        )}
      >
        <div className="flex items-center gap-2">
          {/* 保存为模板 */}
          {onSaveTemplate && value.trim() && (
            <NotionButton
              variant="outline"
              size="sm"
              onClick={() =>
                onSaveTemplate({
                  name: t('systemPrompt.newTemplateName'),
                  content: value,
                })
              }
              disabled={disabled}
            >
              <Plus className="w-3 h-3" />
              <span>{t('systemPrompt.saveAsTemplate')}</span>
            </NotionButton>
          )}
        </div>

        {/* 字数统计 */}
        <div className={cn(isOverLimit && 'text-destructive font-medium')}>
          {charCount} / {maxLength}
        </div>
      </div>
    </div>
  );
};

export default SystemPromptEditor;
