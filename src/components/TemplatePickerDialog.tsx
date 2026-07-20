/**
 * TemplateInlinePicker（历史名 TemplatePickerDialog）
 *
 * 模板选择器：已由全屏模态框改造为「就地内联展开面板」。
 * - 在触发点下方展开，带平滑高度 / 透明度过渡
 * - 点击面板外部或按 Esc 收起
 * - 模板卡片网格（名称、类型徽标、字段预览）+ 搜索过滤
 * - hover / 键盘聚焦显示迷你预览，方向键 + 回车键盘导航
 * - 展开时焦点移入搜索框，收起时归还触发元素
 *
 * 对外 props 与旧模态版完全兼容（open/onClose/onSelect/onOpenManager）。
 */
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from './ui/shad/Input';
import { NotionButton } from '@/components/ui/NotionButton';
import { ArrowClockwise, CheckCircle, Eye, FolderOpen, PushPin, PushPinSlash, WarningCircle, X } from '@phosphor-icons/react';
import { templateManager } from '../data/ankiTemplates';
import { CustomAnkiTemplate } from '../types';
import { CustomScrollArea } from './custom-scroll-area';
import { IframePreview, renderCardPreview as renderTemplatePreview } from './SharedPreview';
import { cn } from '../lib/utils';
import './TemplatePickerInline.css';

interface TemplatePickerDialogProps {
  open: boolean;
  onClose: () => void;
  onSelect: (template: CustomAnkiTemplate) => void;
  onOpenManager?: () => void;
  /** 当前已选模板 id，用于展示选中态（可选，向后兼容） */
  selectedTemplateId?: string | null;
  className?: string;
}

const COLLAPSE_MS = 260;

export const TemplateInlinePicker: React.FC<TemplatePickerDialogProps> = ({
  open,
  onClose,
  onSelect,
  onOpenManager,
  selectedTemplateId,
  className,
}) => {
  const { t } = useTranslation(['anki']);
  const idPrefix = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const [mounted, setMounted] = useState(open);
  const [expanded, setExpanded] = useState(false);

  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [templates, setTemplates] = useState<CustomAnkiTemplate[]>([]);

  const [activeIndex, setActiveIndex] = useState(-1);
  /** hover / 键盘聚焦产生的临时预览模板 */
  const [hoverTemplateId, setHoverTemplateId] = useState<string | null>(null);
  /** 通过“预览”按钮固定的预览模板 */
  const [pinnedTemplateId, setPinnedTemplateId] = useState<string | null>(null);
  const [previewBack, setPreviewBack] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      await templateManager.refresh();
      setTemplates(templateManager.getAllTemplates());
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error ?? '');
      setLoadError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  // 展开/收起（保持挂载直至收起过渡结束，实现平滑高度动画）
  useEffect(() => {
    if (open) {
      previousFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setMounted(true);
      const raf = requestAnimationFrame(() => {
        setExpanded(true);
        searchInputRef.current?.focus();
      });
      return () => cancelAnimationFrame(raf);
    }
    setExpanded(false);
    const timer = window.setTimeout(() => setMounted(false), COLLAPSE_MS);
    // 收起时归还焦点给触发元素
    const previous = previousFocusRef.current;
    if (previous && previous.isConnected && rootRef.current?.contains(document.activeElement)) {
      previous.focus();
    }
    return () => window.clearTimeout(timer);
  }, [open]);

  // 展开时加载模板
  useEffect(() => {
    if (open) load();
  }, [open, load]);

  // 点击面板外部收起
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (root && event.target instanceof Node && !root.contains(event.target)) {
        onClose();
      }
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [open, onClose]);

  const filtered = useMemo(() => {
    const kw = search.trim().toLowerCase();
    if (!kw) return templates;
    return templates.filter(
      (item) =>
        item.name.toLowerCase().includes(kw) ||
        (item.description || '').toLowerCase().includes(kw) ||
        (item.note_type || '').toLowerCase().includes(kw)
    );
  }, [templates, search]);

  // 过滤结果变化时重置键盘游标，避免 activeIndex 越界
  useEffect(() => {
    setActiveIndex((prev) => (prev >= filtered.length ? filtered.length - 1 : prev));
  }, [filtered.length]);

  const previewTemplate = useMemo(() => {
    const targetId = pinnedTemplateId ?? hoverTemplateId ?? (activeIndex >= 0 ? filtered[activeIndex]?.id : null);
    if (!targetId) return null;
    return filtered.find((item) => item.id === targetId) ?? templates.find((item) => item.id === targetId) ?? null;
  }, [pinnedTemplateId, hoverTemplateId, activeIndex, filtered, templates]);

  // 预览目标变化时回到正面
  useEffect(() => {
    setPreviewBack(false);
  }, [previewTemplate?.id]);

  const getColumnCount = () => {
    const grid = gridRef.current;
    if (!grid) return 1;
    const columns = window.getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean);
    return Math.max(columns.length, 1);
  };

  const moveActive = (next: number) => {
    if (filtered.length === 0) return;
    const clamped = Math.max(0, Math.min(filtered.length - 1, next));
    setActiveIndex(clamped);
    const option = document.getElementById(`${idPrefix}-option-${clamped}`);
    option?.scrollIntoView({ block: 'nearest' });
  };

  const handleListboxKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const cols = getColumnCount();
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        moveActive(activeIndex + 1);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        moveActive(activeIndex - 1);
        break;
      case 'ArrowDown':
        event.preventDefault();
        moveActive(activeIndex < 0 ? 0 : activeIndex + cols);
        break;
      case 'ArrowUp':
        event.preventDefault();
        moveActive(activeIndex - cols);
        break;
      case 'Home':
        event.preventDefault();
        moveActive(0);
        break;
      case 'End':
        event.preventDefault();
        moveActive(filtered.length - 1);
        break;
      case 'Enter':
      case ' ': {
        const active = activeIndex >= 0 ? filtered[activeIndex] : undefined;
        if (active) {
          event.preventDefault();
          onSelect(active);
        }
        break;
      }
      default:
        break;
    }
  };

  const handleRootKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  if (!mounted) return null;

  return (
    <div
      ref={rootRef}
      className={cn('template-inline-picker', className)}
      data-state={expanded ? 'open' : 'closed'}
      onKeyDown={handleRootKeyDown}
      aria-hidden={!open}
    >
      <div className="template-inline-picker__clip">
        <div className="template-inline-picker__panel mt-2 flex flex-col">
          {/* 头部：标题 + 搜索 + 操作 */}
          <div className="flex flex-wrap items-center gap-2 px-4 pt-3 pb-2 border-b border-border">
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold truncate">{t('templatePicker.title')}</h3>
              <p className="text-xs text-muted-foreground mt-0.5 hidden sm:block">
                {t('templatePicker.keyboardHint')}
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <NotionButton
                variant="ghost"
                size="sm"
                onClick={load}
                disabled={loading}
                aria-label={t('templatePicker.refresh')}
              >
                <ArrowClockwise size={15} className={cn('mr-1', loading && 'animate-spin')} />
                {t('templatePicker.refresh')}
              </NotionButton>
              {onOpenManager && (
                <NotionButton variant="ghost" size="sm" onClick={onOpenManager}>
                  <FolderOpen size={15} className="mr-1" />
                  {t('templatePicker.openManager')}
                </NotionButton>
              )}
              <NotionButton
                variant="ghost"
                size="icon"
                iconOnly
                onClick={onClose}
                aria-label={t('templatePicker.close')}
              >
                <X size={15} />
              </NotionButton>
            </div>
            <div className="w-full">
              <Input
                ref={searchInputRef}
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    listboxRef.current?.focus();
                    moveActive(activeIndex < 0 ? 0 : activeIndex);
                  }
                }}
                placeholder={t('templatePicker.searchPlaceholder')}
                aria-label={t('templatePicker.searchPlaceholder')}
              />
            </div>
          </div>

          {/* 主体：模板网格 + 迷你预览 */}
          <div className="flex gap-3 px-4 py-3">
            <CustomScrollArea className="flex-1 min-w-0 max-h-[360px]">
              {loading && templates.length === 0 && (
                <div className="text-sm text-muted-foreground py-8 text-center">
                  {t('templatePicker.loading')}
                </div>
              )}

              {loadError && !loading && (
                <div className="flex flex-col items-center gap-2 py-8 text-sm text-destructive">
                  <WarningCircle size={20} />
                  <span>{t('templatePicker.loadFailed')}</span>
                  <NotionButton variant="ghost" size="sm" onClick={load}>
                    {t('templatePicker.retry')}
                  </NotionButton>
                </div>
              )}

              {!loadError && (
                <div
                  ref={listboxRef}
                  role="listbox"
                  aria-label={t('templatePicker.title')}
                  aria-activedescendant={activeIndex >= 0 ? `${idPrefix}-option-${activeIndex}` : undefined}
                  tabIndex={0}
                  className="template-inline-picker__listbox outline-none"
                  onKeyDown={handleListboxKeyDown}
                >
                  <div ref={gridRef} className="grid gap-2 grid-cols-1 sm:grid-cols-2">
                    {filtered.map((template, index) => {
                      const isSelected = !!selectedTemplateId && template.id === selectedTemplateId;
                      const fieldsPreview = template.fields.slice(0, 4);
                      const restFields = template.fields.length - fieldsPreview.length;
                      return (
                        <div
                          key={template.id}
                          id={`${idPrefix}-option-${index}`}
                          role="option"
                          aria-selected={isSelected}
                          data-active={index === activeIndex || undefined}
                          data-selected={isSelected || undefined}
                          className="template-inline-picker__option"
                          onClick={() => onSelect(template)}
                          // 保持焦点留在面板内（搜索框/列表），Esc 收起才能持续生效
                          onMouseDown={(event) => event.preventDefault()}
                          onMouseEnter={() => {
                            setHoverTemplateId(template.id);
                            setActiveIndex(index);
                          }}
                          onMouseLeave={() => setHoverTemplateId((prev) => (prev === template.id ? null : prev))}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="text-sm font-medium truncate" title={template.name}>
                              {template.name}
                            </div>
                            {isSelected && (
                              <span className="inline-flex items-center gap-1 text-xs text-primary shrink-0">
                                <CheckCircle size={13} weight="fill" />
                                {t('templatePicker.selectedBadge')}
                              </span>
                            )}
                          </div>
                          <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                            <span className="text-[11px] px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                              {template.note_type}
                            </span>
                            <span
                              className={cn(
                                'text-[11px] px-1.5 py-0.5 rounded',
                                template.is_built_in
                                  ? 'bg-muted text-muted-foreground'
                                  : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                              )}
                            >
                              {template.is_built_in
                                ? t('templatePicker.builtinBadge')
                                : t('templatePicker.customBadge')}
                            </span>
                          </div>
                          {template.description && (
                            <div
                              className="mt-1 text-xs text-muted-foreground line-clamp-2"
                              title={template.description}
                            >
                              {template.description}
                            </div>
                          )}
                          <div className="mt-1.5 flex items-center gap-1 flex-wrap">
                            {fieldsPreview.map((field) => (
                              <span
                                key={field}
                                className="text-[11px] px-1.5 py-0.5 rounded border border-border text-muted-foreground"
                              >
                                {field}
                              </span>
                            ))}
                            {restFields > 0 && (
                              <span className="text-[11px] text-muted-foreground">+{restFields}</span>
                            )}
                          </div>
                          <div className="mt-1.5 flex justify-end">
                            <NotionButton
                              variant="ghost"
                              size="sm"
                              className="!h-6 !px-1.5 text-xs"
                              aria-pressed={pinnedTemplateId === template.id}
                              onClick={(event) => {
                                event.stopPropagation();
                                setPinnedTemplateId((prev) =>
                                  prev === template.id ? null : template.id
                                );
                              }}
                            >
                              {pinnedTemplateId === template.id ? (
                                <PushPinSlash size={13} className="mr-1" />
                              ) : (
                                <Eye size={13} className="mr-1" />
                              )}
                              {pinnedTemplateId === template.id
                                ? t('templatePicker.closePreview')
                                : t('templatePicker.preview')}
                            </NotionButton>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {filtered.length === 0 && !loading && (
                    <div className="text-center text-sm text-muted-foreground py-8">
                      {t('templatePicker.empty')}
                    </div>
                  )}
                </div>
              )}
            </CustomScrollArea>

            {/* 迷你预览（hover / 键盘聚焦 / 固定） */}
            {previewTemplate && (
              <div className="template-inline-picker__preview hidden md:flex flex-col w-[260px] shrink-0 rounded-lg border border-border bg-background overflow-hidden">
                <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-border">
                  <span className="text-xs font-medium truncate" title={previewTemplate.name}>
                    {previewTemplate.name}
                  </span>
                  {pinnedTemplateId === previewTemplate.id && (
                    <PushPin size={12} className="text-primary shrink-0" weight="fill" />
                  )}
                </div>
                <div className="flex items-center gap-1 px-2.5 pt-1.5">
                  <NotionButton
                    variant="ghost"
                    size="sm"
                    className={cn('!h-6 !px-2 text-xs', !previewBack && 'bg-primary/10 text-primary')}
                    onClick={() => setPreviewBack(false)}
                  >
                    {t('templatePicker.frontSide')}
                  </NotionButton>
                  <NotionButton
                    variant="ghost"
                    size="sm"
                    className={cn('!h-6 !px-2 text-xs', previewBack && 'bg-primary/10 text-primary')}
                    onClick={() => setPreviewBack(true)}
                  >
                    {t('templatePicker.backSide')}
                  </NotionButton>
                </div>
                <div className="p-2">
                  <IframePreview
                    key={`${previewTemplate.id}-${previewBack ? 'back' : 'front'}`}
                    htmlContent={renderTemplatePreview(
                      previewBack ? previewTemplate.back_template : previewTemplate.front_template,
                      previewTemplate,
                      undefined,
                      previewBack
                    )}
                    cssContent={previewTemplate.css_style}
                    height={210}
                    compact
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

/** 兼容旧引用名：原模态组件已内联化，props 完全兼容 */
const TemplatePickerDialog = TemplateInlinePicker;

export default TemplatePickerDialog;
