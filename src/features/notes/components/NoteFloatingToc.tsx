import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DsButton } from '@/components/ui/DsButton';
import { addTypedEventListener } from '@/events/registry';
import { isComposingKeyEvent } from '@/utils/isComposingKeyEvent';
import {
  NOTES_ACTIVE_HEADING_EVENT,
  normalizeActiveHeadingText,
  type NotesActiveHeadingDetail,
} from './outlineActiveHeadingBridge';
import '@/styles/notes-typography.css';
import './NoteFloatingToc.css';

export interface NoteFloatingTocProps {
  noteId: string | undefined;
  markdown: string;
  /** Hide when right sidebar/panel is already showing outline or in narrow/compact containers */
  hidden?: boolean;
  onNavigateHeading: (target: { text: string; level: number; occurrence: number }) => void;
}

export interface FloatingTocHeading {
  id: string;
  level: number;
  text: string;
  searchText: string;
  occurrence: number;
}

const stripInlineMarkdown = (raw: string): string => {
  const withoutImages = raw.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');
  const withoutLinks = withoutImages.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  const withoutFormatting = withoutLinks.replace(/[*_`~]/g, '');
  const withoutTrailingHashes = withoutFormatting.replace(/\s*#+\s*$/, '');
  return withoutTrailingHashes.replace(/\s+/g, ' ').trim();
};

const matchFenceStart = (line: string): { marker: '`' | '~'; length: number } | null => {
  const match = line.match(/^\s{0,3}(`{3,}|~{3,})/);
  if (!match) return null;
  const seq = match[1];
  return {
    marker: seq[0] as '`' | '~',
    length: seq.length,
  };
};

const isMatchingFenceEnd = (line: string, fence: { marker: '`' | '~'; length: number }): boolean => {
  const pattern = fence.marker === '`' ? /^\s{0,3}(`{3,})\s*$/ : /^\s{0,3}(~{3,})\s*$/;
  const match = line.match(pattern);
  return Boolean(match && match[1].length >= fence.length);
};

/**
 * Extracts h1–h6 headings from Markdown while skipping fenced code blocks,
 * stripping inline markdown syntax, and tracking 0-based `occurrence` for
 * duplicate headings of the same level and normalized text.
 */
export function extractFloatingTocHeadings(markdown: string): FloatingTocHeading[] {
  if (!markdown) return [];
  const lines = markdown.split(/\r?\n/);
  const extracted: FloatingTocHeading[] = [];
  const occurrenceCounter = new Map<string, number>();
  let activeFence: { marker: '`' | '~'; length: number } | null = null;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
    const line = lines[lineIdx];
    if (activeFence) {
      if (isMatchingFenceEnd(line, activeFence)) {
        activeFence = null;
      }
      continue;
    }

    const fenceStart = matchFenceStart(line);
    if (fenceStart) {
      activeFence = fenceStart;
      continue;
    }

    const match = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
    if (!match) continue;

    const rawText = match[2].trim();
    const cleaned = stripInlineMarkdown(rawText);
    const displayText = cleaned || rawText;
    const searchText = normalizeActiveHeadingText(displayText);
    if (!searchText) continue;

    const level = match[1].length;
    const occurrenceKey = `${level}:${searchText}`;
    const occurrence = occurrenceCounter.get(occurrenceKey) ?? 0;
    occurrenceCounter.set(occurrenceKey, occurrence + 1);

    extracted.push({
      id: `${level}:${searchText}:${occurrence}`,
      level,
      text: displayText,
      searchText,
      occurrence,
    });
  }

  return extracted;
}

const SCROLL_FOLLOW_SUPPRESS_MS = 600;
const MAX_INDENT_STEPS = 4;
const INDENT_STEP_PX = 10;
const MAX_RAIL_TICKS = 36;

function sampleRailHeadings(
  headings: FloatingTocHeading[],
  activeHeadingId: string | null,
  maxTicks = MAX_RAIL_TICKS,
): FloatingTocHeading[] {
  if (headings.length <= maxTicks) return headings;
  const indices = new Set<number>();
  for (let i = 0; i < maxTicks; i += 1) {
    const idx = Math.round((i * (headings.length - 1)) / (maxTicks - 1));
    indices.add(idx);
  }
  if (activeHeadingId) {
    const activeIdx = headings.findIndex((item) => item.id === activeHeadingId);
    if (activeIdx >= 0 && !indices.has(activeIdx)) {
      let nearestIdx = -1;
      let nearestDistance = Number.POSITIVE_INFINITY;
      for (const idx of indices) {
        if (idx === 0 || idx === headings.length - 1) continue;
        const distance = Math.abs(idx - activeIdx);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestIdx = idx;
        }
      }
      if (nearestIdx >= 0) {
        indices.delete(nearestIdx);
      }
      indices.add(activeIdx);
    }
  }
  return Array.from(indices)
    .sort((a, b) => a - b)
    .map((idx) => headings[idx]);
}

export const NoteFloatingToc: React.FC<NoteFloatingTocProps> = ({
  noteId,
  markdown,
  hidden = false,
  onNavigateHeading,
}) => {
  const { t } = useTranslation(['notes', 'common']);
  const headings = useMemo(() => extractFloatingTocHeadings(markdown), [markdown]);
  const [activeHeadingId, setActiveHeadingId] = useState<string | null>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [isFocusedWithin, setIsFocusedWithin] = useState(false);
  const isPopoverVisible = isHovered || isFocusedWithin;

  const railHeadings = useMemo(
    () => sampleRailHeadings(headings, activeHeadingId, MAX_RAIL_TICKS),
    [headings, activeHeadingId],
  );

  const headingsRef = useRef(headings);
  headingsRef.current = headings;
  const scrollFollowSuppressedUntilRef = useRef(0);
  const itemRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const navRef = useRef<HTMLElement>(null);

  // Reset active highlight when switching notes
  useEffect(() => {
    setActiveHeadingId(null);
    scrollFollowSuppressedUntilRef.current = 0;
  }, [noteId]);

  // Clear highlight if the highlighted heading no longer exists after edits
  useEffect(() => {
    if (!activeHeadingId) return;
    if (!headings.some((item) => item.id === activeHeadingId)) {
      setActiveHeadingId(null);
    }
  }, [headings, activeHeadingId]);

  // Subscribe to scroll-follow active heading broadcasts filtered by noteId
  useEffect(() => {
    if (!noteId) return;
    return addTypedEventListener<NotesActiveHeadingDetail>(
      NOTES_ACTIVE_HEADING_EVENT,
      (detail) => {
        if (!detail || detail.noteId !== noteId) return;
        if (Date.now() < scrollFollowSuppressedUntilRef.current) return;
        const normalizedText = normalizeActiveHeadingText(detail.text ?? '');
        if (!normalizedText) return;
        const list = headingsRef.current;
        const matched =
          list.find(
            (item) =>
              item.level === detail.level &&
              item.searchText === normalizedText &&
              item.occurrence === detail.occurrence,
          ) ??
          list.find((item) => item.level === detail.level && item.searchText === normalizedText) ??
          list.find((item) => item.searchText === normalizedText) ??
          null;
        if (!matched) return;
        setActiveHeadingId((prev) => (prev === matched.id ? prev : matched.id));
      },
    );
  }, [noteId]);

  // Keep the active item visible inside the scrollable popover list only while visible
  useEffect(() => {
    if (!activeHeadingId || !isPopoverVisible) return;
    const button = itemRefs.current.get(activeHeadingId);
    if (button && typeof button.scrollIntoView === 'function') {
      button.scrollIntoView({ block: 'nearest' });
    }
  }, [activeHeadingId, isPopoverVisible]);

  const handleNavigate = useCallback(
    (heading: FloatingTocHeading) => {
      scrollFollowSuppressedUntilRef.current = Date.now() + SCROLL_FOLLOW_SUPPRESS_MS;
      setActiveHeadingId(heading.id);
      onNavigateHeading({
        text: heading.text,
        level: heading.level,
        occurrence: heading.occurrence,
      });
    },
    [onNavigateHeading],
  );

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (isComposingKeyEvent(event)) return;
    if (event.key === 'Escape') {
      const active = document.activeElement;
      if (active instanceof HTMLElement && navRef.current?.contains(active)) {
        active.blur();
      }
      return;
    }

    if (
      event.key === 'ArrowDown' ||
      event.key === 'ArrowUp' ||
      event.key === 'Home' ||
      event.key === 'End'
    ) {
      const buttons = headingsRef.current
        .map((item) => itemRefs.current.get(item.id))
        .filter((node): node is HTMLButtonElement => Boolean(node));
      if (buttons.length === 0) return;

      const currentIndex = buttons.findIndex((button) => button === document.activeElement);
      let nextIndex: number;
      if (event.key === 'Home') {
        nextIndex = 0;
      } else if (event.key === 'End') {
        nextIndex = buttons.length - 1;
      } else if (event.key === 'ArrowDown') {
        nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % buttons.length;
      } else {
        nextIndex = currentIndex < 0 ? buttons.length - 1 : (currentIndex - 1 + buttons.length) % buttons.length;
      }
      event.preventDefault();
      buttons[nextIndex]?.focus();
    }
  }, []);

  if (hidden || headings.length < 2) {
    return null;
  }

  const minLevel = headings.reduce((min, item) => Math.min(min, item.level), 6);
  const tocLabel = t('notes:outline.floating_toc', '目录');

  return (
    <nav
      ref={navRef}
      className="notes-floating-toc"
      aria-label={tocLabel}
      onKeyDown={handleKeyDown}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onFocus={() => setIsFocusedWithin(true)}
      onBlur={(event) => {
        if (!navRef.current?.contains(event.relatedTarget as Node | null)) {
          setIsFocusedWithin(false);
        }
      }}
    >
      <div
        className="notes-floating-toc-rail"
        tabIndex={0}
        aria-label={tocLabel}
      >
        {railHeadings.map((heading) => {
          const isActive = heading.id === activeHeadingId;
          const visualLevel = heading.level <= 2 ? heading.level : 3;
          return (
            <span
              key={heading.id}
              className="notes-floating-toc-tick"
              data-level={String(visualLevel)}
              data-active={isActive ? 'true' : undefined}
              aria-hidden="true"
            />
          );
        })}
      </div>

      <div className="notes-floating-toc-popover">
        <ul className="notes-floating-toc-list">
          {headings.map((heading) => {
            const isActive = heading.id === activeHeadingId;
            const indentSteps = Math.min(MAX_INDENT_STEPS, Math.max(0, heading.level - minLevel));
            return (
              <li key={heading.id}>
                <DsButton
                  ref={(node) => {
                    if (node) {
                      itemRefs.current.set(heading.id, node);
                    } else {
                      itemRefs.current.delete(heading.id);
                    }
                  }}
                  variant="ghost"
                  size="sm"
                  className="notes-floating-toc-item"
                  style={{ '--toc-indent': `${indentSteps * INDENT_STEP_PX}px` } as React.CSSProperties}
                  data-level={String(heading.level)}
                  data-active={isActive ? 'true' : undefined}
                  aria-current={isActive ? 'location' : undefined}
                  title={heading.text}
                  onClick={() => handleNavigate(heading)}
                  onKeyDown={(event) => {
                    if (isComposingKeyEvent(event)) return;
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      handleNavigate(heading);
                    }
                  }}
                >
                  <span className="notes-floating-toc-item-label">{heading.text}</span>
                </DsButton>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
};

export default NoteFloatingToc;
