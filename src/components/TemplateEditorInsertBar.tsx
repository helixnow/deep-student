import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  BracketsCurly,
  TextAa,
  ArrowsInLineHorizontal,
  Prohibit,
  FlipHorizontal,
  CaretDown,
  WarningCircle,
} from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import {
  AppMenu,
  AppMenuTrigger,
  AppMenuContent,
  AppMenuItem,
} from '@/components/ui/app-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/shad/Tooltip';
import { TemplateLintIssue } from './TemplateEditorLint';

interface TemplateEditorSnippetMenuProps {
  fields: string[];
  isBackTemplate?: boolean;
  onInsertText: (text: string, cursorOffset?: number) => void;
  onWrapSelection: (open: string, close: string) => void;
}

/**
 * 语法快捷插入下拉菜单（放在代码区顶栏右侧，消除双行芯片叠罗汉）。
 */
export const TemplateEditorSnippetMenu: React.FC<TemplateEditorSnippetMenuProps> = ({
  fields,
  isBackTemplate = false,
  onInsertText,
  onWrapSelection,
}) => {
  const { t } = useTranslation('anki');
  const { t: tTemplate } = useTranslation('template');
  const firstField = fields[0] ?? 'Front';

  return (
    <AppMenu>
      <AppMenuTrigger asChild>
        <DsButton variant="ghost" size="sm">
          <BracketsCurly size={14} aria-hidden="true" />
          <span>{tTemplate('editor.insert_snippet_menu')}</span>
          <CaretDown size={12} aria-hidden="true" />
        </DsButton>
      </AppMenuTrigger>
      <AppMenuContent align="end" width={230}>
        <AppMenuItem
          icon={<TextAa size={15} />}
          onClick={() => onInsertText(`{{cloze:${firstField}}}`, 8)}
        >
          {t('templateEditor.snippetCloze')}
        </AppMenuItem>
        <AppMenuItem
          icon={<BracketsCurly size={15} />}
          onClick={() => onWrapSelection(`{{#${firstField}}}`, `{{/${firstField}}}`)}
        >
          {t('templateEditor.snippetCondition')}
        </AppMenuItem>
        <AppMenuItem
          icon={<Prohibit size={15} />}
          onClick={() => onWrapSelection(`{{^${firstField}}}`, `{{/${firstField}}}`)}
        >
          {t('templateEditor.snippetConditionNegative')}
        </AppMenuItem>
        <AppMenuItem
          icon={<ArrowsInLineHorizontal size={15} />}
          onClick={() => onInsertText(`{{text:${firstField}}}`, 7)}
        >
          {t('templateEditor.snippetTextFilter')}
        </AppMenuItem>
        {isBackTemplate && (
          <AppMenuItem
            icon={<FlipHorizontal size={15} />}
            onClick={() => onInsertText('{{FrontSide}}')}
          >
            {t('templateEditor.snippetFrontSide')}
          </AppMenuItem>
        )}
      </AppMenuContent>
    </AppMenu>
  );
};

interface TemplateEditorInsertBarProps {
  /** 模板声明的全部字段 */
  fields: string[];
  /** 在光标处插入文本；cursorOffset 为插入后光标相对插入起点的偏移 */
  onInsertText: (text: string, cursorOffset?: number) => void;
}

/**
 * 紧凑单行字段占位符插入条。
 */
export const TemplateEditorInsertBar: React.FC<TemplateEditorInsertBarProps> = ({
  fields,
  onInsertText,
}) => {
  const { t } = useTranslation('anki');

  if (fields.length === 0) return null;

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none py-0.5">
      <span className="shrink-0 text-xs font-medium text-muted-foreground/70">
        {t('templateEditor.insertField')}
      </span>
      {fields.map((field) => (
        <Tooltip key={field}>
          <TooltipTrigger asChild>
            <DsButton
              type="button"
              variant="ghost"
              size="sm"
              className="shrink-0 rounded-pill border-border/50 bg-muted/40 font-mono text-xs text-foreground/85 hover:border-primary/40 hover:bg-primary/10 hover:text-primary"
              onClick={() => onInsertText(`{{${field}}}`)}
            >
              {`{{${field}}}`}
            </DsButton>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {t('templateEditor.insertFieldTitle', { field })}
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
};

interface TemplateEditorLintBarProps {
  lintIssues: TemplateLintIssue[];
}

/**
 * 模板静态检查结果条（放在代码编辑器底部，有告警才出现，不挤压顶部工具栏）。
 */
export const TemplateEditorLintBar: React.FC<TemplateEditorLintBarProps> = ({ lintIssues }) => {
  const { t } = useTranslation('anki');

  if (lintIssues.length === 0) return null;

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
    <div
      className="flex-none space-y-1 border-t border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning"
      role="alert"
    >
      {lintIssues.map((issue, index) => (
        <div key={`${issue.type}-${index}`} className="flex items-start gap-1.5 leading-snug">
          <WarningCircle size={14} weight="fill" className="mt-0.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 break-words text-foreground/90">{describeIssue(issue)}</span>
        </div>
      ))}
    </div>
  );
};

export default TemplateEditorInsertBar;
