/**
 * 笔记模板内联面板（自 NotesCrepeEditor 抽出）。
 *
 * - 编辑器顶部随文档流展开（grid-rows 0fr→1fr），无浮层遮挡；
 * - 方向键 / Home / End 在模板卡片间移动焦点（roving tabindex），Enter 应用；
 * - Esc 收起并把焦点还给触发按钮；
 * - prefers-reduced-motion 下跳过展开/收起过渡。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NoteBlank } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { getNoteTemplates, type NoteTemplate } from '../noteTemplates';

/** 模板内联面板收起动画时长（200ms 过渡 + 少量缓冲后卸载） */
const TEMPLATE_PANEL_EXIT_MS = 220;

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export interface NotesTemplatePanelProps {
  /** 展开状态（父组件受控） */
  open: boolean;
  /** Esc 或应用模板后请求收起 */
  onRequestClose: () => void;
  /** 应用模板（父组件负责渲染变量并写入编辑器） */
  onApplyTemplate: (template: NoteTemplate) => void;
  /** 卡片禁用（只读 / 编辑器未就绪） */
  disabled?: boolean;
  /** aria-controls 关联 id（由触发按钮持有） */
  panelId: string;
  /** 收起后焦点归还目标（模板触发按钮） */
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
}

export const NotesTemplatePanel: React.FC<NotesTemplatePanelProps> = ({
  open,
  onRequestClose,
  onApplyTemplate,
  disabled = false,
  panelId,
  triggerRef,
}) => {
  const { t, i18n } = useTranslation(['notes']);
  // mounted 控制 DOM 挂载（收起动画结束后卸载），expanded 驱动过渡目标态
  const [mounted, setMounted] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const cardRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    if (open) {
      setMounted(true);
      setActiveIndex(0);
      if (prefersReducedMotion()) {
        setExpanded(true);
        return;
      }
      // 先以 0fr 挂载，下一帧再切 1fr，保证入场有过渡
      const raf = requestAnimationFrame(() => setExpanded(true));
      return () => cancelAnimationFrame(raf);
    }
    setExpanded(false);
    if (prefersReducedMotion()) {
      setMounted(false);
      return;
    }
    const timer = window.setTimeout(() => setMounted(false), TEMPLATE_PANEL_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [open]);

  const templates = getNoteTemplates(i18n?.resolvedLanguage ?? i18n?.language ?? 'en-US');

  /** 网格列数（按第一行 offsetTop 相同的卡片数推算，供 ↑/↓ 跨行移动） */
  const measureColumns = useCallback((): number => {
    const cards = cardRefs.current.filter(Boolean) as HTMLButtonElement[];
    if (cards.length <= 1) return 1;
    const firstTop = cards[0].offsetTop;
    let columns = 0;
    for (const card of cards) {
      if (Math.abs(card.offsetTop - firstTop) > 1) break;
      columns += 1;
    }
    return Math.max(1, columns);
  }, []);

  const focusCard = useCallback((index: number) => {
    const count = templates.length;
    if (count === 0) return;
    const clamped = Math.min(Math.max(index, 0), count - 1);
    setActiveIndex(clamped);
    cardRefs.current[clamped]?.focus();
  }, [templates.length]);

  const handleGridKeyDown = useCallback((event: React.KeyboardEvent) => {
    const count = templates.length;
    if (count === 0) return;
    let next: number | null = null;
    switch (event.key) {
      case 'ArrowRight':
        next = (activeIndex + 1) % count;
        break;
      case 'ArrowLeft':
        next = (activeIndex - 1 + count) % count;
        break;
      case 'ArrowDown': {
        const columns = measureColumns();
        next = Math.min(activeIndex + columns, count - 1);
        break;
      }
      case 'ArrowUp': {
        const columns = measureColumns();
        next = Math.max(activeIndex - columns, 0);
        break;
      }
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = count - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    if (next !== null) focusCard(next);
  }, [activeIndex, focusCard, measureColumns, templates.length]);

  if (!mounted) return null;

  return (
    <div
      id={panelId}
      className={cn(
        'grid transition-[grid-template-rows,opacity] duration-200 ease-[var(--dropdown-ease,cubic-bezier(0.22,1,0.36,1))] will-change-[grid-template-rows]',
        'motion-reduce:transition-none',
        expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
      )}
    >
      <div className="min-h-0 overflow-hidden">
        <div
          role="region"
          aria-label={t('notes:toolbar.note_templates', 'Note templates')}
          className="notes-template-panel mx-auto w-full max-w-[var(--notes-content-max-w)] px-5 sm:px-12"
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            onRequestClose();
            triggerRef?.current?.focus();
          }}
        >
          <div className="notes-template-panel__head">
            <span className="notes-template-panel__label">
              {t('notes:toolbar.note_templates', 'Note templates')}
            </span>
            <span className="notes-template-panel__hint">
              {t('notes:templates.insert_hint', '插入到当前笔记末尾')}
            </span>
          </div>
          <div
            ref={gridRef}
            className="notes-template-panel__grid"
            onKeyDown={handleGridKeyDown}
          >
            {templates.map((template, index) => (
              <button
                key={template.id}
                ref={(el) => { cardRefs.current[index] = el; }}
                type="button"
                className="notes-template-card"
                disabled={disabled}
                tabIndex={index === activeIndex ? 0 : -1}
                onFocus={() => setActiveIndex(index)}
                onClick={() => onApplyTemplate(template)}
              >
                <span className="notes-template-card__title">
                  <NoteBlank size={13} aria-hidden className="notes-template-card__icon" />
                  {t(`notes:templates.${template.id}`, template.title)}
                </span>
                <span className="notes-template-card__summary">
                  {t(`notes:templates.${template.id}_summary`, template.summary)}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default NotesTemplatePanel;
