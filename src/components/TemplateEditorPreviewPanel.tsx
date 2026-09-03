import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Sun, Moon, WarningCircle, CaretDown, CaretRight } from '@phosphor-icons/react';
import { IframePreview } from './SharedPreview';
import { Input } from './ui/shad/Input';
import type { TemplateRenderIssue } from '../services/ankiTemplateEngine';
import './TemplateEditorEnhancements.css';

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
    return value.map(item => (typeof item === 'string' ? item : JSON.stringify(item))).join(', ');
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

/**
 * 实时渲染预览面板：正/反面切换、暗/亮预览切换、渲染错误内联提示、
 * 示例数据字段级快速编辑（无需切到 JSON 页）。
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

  const handleSampleInput = (field: string, raw: string) => {
    const original = sampleData?.[field];
    if (Array.isArray(original)) {
      onSampleFieldChange(field, raw.split(',').map(item => item.trim()).filter(item => item !== ''));
    } else {
      onSampleFieldChange(field, raw);
    }
  };

  return (
    <div className="template-editor-preview-panel">
      {/* 工具行：正/反面 + 暗色切换 */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-xs font-medium text-muted-foreground/80 uppercase tracking-wider">
          {t('templateEditor.previewTitle')}
        </span>
        <div className="flex items-center gap-1.5">
          <div className="template-editor-segmented" role="tablist" aria-label={t('templateEditor.previewTitle') as string}>
            <button
              type="button"
              role="tab"
              aria-selected={previewSide === 'front'}
              className={`template-editor-segmented-item ${previewSide === 'front' ? 'active' : ''}`}
              onClick={() => onPreviewSideChange('front')}
            >
              {t('templateEditor.frontSide')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={previewSide === 'back'}
              className={`template-editor-segmented-item ${previewSide === 'back' ? 'active' : ''}`}
              onClick={() => onPreviewSideChange('back')}
            >
              {t('templateEditor.backSide')}
            </button>
          </div>
          <button
            type="button"
            className="template-editor-icon-toggle"
            aria-pressed={darkPreview}
            title={(darkPreview ? t('templateEditor.switchToLightPreview') : t('templateEditor.switchToDarkPreview')) as string}
            onClick={() => onDarkPreviewChange(!darkPreview)}
          >
            {darkPreview ? <Moon size={13} weight="fill" /> : <Sun size={13} weight="bold" />}
          </button>
        </div>
      </div>

      {/* 渲染问题列表（引擎返回的结构化问题，不吞掉） */}
      {renderIssues.length > 0 && (
        <div className="template-editor-render-error" role="alert">
          <WarningCircle size={16} weight="bold" />
          <div>
            <div className="font-medium">{t('templateEditor.renderIssuesTitle', { count: renderIssues.length })}</div>
            {renderIssues.map((issue, index) => (
              <div key={`${issue.code}-${index}`} className="text-[11px] opacity-80 break-all">
                {issue.message}{issue.tag ? `（${issue.tag}）` : ''}
              </div>
            ))}
            <div className="text-[11px] opacity-60 mt-1">{t('templateEditor.renderErrorHint')}</div>
          </div>
        </div>
      )}

      {/* 预览画布 */}
      <div className={`template-editor-preview-canvas ${darkPreview ? 'dark-canvas' : ''}`}>
        <IframePreview htmlContent={effectiveHtml} cssContent={effectiveCss} />
      </div>

      {/* 示例数据快速编辑 */}
      <div className="template-editor-sample-section">
        <button
          type="button"
          className="template-editor-sample-toggle"
          aria-expanded={sampleOpen}
          onClick={() => setSampleOpen(open => !open)}
        >
          {sampleOpen ? <CaretDown size={11} weight="bold" /> : <CaretRight size={11} weight="bold" />}
          {t('templateEditor.sampleData')}
        </button>
        {sampleOpen && (
          sampleData === null ? (
            <div className="template-editor-lint-item mt-1.5">
              {t('templateEditor.sampleDataInvalid')}
            </div>
          ) : (
            <div className="template-editor-sample-grid">
              {fields.map(field => (
                <div key={field} className="template-editor-sample-row">
                  <label className="template-editor-sample-label" title={field}>{field}</label>
                  <Input
                    type="text"
                    value={formatSampleValue(sampleData[field])}
                    placeholder={t('templateEditor.sampleValuePlaceholder') as string}
                    onChange={(e) => handleSampleInput(field, e.target.value)}
                    className="md:!h-7 text-xs [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:text-base"
                  />
                </div>
              ))}
              <p className="text-[10px] max-md:text-[11px] text-muted-foreground/60 col-span-full mt-0.5">
                {t('templateEditor.sampleDataHint')}
              </p>
            </div>
          )
        )}
      </div>
    </div>
  );
};

export default TemplateEditorPreviewPanel;
