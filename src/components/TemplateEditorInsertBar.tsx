import React from 'react';
import { useTranslation } from 'react-i18next';
import { BracketsCurly, TextAa, ArrowsInLineHorizontal, Prohibit, FlipHorizontal } from '@phosphor-icons/react';
import { TemplateLintIssue } from './TemplateEditorLint';
import './TemplateEditorEnhancements.css';

interface TemplateEditorInsertBarProps {
  /** 模板声明的全部字段 */
  fields: string[];
  /** 当前是否为背面模板（显示 {{FrontSide}} 快捷插入） */
  isBackTemplate?: boolean;
  /** 在光标处插入文本；cursorOffset 为插入后光标相对插入起点的偏移 */
  onInsertText: (text: string, cursorOffset?: number) => void;
  /** 用一对标签包裹当前选区（无选区时插入并把光标放中间） */
  onWrapSelection: (open: string, close: string) => void;
  /** 当前模板的静态检查结果（内联警告） */
  lintIssues: TemplateLintIssue[];
}

/**
 * 字段占位符插入按钮条 + 语法快捷插入 + 内联 lint 警告。
 * 参考 Anki Desktop 模板编辑器的字段下拉，但改为一键 chips，全部内联无弹层。
 */
export const TemplateEditorInsertBar: React.FC<TemplateEditorInsertBarProps> = ({
  fields,
  isBackTemplate = false,
  onInsertText,
  onWrapSelection,
  lintIssues,
}) => {
  const { t } = useTranslation('anki');
  const firstField = fields[0] ?? 'Front';

  const describeIssue = (issue: TemplateLintIssue): string => {
    switch (issue.type) {
      case 'unknown-field':
        return t('templateEditor.lintUnknownField', { fields: issue.detail });
      case 'unbalanced-braces':
        return t('templateEditor.lintUnbalancedBraces');
      case 'unclosed-section':
        return t('templateEditor.lintUnclosedSection', { tag: issue.detail });
      case 'mismatched-section':
        return t('templateEditor.lintMismatchedSection', { tag: issue.detail, expected: issue.expected ?? '' });
      case 'orphan-close':
        return t('templateEditor.lintOrphanClose', { tag: issue.detail });
    }
  };

  return (
    <div className="template-editor-insert-bar">
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-[10px] max-md:text-[11px] font-medium text-muted-foreground/70 uppercase tracking-wider shrink-0">
          {t('templateEditor.insertField')}
        </span>
        {fields.map(field => (
          <button
            key={field}
            type="button"
            className="template-editor-chip"
            title={t('templateEditor.insertFieldTitle', { field }) as string}
            onClick={() => onInsertText(`{{${field}}}`)}
          >
            {`{{${field}}}`}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
        <span className="text-[10px] max-md:text-[11px] font-medium text-muted-foreground/70 uppercase tracking-wider shrink-0">
          {t('templateEditor.snippets')}
        </span>
        <button
          type="button"
          className="template-editor-chip template-editor-chip-snippet"
          title={t('templateEditor.snippetClozeTitle') as string}
          onClick={() => onInsertText(`{{cloze:${firstField}}}`, 8)}
        >
          <TextAa size={11} weight="bold" />
          {t('templateEditor.snippetCloze')}
        </button>
        <button
          type="button"
          className="template-editor-chip template-editor-chip-snippet"
          title={t('templateEditor.snippetConditionTitle') as string}
          onClick={() => onWrapSelection(`{{#${firstField}}}`, `{{/${firstField}}}`)}
        >
          <BracketsCurly size={11} weight="bold" />
          {t('templateEditor.snippetCondition')}
        </button>
        <button
          type="button"
          className="template-editor-chip template-editor-chip-snippet"
          title={t('templateEditor.snippetConditionNegativeTitle') as string}
          onClick={() => onWrapSelection(`{{^${firstField}}}`, `{{/${firstField}}}`)}
        >
          <Prohibit size={11} weight="bold" />
          {t('templateEditor.snippetConditionNegative')}
        </button>
        <button
          type="button"
          className="template-editor-chip template-editor-chip-snippet"
          title={t('templateEditor.snippetTextFilterTitle') as string}
          onClick={() => onInsertText(`{{text:${firstField}}}`, 7)}
        >
          <ArrowsInLineHorizontal size={11} weight="bold" />
          {t('templateEditor.snippetTextFilter')}
        </button>
        {isBackTemplate && (
          <button
            type="button"
            className="template-editor-chip template-editor-chip-snippet"
            title={t('templateEditor.snippetFrontSideTitle') as string}
            onClick={() => onInsertText('{{FrontSide}}')}
          >
            <FlipHorizontal size={11} weight="bold" />
            {t('templateEditor.snippetFrontSide')}
          </button>
        )}
      </div>
      {lintIssues.length > 0 && (
        <div className="template-editor-lint-list" role="alert">
          {lintIssues.map((issue, index) => (
            <div key={`${issue.type}-${index}`} className="template-editor-lint-item">
              {describeIssue(issue)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default TemplateEditorInsertBar;
