/**
 * W09 内联格式条（MindMapFormatBar）
 *
 * 契约（见 MindMapContentView）：无必需 props，内部消费当前 store。
 * 选中节点（focusedNodeId 或多选 selection）时在工具栏下方内联展开，
 * 提供 B/I/U/S、标题级别、文字颜色与高亮的快捷入口；
 * 多选时对全部选中节点应用同一补丁。
 *
 * 样式补丁走 store.updateNode（text/note/style 补丁自动按节点+字段合并 history）。
 */

import React, { useCallback, useMemo } from 'react';
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
  X,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { useMindMapStore } from '../../store';
import { findNodeById } from '../../utils/node/find';
import type { MindMapNode, NodeStyle } from '../../types';
import { getQuickBgColors, getQuickTextColors } from '../../constants/colors';
import { useMindMapDarkMode } from '../../hooks/useMindMapTheme';

type ToggleStyleProp = 'fontWeight' | 'fontStyle' | 'textDecoration';

const formatBtnClass = (active: boolean) =>
  cn(
    'ds-btn !w-7 !h-7 !min-w-0 !p-0 justify-center rounded',
    active
      ? 'bg-[var(--mm-bg-active)] text-[var(--mm-text)]'
      : 'text-[var(--mm-text-secondary)] hover:bg-[var(--mm-bg-hover)]',
  );

/** 色板行：小圆形色块 + 清除按钮 */
const ColorSwatchRow: React.FC<{
  colors: readonly string[];
  activeColor?: string;
  label: string;
  icon: React.ReactNode;
  onSelect: (color: string | undefined) => void;
  clearLabel: string;
  selectLabel: (color: string) => string;
}> = ({ colors, activeColor, label, icon, onSelect, clearLabel, selectLabel }) => (
  <div className="flex items-center gap-1" role="group" aria-label={label}>
    <span className="flex items-center gap-1 text-xs text-[var(--mm-text-muted)] select-none pr-0.5">
      {icon}
    </span>
    {colors.map((color) => (
      <button
        key={color}
        type="button"
        className={cn(
          'w-4 h-4 rounded-full border transition-transform hover:scale-110',
          activeColor === color
            ? 'border-[var(--mm-primary)] ring-1 ring-[var(--mm-primary)]'
            : 'border-[var(--mm-border)]',
        )}
        style={{ backgroundColor: color }}
        onClick={() => onSelect(color)}
        aria-pressed={activeColor === color}
        aria-label={selectLabel(color)}
        title={selectLabel(color)}
      />
    ))}
    <button
      type="button"
      className="w-4 h-4 rounded-full border border-[var(--mm-border)] flex items-center justify-center text-[var(--mm-text-muted)] hover:bg-[var(--mm-bg-hover)]"
      onClick={() => onSelect(undefined)}
      aria-label={clearLabel}
      title={clearLabel}
    >
      <X size={10} />
    </button>
  </div>
);

export const MindMapFormatBar: React.FC = () => {
  const { t } = useTranslation('mindmap');
  const isDark = useMindMapDarkMode();

  const document = useMindMapStore((state) => state.document);
  const focusedNodeId = useMindMapStore((state) => state.focusedNodeId);
  const selection = useMindMapStore((state) => state.selection);
  const updateNode = useMindMapStore((state) => state.updateNode);

  const targetIds = useMemo(() => {
    if (selection.length > 0) return selection;
    return focusedNodeId ? [focusedNodeId] : [];
  }, [selection, focusedNodeId]);

  /** 活跃态以第一个目标节点为准（多选时作代表值） */
  const primaryNode: MindMapNode | null = useMemo(() => {
    for (const id of targetIds) {
      const node = findNodeById(document.root, id);
      if (node) return node;
    }
    return null;
  }, [document, targetIds]);

  const applyStylePatch = useCallback(
    (patchStyle: (style: NodeStyle | undefined) => NodeStyle) => {
      for (const id of targetIds) {
        const node = findNodeById(document.root, id);
        if (!node) continue;
        updateNode(id, { style: patchStyle(node.style) });
      }
    },
    [targetIds, document, updateNode],
  );

  if (!primaryNode) return null;

  const style = primaryNode.style;

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
      className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5"
      role="toolbar"
      aria-label={t('contextMenu.textStyleGroup', { defaultValue: '文本样式' })}
    >
      <div className="flex items-center gap-0.5" role="group">
        {toggles.map(({ key, icon: Icon, prop, val }) => {
          const active = style?.[prop] === val;
          return (
            <DsButton
              variant="ghost"
              key={key}
              className={formatBtnClass(active)}
              onClick={() =>
                applyStylePatch((s) => ({ ...s, [prop]: s?.[prop] === val ? undefined : val }))
              }
              aria-pressed={active}
              title={t(`contextMenu.${key}`)}
              aria-label={t(`contextMenu.${key}`)}
            >
              <Icon className="w-4 h-4" />
            </DsButton>
          );
        })}
      </div>

      <div className="w-px h-4 bg-[var(--mm-border)]" />

      <div className="flex items-center gap-0.5" role="group" aria-label={t('contextMenu.headingLevel')}>
        {headings.map(([level, Icon, labelKey]) => {
          const active = style?.headingLevel === level;
          return (
            <DsButton
              variant="ghost"
              key={level}
              className={formatBtnClass(active)}
              onClick={() =>
                applyStylePatch((s) => ({
                  ...s,
                  headingLevel: s?.headingLevel === level ? undefined : level,
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

      <div className="w-px h-4 bg-[var(--mm-border)] hidden sm:block" />

      <ColorSwatchRow
        colors={getQuickTextColors(isDark)}
        activeColor={style?.textColor}
        label={t('contextMenu.textColor')}
        icon={<Palette size={14} />}
        onSelect={(color) => applyStylePatch((s) => ({ ...s, textColor: color }))}
        clearLabel={t('contextMenu.clearColor', { defaultValue: '清除颜色' })}
        selectLabel={(color) => t('contextMenu.selectColor', { color, defaultValue: `选择颜色 ${color}` })}
      />

      <ColorSwatchRow
        colors={getQuickBgColors(isDark)}
        activeColor={style?.bgColor}
        label={t('contextMenu.highlight')}
        icon={<Highlighter size={14} />}
        onSelect={(color) => applyStylePatch((s) => ({ ...s, bgColor: color }))}
        clearLabel={t('contextMenu.clearColor', { defaultValue: '清除颜色' })}
        selectLabel={(color) => t('contextMenu.selectColor', { color, defaultValue: `选择颜色 ${color}` })}
      />
    </div>
  );
};
