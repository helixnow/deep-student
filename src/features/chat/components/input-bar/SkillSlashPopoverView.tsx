import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  BookOpen,
  Check,
  Compass,
  GearSix,
  GraduationCap,
  Lightning,
  PuzzlePiece,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { Z_INDEX } from '@/config/zIndex';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { DsButton } from '@/components/ui/DsButton';
import { readCssDurationMs, useMotionPresence } from '@/hooks/useMotionPresence';
import { SlotEntryScope } from '@/ui-kernel/outlet';
import type { BuiltinSlashCommandId, SlashCommandCategory } from '../../commands/slashCommandProtocol';
import type { SkillSlashSuggestion } from './SkillSlashPopover';

export interface SkillSlashPopoverProps {
  open: boolean;
  query: string;
  activeParentCommand?: { id: BuiltinSlashCommandId; label: string } | null;
  suggestions: SkillSlashSuggestion[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  onSelectedIndexChange: (index: number) => void;
  onStepOutSubpicker?: () => void;
  className?: string;
}

function renderCategoryIcon(item: SkillSlashSuggestion): React.ReactNode {
  if (item.slotEntry?.value.icon) {
    return (
      <SlotEntryScope
        slot="chat.composer.commands"
        entry={item.slotEntry}
        fallback={<PuzzlePiece size={14} weight="bold" />}
      >
        {React.createElement(item.slotEntry.value.icon, { size: 14 })}
      </SlotEntryScope>
    );
  }
  switch (item.category) {
    case 'control':
      return <GearSix size={14} weight="bold" />;
    case 'study':
      return <GraduationCap size={14} weight="bold" />;
    case 'plugin':
      return <PuzzlePiece size={14} weight="bold" />;
    case 'skill':
    default:
      return item.id === 'research-mode' || item.id === 'literature-review'
        ? <Compass size={14} weight="bold" />
        : item.id === 'course-study'
          ? <BookOpen size={14} weight="bold" />
          : <Lightning size={14} weight="bold" />;
  }
}

export const SkillSlashPopover: React.FC<SkillSlashPopoverProps> = ({
  open,
  query,
  activeParentCommand = null,
  suggestions,
  selectedIndex,
  onSelect,
  onSelectedIndexChange,
  onStepOutSubpicker,
  className,
}) => {
  const { t } = useTranslation(['chatV2']);
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const presence = useMotionPresence(open, {
    exitMs: readCssDurationMs('--dropdown-close-dur', 150),
    enter: 'transition',
  });

  useEffect(() => {
    itemRefs.current = itemRefs.current.slice(0, suggestions.length);
  }, [suggestions.length]);

  useEffect(() => {
    if (!open || suggestions.length === 0) return;
    const selectedItem = itemRefs.current[selectedIndex];
    if (selectedItem && listRef.current) {
      selectedItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [selectedIndex, open, suggestions.length]);

  if (!presence.mounted || suggestions.length === 0) {
    return null;
  }

  const activeDescendantId = suggestions[selectedIndex]
    ? `skill-slash-option-${suggestions[selectedIndex].id}`
    : undefined;

  const showCategoryHeaders = !activeParentCommand && query.trim().length === 0;

  const getCategoryTitle = (cat?: SlashCommandCategory): string => {
    switch (cat) {
      case 'control':
        return t('chatV2:inputBar.slashCommand.groupControl');
      case 'study':
        return t('chatV2:inputBar.slashCommand.groupStudy');
      case 'plugin':
        return t('chatV2:inputBar.slashCommand.groupPlugin');
      case 'skill':
      default:
        return t('chatV2:inputBar.slashCommand.groupSkill');
    }
  };

  return (
    <div
      data-testid="skill-slash-popover"
      data-state={presence.exiting || !open ? 'closed' : 'open'}
      className={cn(
        't-dropdown',
        presence.exiting && 'is-closing',
        (presence.exiting || !open) && 'pointer-events-none',
        presence.shown && 'is-open',
        'absolute w-[min(23rem,calc(100vw-2rem))] rounded-2xl border border-border/50 bg-popover/85 backdrop-blur-xl backdrop-saturate-150 shadow-lg ring-1 ring-border/40',
        'bottom-full mb-3 left-0',
        className,
      )}
      style={{ zIndex: Z_INDEX.inputBarPopover }}
      data-origin="bottom-left"
      data-wb-blur-surface
      role="listbox"
      aria-label={t('chatV2:inputBar.slashCommand.title')}
      aria-activedescendant={activeDescendantId}
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/50">
        {activeParentCommand ? (
          <>
            {onStepOutSubpicker && (
              <DsButton
                variant="ghost"
                size="icon"
                iconOnly
                className="!h-5 !w-5 rounded-md text-muted-foreground hover:text-foreground"
                aria-label={t('chatV2:inputBar.slashCommand.backToCommands')}
                onPointerDown={(e) => {
                  e.preventDefault();
                  onStepOutSubpicker();
                }}
              >
                <ArrowLeft size={12} weight="bold" />
              </DsButton>
            )}
            <span className="font-mono text-xs font-semibold text-primary">
              /{activeParentCommand.id}
            </span>
            <span className="truncate text-xs font-medium text-foreground/80">
              {activeParentCommand.label}
            </span>
            {query && (
              <span className="ml-auto font-mono text-xs text-muted-foreground">{query}</span>
            )}
          </>
        ) : (
          <>
            <Lightning size={14} weight="bold" className="text-primary" />
            <span className="text-xs font-medium text-foreground/80">
              {t('chatV2:inputBar.slashCommand.title')}
            </span>
            {query && (
              <span className="ml-auto font-mono text-xs text-muted-foreground">/{query}</span>
            )}
          </>
        )}
      </div>

      <CustomScrollArea
        viewportRef={listRef}
        fullHeight={false}
        className="max-h-72"
        viewportClassName="max-h-72 p-1"
      >
        {suggestions.map((skill, index) => {
          const prevCategory = index > 0 ? suggestions[index - 1]?.category : undefined;
          const renderHeader = showCategoryHeaders && skill.category !== prevCategory;
          const tokenText = skill.displayToken ?? `/${skill.id}`;

          return (
            <React.Fragment
              key={skill.slotEntry ? `${skill.slotEntry.owner}\u0000${skill.slotEntry.id}` : skill.id}
            >
              {renderHeader && (
                <div
                  role="presentation"
                  className={cn(
                    'px-2.5 pt-2 pb-1 text-2xs font-semibold tracking-wide text-muted-foreground/80 select-none',
                    index > 0 && 'mt-1 border-t border-border/40',
                  )}
                >
                  {getCategoryTitle(skill.category)}
                </div>
              )}
              <div
                id={`skill-slash-option-${skill.id}`}
                ref={(el) => {
                  itemRefs.current[index] = el;
                }}
                role="option"
                aria-selected={index === selectedIndex}
                className={cn(
                  'flex items-start gap-2.5 px-2.5 py-2 rounded-lg cursor-pointer transition-colors text-sm',
                  index === selectedIndex
                    ? 'bg-accent text-accent-foreground'
                    : 'hover:bg-[var(--interactive-hover)] text-foreground',
                )}
                onPointerDown={(e) => {
                  e.preventDefault();
                  onSelect(index);
                }}
                onMouseEnter={() => onSelectedIndexChange(index)}
              >
                <div
                  className={cn(
                    'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg',
                    skill.category === 'study'
                      ? 'bg-warning/12 text-warning'
                      : 'bg-primary/10 text-primary',
                  )}
                >
                  {renderCategoryIcon(skill)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-medium">{skill.name}</span>
                    <span className="shrink-0 font-mono text-2xs text-muted-foreground">
                      {tokenText}
                    </span>
                    {skill.argumentHint && (
                      <span className="truncate font-mono text-2xs text-muted-foreground/70">
                        {skill.argumentHint}
                      </span>
                    )}
                    {skill.statusBadge ? (
                      <span className="ml-auto shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-2xs leading-none text-muted-foreground">
                        {skill.statusBadge}
                      </span>
                    ) : skill.isActive ? (
                      <span className="ml-auto shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-2xs leading-none text-primary">
                        {t('chatV2:inputBar.slashCommand.active')}
                      </span>
                    ) : null}
                  </div>
                  {skill.description && (
                    <div className="mt-0.5 truncate text-xs text-muted-foreground">
                      {skill.description}
                    </div>
                  )}
                </div>
                {index === selectedIndex && (
                  <Check size={16} weight="bold" className="mt-0.5 shrink-0 text-primary" />
                )}
              </div>
            </React.Fragment>
          );
        })}
      </CustomScrollArea>

      <div className="flex items-center gap-2 border-t border-border/50 px-3 py-1.5 text-2xs text-muted-foreground">
        <span className="inline-flex items-center gap-0.5">
          <kbd className="rounded bg-muted px-1 py-0.5 text-2xs">↑</kbd>
          <kbd className="rounded bg-muted px-1 py-0.5 text-2xs">↓</kbd>
          <span className="ml-0.5">{t('chatV2:modelMention.navigate')}</span>
        </span>
        <span className="inline-flex items-center gap-0.5">
          <kbd className="rounded bg-muted px-1 py-0.5 text-2xs">Tab</kbd>
          <kbd className="rounded bg-muted px-1 py-0.5 text-2xs">↵</kbd>
          <span className="ml-0.5">{t('chatV2:modelMention.confirm')}</span>
        </span>
        <span className="inline-flex items-center gap-0.5">
          <kbd className="rounded bg-muted px-1 py-0.5 text-2xs">Esc</kbd>
          <span className="ml-0.5">{t('chatV2:modelMention.dismiss')}</span>
        </span>
      </div>
    </div>
  );
};

export default SkillSlashPopover;
