/**
 * 模板库工具栏：搜索（防抖在上层）、类型/来源筛选 chips、排序、网格/列表视图切换。
 * 全部内联控件，无任何弹层。
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { MagnifyingGlass, SquaresFour, Rows, CaretDown, X } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import type {
  TemplateLibraryQuery,
  TemplateSortOrder,
  TemplateSourceFilter,
  TemplateTypeFilter,
  TemplateViewMode,
} from '../lib/templateLibrary';
import { hasActiveFilters } from '../lib/templateLibrary';

export interface TemplateToolbarProps {
  searchInput: string;
  onSearchInputChange: (value: string) => void;
  query: TemplateLibraryQuery;
  onTypeFilterChange: (value: TemplateTypeFilter) => void;
  onSourceFilterChange: (value: TemplateSourceFilter) => void;
  onSortOrderChange: (value: TemplateSortOrder) => void;
  onResetFilters: () => void;
  viewMode: TemplateViewMode;
  onViewModeChange: (mode: TemplateViewMode) => void;
  resultCount: number;
  totalCount: number;
}

const TYPE_FILTERS: TemplateTypeFilter[] = ['all', 'basic', 'cloze', 'other'];
const SOURCE_FILTERS: TemplateSourceFilter[] = ['all', 'builtin', 'custom'];
const SORT_ORDERS: TemplateSortOrder[] = ['updated_desc', 'created_desc', 'name_asc', 'fields_desc'];

export const TemplateToolbar: React.FC<TemplateToolbarProps> = ({
  searchInput,
  onSearchInputChange,
  query,
  onTypeFilterChange,
  onSourceFilterChange,
  onSortOrderChange,
  onResetFilters,
  viewMode,
  onViewModeChange,
  resultCount,
  totalCount,
}) => {
  const { t } = useTranslation('template');
  const filtersActive = hasActiveFilters({ ...query, search: searchInput });

  const typeLabel = (value: TemplateTypeFilter) => t(`templateMgmt.type_${value}`);
  const sourceLabel = (value: TemplateSourceFilter) => t(`templateMgmt.source_${value}`);

  return (
    <div className="wb-tm-toolbar" role="search">
      <div className="wb-tm-toolbar-row">
        <div className="wb-tm-toolbar-search">
          <MagnifyingGlass size={14} aria-hidden />
          <input
            type="search"
            value={searchInput}
            onChange={(e) => onSearchInputChange(e.target.value)}
            placeholder={t('search_placeholder')}
            aria-label={t('search_placeholder')}
            className="wb-tm-toolbar-search-input"
          />
          {searchInput && (
            <button
              type="button"
              className="wb-tm-toolbar-search-clear"
              onClick={() => onSearchInputChange('')}
              aria-label={t('templateMgmt.clear_search')}
            >
              <X size={12} weight="bold" />
            </button>
          )}
        </div>

        <div className="wb-tm-toolbar-spacer" />

        <span className="wb-tm-toolbar-count" aria-live="polite">
          {filtersActive
            ? t('templateMgmt.results_of_total', { count: resultCount, total: totalCount })
            : t('templateMgmt.results_count', { count: resultCount })}
        </span>

        <div className="wb-tm-sort">
          <label className="wb-tm-sort-label" htmlFor="wb-tm-sort-select">
            {t('templateMgmt.sort_label')}
          </label>
          <div className="wb-tm-sort-select-wrap">
            <select
              id="wb-tm-sort-select"
              className="wb-tm-sort-select"
              value={query.sortOrder}
              onChange={(e) => onSortOrderChange(e.target.value as TemplateSortOrder)}
            >
              {SORT_ORDERS.map((order) => (
                <option key={order} value={order}>
                  {t(`templateMgmt.sort_${order}`)}
                </option>
              ))}
            </select>
            <CaretDown size={11} className="wb-tm-sort-caret" aria-hidden />
          </div>
        </div>

        <div className="wb-tm-view-toggle" role="group" aria-label={t('templateMgmt.view_toggle_aria')}>
          <button
            type="button"
            className="wb-tm-view-toggle-btn"
            data-active={viewMode === 'grid' ? 'true' : undefined}
            aria-pressed={viewMode === 'grid'}
            onClick={() => onViewModeChange('grid')}
            title={t('templateMgmt.view_grid')}
            aria-label={t('templateMgmt.view_grid')}
          >
            <SquaresFour size={15} weight={viewMode === 'grid' ? 'fill' : 'regular'} />
          </button>
          <button
            type="button"
            className="wb-tm-view-toggle-btn"
            data-active={viewMode === 'list' ? 'true' : undefined}
            aria-pressed={viewMode === 'list'}
            onClick={() => onViewModeChange('list')}
            title={t('templateMgmt.view_list')}
            aria-label={t('templateMgmt.view_list')}
          >
            <Rows size={15} weight={viewMode === 'list' ? 'fill' : 'regular'} />
          </button>
        </div>
      </div>

      <div className="wb-tm-toolbar-row wb-tm-toolbar-row--chips">
        <div className="wb-tm-chip-group" role="group" aria-label={t('templateMgmt.filter_type_label')}>
          {TYPE_FILTERS.map((value) => (
            <button
              key={value}
              type="button"
              className="wb-tm-chip"
              data-active={query.typeFilter === value ? 'true' : undefined}
              aria-pressed={query.typeFilter === value}
              onClick={() => onTypeFilterChange(value)}
            >
              {typeLabel(value)}
            </button>
          ))}
        </div>

        <span className="wb-tm-chip-divider" aria-hidden />

        <div className="wb-tm-chip-group" role="group" aria-label={t('templateMgmt.filter_source_label')}>
          {SOURCE_FILTERS.map((value) => (
            <button
              key={value}
              type="button"
              className="wb-tm-chip"
              data-active={query.sourceFilter === value ? 'true' : undefined}
              aria-pressed={query.sourceFilter === value}
              onClick={() => onSourceFilterChange(value)}
            >
              {sourceLabel(value)}
            </button>
          ))}
        </div>

        {filtersActive && (
          <button
            type="button"
            className={cn('wb-tm-chip', 'wb-tm-chip--reset')}
            onClick={onResetFilters}
          >
            <X size={11} weight="bold" />
            {t('templateMgmt.clear_filters')}
          </button>
        )}
      </div>
    </div>
  );
};

export default TemplateToolbar;
