/**
 * 模板管理 — 模板库浏览器
 *
 * - 网格视图：缩略卡（名称 / 类型徽标 / 内置或自定义 / 字段数 / 正反面预览切换），
 *   hover / 键盘聚焦时浮现操作（编辑、复制副本、导出、删除）；
 * - 列表视图：紧凑行，同一套操作；
 * - 删除采用行内二次确认（8 秒后自动还原），内置模板给出"升级会复活"的诚实提示；
 * - 键盘导航：方向键在卡片间移动，Enter 打开（选择模式下为选用），Delete 触发删除确认；
 * - 加载骨架 / 空态 / 无匹配态。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  PencilSimple, Copy, Trash, FileText, Lightbulb, Download,
  Star, Warning, Plus, FunnelSimple, Cards,
} from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
import { IframePreview } from '@/components/SharedPreview';
import { cn } from '@/lib/utils';
import type { CustomAnkiTemplate } from '@/types';
import type { TemplateViewMode } from '../lib/templateLibrary';
import { getTemplateKind, formatTemplateDate } from '../lib/templateLibrary';

export type RenderPreview = (
  template: string,
  templateData: CustomAnkiTemplate,
  isBack?: boolean,
) => string;

/* ── 内联删除确认（无弹窗，自动超时还原） ── */

const DELETE_CONFIRM_TIMEOUT_MS = 8000;

interface InlineDeleteConfirmProps {
  template: CustomAnkiTemplate;
  onConfirm: () => void;
  onCancel: () => void;
}

const InlineDeleteConfirm: React.FC<InlineDeleteConfirmProps> = ({ template, onConfirm, onCancel }) => {
  const { t } = useTranslation('template');

  useEffect(() => {
    const timer = window.setTimeout(onCancel, DELETE_CONFIRM_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [onCancel]);

  return (
    <div className="wb-tm-delete-confirm" role="alert" aria-label={t('templateMgmt.delete_confirm_title', { name: template.name })}>
      <div className="wb-tm-delete-confirm-text">
        <Warning size={14} weight="fill" aria-hidden />
        <span>
          <strong>{t('templateMgmt.delete_confirm_title', { name: template.name })}</strong>{' '}
          {template.is_built_in
            ? t('templateMgmt.delete_confirm_builtin_note')
            : t('templateMgmt.delete_confirm_custom_note')}
        </span>
      </div>
      <div className="wb-tm-delete-confirm-actions">
        <NotionButton variant="ghost" size="sm" onClick={onCancel} autoFocus>
          {t('cancel_button')}
        </NotionButton>
        <NotionButton variant="danger" size="sm" onClick={onConfirm}>
          {t('templateMgmt.delete_confirm_button')}
        </NotionButton>
      </div>
    </div>
  );
};

/* ── 徽标 ── */

const TemplateBadges: React.FC<{ template: CustomAnkiTemplate; isDefault: boolean }> = ({ template, isDefault }) => {
  const { t } = useTranslation('template');
  const kind = getTemplateKind(template);
  return (
    <div className="wb-tm-card-badges">
      <span className={cn('wb-tm-badge', kind === 'cloze' ? 'wb-tm-badge--cloze' : 'wb-tm-badge--kind')}>
        {t(`templateMgmt.type_${kind}`)}
      </span>
      <span className="wb-tm-badge">
        {template.is_built_in ? t('builtin_badge') : t('templateMgmt.badge_custom')}
      </span>
      {isDefault && <span className="wb-tm-badge wb-tm-badge--primary">{t('default_badge')}</span>}
      {!template.is_active && <span className="wb-tm-badge wb-tm-badge--danger">{t('inactive_badge')}</span>}
    </div>
  );
};

/* ── 操作组（网格 hover 浮现 / 列表行尾） ── */

interface CardActionsProps {
  template: CustomAnkiTemplate;
  isDefault: boolean;
  isSelectingMode: boolean;
  onTemplateSelected?: (template: CustomAnkiTemplate) => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onExport: () => void;
  onRequestDelete: () => void;
  onSetDefault: () => void;
}

const CardActions: React.FC<CardActionsProps> = ({
  template,
  isDefault,
  isSelectingMode,
  onTemplateSelected,
  onEdit,
  onDuplicate,
  onExport,
  onRequestDelete,
  onSetDefault,
}) => {
  const { t } = useTranslation('template');

  if (isSelectingMode) {
    return (
      <div className="wb-tm-card-actions" onClick={(e) => e.stopPropagation()}>
        <NotionButton variant="primary" size="sm" className="w-full" onClick={() => onTemplateSelected?.(template)}>
          {t('use_template')}
        </NotionButton>
      </div>
    );
  }

  return (
    <div className="wb-tm-card-actions" onClick={(e) => e.stopPropagation()}>
      <NotionButton
        variant="utility"
        size="icon"
        iconOnly
        onClick={isDefault ? undefined : onSetDefault}
        disabled={isDefault}
        aria-label={isDefault ? t('default_template') : t('set_default')}
        title={isDefault ? t('default_template') : t('set_default')}
        className={cn(isDefault && 'wb-tm-star--active')}
      >
        <Star size={16} weight={isDefault ? 'fill' : 'regular'} />
      </NotionButton>
      <NotionButton variant="utility" size="icon" iconOnly onClick={onEdit} aria-label={t('edit_tooltip')} title={t('edit_tooltip')}>
        <PencilSimple size={16} />
      </NotionButton>
      <NotionButton variant="utility" size="icon" iconOnly onClick={onDuplicate} aria-label={t('duplicate_tooltip')} title={t('duplicate_tooltip')}>
        <Copy size={16} />
      </NotionButton>
      <NotionButton variant="utility" size="icon" iconOnly onClick={onExport} aria-label={t('export_tooltip')} title={t('export_tooltip')}>
        <Download size={16} />
      </NotionButton>
      <NotionButton variant="danger" size="icon" iconOnly onClick={onRequestDelete} aria-label={t('delete_tooltip')} title={t('delete_tooltip')}>
        <Trash size={16} />
      </NotionButton>
    </div>
  );
};

/* ── 网格缩略卡 ── */

interface TemplateCardProps {
  template: CustomAnkiTemplate;
  isSelected: boolean;
  isDefault: boolean;
  isPendingDelete: boolean;
  focusable: boolean;
  isSelectingMode: boolean;
  onTemplateSelected?: (template: CustomAnkiTemplate) => void;
  renderPreview: RenderPreview;
  onSelect: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onExport: () => void;
  onRequestDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  onSetDefault: () => void;
}

const TemplateCard: React.FC<TemplateCardProps> = ({
  template,
  isSelected,
  isDefault,
  isPendingDelete,
  focusable,
  isSelectingMode,
  onTemplateSelected,
  renderPreview,
  onSelect,
  onEdit,
  onDuplicate,
  onExport,
  onRequestDelete,
  onConfirmDelete,
  onCancelDelete,
  onSetDefault,
}) => {
  const { t, i18n } = useTranslation('template');
  const [previewSide, setPreviewSide] = useState<'front' | 'back'>('front');

  const previewHtml = previewSide === 'front'
    ? renderPreview(template.front_template || template.preview_front || '', template, false)
    : renderPreview(template.back_template || template.preview_back || '', template, true);

  const updatedLabel = formatTemplateDate(template.updated_at, i18n.language);

  return (
    <div
      className={cn('wb-tm-card ui-press', !template.is_active && 'inactive')}
      data-selected={isSelected || undefined}
      data-agent-entity={`templates:${template.id}`}
      data-template-item
      role="listitem"
      tabIndex={focusable ? 0 : -1}
      onClick={onSelect}
      aria-label={template.name}
    >
      <div className="wb-tm-card-header">
        <div className="min-w-0">
          <h4 className="wb-tm-card-title" title={template.name}>{template.name}</h4>
          <TemplateBadges template={template} isDefault={isDefault} />
        </div>
      </div>

      <div className="wb-tm-preview-container">
        <div className="wb-tm-preview-section">
          <div className="wb-tm-preview-label">
            <div className="wb-tm-side-toggle" role="group" aria-label={t('templateMgmt.preview_side_aria')} onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                className="wb-tm-side-toggle-btn"
                data-active={previewSide === 'front' ? 'true' : undefined}
                aria-pressed={previewSide === 'front'}
                onClick={() => setPreviewSide('front')}
                tabIndex={-1}
              >
                {t('front_label')}
              </button>
              <button
                type="button"
                className="wb-tm-side-toggle-btn"
                data-active={previewSide === 'back' ? 'true' : undefined}
                aria-pressed={previewSide === 'back'}
                onClick={() => setPreviewSide('back')}
                tabIndex={-1}
              >
                {t('back_label')}
              </button>
            </div>
            <span className="wb-tm-preview-meta">v{template.version}</span>
          </div>
          <div className="wb-tm-preview-content">
            <IframePreview
              htmlContent={previewHtml}
              cssContent={template.css_style || ''}
            />
          </div>
        </div>
      </div>

      <div className="wb-tm-card-info">
        {template.description && (
          <p className="wb-tm-card-description">{template.description}</p>
        )}
        <div className="wb-tm-card-meta">
          <span className="wb-tm-meta-item">
            <FileText size={12} className="opacity-70" aria-hidden />
            {t('fields_count', { count: template.fields.length })}
          </span>
          {updatedLabel && (
            <span className="wb-tm-meta-item">
              {t('templateMgmt.updated_short', { date: updatedLabel })}
            </span>
          )}
        </div>
        <div className="wb-tm-fields">
          {template.fields.slice(0, 4).map((field) => (
            <span key={field} className="wb-tm-field-tag">{field}</span>
          ))}
          {template.fields.length > 4 && (
            <span className="wb-tm-field-tag more">+{template.fields.length - 4}</span>
          )}
        </div>
      </div>

      {isPendingDelete ? (
        <div onClick={(e) => e.stopPropagation()}>
          <InlineDeleteConfirm template={template} onConfirm={onConfirmDelete} onCancel={onCancelDelete} />
        </div>
      ) : (
        <CardActions
          template={template}
          isDefault={isDefault}
          isSelectingMode={isSelectingMode}
          onTemplateSelected={onTemplateSelected}
          onEdit={onEdit}
          onDuplicate={onDuplicate}
          onExport={onExport}
          onRequestDelete={onRequestDelete}
          onSetDefault={onSetDefault}
        />
      )}
    </div>
  );
};

/* ── 列表行 ── */

type TemplateListRowProps = Omit<TemplateCardProps, 'renderPreview'>;

const TemplateListRow: React.FC<TemplateListRowProps> = ({
  template,
  isSelected,
  isDefault,
  isPendingDelete,
  focusable,
  isSelectingMode,
  onTemplateSelected,
  onSelect,
  onEdit,
  onDuplicate,
  onExport,
  onRequestDelete,
  onConfirmDelete,
  onCancelDelete,
  onSetDefault,
}) => {
  const { t, i18n } = useTranslation('template');
  const updatedLabel = formatTemplateDate(template.updated_at, i18n.language);

  return (
    <div
      className={cn('wb-tm-row', !template.is_active && 'inactive')}
      data-selected={isSelected || undefined}
      data-agent-entity={`templates:${template.id}`}
      data-template-item
      role="listitem"
      tabIndex={focusable ? 0 : -1}
      onClick={onSelect}
      aria-label={template.name}
    >
      <div className="wb-tm-row-main">
        <div className="wb-tm-row-title-line">
          <span className="wb-tm-row-name" title={template.name}>{template.name}</span>
          <TemplateBadges template={template} isDefault={isDefault} />
        </div>
        {template.description && (
          <p className="wb-tm-row-description">{template.description}</p>
        )}
      </div>
      <div className="wb-tm-row-meta">
        <span>{t('fields_count', { count: template.fields.length })}</span>
        {updatedLabel && <span>{t('templateMgmt.updated_short', { date: updatedLabel })}</span>}
      </div>
      {isPendingDelete ? (
        <div className="wb-tm-row-confirm" onClick={(e) => e.stopPropagation()}>
          <InlineDeleteConfirm template={template} onConfirm={onConfirmDelete} onCancel={onCancelDelete} />
        </div>
      ) : (
        <CardActions
          template={template}
          isDefault={isDefault}
          isSelectingMode={isSelectingMode}
          onTemplateSelected={onTemplateSelected}
          onEdit={onEdit}
          onDuplicate={onDuplicate}
          onExport={onExport}
          onRequestDelete={onRequestDelete}
          onSetDefault={onSetDefault}
        />
      )}
    </div>
  );
};

/* ── 骨架屏 ── */

const TemplateSkeletonGrid: React.FC<{ viewMode: TemplateViewMode }> = ({ viewMode }) => {
  const items = Array.from({ length: viewMode === 'grid' ? 6 : 8 });
  if (viewMode === 'list') {
    return (
      <div className="wb-tm-list" aria-hidden>
        {items.map((_, i) => (
          <div key={i} className="wb-tm-row wb-tm-skeleton-row">
            <div className="wb-tm-skeleton wb-tm-skeleton--title" />
            <div className="wb-tm-skeleton wb-tm-skeleton--line" />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="wb-tm-grid" aria-hidden>
      {items.map((_, i) => (
        <div key={i} className="wb-tm-card wb-tm-skeleton-card">
          <div className="wb-tm-skeleton wb-tm-skeleton--title" />
          <div className="wb-tm-skeleton wb-tm-skeleton--preview" />
          <div className="wb-tm-skeleton wb-tm-skeleton--line" />
          <div className="wb-tm-skeleton wb-tm-skeleton--line short" />
        </div>
      ))}
    </div>
  );
};

/* ── 浏览器主体 ── */

export interface TemplateBrowserProps {
  templates: CustomAnkiTemplate[];
  totalCount: number;
  hasFilters: boolean;
  viewMode: TemplateViewMode;
  selectedTemplate: CustomAnkiTemplate | null;
  onSelectTemplate: (template: CustomAnkiTemplate) => void;
  onEditTemplate: (template: CustomAnkiTemplate) => void;
  onDuplicateTemplate: (template: CustomAnkiTemplate) => void;
  onDeleteTemplate: (template: CustomAnkiTemplate) => void | Promise<void>;
  onSetDefaultTemplate: (template: CustomAnkiTemplate) => void;
  onExportTemplate: (template: CustomAnkiTemplate) => void;
  onCreateTemplate?: () => void;
  onResetFilters?: () => void;
  defaultTemplateId: string | null;
  isLoading: boolean;
  isSelectingMode?: boolean;
  onTemplateSelected?: (template: CustomAnkiTemplate) => void;
  renderPreview: RenderPreview;
  isSmallScreen?: boolean;
}

export const TemplateBrowser: React.FC<TemplateBrowserProps> = ({
  templates,
  totalCount,
  hasFilters,
  viewMode,
  selectedTemplate,
  onSelectTemplate,
  onEditTemplate,
  onDuplicateTemplate,
  onDeleteTemplate,
  onSetDefaultTemplate,
  onExportTemplate,
  onCreateTemplate,
  onResetFilters,
  defaultTemplateId,
  isLoading,
  isSelectingMode = false,
  onTemplateSelected,
  renderPreview,
  isSmallScreen = false,
}) => {
  const { t } = useTranslation('template');
  const containerRef = useRef<HTMLDivElement>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  // roving focus：记录当前可 Tab 到的卡片 id
  const [focusedId, setFocusedId] = useState<string | null>(null);

  // 列表变化后清理悬挂状态（如删除后 pendingDeleteId 指向已消失的模板）
  useEffect(() => {
    if (pendingDeleteId && !templates.some((item) => item.id === pendingDeleteId)) {
      setPendingDeleteId(null);
    }
    if (focusedId && !templates.some((item) => item.id === focusedId)) {
      setFocusedId(templates[0]?.id ?? null);
    }
  }, [templates, pendingDeleteId, focusedId]);

  const effectiveFocusId = focusedId ?? templates[0]?.id ?? null;

  const focusItemByIndex = useCallback((index: number) => {
    const container = containerRef.current;
    if (!container) return;
    const items = Array.from(container.querySelectorAll<HTMLElement>('[data-template-item]'));
    const clamped = Math.max(0, Math.min(index, items.length - 1));
    const target = items[clamped];
    if (target) {
      const template = templates[clamped];
      if (template) setFocusedId(template.id);
      target.focus();
    }
  }, [templates]);

  const getColumnsCount = useCallback(() => {
    const container = containerRef.current;
    if (!container || viewMode === 'list') return 1;
    const items = Array.from(container.querySelectorAll<HTMLElement>('[data-template-item]'));
    if (items.length <= 1) return 1;
    const firstTop = items[0].offsetTop;
    let columns = 0;
    for (const item of items) {
      if (Math.abs(item.offsetTop - firstTop) < 2) columns += 1;
      else break;
    }
    return Math.max(1, columns);
  }, [viewMode]);

  const handleContainerKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    // 只处理卡片本体上的按键，避免劫持内部按钮/输入框
    if (!target.hasAttribute('data-template-item')) return;

    const container = containerRef.current;
    if (!container) return;
    const items = Array.from(container.querySelectorAll<HTMLElement>('[data-template-item]'));
    const currentIndex = items.indexOf(target);
    if (currentIndex < 0) return;
    const template = templates[currentIndex];
    const columns = getColumnsCount();

    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        focusItemByIndex(currentIndex + 1);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        focusItemByIndex(currentIndex - 1);
        break;
      case 'ArrowDown':
        event.preventDefault();
        focusItemByIndex(currentIndex + columns);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusItemByIndex(currentIndex - columns);
        break;
      case 'Home':
        event.preventDefault();
        focusItemByIndex(0);
        break;
      case 'End':
        event.preventDefault();
        focusItemByIndex(items.length - 1);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (!template) break;
        if (isSelectingMode) {
          onTemplateSelected?.(template);
        } else {
          onEditTemplate(template);
        }
        break;
      case 'Delete':
      case 'Backspace':
        if (!isSelectingMode && template) {
          event.preventDefault();
          setPendingDeleteId(template.id);
        }
        break;
      default:
        break;
    }
  }, [templates, getColumnsCount, focusItemByIndex, isSelectingMode, onTemplateSelected, onEditTemplate]);

  const confirmDelete = useCallback((template: CustomAnkiTemplate) => {
    setPendingDeleteId(null);
    void onDeleteTemplate(template);
  }, [onDeleteTemplate]);

  const cancelDelete = useCallback(() => setPendingDeleteId(null), []);

  const renderItem = (template: CustomAnkiTemplate) => {
    const shared = {
      template,
      isSelected: selectedTemplate?.id === template.id,
      isDefault: defaultTemplateId === template.id,
      isPendingDelete: pendingDeleteId === template.id,
      focusable: effectiveFocusId === template.id,
      isSelectingMode,
      onTemplateSelected,
      onSelect: () => {
        setFocusedId(template.id);
        onSelectTemplate(template);
      },
      onEdit: () => onEditTemplate(template),
      onDuplicate: () => onDuplicateTemplate(template),
      onExport: () => onExportTemplate(template),
      onRequestDelete: () => setPendingDeleteId(template.id),
      onConfirmDelete: () => confirmDelete(template),
      onCancelDelete: cancelDelete,
      onSetDefault: () => onSetDefaultTemplate(template),
    };
    return viewMode === 'grid'
      ? <TemplateCard key={template.id} {...shared} renderPreview={renderPreview} />
      : <TemplateListRow key={template.id} {...shared} />;
  };

  const isEmptyLibrary = totalCount === 0 && !isLoading;
  const isNoResults = totalCount > 0 && templates.length === 0 && !isLoading;

  return (
    <div className={cn('wb-tm-browser', isSmallScreen && 'mobile-layout')}>
      {isSelectingMode && (
        <div className="wb-tm-hint">
          <Lightbulb size={16} aria-hidden />
          <span>{t('mode_hint')}</span>
        </div>
      )}

      {isLoading ? (
        <TemplateSkeletonGrid viewMode={viewMode} />
      ) : isEmptyLibrary ? (
        <div className="wb-tm-empty">
          <Cards size={36} className="text-muted-foreground/40" aria-hidden />
          <h3 className="wb-tm-empty-title">{t('empty_title')}</h3>
          <p>{t('empty_description')}</p>
          {!isSelectingMode && onCreateTemplate && (
            <NotionButton variant="primary" size="sm" onClick={onCreateTemplate} className="mt-1">
              <Plus size={14} />
              {t('tab_create')}
            </NotionButton>
          )}
        </div>
      ) : isNoResults ? (
        <div className="wb-tm-empty">
          <FunnelSimple size={36} className="text-muted-foreground/40" aria-hidden />
          <h3 className="wb-tm-empty-title">{t('templateMgmt.no_results_title')}</h3>
          <p>{t('templateMgmt.no_results_desc')}</p>
          {onResetFilters && hasFilters && (
            <NotionButton variant="default" size="sm" onClick={onResetFilters} className="mt-1">
              {t('templateMgmt.clear_filters')}
            </NotionButton>
          )}
        </div>
      ) : (
        <div
          ref={containerRef}
          className={viewMode === 'grid' ? 'wb-tm-grid' : 'wb-tm-list'}
          role="list"
          aria-label={t('templateMgmt.library_aria')}
          onKeyDown={handleContainerKeyDown}
        >
          {templates.map(renderItem)}
        </div>
      )}
    </div>
  );
};

export default TemplateBrowser;
