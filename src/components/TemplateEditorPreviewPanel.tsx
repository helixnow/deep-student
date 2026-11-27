import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Sun, Moon, WarningCircle, CaretDown, CaretRight } from '@phosphor-icons/react';
import { IframePreview } from './SharedPreview';
import { Input } from './ui/shad/Input';
import { DsButton } from '@/components/ui/DsButton';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Alert } from './ui/shad/Alert';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/shad/Tooltip';
import { cn } from '@/utils/cn';
import type { TemplateRenderIssue } from '../services/ankiTemplateEngine';

export type TemplatePreviewSide = 'front' | 'back';

interface TemplateEditorPreviewPanelProps {
  /** 已渲染好的卡片 HTML（当前面） */
  html: string;
  /** 模板 CSS */
  css: string;
  /** 统一渲染引擎返回的渲染问题列表（非空时在预览上方内联展示） */
  renderIssues: TemplateRenderIssue[];
  previewSide: TemplatePreviewSide;
  onPreviewSideChange: (side: TemplatePreviewSide) => void;
  darkPreview: boolean;
  onDarkPreviewChange: (dark: boolean) => void;
  /** 模板字段列表（示例数据快速编辑用） */
  fields: string[];
  /** 解析后的示例数据；null 表示 JSON 无效 */
  sampleData: Record<string, unknown> | null;
  onSampleFieldChange: (field: string, value: unknown) => void;
  /** 移动端紧凑布局 */
  compact?: boolean;
  /** 是否展示底部示例数据快速编辑区（预览数据页自身已在左侧编辑，可隐藏避免重复） */
  showSampleEditor?: boolean;
}

/** Anki 夜间模式约定：body/根节点带 night_mode class，模板 CSS 可用 .night_mode 适配 */
const DARK_PREVIEW_CSS = `
:root { color-scheme: dark; }
body { background: #1c1c1f; }
.template-editor-night-root { background: #1c1c1f; color: #e4e4e7; min-height: 100%; }
`;

const formatSampleValue = (value: unknown): string => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join(', ');
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

/**
 * 实时渲染预览面板：正/反面分段切换、暗/亮预览切换、渲染问题内联提示、
 * 以及可选的示例数据字段级快速编辑。
 */
export const TemplateEditorPreviewPanel: React.FC<TemplateEditorPreviewPanelProps> = ({
  html,
  css,
  renderIssues,
  previewSide,
  onPreviewSideChange,
  darkPreview,
  onDarkPreviewChange,
  fields,
  sampleData,
  onSampleFieldChange,
  compact = false,
  showSampleEditor = true,
}) => {
  const { t } = useTranslation('anki');
  const [sampleOpen, setSampleOpen] = useState(!compact);

  const effectiveHtml = useMemo(
    () => (darkPreview
      ? `<div class="night_mode nightMode template-editor-night-root">${html}</div>`
      : html),
    [darkPreview, html],
  );
  const effectiveCss = useMemo(
    () => (darkPreview ? `${css}\n${DARK_PREVIEW_CSS}` : css),
    [darkPreview, css],
  );

  const sideOptions = useMemo(
    () => [
      { value: 'front' as const, label: t('templateEditor.frontSide') },
      { value: 'back' as const, label: t('templateEditor.backSide') },
    ],
    [t],
  );

  const handleSampleInput = (field: string, raw: string) => {
    const original = sampleData?.[field];
    if (Array.isArray(original)) {
      onSampleFieldChange(
        field,
        raw.split(',').map((item) => item.trim()).filter((item) => item !== ''),
      );
    } else {
      onSampleFieldChange(field, raw);
    }
  };

  const themeToggleLabel = (
    darkPreview
      ? t('templateEditor.switchToLightPreview')
      : t('templateEditor.switchToDarkPreview')
  ) as string;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {/* 顶栏：标题 + 正反面切换 + 亮/暗预览切换 */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-semibold text-muted-foreground">
          {t('templateEditor.previewTitle')}
        </span>
        <div className="flex items-center gap-1.5">
          <SegmentedControl
            ariaLabel={t('templateEditor.previewTitle') as string}
            value={previewSide}
            onValueChange={onPreviewSideChange}
            options={sideOptions}
            size="compact"
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <DsButton
                type="button"
                variant="ghost"
                size="sm"
                iconOnly
                aria-label={themeToggleLabel}
                aria-pressed={darkPreview}
                onClick={() => onDarkPreviewChange(!darkPreview)}
                className={cn(darkPreview && 'bg-primary/10 text-primary')}
              >
                {darkPreview ? <Moon size={15} weight="fill" /> : <Sun size={15} />}
              </DsButton>
            </TooltipTrigger>
            <TooltipContent side="bottom">{themeToggleLabel}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* 渲染问题列表 */}
      {renderIssues.length > 0 && (
        <Alert variant="destructive" className="flex items-start gap-2 text-xs">
          <WarningCircle size={16} weight="bold" className="mt-0.5 shrink-0" aria-hidden="true" />
          <div className="min-w-0 space-y-1">
            <div className="font-medium">
              {t('templateEditor.renderIssuesTitle', { count: renderIssues.length })}
            </div>
            {renderIssues.map((issue, index) => (
              <div key={`${issue.code}-${index}`} className="break-words opacity-85">
                {issue.message}{issue.tag ? `（${issue.tag}）` : ''}
              </div>
            ))}
            <div className="text-xs opacity-70">{t('templateEditor.renderErrorHint')}</div>
          </div>
        </Alert>
      )}

      {/* 预览画布 */}
      <div
        className={cn(
          'overflow-hidden rounded-[var(--radius-card)] border border-border/50 transition-colors',
          darkPreview ? 'bg-foreground/95 dark:bg-background' : 'bg-background',
        )}
      >
        <IframePreview htmlContent={effectiveHtml} cssContent={effectiveCss} />
      </div>

      {/* 示例数据快速编辑 */}
      {showSampleEditor && (
        <div className="border-t border-border/40 pt-2.5">
          <DsButton
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={sampleOpen}
            onClick={() => setSampleOpen((open) => !open)}
            className="-ml-2 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            {sampleOpen
              ? <CaretDown size={13} aria-hidden="true" />
              : <CaretRight size={13} aria-hidden="true" />}
            <span>{t('templateEditor.sampleData')}</span>
          </DsButton>

          {sampleOpen && (
            sampleData === null ? (
              <Alert variant="warning" className="mt-2 py-2 text-xs">
                {t('templateEditor.sampleDataInvalid')}
              </Alert>
            ) : (
              <div className="mt-2 space-y-2 rounded-2xl bg-muted/60 p-3">
                {fields.map((field) => (
                  <div key={field} className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
                    <label
                      className="shrink-0 truncate font-mono text-xs text-muted-foreground sm:w-24"
                      title={field}
                    >
                      {field}
                    </label>
                    <Input
                      type="text"
                      value={formatSampleValue(sampleData[field])}
                      placeholder={t('templateEditor.sampleValuePlaceholder') as string}
                      onChange={(e) => handleSampleInput(field, e.target.value)}
                      className="min-w-0 flex-1"
                    />
                  </div>
                ))}
                <p className="pt-1 text-xs text-muted-foreground/70">
                  {t('templateEditor.sampleDataHint')}
                </p>
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
};

export default TemplateEditorPreviewPanel;
