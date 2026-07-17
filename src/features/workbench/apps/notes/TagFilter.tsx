import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { useNoteTags, type NoteTagItem } from './hooks/useNoteTags';
import './TagFilter.css';

export interface TagFilterProps {
  /** Currently selected tags (controlled). Intersection filter when multi-select. */
  selectedTags: readonly string[];
  /** Called with the next selected tag list after toggle / clear. */
  onChange: (next: string[]) => void;
  /**
   * Optional available tags. When omitted, tags are loaded via `useNoteTags`.
   * Pass this when the host already owns the tag list (e.g. Explorer header).
   */
  tags?: readonly NoteTagItem[];
  loading?: boolean;
  error?: string | null;
  onRefresh?: () => void;
  className?: string;
}

function normalizeSelected(selected: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of selected) {
    const trimmed = tag.trim();
    if (!trimmed) continue;
    const key = trimmed.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

export const TagFilter: React.FC<TagFilterProps> = ({
  selectedTags,
  onChange,
  tags: tagsProp,
  loading: loadingProp,
  error: errorProp,
  onRefresh,
  className,
}) => {
  const { t } = useTranslation();
  const hooked = useNoteTags(tagsProp === undefined);
  const tags = tagsProp ?? hooked.tags;
  const loading = loadingProp ?? (tagsProp === undefined ? hooked.loading : false);
  const error = errorProp ?? (tagsProp === undefined ? hooked.error : null);
  const refresh = onRefresh ?? (tagsProp === undefined ? hooked.refresh : undefined);

  const selected = normalizeSelected(selectedTags);
  const selectedKeys = new Set(selected.map((tag) => tag.toLocaleLowerCase()));

  const toggleTag = useCallback((tag: string) => {
    const key = tag.trim().toLocaleLowerCase();
    if (!key) return;
    const current = normalizeSelected(selectedTags);
    const has = current.some((item) => item.toLocaleLowerCase() === key);
    onChange(has
      ? current.filter((item) => item.toLocaleLowerCase() !== key)
      : [...current, tag.trim()]);
  }, [onChange, selectedTags]);

  const clearAll = useCallback(() => {
    onChange([]);
  }, [onChange]);

  return (
    <div className={cn('notes-tag-filter', className)} data-notes-tag-filter>
      <div className="notes-tag-filter-toolbar">
        <span className="notes-tag-filter-label">
          {t('workbench:notesWorkspace.tagFilter.label')}
        </span>
        <button
          type="button"
          className="notes-tag-filter-clear"
          disabled={selected.length === 0}
          onClick={clearAll}
        >
          {t('workbench:notesWorkspace.tagFilter.clear')}
        </button>
      </div>

      {loading ? (
        <div className="notes-tag-filter-status">
          {t('workbench:notesWorkspace.tagFilter.loading')}
        </div>
      ) : error ? (
        <div className="notes-tag-filter-status" data-error="true" role="alert">
          <span>{error}</span>
          {refresh && (
            <button type="button" className="notes-tag-filter-clear" onClick={() => void refresh()}>
              {t('workbench:notesWorkspace.tagFilter.retry')}
            </button>
          )}
        </div>
      ) : tags.length === 0 ? (
        <div className="notes-tag-filter-status">
          {t('workbench:notesWorkspace.tagFilter.empty')}
        </div>
      ) : (
        <div className="notes-tag-filter-chips" role="group" aria-label={t('workbench:notesWorkspace.tagFilter.label')}>
          {tags.map((tag) => {
            const active = selectedKeys.has(tag.name.toLocaleLowerCase());
            return (
              <button
                key={tag.name}
                type="button"
                className="notes-tag-filter-chip"
                data-active={active ? 'true' : undefined}
                aria-pressed={active}
                onClick={() => toggleTag(tag.name)}
              >
                <span>{tag.name}</span>
                {typeof tag.count === 'number' && (
                  <span className="notes-tag-filter-chip-count">{tag.count}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default TagFilter;
