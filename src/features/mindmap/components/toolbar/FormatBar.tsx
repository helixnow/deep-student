/**
 * W09 内联格式条（MindMapFormatBar）
 *
 * 契约（见 MindMapContentView）：无必需 props，内部消费当前 store。
 * 选中节点（focusedNodeId 或多选 selection）时在工具栏下方以浮层胶囊呈现：
 * - 文本格式 B/I/U/S 与标题级别 H1/H2/H3/T；
 * - 紧凑弹出式「文字色 / 背景色」色盘，释放水平空间消除静默截断；
 * - W08 快捷属性（优先级 P1-P6、完成进度、超链接、待办勾选框）；
 * - 学习与 AI 动作（归纳总结 }、投影闪卡、导出讲义、AI 扩写/总结、引用到聊天）；
 * - 批量样式 / 闪卡 / 属性修改聚合为单步 Undo（首节点记历史，其余 skipHistory: true）。
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  TextB,
  TextItalic,
  TextUnderline,
  TextStrikethrough,
  TextHOne,
  TextHTwo,
  TextHThree,
  TextT,
  Palette,
  Highlighter,
  Quotes,
  BracketsCurly,
  Cards,
  Article,
  Flag,
  CheckSquare,
  Sparkle,
  TreeStructure,
  ListBullets,
  LinkSimple,
  X,
} from '@phosphor-icons/react';
import { cn } from '@/utils/cn';
import { DsButton } from '@/components/ui/DsButton';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/shad/Popover';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { useMindMapStore } from '../../store';
import { exportMindMapSelectionToHandoutNote } from '../../interop/handoutExport';
import { findNodeById } from '../../utils/node/find';
import { serializeNodesToOutlineText } from '../../utils/node/outlineText';
import { resolveSiblingRangeForSummary } from '../../utils/summaryBraces';
import type { MindMapNode, NodeStyle, UpdateNodeParams } from '../../types';
import { getQuickBgColors, getQuickTextColors } from '../../constants/colors';
import { useMindMapDarkMode } from '../../hooks/useMindMapTheme';
import { useImeCompositionGuard } from '../../hooks/useImeCompositionGuard';

type ToggleStyleProp = 'fontWeight' | 'fontStyle' | 'textDecoration';

const PRIORITY_LEVELS = [1, 2, 3, 4, 5, 6] as const;
const PROGRESS_STEPS = [0, 25, 50, 75, 100] as const;

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

const formatBtnClass = (active: boolean) =>
  cn(
    'ds-btn !w-7 !h-7 !min-w-0 !p-0 justify-center rounded shrink-0',
    'transition-colors motion-reduce:transition-none',
    '[@media(pointer:coarse)]:!w-11 [@media(pointer:coarse)]:!h-11',
    active
      ? 'bg-[var(--mm-bg-active)] text-[var(--mm-text)]'
      : 'text-[var(--mm-text-secondary)] hover:bg-[var(--mm-bg-hover)]',
  );

const formatPillBtnClass = (active: boolean) =>
  cn(
    'h-7 px-2 text-xs gap-1 rounded-[var(--mm-radius-control,5px)] shrink-0',
    'transition-colors motion-reduce:transition-none',
    '[@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:px-3',
    active
      ? 'bg-[var(--mm-celadon-pill-bg)] text-[var(--mm-celadon-pill-fg)] font-medium'
      : 'hover:bg-[var(--mm-bg-hover)] text-[var(--mm-text)]',
  );

/** 弹出色盘按钮：将平铺色块收纳为紧凑按钮 + 当前色微点 */
const ColorPalettePopover: React.FC<{
  colors: readonly string[];
  activeColor?: string;
  label: string;
  icon: React.ReactNode;
  onSelect: (color: string | undefined) => void;
  clearLabel: string;
  selectLabel: (color: string) => string;
  testId: string;
}> = ({ colors, activeColor, label, icon, onSelect, clearLabel, selectLabel, testId }) => {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <DsButton
          variant="ghost"
          className={cn(formatBtnClass(Boolean(activeColor)), 'relative')}
          aria-label={label}
          title={label}
          aria-expanded={open}
          data-testid={testId}
        >
          {icon}
          <span
            aria-hidden="true"
            className="absolute bottom-1 right-1 h-1.5 w-1.5 rounded-full border border-[var(--mm-bg-elevated)]"
            style={{ backgroundColor: activeColor || 'var(--mm-border-strong)' }}
          />
        </DsButton>
      </PopoverTrigger>
      <PopoverContent
        align="center"
        sideOffset={8}
        className="mindmap-container mm-format-popover w-auto p-2 rounded-[var(--mm-radius-popup,8px)] border border-[var(--mm-border)] bg-[var(--mm-bg-elevated)] shadow-[var(--mm-popover-shadow)]"
      >
        <div className="mb-1.5 text-[11px] font-medium text-[var(--mm-text-secondary)]">{label}</div>
        <div
          className="flex flex-wrap items-center gap-1.5 [@media(pointer:coarse)]:gap-3"
          role="group"
          aria-label={label}
        >
          {colors.map((color) => (
            <button
              key={color}
              type="button"
              className={cn(
                'w-5 h-5 rounded-full border transition-colors motion-reduce:transition-none',
                "relative [@media(pointer:coarse)]:w-7 [@media(pointer:coarse)]:h-7 [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-2 [@media(pointer:coarse)]:after:content-['']",
                activeColor === color
                  ? 'border-[var(--mm-primary)] ring-2 ring-[var(--mm-primary)] ring-offset-1 ring-offset-[var(--mm-bg-elevated)]'
                  : 'border-[var(--mm-border)] hover:border-[var(--mm-text-secondary)] hover:ring-2 hover:ring-[var(--mm-border-strong)]',
              )}
              style={{ backgroundColor: color }}
              onClick={() => {
                onSelect(color);
                setOpen(false);
              }}
              aria-pressed={activeColor === color}
              aria-label={selectLabel(color)}
              title={selectLabel(color)}
            />
          ))}
          <button
            type="button"
            className="w-5 h-5 rounded-full border border-[var(--mm-border)] flex items-center justify-center text-[var(--mm-text-muted)] hover:bg-[var(--mm-bg-hover)] transition-colors motion-reduce:transition-none relative [@media(pointer:coarse)]:w-7 [@media(pointer:coarse)]:h-7 [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-2 [@media(pointer:coarse)]:after:content-['']"
            onClick={() => {
              onSelect(undefined);
              setOpen(false);
            }}
            aria-label={clearLabel}
            title={clearLabel}
          >
            <X size={11} />
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
};

export const MindMapFormatBar: React.FC = () => {
  const { t } = useTranslation('mindmap');
  const isDark = useMindMapDarkMode();

  const document = useMindMapStore((state) => state.document);
  const focusedNodeId = useMindMapStore((state) => state.focusedNodeId);
  const selection = useMindMapStore((state) => state.selection);
  const updateNode = useMindMapStore((state) => state.updateNode);
  const addSummaryBrace = useMindMapStore((state) => state.addSummaryBrace);
  const mindmapId = useMindMapStore((state) => state.mindmapId);
  const mapTitle = useMindMapStore((state) => state.metadata?.title);

  const [w08Open, setW08Open] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [hrefDraft, setHrefDraft] = useState('');
  const [hrefInvalid, setHrefInvalid] = useState(false);
  const hrefImeGuard = useImeCompositionGuard();

  const targetIds = useMemo(() => {
    if (selection.length > 0) return selection;
    return focusedNodeId ? [focusedNodeId] : [];
  }, [selection, focusedNodeId]);

  const siblingSummaryRange = useMemo(
    () => resolveSiblingRangeForSummary(document.root, targetIds),
    [document.root, targetIds],
  );

  const allFlashcards = useMemo(() => {
    if (targetIds.length === 0) return false;
    return targetIds.every((id) => findNodeById(document.root, id)?.isFlashcard === true);
  }, [document.root, targetIds]);

  /** 活跃态以第一个目标节点为准（多选时作代表值） */
  const primaryNode: MindMapNode | null = useMemo(() => {
    for (const id of targetIds) {
      const node = findNodeById(document.root, id);
      if (node) return node;
    }
    return null;
  }, [document, targetIds]);

  useEffect(() => {
    setHrefDraft(primaryNode?.href ?? '');
    setHrefInvalid(false);
  }, [primaryNode?.id, primaryNode?.href]);

  /** 批量更新节点：首个节点记历史，其余 skipHistory: true，聚合为单步 Undo */
  const applyBatchNodeUpdates = useCallback(
    (buildPatch: (node: MindMapNode) => UpdateNodeParams | null) => {
      let recordedHistory = false;
      for (const id of targetIds) {
        const node = findNodeById(document.root, id);
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
    [document.root, targetIds, updateNode],
  );

  const applyStylePatch = useCallback(
    (patchStyle: (style: NodeStyle | undefined) => NodeStyle) => {
      applyBatchNodeUpdates((node) => ({ style: patchStyle(node.style) }));
    },
    [applyBatchNodeUpdates],
  );

  const handleToggleFlashcard = useCallback(() => {
    const next = !allFlashcards;
    applyBatchNodeUpdates((node) => {
      if ((node.isFlashcard === true) === next) return null;
      return { isFlashcard: next ? true : undefined };
    });
  }, [allFlashcards, applyBatchNodeUpdates]);

  const handleApplyHref = useCallback(() => {
    const normalized = normalizeSafeHref(hrefDraft);
    if (normalized === null) {
      setHrefInvalid(true);
      return;
    }
    setHrefInvalid(false);
    applyBatchNodeUpdates(() => ({ href: normalized }));
  }, [applyBatchNodeUpdates, hrefDraft]);

  const handleExportHandout = useCallback(() => {
    const selectedNodes: MindMapNode[] = [];
    for (const id of targetIds) {
      const node = findNodeById(document.root, id);
      if (node) selectedNodes.push(node);
    }
    if (selectedNodes.length === 0) return;

    void exportMindMapSelectionToHandoutNote({
      nodes: selectedNodes,
      mindmapId,
      mindmapTitle: document.root.text,
      defaultNoteSuffix: t('mn5.exportHandoutSuffix'),
    })
      .then((outcome) => {
        showGlobalNotification(
          'success',
          t('mn5.exportHandoutSuccess', { title: outcome.noteTitle }),
        );
      })
      .catch((err) => {
        showGlobalNotification(
          'error',
          t('mn5.exportHandoutFailed', { error: getErrorMessage(err) }),
        );
      });
  }, [document.root, mindmapId, t, targetIds]);

  const sendSelectionToChat = useCallback(
    (promptPrefix?: string) => {
      if (!mindmapId) return;
      const nodes: MindMapNode[] = [];
      for (const id of targetIds) {
        const node = findNodeById(document.root, id);
        if (node) nodes.push(node);
      }
      if (nodes.length === 0) return;
      const outlineText = serializeNodesToOutlineText(nodes);
      const text = promptPrefix ? `${promptPrefix}\n${outlineText}` : outlineText;
      void import('@/features/chat/context/selectionRef').then(({ selectionToChat }) =>
        selectionToChat({
          text,
          source: {
            kind: 'mindmap',
            sourceId: mindmapId,
            locator: targetIds.length === 1 ? `node:${targetIds[0]}` : `nodes:${targetIds.length}`,
            title: mapTitle || undefined,
          },
        }),
      );
    },
    [document.root, mapTitle, mindmapId, targetIds],
  );

  const handleAddAsContext = useCallback(() => {
    sendSelectionToChat(undefined);
  }, [sendSelectionToChat]);

  const handleAiAction = useCallback(
    (action: 'expand' | 'summarize') => {
      const targetNodeId = targetIds[0] ?? primaryNode?.id;
      if (typeof window !== 'undefined' && targetNodeId) {
        const aiEvent = new CustomEvent('mindmap:ai-action', {
          cancelable: true,
          detail: { action, nodeId: targetNodeId, mindmapId },
        });
        window.dispatchEvent(aiEvent);
        if (aiEvent.defaultPrevented) {
          setAiOpen(false);
          return;
        }
      }
      const prompt =
        action === 'expand'
          ? t('ai.expandPrompt', { defaultValue: '请围绕以下思维导图节点进行结构化扩写，补充关键子节点：' })
          : t('ai.summarizePrompt', { defaultValue: '请提炼总结以下思维导图分支的核心要点：' });
      sendSelectionToChat(prompt);
      setAiOpen(false);
    },
    [mindmapId, primaryNode?.id, sendSelectionToChat, t, targetIds],
  );

  if (!primaryNode) return null;

  const style = primaryNode.style;
  const hasW08Decoration =
    primaryNode.priority !== undefined ||
    primaryNode.progress !== undefined ||
    Boolean(primaryNode.href);

  const toggles: Array<{
    key: string;
    icon: React.ComponentType<{ className?: string }>;
    prop: ToggleStyleProp;
    val: NonNullable<NodeStyle[ToggleStyleProp]>;
  }> = [
    { key: 'bold', icon: TextB, prop: 'fontWeight', val: 'bold' },
    { key: 'italic', icon: TextItalic, prop: 'fontStyle', val: 'italic' },
    { key: 'underline', icon: TextUnderline, prop: 'textDecoration', val: 'underline' },
    { key: 'strikethrough', icon: TextStrikethrough, prop: 'textDecoration', val: 'line-through' },
  ];

  const headings = [
    ['h1', TextHOne, 'heading1'],
    ['h2', TextHTwo, 'heading2'],
    ['h3', TextHThree, 'heading3'],
  ] as const;

  return (
    <div
      className="mm-format-bar flex flex-nowrap items-center gap-1 px-2 py-1 max-w-full"
      role="toolbar"
      aria-label={t('contextMenu.textStyleGroup', { defaultValue: '文本样式' })}
    >
      {/* 格式与学习动作区：窄容器/分栏下独立水平滚动，避免挤压右侧固定的 AI 入口 */}
      <div
        className="flex flex-1 min-w-0 flex-nowrap items-center gap-1 overflow-x-auto scrollbar-none"
        data-testid="mm-format-scroll-group"
      >
      {/* 文本修饰 B / I / U / S */}
      <div className="flex items-center gap-0.5 shrink-0" role="group">
        {toggles.map(({ key, icon: Icon, prop, val }) => {
          const active = style?.[prop] === val;
          const nextValue = active ? undefined : val;
          return (
            <DsButton
              variant="ghost"
              key={key}
              className={formatBtnClass(active)}
              onClick={() => applyStylePatch((s) => ({ ...s, [prop]: nextValue }))}
              aria-pressed={active}
              title={t(`contextMenu.${key}`)}
              aria-label={t(`contextMenu.${key}`)}
            >
              <Icon className="w-4 h-4" />
            </DsButton>
          );
        })}
      </div>

      <div className="w-px h-4 bg-[var(--mm-border)] shrink-0" />

      {/* 标题层级 H1 / H2 / H3 / T */}
      <div className="flex items-center gap-0.5 shrink-0" role="group" aria-label={t('contextMenu.headingLevel')}>
        {headings.map(([level, Icon, labelKey]) => {
          const active = style?.headingLevel === level;
          const nextHeading = active ? undefined : level;
          return (
            <DsButton
              variant="ghost"
              key={level}
              className={formatBtnClass(active)}
              onClick={() =>
                applyStylePatch((s) => ({
                  ...s,
                  headingLevel: nextHeading,
                }))
              }
              aria-pressed={active}
              title={t(`contextMenu.${labelKey}`)}
              aria-label={t(`contextMenu.${labelKey}`)}
            >
              <Icon className="w-4 h-4" />
            </DsButton>
          );
        })}
        <DsButton
          variant="ghost"
          className={formatBtnClass(!style?.headingLevel)}
          onClick={() => applyStylePatch((s) => ({ ...s, headingLevel: undefined }))}
          aria-pressed={!style?.headingLevel}
          title={t('contextMenu.normalText')}
          aria-label={t('contextMenu.normalText')}
        >
          <TextT className="w-4 h-4" />
        </DsButton>
      </div>

      <div className="w-px h-4 bg-[var(--mm-border)] shrink-0" />

      {/* 紧凑弹出式文字色 / 背景色 */}
      <div className="flex items-center gap-0.5 shrink-0" role="group">
        <ColorPalettePopover
          colors={getQuickTextColors(isDark)}
          activeColor={style?.textColor}
          label={t('contextMenu.textColor')}
          icon={<Palette size={15} />}
          onSelect={(color) => applyStylePatch((s) => ({ ...s, textColor: color }))}
          clearLabel={t('contextMenu.clearColor', { defaultValue: '清除颜色' })}
          selectLabel={(color) => t('contextMenu.selectColor', { color, defaultValue: `选择颜色 ${color}` })}
          testId="mm-format-text-color-trigger"
        />
        <ColorPalettePopover
          colors={getQuickBgColors(isDark)}
          activeColor={style?.bgColor}
          label={t('contextMenu.highlight')}
          icon={<Highlighter size={15} />}
          onSelect={(color) => applyStylePatch((s) => ({ ...s, bgColor: color }))}
          clearLabel={t('contextMenu.clearColor', { defaultValue: '清除颜色' })}
          selectLabel={(color) => t('contextMenu.selectColor', { color, defaultValue: `选择颜色 ${color}` })}
          testId="mm-format-bg-color-trigger"
        />
      </div>

      <div className="w-px h-4 bg-[var(--mm-border)] shrink-0" />

      {/* W08 快捷入口：优先级 / 进度 / 超链接 + 待办勾选框 */}
      <div className="flex items-center gap-0.5 shrink-0" role="group" aria-label={t('style.nodeAttributes', { defaultValue: '节点属性' })}>
        <Popover open={w08Open} onOpenChange={setW08Open}>
          <PopoverTrigger asChild>
            <DsButton
              variant="ghost"
              className={formatBtnClass(hasW08Decoration)}
              aria-label={t('style.nodeAttributes', { defaultValue: '优先级、进度与超链接' })}
              title={t('style.nodeAttributes', { defaultValue: '优先级、进度与超链接' })}
              aria-expanded={w08Open}
              data-testid="mm-format-w08-trigger"
            >
              <Flag className="w-4 h-4" />
            </DsButton>
          </PopoverTrigger>
          <PopoverContent
            align="center"
            sideOffset={8}
            className="mindmap-container mm-format-popover w-64 p-2.5 space-y-2.5 rounded-[var(--mm-radius-popup,8px)] border border-[var(--mm-border)] bg-[var(--mm-bg-elevated)] shadow-[var(--mm-popover-shadow)]"
          >
            {/* 优先级 P1-P6 */}
            <div className="space-y-1">
              <div className="text-[11px] font-medium text-[var(--mm-text-secondary)]">
                {t('style.priority', { defaultValue: '优先级' })}
              </div>
              <div className="flex flex-wrap items-center gap-1" role="group">
                {PRIORITY_LEVELS.map((level) => {
                  const active = primaryNode.priority === level;
                  return (
                    <button
                      key={level}
                      type="button"
                      className={cn(
                        'h-6 min-w-6 px-1.5 rounded text-[11px] font-mono tabular-nums border transition-colors motion-reduce:transition-none',
                        '[@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11',
                        active
                          ? 'border-[var(--mm-primary)] bg-[var(--mm-primary-soft)] text-[var(--mm-primary)] font-semibold'
                          : 'border-[var(--mm-border)] text-[var(--mm-text-secondary)] hover:bg-[var(--mm-bg-hover)]',
                      )}
                      aria-pressed={active}
                      onClick={() =>
                        applyBatchNodeUpdates(() => ({ priority: active ? undefined : level }))
                      }
                      data-testid={`mm-format-priority-${level}`}
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

            {/* 完成进度 */}
            <div className="space-y-1">
              <div className="text-[11px] font-medium text-[var(--mm-text-secondary)]">
                {t('style.progress', { defaultValue: '完成进度' })}
              </div>
              <div className="flex flex-wrap items-center gap-1" role="group">
                {PROGRESS_STEPS.map((pct) => {
                  const active = primaryNode.progress === pct;
                  return (
                    <button
                      key={pct}
                      type="button"
                      className={cn(
                        'h-6 px-1.5 rounded text-[11px] font-mono tabular-nums border transition-colors motion-reduce:transition-none',
                        '[@media(pointer:coarse)]:min-h-11',
                        active
                          ? 'border-[var(--mm-primary)] bg-[var(--mm-primary-soft)] text-[var(--mm-primary)] font-semibold'
                          : 'border-[var(--mm-border)] text-[var(--mm-text-secondary)] hover:bg-[var(--mm-bg-hover)]',
                      )}
                      aria-pressed={active}
                      onClick={() =>
                        applyBatchNodeUpdates(() => ({ progress: active ? undefined : pct }))
                      }
                      data-testid={`mm-format-progress-${pct}`}
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
              <label className="flex items-center gap-1 text-[11px] font-medium text-[var(--mm-text-secondary)]">
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
                  onCompositionStart={hrefImeGuard.onCompositionStart}
                  onCompositionEnd={hrefImeGuard.onCompositionEnd}
                  onKeyDown={(e) => {
                    if (hrefImeGuard.isComposingKeyEvent(e)) return;
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
                  data-testid="mm-format-href-input"
                />
                <DsButton
                  variant="ghost"
                  className="ds-btn !h-7 px-2 text-xs [@media(pointer:coarse)]:!min-h-11"
                  onClick={handleApplyHref}
                  data-testid="mm-format-href-apply"
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
          </PopoverContent>
        </Popover>

        <DsButton
          variant="ghost"
          className={formatBtnClass(Boolean(style?.showCheckbox))}
          onClick={() => {
            const nextShowCheckbox = style?.showCheckbox ? undefined : true;
            applyStylePatch((s) => ({
              ...s,
              showCheckbox: nextShowCheckbox,
            }));
          }}
          aria-pressed={Boolean(style?.showCheckbox)}
          title={t('style.showCheckbox', { defaultValue: '待办勾选框' })}
          aria-label={t('style.showCheckbox', { defaultValue: '待办勾选框' })}
          data-testid="mm-format-checkbox-toggle"
        >
          <CheckSquare className="w-4 h-4" />
        </DsButton>
      </div>

      <div className="w-px h-4 bg-[var(--mm-border)] shrink-0" />

      {/* 学习动作：归纳总结 } / 投影闪卡 / 导出讲义 */}
      {siblingSummaryRange && (
        <DsButton
          variant="ghost"
          className={formatPillBtnClass(false)}
          onClick={() => addSummaryBrace(targetIds)}
          title={t('mn5.addSummaryBraceHint')}
          aria-label={t('mn5.addSummaryBrace')}
          data-testid="mm-format-add-summary-brace"
        >
          <BracketsCurly className="w-3.5 h-3.5 text-[var(--mm-celadon-accent)]" />
          <span>{t('mn5.addSummaryBrace')}</span>
        </DsButton>
      )}

      <DsButton
        variant="ghost"
        className={formatPillBtnClass(allFlashcards)}
        onClick={handleToggleFlashcard}
        aria-pressed={allFlashcards}
        title={t(allFlashcards ? 'mn5.unprojectFlashcard' : 'mn5.projectAsFlashcard')}
        aria-label={t(allFlashcards ? 'mn5.unprojectFlashcard' : 'mn5.projectAsFlashcard')}
        data-testid="mm-format-flashcard-toggle"
      >
        <Cards className="w-3.5 h-3.5" />
        <span className="hidden xl:inline">{t('mn5.projectAsFlashcard')}</span>
      </DsButton>

      <DsButton
        variant="ghost"
        className={formatPillBtnClass(false)}
        onClick={handleExportHandout}
        title={t('mn5.exportHandoutHint')}
        aria-label={t('mn5.exportHandout')}
        data-testid="mm-format-export-handout"
      >
        <Article className="w-3.5 h-3.5 text-[var(--mm-celadon-accent)]" />
        <span className="hidden xl:inline">{t('mn5.exportHandout')}</span>
      </DsButton>
      </div>

      {/* AI 扩写 / 总结 + 引用到聊天：固定在滚动区外侧，1440×900 开侧边栏也不被裁剪 */}
      {mindmapId && (
        <div
          className="flex items-center gap-1 shrink-0 pl-1 border-l border-[var(--mm-border)]"
          data-testid="mm-format-ai-pinned"
        >
          <Popover open={aiOpen} onOpenChange={setAiOpen}>
            <PopoverTrigger asChild>
              <DsButton
                variant="ghost"
                className={formatPillBtnClass(aiOpen)}
                aria-label={t('ai.quickActions', { defaultValue: 'AI 扩写/总结' })}
                title={t('ai.quickActions', { defaultValue: 'AI 扩写/总结' })}
                aria-expanded={aiOpen}
                data-testid="mm-format-ai-trigger"
              >
                <Sparkle className="w-3.5 h-3.5 text-[var(--mm-primary)]" />
                <span className="hidden xl:inline">{t('ai.label', { defaultValue: 'AI' })}</span>
              </DsButton>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              sideOffset={8}
              className="mindmap-container mm-format-popover w-40 p-1 rounded-[var(--mm-radius-popup,8px)] border border-[var(--mm-border)] bg-[var(--mm-bg-elevated)] shadow-[var(--mm-popover-shadow)]"
            >
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-[var(--mm-radius-control,5px)] px-2.5 py-1.5 text-xs text-[var(--mm-text)] hover:bg-[var(--mm-bg-hover)] transition-colors motion-reduce:transition-none [@media(pointer:coarse)]:min-h-11"
                onClick={() => handleAiAction('expand')}
                data-testid="mm-format-ai-expand"
              >
                <TreeStructure size={13} className="text-[var(--mm-primary)] shrink-0" />
                <span>{t('ai.expand', { defaultValue: 'AI 扩写' })}</span>
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-[var(--mm-radius-control,5px)] px-2.5 py-1.5 text-xs text-[var(--mm-text)] hover:bg-[var(--mm-bg-hover)] transition-colors motion-reduce:transition-none [@media(pointer:coarse)]:min-h-11"
                onClick={() => handleAiAction('summarize')}
                data-testid="mm-format-ai-summarize"
              >
                <ListBullets size={13} className="text-[var(--mm-primary)] shrink-0" />
                <span>{t('ai.summarize', { defaultValue: 'AI 总结' })}</span>
              </button>
            </PopoverContent>
          </Popover>

          <DsButton
            variant="ghost"
            className={formatBtnClass(false)}
            onClick={handleAddAsContext}
            title={t('toolbar.quoteToChat', { defaultValue: '引用到 AI 对话' })}
            aria-label={t('toolbar.quoteToChat', { defaultValue: '引用到 AI 对话' })}
          >
            <Quotes className="w-4 h-4" />
          </DsButton>
        </div>
      )}
    </div>
  );
};
