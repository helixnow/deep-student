import React, { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '@/i18n';
import { ArrowLeft, CheckCircle2, Code2, Eye, RefreshCw, XCircle } from 'lucide-react';
import { CustomAnkiTemplate } from '../types';
import { templateManager } from '../data/ankiTemplates';
import { getErrorMessage } from '../utils/errorUtils';
import { IframePreview, renderCardPreview } from './SharedPreview';
import { CustomScrollArea } from './custom-scroll-area';
import { useMobileHeader } from './layout';
import { NotionButton } from './ui/NotionButton';
import { Badge } from './ui/shad/Badge';
import { Alert, AlertDescription, AlertTitle } from './ui/shad/Alert';
import { UnifiedCodeEditor } from './shared/UnifiedCodeEditor';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { cn } from '../lib/utils';
import './TemplateJsonPreviewPage.css';

type NormalizedEntry = {
  key: string;
  templateId?: string;
  template?: CustomAnkiTemplate;
  data: Record<string, any> | null;
  error?: string;
};

interface TemplateJsonPreviewPageProps {
  onBack: () => void;
}

const SAMPLE_JSON = `{
  "cards": [
    {
      "template_id": "minimal-card",
      "data": {
        "Front": "什么是动量守恒定律？",
        "Back": "在没有外力作用的系统中，总动量保持不变",
        "Notes": "强调系统闭合与外力为零的前提",
        "Tags": ["物理", "力学"]
      }
    },
    {
      "template_id": "cloze-card",
      "data": {
        "Text": "勾股定理：{{c1::a^2 + b^2 = c^2}}，其中a、b、c分别表示{{c1::两条直角边}}和{{c1::斜边}}",
        "Hint": "所有挖空都用 c1 保持同一张卡片",
        "Source": "几何基础"
      }
    }
  ]
}`;

const TemplateJsonPreviewPage: React.FC<TemplateJsonPreviewPageProps> = ({ onBack }) => {
  const { t } = useTranslation('template');
  const { isSmallScreen } = useBreakpoint();
  const [inputValue, setInputValue] = useState<string>(SAMPLE_JSON);
  const [templates, setTemplates] = useState<CustomAnkiTemplate[]>([]);
  const [isLoadingTemplates, setIsLoadingTemplates] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [entries, setEntries] = useState<NormalizedEntry[]>([]);
  const [parseTick, setParseTick] = useState(0);

  // 函数引用，用于 useMobileHeader
  const loadTemplatesRef = useRef<() => void>(() => {});
  const handleParseRef = useRef<() => void>(() => {});

  // 移动端统一顶栏配置
  useMobileHeader('template-json-preview', {
    title: t('json_preview.title'),
    subtitle: t('json_preview.subtitle'),
    rightActions: (
      <>
        <NotionButton variant="ghost" size="sm" onClick={() => loadTemplatesRef.current()} disabled={isLoadingTemplates}>
          {isLoadingTemplates ? <RefreshCw className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        </NotionButton>
        <NotionButton variant="ghost" size="sm" onClick={() => handleParseRef.current()}>
          <Eye className="h-4 w-4" />
        </NotionButton>
      </>
    ),
  }, [t, isLoadingTemplates]);

  const loadTemplates = useCallback(async () => {
    setIsLoadingTemplates(true);
    try {
      await templateManager.refresh();
      setTemplates(templateManager.getAllTemplates());
    } catch (error: unknown) {
      setParseError(t('json_preview.load_templates_failed', { message: getErrorMessage(error) }));
    } finally {
      setIsLoadingTemplates(false);
    }
  }, [t]);

  useEffect(() => {
    loadTemplates();
  }, [loadTemplates]);

  const normalizePayload = (value: any): any[] => {
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') {
      if (Array.isArray(value.cards)) return value.cards;
      if (Array.isArray(value.items)) return value.items;
      if (Array.isArray(value.templates)) return value.templates;
      return [value];
    }
    return [];
  };

  const looksLikeTemplateDef = (obj: any): boolean => {
    if (!obj || typeof obj !== 'object') return false;
    return (
      typeof obj.front_template === 'string' ||
      typeof obj.back_template === 'string' ||
      typeof obj.css_style === 'string' ||
      typeof obj.fields_json === 'string' ||
      Array.isArray(obj.fields)
    );
  };

  const convertRawTemplate = (raw: any): CustomAnkiTemplate => {
    // 支持内置模板 JSON 结构（fields_json/field_extraction_rules_json）或直接模板对象
    const fields: string[] = Array.isArray(raw?.fields)
      ? raw.fields
      : (() => {
          try {
            if (typeof raw?.fields_json === 'string') {
              const parsed = JSON.parse(raw.fields_json);
              if (Array.isArray(parsed)) return parsed;
            }
          } catch {}
          return ['Front', 'Back'];
        })();

    const fieldExtractionRules: Record<string, any> =
      typeof raw?.field_extraction_rules === 'object' && raw.field_extraction_rules !== null
        ? raw.field_extraction_rules
        : (() => {
            try {
              if (typeof raw?.field_extraction_rules_json === 'string') {
                const parsed = JSON.parse(raw.field_extraction_rules_json);
                if (parsed && typeof parsed === 'object') return parsed;
              }
            } catch {}
            return {};
          })();

    const parseDate = (val: any) => {
      if (typeof val === 'string') return val;
      if (val && typeof val === 'object' && typeof val.toISOString === 'function') return val.toISOString();
      return new Date().toISOString();
    };

    const previewDataJson =
      typeof raw?.preview_data_json === 'string'
        ? raw.preview_data_json
        : raw?.preview_data
        ? JSON.stringify(raw.preview_data)
        : undefined;

    return {
      id: raw?.id || raw?.template_id || raw?.name || `preview-${Date.now()}`,
      name: raw?.name || raw?.template_name || raw?.id || i18n.t('template:preview_template_name', 'Preview Template'),
      description: raw?.description || '',
      author: raw?.author || 'Preview',
      version: raw?.version || '1.0.0',
      preview_front: raw?.preview_front || fields[0] || 'Front',
      preview_back: raw?.preview_back || fields[1] || 'Back',
      note_type: raw?.note_type || 'Basic',
      fields,
      generation_prompt: raw?.generation_prompt || '',
      front_template: raw?.front_template || '',
      back_template: raw?.back_template || '',
      css_style: raw?.css_style || '',
      field_extraction_rules: fieldExtractionRules,
      created_at: parseDate(raw?.created_at),
      updated_at: parseDate(raw?.updated_at),
      is_active: raw?.is_active !== undefined ? Boolean(raw.is_active) : true,
      is_built_in: raw?.is_built_in !== undefined ? Boolean(raw.is_built_in) : false,
      preview_data_json: previewDataJson,
    };
  };

  const handleParse = useCallback(() => {
    setParseError(null);
    try {
      const raw = JSON.parse(inputValue);
      const normalized = normalizePayload(raw);
      if (!normalized.length) {
        setParseError(t('json_preview.no_items'));
        setEntries([]);
        return;
      }

    const mapped: NormalizedEntry[] = normalized.map((item, index) => {
        const templateId =
          item?.template_id ??
          item?.templateId ??
          item?.template ??
          item?.templateName ??
          item?.id ??
          item?.name;

        let template: CustomAnkiTemplate | undefined;
        let templateError: string | undefined;

        // 1) 优先匹配已加载模板
        if (templateId) {
          template = templates.find(
            (tpl) =>
              tpl.id === templateId ||
              tpl.name === templateId ||
              tpl.id === item?.template_name ||
              tpl.name === item?.template_name
          );
        }

        // 2) 尝试从 item.template / 内嵌定义 / 自身即模板定义 构造一个临时模板
        if (!template) {
          const candidateTemplateObj = item?.template || (looksLikeTemplateDef(item) ? item : undefined);
          if (candidateTemplateObj) {
            try {
              template = convertRawTemplate(candidateTemplateObj);
            } catch (err: unknown) {
              templateError = t('json_preview.template_invalid', { message: getErrorMessage(err) });
            }
          }
        }

        // 3) 允许没有 template_id 但提供了完整模板定义的场景
        const finalTemplateId = template?.id || templateId;

        // 允许 data 平铺，或 data/fields 字段
        const extractedData =
          item?.data ??
          item?.fields ??
          (() => {
            if (!item || typeof item !== 'object') return null;
            const clone = { ...item };
            delete clone.template_id;
            delete clone.templateId;
            delete clone.template;
            delete clone.templateName;
            delete clone.id;
            delete clone.name;
            delete clone.fields_json;
            delete clone.field_extraction_rules_json;
            delete clone.front_template;
            delete clone.back_template;
            delete clone.css_style;
            delete clone.preview_front;
            delete clone.preview_back;
            delete clone.preview_data_json;
            return clone;
          })();

        let data: Record<string, any> | null =
          extractedData && typeof extractedData === 'object' && !Array.isArray(extractedData)
            ? (extractedData as Record<string, any>)
            : null;

        // 如果 data 为空，尝试用模板的 preview_data_json 兜底
        if (!data && template?.preview_data_json) {
          try {
            const parsed = JSON.parse(template.preview_data_json);
            if (parsed && typeof parsed === 'object') {
              data = parsed as Record<string, any>;
            }
          } catch {}
        }

        let error: string | undefined = templateError;
        if (!finalTemplateId && !template) {
          error = t('json_preview.missing_template', { index: index + 1 });
        } else if (!template) {
          error = t('json_preview.template_not_found', { id: templateId || '-' });
        } else if (!data) {
          error = t('json_preview.data_invalid', { id: finalTemplateId || templateId || '-' });
        }

        return {
          key: `${finalTemplateId || 'entry'}-${index}`,
          templateId: finalTemplateId,
          template,
          data,
          error,
        };
      });

      setEntries(mapped);
      setParseTick((n) => n + 1);
    } catch (error: unknown) {
      setParseError(t('json_preview.parse_error', { message: getErrorMessage(error) }));
      setEntries([]);
    }
  }, [inputValue, templates, t]);

  // 更新 ref 引用以便 useMobileHeader 中调用
  loadTemplatesRef.current = loadTemplates;
  handleParseRef.current = handleParse;

  const validEntries = useMemo(() => entries.filter((e) => e.template && e.data && !e.error), [entries]);

  return (
    <div className="template-json-preview-page page-container">
      {/* 桌面端顶部导航栏 */}
      {!isSmallScreen && (
        <div className="template-json-preview-header">
          <div className="left">
            <NotionButton variant="ghost" size="sm" onClick={onBack} className="gap-2">
              <ArrowLeft className="h-4 w-4" />
              {t('json_preview.back')}
            </NotionButton>
            <div className="titles">
              <h2>{t('json_preview.title')}</h2>
              <p>{t('json_preview.subtitle')}</p>
            </div>
          </div>
          <div className="actions">
            <NotionButton variant="default" size="sm" onClick={loadTemplates} disabled={isLoadingTemplates} className="gap-1.5">
              {isLoadingTemplates ? <RefreshCw className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              <span>{t('json_preview.reload_templates')}</span>
            </NotionButton>
            <NotionButton variant="primary" size="sm" onClick={handleParse} className="gap-1.5">
              <Eye className="h-4 w-4" />
              <span>{t('json_preview.parse_button')}</span>
            </NotionButton>
          </div>
        </div>
      )}

      <CustomScrollArea viewportClassName="template-json-preview-viewport">
        <div className={cn("template-json-preview-body", isSmallScreen && "flex-col")}>
          <div className="input-column">
            <div className="panel">
              <div className="panel-header">
                <div className="title-group">
                  <Code2 className="h-4 w-4 text-indigo-500" />
                  <span>{t('json_preview.input_title')}</span>
                </div>
                <Badge variant="secondary">{t('json_preview.supports_multiple')}</Badge>
              </div>
              <p className="panel-desc">{t('json_preview.input_desc')}</p>
              <UnifiedCodeEditor
                value={inputValue}
                onChange={(value) => setInputValue(value)}
                language="json"
                height="400px"
                className="json-editor-wrapper"
              />
              <div className="panel-footer">
                <div className="legend">
                  <Badge variant="default">{t('json_preview.example_label')}</Badge>
                  <span>{t('json_preview.example_hint')}</span>
                </div>
                <div className="footer-actions">
                  <NotionButton
                    variant="default"
                    size="sm"
                    onClick={() => setInputValue(SAMPLE_JSON)}
                    className="gap-1.5"
                  >
                    <RefreshCw className="h-4 w-4" />
                    <span>{t('json_preview.reset')}</span>
                  </NotionButton>
                  <NotionButton variant="primary" size="sm" onClick={handleParse} className="gap-1.5">
                    <Eye className="h-4 w-4" />
                    <span>{t('json_preview.parse_button')}</span>
                  </NotionButton>
                </div>
              </div>
              {parseError && (
                <Alert variant="destructive" className="mt-3">
                  <AlertTitle>{t('json_preview.parse_failed')}</AlertTitle>
                  <AlertDescription>{parseError}</AlertDescription>
                </Alert>
              )}
            </div>
          </div>

          <div className="preview-column">
            <div className="panel sticky">
              <div className="panel-header">
                <div className="title-group">
                  <Eye className="h-4 w-4 text-emerald-500" />
                  <span>{t('json_preview.preview_title')}</span>
                </div>
                <Badge variant="outline">
                  {t('json_preview.preview_count', { count: validEntries.length })}
                </Badge>
              </div>
              {entries.length === 0 && (
                <div className="empty">
                  <p>{t('json_preview.empty')}</p>
                </div>
              )}
              <div className="preview-list" data-refresh-key={parseTick}>
                {entries.map((entry, index) => (
                  <div className="preview-card" key={`${entry.key}-${index}`}>
                    <div className="preview-card-head">
                      <div>
                        <div className="preview-card-title">
                          {entry.template?.name || entry.templateId || t('json_preview.unknown_template')}
                        </div>
                        <div className="preview-card-meta">
                          <span>{t('json_preview.template_id', { id: entry.templateId || '-' })}</span>
                          {entry.template?.note_type && (
                            <span className="note-type">
                              {t('json_preview.note_type', { noteType: entry.template.note_type })}
                            </span>
                          )}
                        </div>
                      </div>
                      <Badge variant={entry.error ? 'destructive' : 'secondary'}>
                        {entry.error ? t('json_preview.error_badge') : t('json_preview.ok_badge')}
                      </Badge>
                    </div>

                    {entry.error ? (
                      <Alert variant="destructive" className="mt-2">
                        <AlertTitle>{t('json_preview.parse_failed')}</AlertTitle>
                        <AlertDescription>{entry.error}</AlertDescription>
                      </Alert>
                    ) : (
                      <>
                        <div className="preview-grid">
                          <div className="preview-block">
                            <div className="preview-block-title">
                              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                              <span>{t('front_label')}</span>
                            </div>
                            {entry.template ? (
                              <IframePreview
                                htmlContent={renderCardPreview(
                                  entry.template.front_template || entry.template.preview_front || '',
                                  entry.template,
                                  entry.data || undefined,
                                  false
                                )}
                                cssContent={entry.template.css_style || ''}
                              />
                            ) : (
                              <Alert variant="destructive" className="mt-2">
                                <AlertDescription>{t('json_preview.template_not_found', { id: entry.templateId || '-' })}</AlertDescription>
                              </Alert>
                            )}
                          </div>
                          <div className="preview-block">
                            <div className="preview-block-title">
                              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                              <span>{t('back_label')}</span>
                            </div>
                            {entry.template ? (
                              <IframePreview
                                htmlContent={renderCardPreview(
                                  entry.template.back_template || entry.template.preview_back || '',
                                  entry.template,
                                  entry.data || undefined,
                                  true
                                )}
                                cssContent={entry.template.css_style || ''}
                              />
                            ) : null}
                          </div>
                        </div>
                        <div className="data-block">
                          <div className="data-block-title">
                            <Badge variant="outline">{t('json_preview.data_title')}</Badge>
                          </div>
                          <pre className="data-pre">{JSON.stringify(entry.data, null, 2)}</pre>
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* 移动端底部占位，避免被底部导航栏遮挡 */}
        {isSmallScreen && (
          <div
            style={{
              // 使用 CSS 变量作为 Android fallback
              height: 'calc(var(--android-safe-area-bottom, env(safe-area-inset-bottom, 0px)) + 64px)',
              flexShrink: 0,
            }}
          />
        )}
      </CustomScrollArea>
    </div>
  );
};

export default TemplateJsonPreviewPage;
