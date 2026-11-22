import React, { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Z_INDEX } from '@/config/zIndex';
import { DsButton } from '@/components/ui/DsButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import {
  BACK_PRIORITY,
  registerBackHandler,
} from '@/app/navigation/androidBackCoordinator';
import { useMindMapStore } from '../../store';
import { useMindMapIsActive } from '../../MindMapActiveContext';
import { StyleRegistry } from '../../registry';
import { ensureInitialized } from '../../init';
import { findNodeById } from '../../utils/node/find';
import type { MindMapNode, NodeStyle, UpdateNodeParams } from '../../types';
import {
  Palette,
  CaretDown,
  Check,
  TextT,
  TextB,
  TextItalic,
  TextUnderline,
  TextStrikethrough,
  TextHOne,
  TextHTwo,
  TextHThree,
  LinkSimple,
  CheckSquare,
  X,
} from '@phosphor-icons/react';

// ============================================================================
// 预设颜色（统一引用共享常量）
// ============================================================================
import { getFullTextColors, getFullBgColors } from '../../constants';
import { useMindMapDarkMode, useMindMapTheme } from '../../hooks/useMindMapTheme';
import { useImeCompositionGuard } from '../../hooks/useImeCompositionGuard';
import type { IStyleTheme } from '../../registry/types';

const PRIORITY_LEVELS = [1, 2, 3, 4, 5, 6] as const;
const PROGRESS_STEPS = [0, 25, 50, 75, 100] as const;

/** 计算节点在树中的深度（Root = 0, L1 = 1, L2+ >= 2） */
function findNodeWithDepth(
  root: MindMapNode | undefined,
  nodeId: string,
  depth = 0,
): { node: MindMapNode; depth: number } | null {
  if (!root) return null;
  if (root.id === nodeId) return { node: root, depth };
  for (const child of root.children ?? []) {
    const found = findNodeWithDepth(child, nodeId, depth + 1);
    if (found) return found;
  }
  return null;
}

/** 按节点真实层级与当前主题推算默认字号（Root 18 / L1 15 / L2+ 14） */
function resolveDefaultFontSize(depth: number, theme: IStyleTheme | undefined): number {
  if (depth === 0) return theme?.node?.root?.fontSize ?? 18;
  if (depth === 1) return theme?.node?.branch?.fontSize ?? 15;
  return theme?.node?.leaf?.fontSize ?? 14;
}

/** 仅放行 http/https/mailto；空串表示清除，非法协议返回 null */
function normalizeSafeHref(raw: string): string | undefined | null {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:') {
      return candidate;
    }
    return null;
  } catch {
    return null;
  }
}

// ============================================================================
// 子组件：主题缩略预览（画布底色 + 核心锚点 + 连线 + 一级分支卡片几何关系）
// ============================================================================
const ThemeThumbnail: React.FC<{ theme: IStyleTheme }> = ({ theme }) => {
  const canvasBg = theme.canvas?.background || theme.canvasStyle?.background || 'var(--mm-bg)';
  const rootBg = theme.node?.root?.background || 'var(--mm-primary)';
  const branchBg = theme.node?.branch?.background || 'var(--mm-bg-elevated)';
  const branchBorder = theme.node?.branch?.border || '1px solid var(--mm-border)';
  const edgeStroke = theme.edge?.stroke || 'var(--mm-edge)';
  return (
    <span
      aria-hidden
      data-preview-theme-id={theme.id}
      className="inline-flex items-center justify-between h-5 w-11 shrink-0 rounded-[5px] border border-[var(--mm-border)] px-1.5 overflow-hidden"
      style={{ background: canvasBg }}
    >
      <span
        className="h-2.5 w-3.5 shrink-0 rounded-[3px]"
        style={{ background: rootBg }}
      />
      <svg className="w-2 h-3.5 shrink-0 overflow-visible" viewBox="0 0 8 14" fill="none">
        <path
          d="M0 7 C3 7, 4 3.5, 8 3.5 M0 7 C3 7, 4 10.5, 8 10.5"
          stroke={edgeStroke}
          strokeWidth="1.15"
          strokeLinecap="round"
        />
      </svg>
      <span className="flex flex-col gap-0.5 min-w-0">
        <span
          className="h-1.5 w-3.5 shrink-0 rounded-[2px]"
          style={{ background: branchBg, border: branchBorder }}
        />
        <span
          className="h-1.5 w-3.5 shrink-0 rounded-[2px]"
          style={{ background: branchBg, border: branchBorder }}
        />
      </span>
    </span>
  );
};

// ============================================================================
// 子组件：颜色选择器
// ============================================================================
const ColorPicker: React.FC<{
  colors: string[];
  value?: string;
  onChange: (color: string) => void;
  label: string;
}> = ({ colors, value, onChange, label }) => (
  <div className="mm-style-color-section">
    <div className="mm-style-label">{label}</div>
    <div className="mm-style-swatches">
      {colors.map((color) => (
        <DsButton
          variant="ghost"
          key={color}
          className={cn(
            'mm-style-swatch motion-reduce:transition-none',
            color === 'transparent' && 'mm-style-swatch-transparent',
            value === color && 'is-active',
          )}
          style={{ backgroundColor: color !== 'transparent' && color !== 'inherit' ? color : undefined }}
          onClick={() => onChange(color)}
          title={color}
          aria-pressed={value === color}
        >
          {color === 'inherit' && (
            <span className="flex items-center justify-center w-full h-full text-[10px] text-muted-foreground">A</span>
          )}
        </DsButton>
      ))}
    </div>
  </div>
);

// ============================================================================
// 主组件
// ============================================================================
export const StyleSettings: React.FC<{
  className?: string;
  trigger?: React.ReactNode;
  placement?: 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right' | 'inline';
  /** 受控模式：面板开关状态 */
  open?: boolean;
  /** 受控模式：面板开关状态变化回调 */
  onOpenChange?: (open: boolean) => void;
}> = ({ className, trigger, placement = 'bottom-right', open: controlledOpen, onOpenChange }) => {
  const { t } = useTranslation('mindmap');
  const isDark = useMindMapDarkMode();
  const textColors = useMemo(() => getFullTextColors(isDark) as unknown as string[], [isDark]);
  const presetColors = useMemo(() => getFullBgColors(isDark) as unknown as string[], [isDark]);
  const isMindMapActive = useMindMapIsActive();
  const [internalOpen, setInternalOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  // Portal fixed 锚点定位（防止 <= 520px 工具栏横向滚动容器裁切样式设置面板）
  const [popoverPos, setPopoverPos] = useState<{
    left: number;
    top: number;
    maxHeight: number;
  } | null>(null);
  const {
    onCompositionStart: onHrefCompositionStart,
    onCompositionEnd: onHrefCompositionEnd,
    isComposingKeyEvent: isHrefComposingKeyEvent,
  } = useImeCompositionGuard();

  // 受控/非受控模式
  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : internalOpen;
  const setIsOpen = useCallback((next: boolean) => {
    if (!isControlled) setInternalOpen(next);
    onOpenChange?.(next);
  }, [isControlled, onOpenChange]);

  // inline 模式下始终显示面板
  const isInline = placement === 'inline';

  // Store actions
  const styleId = useMindMapStore((s) => s.styleId);
  const setStyleId = useMindMapStore((s) => s.setStyleId);
  const focusedNodeId = useMindMapStore((s) => s.focusedNodeId);
  const selection = useMindMapStore((s) => s.selection);
  const updateNode = useMindMapStore((s) => s.updateNode);
  const mindMapDocument = useMindMapStore((s) => s.document);
  const activeTheme = useMindMapTheme(styleId);

  // 支持多选批量改样式：selection 非空优先，否则回退 focusedNodeId
  const targetIds = useMemo(() => {
    if (selection.length > 0) return selection;
    return focusedNodeId ? [focusedNodeId] : [];
  }, [selection, focusedNodeId]);

  // 获取代表节点及其层级深度
  const primaryEntry = useMemo(() => {
    if (!mindMapDocument?.root) return null;
    for (const id of targetIds) {
      const found = findNodeWithDepth(mindMapDocument.root, id);
      if (found) return found;
    }
    return null;
  }, [mindMapDocument, targetIds]);

  const primaryNode = primaryEntry?.node ?? null;
  const defaultFontSize = useMemo(
    () => (primaryEntry ? resolveDefaultFontSize(primaryEntry.depth, activeTheme) : 14),
    [primaryEntry, activeTheme],
  );

  const [hrefDraft, setHrefDraft] = useState('');
  const [hrefInvalid, setHrefInvalid] = useState(false);

  useEffect(() => {
    setHrefDraft(primaryNode?.href ?? '');
    setHrefInvalid(false);
  }, [primaryNode?.id, primaryNode?.href]);

  // 确保模块已初始化
  useEffect(() => {
    ensureInitialized();
  }, []);

  // 获取所有主题，并在暗色模式下解析对应的真实暗色变体用于缩略图预览
  const themeEntries = useMemo(() => {
    ensureInitialized();
    const visible = StyleRegistry.getAll();
    const allById = new Map(StyleRegistry.getAllIncludingHidden().map((item) => [item.id, item]));
    return visible.map((theme) => {
      const previewTheme =
        isDark && theme.id !== 'dark' && !theme.id.endsWith('-dark')
          ? (allById.get(`${theme.id}-dark`) ?? theme)
          : theme;
      return { theme, previewTheme };
    });
  }, [isDark]);

  // 批量更新节点：首节点记录历史，其余 skipHistory: true，聚合为单步 Undo
  const applyBatchNodeUpdates = useCallback(
    (buildPatch: (node: MindMapNode) => UpdateNodeParams | null) => {
      if (!mindMapDocument?.root || targetIds.length === 0) return;
      let recordedHistory = false;
      for (const id of targetIds) {
        const node = findNodeById(mindMapDocument.root, id);
        if (!node) continue;
        const patch = buildPatch(node);
        if (!patch) continue;
        if (!recordedHistory) {
          updateNode(id, patch, { coalesceKey: null });
          recordedHistory = true;
        } else {
          updateNode(id, patch, { skipHistory: true });
        }
      }
    },
    [mindMapDocument, targetIds, updateNode],
  );

  const handleNodeStyleUpdate = useCallback(
    (updates: Partial<NodeStyle>) => {
      applyBatchNodeUpdates((node) => ({
        style: {
          ...node.style,
          ...updates,
        },
      }));
    },
    [applyBatchNodeUpdates],
  );

  const handleApplyHref = useCallback(() => {
    const normalized = normalizeSafeHref(hrefDraft);
    if (normalized === null) {
      setHrefInvalid(true);
      return;
    }
    setHrefInvalid(false);
    applyBatchNodeUpdates(() => ({ href: normalized }));
  }, [applyBatchNodeUpdates, hrefDraft]);

  // 点击外部关闭
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        panelRef.current &&
        !panelRef.current.contains(event.target as Node) &&
        !triggerRef.current?.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen, setIsOpen]);

  useEffect(() => {
    if (!isOpen || isInline) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || isHrefComposingKeyEvent(event)) return;
      event.preventDefault();
      event.stopPropagation();
      setIsOpen(false);
      triggerRef.current?.querySelector<HTMLElement>('button')?.focus();
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [isHrefComposingKeyEvent, isInline, isOpen, setIsOpen]);

  useEffect(() => {
    if (!isOpen || isInline || !isMindMapActive) return;
    return registerBackHandler(() => {
      setIsOpen(false);
      return true;
    }, BACK_PRIORITY.overlay);
  }, [isInline, isMindMapActive, isOpen, setIsOpen]);

  // Portal fixed 锚点定位与视口钳位：resize 与祖先滚动时实时重算，杜绝窄屏工具栏裁切
  useLayoutEffect(() => {
    if (!isOpen || isInline) return;
    const measure = () => {
      const triggerEl = triggerRef.current;
      if (!triggerEl) return;
      const rect = triggerEl.getBoundingClientRect();
      const margin = 8;
      const gap = 8;
      const panelWidth = panelRef.current?.offsetWidth || 296;
      const panelHeight = panelRef.current?.offsetHeight || 0;
      const isLeftAligned = placement === 'bottom-left' || placement === 'top-left';
      const isTopAligned = placement === 'top-left' || placement === 'top-right';

      const rawLeft = isLeftAligned ? rect.left : rect.right - panelWidth;
      const maxLeft = Math.max(margin, window.innerWidth - margin - panelWidth);
      const left = Math.min(Math.max(rawLeft, margin), maxLeft);

      let top: number;
      let maxHeight: number;
      if (isTopAligned) {
        maxHeight = Math.max(160, Math.min(680, Math.floor(rect.top - gap - margin)));
        const effectiveHeight = panelHeight > 0 ? Math.min(panelHeight, maxHeight) : maxHeight;
        top = Math.max(margin, rect.top - gap - effectiveHeight);
      } else {
        const rawTop = rect.bottom + gap;
        maxHeight = Math.max(160, Math.min(680, Math.floor(window.innerHeight - rawTop - margin)));
        top = Math.min(Math.max(margin, rawTop), Math.max(margin, window.innerHeight - margin - 160));
      }

      setPopoverPos((prev) =>
        prev && prev.left === left && prev.top === top && prev.maxHeight === maxHeight
          ? prev
          : { left, top, maxHeight },
      );
    };

    const handleScroll = (event: Event) => {
      if (panelRef.current && event.target instanceof Node && panelRef.current.contains(event.target)) {
        return;
      }
      measure();
    };

    measure();
    const frameId = requestAnimationFrame(measure);
    window.addEventListener('resize', measure, { passive: true });
    window.addEventListener('scroll', handleScroll, { capture: true, passive: true });
    return () => {
      cancelAnimationFrame(frameId);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [isOpen, isInline, placement]);

  // 面板内容（共用）
  const panelContent = (
    <div className="mm-style-panel">
      {/* 全局主题 */}
      <div>
        <h4 className="mm-style-heading">{t('style.globalTheme')}</h4>
        <div className="mm-theme-list">
          {themeEntries.map(({ theme, previewTheme }) => (
            <DsButton
              variant="ghost"
              key={theme.id}
              onClick={() => setStyleId(theme.id)}
              className={cn(
                'mm-theme-option',
                styleId === theme.id && 'is-active',
              )}
              aria-pressed={styleId === theme.id}
            >
              <span className="inline-flex items-center gap-2 min-w-0">
                <ThemeThumbnail theme={previewTheme} />
                <span className="truncate">{t(theme.name)}</span>
              </span>
              {styleId === theme.id && <Check className="w-3 h-3 shrink-0" />}
            </DsButton>
          ))}
        </div>
      </div>

      <div className="mm-panel-separator" />

      {/* 节点样式（支持单选与多选批量编辑） */}
      {primaryNode ? (
        <div className="mm-node-style-section">
          <div className="flex items-center justify-between gap-2">
            <h4 className="mm-style-heading !mb-0">
              {t('style.currentNodeStyle')}
            </h4>
            {targetIds.length > 1 && (
              <span className="text-[11px] font-mono tabular-nums text-[var(--mm-text-muted)]">
                {t('style.selectedCount', {
                  count: targetIds.length,
                  defaultValue: `已选 ${targetIds.length} 项`,
                })}
              </span>
            )}
          </div>

          {/* 字号：无自定义值时按当前节点真实层级显示（Root 18 / L1 15 / L2+ 14） */}
          <div className="mm-font-size-control">
            <TextT className="w-4 h-4 text-muted-foreground ml-1" />
            <input
              type="number"
              min={8}
              max={72}
              step={1}
              inputMode="numeric"
              className="mm-font-size-input"
              aria-label={t('style.fontSize', { defaultValue: '字号' })}
              value={primaryNode.style?.fontSize ?? defaultFontSize}
              onChange={(e) => {
                const value = e.currentTarget.valueAsNumber;
                if (!Number.isFinite(value)) return;
                handleNodeStyleUpdate({ fontSize: Math.min(72, Math.max(8, value)) });
              }}
            />
          </div>

          {/* B / I / U / S */}
          <div className="mm-style-button-row">
            {[
              { key: 'bold', icon: TextB, prop: 'fontWeight' as const, val: 'bold' as const, cur: primaryNode.style?.fontWeight },
              { key: 'italic', icon: TextItalic, prop: 'fontStyle' as const, val: 'italic' as const, cur: primaryNode.style?.fontStyle },
              { key: 'underline', icon: TextUnderline, prop: 'textDecoration' as const, val: 'underline' as const, cur: primaryNode.style?.textDecoration },
              { key: 'strikethrough', icon: TextStrikethrough, prop: 'textDecoration' as const, val: 'line-through' as const, cur: primaryNode.style?.textDecoration },
            ].map(({ key, icon: Icon, prop, val, cur }) => (
              <DsButton
                variant="ghost"
                key={key}
                onClick={() => handleNodeStyleUpdate({ [prop]: cur === val ? undefined : val })}
                className={cn(
                  'mm-style-icon-button',
                  cur === val ? 'is-active' : '',
                )}
                aria-pressed={cur === val}
                title={t(`contextMenu.${key}`)}
                aria-label={t(`contextMenu.${key}`)}
              >
                <Icon className="w-4 h-4" />
              </DsButton>
            ))}
          </div>

          {/* H1 / H2 / H3 / T */}
          <div>
            <div className="mm-style-label">{t('contextMenu.headingLevel')}</div>
            <div className="mm-style-button-row">
              {([['h1', TextHOne], ['h2', TextHTwo], ['h3', TextHThree]] as const).map(([level, Icon]) => (
                <DsButton
                  variant="ghost"
                  key={level}
                  onClick={() => handleNodeStyleUpdate({ headingLevel: primaryNode.style?.headingLevel === level ? undefined : level })}
                  className={cn(
                    'mm-style-icon-button',
                    primaryNode.style?.headingLevel === level ? 'is-active' : '',
                  )}
                  aria-pressed={primaryNode.style?.headingLevel === level}
                  title={t(`contextMenu.${level === 'h1' ? 'heading1' : level === 'h2' ? 'heading2' : 'heading3'}`)}
                  aria-label={t(`contextMenu.${level === 'h1' ? 'heading1' : level === 'h2' ? 'heading2' : 'heading3'}`)}
                >
                  <Icon className="w-4 h-4" />
                </DsButton>
              ))}
              <DsButton
                variant="ghost"
                onClick={() => handleNodeStyleUpdate({ headingLevel: undefined })}
                className={cn(
                  'mm-style-icon-button',
                  !primaryNode.style?.headingLevel ? 'is-active' : '',
                )}
                aria-pressed={!primaryNode.style?.headingLevel}
                title={t('contextMenu.normalText')}
                aria-label={t('contextMenu.normalText')}
              >
                <TextT className="w-4 h-4" />
              </DsButton>
            </div>
          </div>

          {/* 文本颜色 */}
          <ColorPicker
            label={t('style.textColor')}
            colors={textColors}
            value={primaryNode.style?.textColor || 'inherit'}
            onChange={(color) => handleNodeStyleUpdate({ textColor: color === 'inherit' ? undefined : color })}
          />

          {/* 背景颜色 */}
          <ColorPicker
            label={t('style.bgColor')}
            colors={presetColors}
            value={primaryNode.style?.bgColor || 'transparent'}
            onChange={(color) => handleNodeStyleUpdate({ bgColor: color === 'transparent' ? undefined : color })}
          />

          <div className="mm-panel-separator" />

          {/* W08 节点属性编辑区：优先级 / 进度 / 超链接 / 勾选框开关 */}
          <div className="space-y-2.5" data-testid="mm-style-w08-section">
            <h4 className="mm-style-heading !mb-0">
              {t('style.nodeAttributes', { defaultValue: '节点属性' })}
            </h4>

            {/* 优先级 P1-P6 */}
            <div className="space-y-1">
              <div className="mm-style-label">{t('style.priority', { defaultValue: '优先级' })}</div>
              <div className="flex flex-wrap items-center gap-1">
                {PRIORITY_LEVELS.map((level) => {
                  const active = primaryNode.priority === level;
                  return (
                    <button
                      key={level}
                      type="button"
                      className={cn(
                        'h-6 min-w-7 px-1.5 rounded-[var(--mm-radius-control,5px)] text-[11px] font-mono tabular-nums border transition-colors motion-reduce:transition-none',
                        '[@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11',
                        active
                          ? 'border-[var(--mm-primary)] bg-[var(--mm-primary-soft)] text-[var(--mm-primary)] font-semibold'
                          : 'border-[var(--mm-border)] text-[var(--mm-text-secondary)] hover:bg-[var(--mm-bg-hover)]',
                      )}
                      aria-pressed={active}
                      onClick={() =>
                        applyBatchNodeUpdates(() => ({ priority: active ? undefined : level }))
                      }
                      data-testid={`mm-style-priority-${level}`}
                    >
                      P{level}
                    </button>
                  );
                })}
                {primaryNode.priority !== undefined && (
                  <button
                    type="button"
                    className="h-6 px-1.5 rounded text-[11px] text-[var(--mm-text-muted)] hover:bg-[var(--mm-bg-hover)] transition-colors motion-reduce:transition-none [@media(pointer:coarse)]:min-h-11"
                    onClick={() => applyBatchNodeUpdates(() => ({ priority: undefined }))}
                    aria-label={t('style.clearPriority', { defaultValue: '清除优先级' })}
                  >
                    <X size={11} />
                  </button>
                )}
              </div>
            </div>

            {/* 进度 */}
            <div className="space-y-1">
              <div className="mm-style-label">{t('style.progress', { defaultValue: '完成进度' })}</div>
              <div className="flex flex-wrap items-center gap-1">
                {PROGRESS_STEPS.map((pct) => {
                  const active = primaryNode.progress === pct;
                  return (
                    <button
                      key={pct}
                      type="button"
                      className={cn(
                        'h-6 px-1.5 rounded-[var(--mm-radius-control,5px)] text-[11px] font-mono tabular-nums border transition-colors motion-reduce:transition-none',
                        '[@media(pointer:coarse)]:min-h-11',
                        active
                          ? 'border-[var(--mm-primary)] bg-[var(--mm-primary-soft)] text-[var(--mm-primary)] font-semibold'
                          : 'border-[var(--mm-border)] text-[var(--mm-text-secondary)] hover:bg-[var(--mm-bg-hover)]',
                      )}
                      aria-pressed={active}
                      onClick={() =>
                        applyBatchNodeUpdates(() => ({ progress: active ? undefined : pct }))
                      }
                      data-testid={`mm-style-progress-${pct}`}
                    >
                      {pct}%
                    </button>
                  );
                })}
                {primaryNode.progress !== undefined && (
                  <button
                    type="button"
                    className="h-6 px-1.5 rounded text-[11px] text-[var(--mm-text-muted)] hover:bg-[var(--mm-bg-hover)] transition-colors motion-reduce:transition-none [@media(pointer:coarse)]:min-h-11"
                    onClick={() => applyBatchNodeUpdates(() => ({ progress: undefined }))}
                    aria-label={t('style.clearProgress', { defaultValue: '清除进度' })}
                  >
                    <X size={11} />
                  </button>
                )}
              </div>
            </div>

            {/* 超链接 */}
            <div className="space-y-1">
              <label className="mm-style-label flex items-center gap-1">
                <LinkSimple size={12} />
                <span>{t('style.hyperlink', { defaultValue: '超链接' })}</span>
              </label>
              <div className="flex items-center gap-1">
                <input
                  type="url"
                  value={hrefDraft}
                  onChange={(e) => {
                    setHrefDraft(e.target.value);
                    if (hrefInvalid) setHrefInvalid(false);
                  }}
                  onCompositionStart={onHrefCompositionStart}
                  onCompositionEnd={onHrefCompositionEnd}
                  onKeyDown={(e) => {
                    if (isHrefComposingKeyEvent(e)) return;
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleApplyHref();
                    }
                  }}
                  placeholder="https://..."
                  className={cn(
                    'flex-1 min-w-0 h-7 px-2 rounded text-xs bg-[var(--mm-bg)] border text-[var(--mm-text)] outline-none focus:border-[var(--mm-primary)]',
                    '[@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:text-base',
                    hrefInvalid ? 'border-[hsl(var(--destructive))]' : 'border-[var(--mm-border)]',
                  )}
                  data-testid="mm-style-href-input"
                />
                <DsButton
                  variant="ghost"
                  className="ds-btn !h-7 px-2 text-xs [@media(pointer:coarse)]:!min-h-11"
                  onClick={handleApplyHref}
                  data-testid="mm-style-href-apply"
                >
                  {t('common:confirm', { defaultValue: '确定' })}
                </DsButton>
              </div>
              {hrefInvalid && (
                <div className="text-[11px] text-[hsl(var(--destructive))]">
                  {t('style.invalidHref', { defaultValue: '请输入有效的 http/https/mailto 链接' })}
                </div>
              )}
            </div>

            {/* 勾选框开关 */}
            <button
              type="button"
              role="switch"
              aria-checked={Boolean(primaryNode.style?.showCheckbox)}
              className={cn(
                'flex w-full items-center justify-between gap-2 rounded-[var(--mm-radius-control,5px)] border px-2 py-1.5 text-xs transition-colors motion-reduce:transition-none',
                '[@media(pointer:coarse)]:min-h-11',
                primaryNode.style?.showCheckbox
                  ? 'border-[var(--mm-primary)] bg-[var(--mm-primary-soft)] text-[var(--mm-primary)] font-medium'
                  : 'border-[var(--mm-border)] text-[var(--mm-text-secondary)] hover:bg-[var(--mm-bg-hover)]',
              )}
              onClick={() =>
                handleNodeStyleUpdate({
                  showCheckbox: primaryNode.style?.showCheckbox ? undefined : true,
                })
              }
              data-testid="mm-style-checkbox-toggle"
            >
              <span className="inline-flex items-center gap-1.5">
                <CheckSquare size={14} />
                <span>{t('style.showCheckbox', { defaultValue: '显示待办勾选框' })}</span>
              </span>
              <span className="text-[11px] opacity-80">
                {primaryNode.style?.showCheckbox
                  ? t('style.checkboxOn', { defaultValue: '已开启' })
                  : t('style.checkboxOff', { defaultValue: '关闭' })}
              </span>
            </button>
          </div>
        </div>
      ) : (
        <div className="mm-style-empty">
          {t('style.selectNodeHint')}
        </div>
      )}
    </div>
  );

  // inline 模式：直接渲染面板内容
  if (isInline) {
    return (
      <div className={cn('p-2', className)}>
        {panelContent}
      </div>
    );
  }

  return (
    <div ref={triggerRef} className={cn('relative', className)}>
      {trigger ? (
        <div onClick={() => setIsOpen(!isOpen)}>{trigger}</div>
      ) : (
        <DsButton
          variant="ghost"
          onClick={() => setIsOpen(!isOpen)}
          className={cn(
            'flex items-center gap-2 px-2 h-7 rounded',
            "relative [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-2.5 [@media(pointer:coarse)]:after:content-['']",
            'bg-transparent hover:bg-[var(--mm-bg-hover)]',
            'border border-transparent',
            'transition-colors duration-100 motion-reduce:transition-none',
            'text-sm text-[var(--mm-text-secondary)]',
            'focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--mm-primary)]',
            isOpen && 'bg-[var(--mm-bg-hover)] text-[var(--mm-text)]',
          )}
        >
          <Palette className="w-4 h-4 text-muted-foreground" />
          <span>{t('toolbar.style')}</span>
          <CaretDown
            className={cn(
              'w-4 h-4 transition-transform duration-200 motion-reduce:transition-none',
              isOpen && 'rotate-180',
            )}
          />
        </DsButton>
      )}

      {/* 弹出面板（Portal + fixed 锚点定位，彻底免受 <= 520px 工具栏 overflow-x 裁切） */}
      {isOpen &&
        typeof document !== 'undefined' &&
        createPortal(
          <CustomScrollArea
            ref={panelRef}
            className="mindmap-container fixed mm-settings-popover mm-style-popover ui-zoom-fade-in"
            viewportClassName="mm-settings-popover-viewport p-2"
            style={{
              zIndex: Z_INDEX.popover,
              left: popoverPos?.left ?? 0,
              top: popoverPos?.top ?? 0,
              maxHeight: popoverPos ? `min(680px, ${popoverPos.maxHeight}px)` : undefined,
              visibility: popoverPos ? 'visible' : 'hidden',
            }}
            role="dialog"
            aria-label={t('style.globalTheme')}
            data-testid="mm-style-popover"
            fullHeight={false}
          >
            {panelContent}
          </CustomScrollArea>,
          document.body,
        )}
    </div>
  );
};
