import React, { useId, useState } from 'react';
import { CaretDown, FileText, Star, TreeStructure } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { NoteFavoriteItem, NoteFavoriteResourceType } from './hooks/useNoteFavorites';
import './FavoritesSection.css';

export type FavoritesSectionItem = Pick<NoteFavoriteItem, 'id' | 'name' | 'type'> & {
  path?: string;
};

export interface FavoritesSectionProps {
  /** Controlled favorite rows (note + mindmap). */
  items: readonly FavoritesSectionItem[];
  /** Open a favorite resource. */
  onOpen: (item: FavoritesSectionItem) => void;
  /** Remove from favorites (host calls `useNoteFavorites` / API). */
  onUnfavorite: (item: FavoritesSectionItem) => void;
  /** Highlight the active resource id when it appears in favorites. */
  activeId?: string | null;
  /** Controlled expanded state. When omitted, the section manages open/closed itself. */
  expanded?: boolean;
  /** Notified when the user toggles the section header. */
  onExpandedChange?: (expanded: boolean) => void;
  /** Initial expanded state for uncontrolled mode. Default true. */
  defaultExpanded?: boolean;
  className?: string;
}

const TypeGlyph: React.FC<{ type: NoteFavoriteResourceType; size?: number }> = ({
  type,
  size = 14,
}) => (type === 'mindmap'
  ? <TreeStructure size={size} aria-hidden />
  : <FileText size={size} aria-hidden />);

/**
 * Collapsible Favorites block for the Notes explorer sidebar.
 * Fully controlled for data/actions — no DSTU calls inside.
 */
export const FavoritesSection: React.FC<FavoritesSectionProps> = ({
  items,
  onOpen,
  onUnfavorite,
  activeId = null,
  expanded,
  onExpandedChange,
  defaultExpanded = true,
  className,
}) => {
  const { t } = useTranslation();
  const listId = useId();
  const [uncontrolledExpanded, setUncontrolledExpanded] = useState(defaultExpanded);
  const isExpanded = expanded ?? uncontrolledExpanded;

  const setExpanded = (next: boolean) => {
    if (expanded === undefined) setUncontrolledExpanded(next);
    onExpandedChange?.(next);
  };

  return (
    <section className={cn('nfs-section', className)} data-expanded={isExpanded ? 'true' : 'false'}>
      <button
        type="button"
        className="nfs-header"
        aria-expanded={isExpanded}
        aria-controls={listId}
        onClick={() => setExpanded(!isExpanded)}
      >
        <span className={cn('nfs-caret', !isExpanded && 'is-collapsed')} aria-hidden>
          <CaretDown size={12} />
        </span>
        <span className="nfs-header-label">
          {t('workbench:notesWorkspace.favorites.title')}
        </span>
        <span className="nfs-header-count" aria-hidden>{items.length}</span>
      </button>

      {isExpanded ? (
        <div id={listId} className="nfs-list" role="list">
          {items.length === 0 ? (
            <p className="nfs-empty">
              {t('workbench:notesWorkspace.favorites.empty')}
            </p>
          ) : (
            items.map((item) => {
              const isActive = activeId === item.id;
              return (
                <div
                  key={`${item.type}:${item.id}`}
                  className={cn('nfs-item', isActive && 'is-active')}
                  role="listitem"
                >
                  <button
                    type="button"
                    className="nfs-item-main"
                    onClick={() => onOpen(item)}
                    aria-current={isActive ? 'page' : undefined}
                  >
                    <span className="nfs-item-icon"><TypeGlyph type={item.type} /></span>
                    <span className="nfs-item-name">{item.name}</span>
                  </button>
                  <button
                    type="button"
                    className="nfs-unfavorite"
                    aria-label={t('workbench:notesWorkspace.favorites.unfavorite', { name: item.name })}
                    title={t('workbench:notesWorkspace.favorites.unfavorite', { name: item.name })}
                    onClick={() => onUnfavorite(item)}
                  >
                    <Star size={14} weight="fill" aria-hidden />
                  </button>
                </div>
              );
            })
          )}
        </div>
      ) : null}
    </section>
  );
};

export default FavoritesSection;
