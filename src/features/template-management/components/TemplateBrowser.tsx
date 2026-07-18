/**
 * 模板管理 — 浏览网格（双列瀑布流）与模板卡片
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  PencilSimple, Copy, Trash, FileText, Lightbulb, User, Download,
} from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
import { IframePreview } from '@/components/SharedPreview';
import type { CustomAnkiTemplate } from '@/types';

export type RenderPreview = (
  template: string,
  templateData: CustomAnkiTemplate,
  isBack?: boolean,
) => string;

interface TemplateCardProps {
  template: CustomAnkiTemplate;
  isSelected: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onSetDefaultTemplate: () => void;
  defaultTemplateId: string | null;
  isSelectingMode?: boolean;
  onTemplateSelected?: (template: CustomAnkiTemplate) => void;
  renderPreview: RenderPreview;
  onExportTemplate: () => void;
}

const TemplateCard: React.FC<TemplateCardProps> = ({
  template,
  isSelected,
  onSelect,
  onEdit,
  onDuplicate,
  onDelete,
  onSetDefaultTemplate,
  defaultTemplateId,
  isSelectingMode = false,
  onTemplateSelected,
  renderPreview,
  onExportTemplate,
}) => {
  const { t } = useTranslation('template');
  const isDefault = defaultTemplateId === template.id;

  const renderActions = () => (
    <div className="wb-tm-card-actions" onClick={e => e.stopPropagation()}>
      {isSelectingMode ? (
        <NotionButton
          variant="primary"
          size="sm"
          onClick={() => onTemplateSelected?.(template)}
        >
          {t('use_template')}
        </NotionButton>
      ) : (
        <>
          <NotionButton
            variant="shell"
            size="sm"
            className="flex-1 min-w-0"
            onClick={isDefault ? undefined : onSetDefaultTemplate}
            disabled={isDefault}
          >
            {isDefault ? t('default_template') : t('set_default')}
          </NotionButton>
          <div className="wb-tm-action-buttons">
            <NotionButton variant="utility" size="icon" iconOnly onClick={onEdit} aria-label={t('edit_tooltip')} title={t('edit_tooltip')}>
              <PencilSimple size={16} />
            </NotionButton>
            <NotionButton variant="utility" size="icon" iconOnly onClick={onDuplicate} aria-label={t('duplicate_tooltip')} title={t('duplicate_tooltip')}>
              <Copy size={16} />
            </NotionButton>
            <NotionButton variant="utility" size="icon" iconOnly onClick={onExportTemplate} aria-label={t('export_tooltip')} title={t('export_tooltip')}>
              <Download size={16} />
            </NotionButton>
            <NotionButton variant="danger" size="icon" iconOnly onClick={onDelete} aria-label={t('delete_tooltip')} title={t('delete_tooltip')}>
              <Trash size={16} />
            </NotionButton>
          </div>
        </>
      )}
    </div>
  );

  return (
    <div
      className={`wb-tm-card ${!template.is_active ? 'inactive' : ''}`}
      data-selected={isSelected}
      onClick={onSelect}
    >
      {/* 卡片头部 */}
      <div className="wb-tm-card-header">
        <div>
          <h4 className="wb-tm-card-title">{template.name}</h4>
          <div className="wb-tm-card-badges">
            {isDefault && <span className="wb-tm-badge wb-tm-badge--primary">{t('default_badge')}</span>}
            {template.is_built_in && <span className="wb-tm-badge">{t('builtin_badge')}</span>}
            {!template.is_active && <span className="wb-tm-badge wb-tm-badge--danger">{t('inactive_badge')}</span>}
            <span className="wb-tm-badge wb-tm-badge--success">v{template.version}</span>
          </div>
        </div>
      </div>

      {/* 预览区域 */}
      <div className="wb-tm-preview-container">
        <div className="wb-tm-preview-section">
          <div className="wb-tm-preview-label">{t('front_label')}</div>
          <div className="wb-tm-preview-content">
            <IframePreview
              htmlContent={renderPreview(template.front_template || template.preview_front || '', template, false)}
              cssContent={template.css_style || ''}
            />
          </div>
        </div>
        <div className="wb-tm-preview-section">
          <div className="wb-tm-preview-label">{t('back_label')}</div>
          <div className="wb-tm-preview-content">
            <IframePreview
              htmlContent={renderPreview(template.back_template || template.preview_back || '', template, true)}
              cssContent={template.css_style || ''}
            />
          </div>
        </div>
      </div>

      {/* 卡片信息 */}
      <div className="wb-tm-card-info">
        <p className="wb-tm-card-description">{template.description}</p>
        <div className="wb-tm-card-meta">
          <span className="wb-tm-meta-item">
            <User size={12} className="opacity-70" />
            {template.author || t('author_unknown')}
          </span>
          <span className="wb-tm-meta-item">
            <FileText size={12} className="opacity-70" />
            {t('fields_count', { count: template.fields.length })}
          </span>
        </div>
        <div className="wb-tm-fields">
          {template.fields.slice(0, 4).map(field => (
            <span key={field} className="wb-tm-field-tag">{field}</span>
          ))}
          {template.fields.length > 4 && (
            <span className="wb-tm-field-tag more">+{template.fields.length - 4}</span>
          )}
        </div>
      </div>

      {renderActions()}
    </div>
  );
};

export interface TemplateBrowserProps {
  templates: CustomAnkiTemplate[];
  selectedTemplate: CustomAnkiTemplate | null;
  onSelectTemplate: (template: CustomAnkiTemplate) => void;
  onEditTemplate: (template: CustomAnkiTemplate) => void;
  onDuplicateTemplate: (template: CustomAnkiTemplate) => void;
  onDeleteTemplate: (template: CustomAnkiTemplate) => void;
  onSetDefaultTemplate: (template: CustomAnkiTemplate) => void;
  defaultTemplateId: string | null;
  isLoading: boolean;
  isSelectingMode?: boolean;
  onTemplateSelected?: (template: CustomAnkiTemplate) => void;
  renderPreview: RenderPreview;
  onExportTemplate: (template: CustomAnkiTemplate) => void;
  isSmallScreen?: boolean;
}

export const TemplateBrowser: React.FC<TemplateBrowserProps> = ({
  templates,
  selectedTemplate,
  onSelectTemplate,
  onEditTemplate,
  onDuplicateTemplate,
  onDeleteTemplate,
  onSetDefaultTemplate,
  defaultTemplateId,
  isLoading,
  isSelectingMode = false,
  onTemplateSelected,
  renderPreview,
  onExportTemplate,
  isSmallScreen = false,
}) => {
  const { t } = useTranslation('template');

  const renderColumn = (predicate: (index: number) => boolean) => (
    <div className="wb-tm-column">
      {templates.filter((_, i) => predicate(i)).map(template => (
        <TemplateCard
          key={template.id}
          template={template}
          isSelected={selectedTemplate?.id === template.id}
          onSelect={() => onSelectTemplate(template)}
          onEdit={() => onEditTemplate(template)}
          onDuplicate={() => onDuplicateTemplate(template)}
          onDelete={() => onDeleteTemplate(template)}
          onSetDefaultTemplate={() => onSetDefaultTemplate(template)}
          defaultTemplateId={defaultTemplateId}
          isSelectingMode={isSelectingMode}
          onTemplateSelected={onTemplateSelected}
          renderPreview={renderPreview}
          onExportTemplate={() => onExportTemplate(template)}
        />
      ))}
    </div>
  );

  return (
    <div className={`wb-tm-browser ${isSmallScreen ? 'mobile-layout' : ''}`}>
      {/* 选择模式提示 */}
      {isSelectingMode && (
        <div className="wb-tm-hint">
          <Lightbulb size={16} />
          <span>{t('mode_hint')}</span>
        </div>
      )}

      {/* 模板网格 */}
      {isLoading ? (
        <div className="wb-tm-loading">
          <div className="wb-tm-spinner" />
          <span>{t('loading_text')}</span>
        </div>
      ) : (
        <div className="wb-tm-grid">
          {renderColumn(i => i % 2 === 0)}
          {renderColumn(i => i % 2 === 1)}
        </div>
      )}

      {templates.length === 0 && !isLoading && (
        <div className="wb-tm-empty">
          <FileText size={32} className="text-muted-foreground/40" />
          <h3 className="wb-tm-empty-title">{t('empty_title')}</h3>
          <p>{t('empty_description')}</p>
        </div>
      )}
    </div>
  );
};
