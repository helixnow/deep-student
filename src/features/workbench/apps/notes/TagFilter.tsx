import React, { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { useNoteTags, type NoteTagItem } from './hooks/useNoteTags';
import './TagFilter.css';

export interface TagFilterGroup {
  /** First `a/b` path segment, or null for tags without a nested prefix. */
  prefix: string | null;
  tags: readonly NoteTagItem[];
}

/**
 * Groups `a/b`-style nested tags under their first path segment while
 * keeping flat tags in a leading prefix-less group. Group order follows the
 * first appearance in the incoming (already sorted) tag list.
 */
export function groupTagsByPrefix(tags: readonly NoteTagItem[]): TagFilterGroup[] {
  const flat: NoteTagItem[] = [];
  const grouped = new Map<string, NoteTagItem[]>();
  for (const tag of tags) {
    const slash = tag.name.indexOf('/');
    if (slash <= 0 || slash === tag.name.length - 1) {
      flat.push(tag);
      continue;
    }
    const prefix = tag.name.slice(0, slash);
    const bucket = grouped.get(prefix) ?? [];
    bucket.push(tag);
    grouped.set(prefix, bucket);
  }

  const groups: TagFilterGroup[] = [];
  if (flat.length > 0) groups.push({ prefix: null, tags: flat });
  for (const [prefix, bucket] of grouped) {
    // 单独一个 a/b 标签不值得占一行分组，并入平铺组
    if (bucket.length === 1 && flat.length > 0) {
      groups[0] = { prefix: null, tags: [...groups[0].tags, ...bucket] };
      continue;
    }
    groups.push({ prefix, tags: bucket });
  }
  return groups;
}

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

  const groups = useMemo(() => groupTagsByPrefix(tags), [tags]);

  const renderChip = (tag: NoteTagItem, display: string) => {
    const active = selectedKeys.has(tag.name.toLocaleLowerCase());
    return (
      <button
        key={tag.name}
        type="button"
        className="notes-tag-filter-chip"
        data-active={active ? 'true' : undefined}
        aria-pressed={active}
        aria-label={tag.name}
        title={tag.name}
        onClick={() => toggleTag(tag.name)}
      >
        <span>{display}</span>
        {typeof tag.count === 'number' && (
          <span className="notes-tag-filter-chip-count">{tag.count}</span>
        )}
      </button>
    );
  };

  return (
    <div className={cn('notes-tag-filter', className)} data-notes-tag-filter>
      <div className="notes-tag-filter-toolbar">
        <span className="notes-tag-filter-label">
          {t('workbench:notesWorkspace.tagFilter.label')}
          {selected.length > 0 && (
            <span className="notes-tag-filter-selected-count">{selected.length}</span>
          )}
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

      {selected.length > 1 && (
        <p className="notes-tag-filter-hint" role="note">
          {t('workbench:notesWorkspace.tagFilter.intersectionHint', {
            defaultValue: '交集筛选：仅显示同时包含这 {{count}} 个标签的笔记',
            count: selected.length,
          })}
        </p>
      )}

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
          {groups.map((group) => (
            <div
              key={group.prefix ?? ''}
              className="notes-tag-filter-row"
              data-prefix={group.prefix ?? undefined}
            >
              {group.prefix !== null && (
                <span className="notes-tag-filter-group-label" aria-hidden="true">
                  {group.prefix}/
                </span>
              )}
              {group.tags.map((tag) => renderChip(
                tag,
                group.prefix !== null ? tag.name.slice(group.prefix.length + 1) : tag.name,
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default TagFilter;
