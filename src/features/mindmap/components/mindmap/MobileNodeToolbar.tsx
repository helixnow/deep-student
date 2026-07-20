/**
 * 触屏选中节点时的画布底部内联工具条。
 *
 * 替代触屏路径上依赖 CanvasContextMenu Portal 的节点操作：
 * - 主行：加子节点 / 加同级 / 编辑 / 样式 / 删除 / 更多（按钮 ≥44px）
 * - 「样式」「更多」在条上方展开内联面板（非 Portal，非模态）
 * - 注册 Android 返回键：先收起面板，再取消选中关闭工具条
 *
 * 动作逻辑与 CanvasContextMenu 一致（同一批 store action），
 * 颜色面板直接复用其导出的 ColorPalette。
 */
import React, { useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Plus,
  PlusCircle,
  Pencil,
  Palette,
  Trash,
  DotsThree,
  Note,
  Link,
  LineSegment,
  MagnifyingGlassPlus,
  CheckCircle,
  Circle,
  Copy,
  Scissors,
  ClipboardText,
  CaretRight,
  CaretDown,
  TextB,
  TextItalic,
  TextUnderline,
  TextStrikethrough,
  TextHOne,
  TextHTwo,
  TextHThree,
  TextT,
  Highlighter,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import { useMindMapStore } from '../../store';
import { findNodeById, findParentNode } from '../../utils/node/find';
import { QUICK_TEXT_COLORS, QUICK_BG_COLORS } from '../../constants';
import { ColorPalette } from './CanvasContextMenu';

export type MobileToolbarPanel = 'style' | 'more' | null;

export interface MobileNodeToolbarProps {
  nodeId: string;
  panel: MobileToolbarPanel;
  onPanelChange: (panel: MobileToolbarPanel) => void;
  /** 关闭工具条（清除节点选中） */
  onClose: () => void;
  onOpenResourcePicker?: (nodeId: string) => void;
  onStartAssociation?: (nodeId: string) => void;
  onFocusBranch?: (nodeId: string) => void;
}

const PanelRow: React.FC<{
  icon: React.ReactNode;
  label: string;
  destructive?: boolean;
  disabled?: boolean;
  active?: boolean;
  onClick: () => void;
}> = ({ icon, label, destructive, disabled, active, onClick }) => (
  <NotionButton
    variant="ghost"
    className={cn(
      'mm-mobile-panel-row',
      destructive && 'destructive',
      active && 'is-active',
    )}
    disabled={disabled}
    onClick={onClick}
  >
    <span className="w-5 h-5 flex-shrink-0 flex items-center justify-center">{icon}</span>
    <span className="flex-1 text-left">{label}</span>
    {active && <span className="text-[var(--mm-primary)] text-xs">✓</span>}
  </NotionButton>
);

export const MobileNodeToolbar: React.FC<MobileNodeToolbarProps> = ({
  nodeId,
  panel,
  onPanelChange,
  onClose,
  onOpenResourcePicker,
  onStartAssociation,
  onFocusBranch,
}) => {
  const { t } = useTranslation('mindmap');
  const document = useMindMapStore(s => s.document);
  const addNode = useMindMapStore(s => s.addNode);
  const deleteNode = useMindMapStore(s => s.deleteNode);
  const updateNode = useMindMapStore(s => s.updateNode);
  const toggleCollapse = useMindMapStore(s => s.toggleCollapse);
  const setEditingNodeId = useMindMapStore(s => s.setEditingNodeId);
  const setEditingNoteNodeId = useMindMapStore(s => s.setEditingNoteNodeId);
  const setFocusedNodeId = useMindMapStore(s => s.setFocusedNodeId);
  const copyNodes = useMindMapStore(s => s.copyNodes);
  const cutNodes = useMindMapStore(s => s.cutNodes);
  const pasteNodes = useMindMapStore(s => s.pasteNodes);
  const clipboard = useMindMapStore(s => s.clipboard);

  const node = findNodeById(document.root, nodeId);
  const isRoot = nodeId === document.root.id;
  const hasChildren = !!node && node.children.length > 0;
  const isCollapsed = node?.collapsed ?? false;

  // Android back：面板打开时先收面板，否则取消选中关闭工具条
  useEffect(() => {
    return registerBackHandler(() => {
      if (panel) {
        onPanelChange(null);
      } else {
        onClose();
      }
      return true;
    }, BACK_PRIORITY.overlay);
  }, [panel, onPanelChange, onClose]);

  const focusAndEdit = useCallback(
    (id: string | null) => {
      if (!id) return;
      setFocusedNodeId(id);
      requestAnimationFrame(() => setEditingNodeId(id));
    },
    [setFocusedNodeId, setEditingNodeId],
  );

  const handleAddChild = useCallback(() => {
    onPanelChange(null);
    focusAndEdit(addNode(nodeId, 0));
  }, [addNode, nodeId, focusAndEdit, onPanelChange]);

  const handleAddSibling = useCallback(() => {
    onPanelChange(null);
    const parent = findParentNode(document.root, nodeId);
    if (!parent) return;
    const idx = parent.children.findIndex(c => c.id === nodeId);
    focusAndEdit(addNode(parent.id, idx + 1));
  }, [addNode, document.root, nodeId, focusAndEdit, onPanelChange]);

  const handleEdit = useCallback(() => {
    onPanelChange(null);
    setEditingNodeId(nodeId);
  }, [nodeId, setEditingNodeId, onPanelChange]);

  const handleDelete = useCallback(() => {
    onPanelChange(null);
    deleteNode(nodeId);
  }, [deleteNode, nodeId, onPanelChange]);

  const closePanelThen = useCallback(
    (action: () => void) => () => {
      onPanelChange(null);
      action();
    },
    [onPanelChange],
  );

  if (!node) return null;

  return (
    <div className="mm-mobile-node-toolbar" role="toolbar" aria-label={t('node.moreActions')}>
      {panel === 'more' && (
        <div className="mm-mobile-toolbar-panel">
          <PanelRow
            icon={<Note size={18} />}
            label={node.note ? t('contextMenu.editNote') : t('contextMenu.addNote')}
            onClick={closePanelThen(() => setEditingNoteNodeId(nodeId))}
          />
          <PanelRow
            icon={<Link size={18} />}
            label={t('contextMenu.linkResource')}
            onClick={closePanelThen(() => onOpenResourcePicker?.(nodeId))}
          />
          <PanelRow
            icon={<LineSegment size={18} />}
            label={t('association.add', { defaultValue: '添加关联线' })}
            onClick={closePanelThen(() => onStartAssociation?.(nodeId))}
          />
          {!isRoot && (
            <PanelRow
              icon={<MagnifyingGlassPlus size={18} />}
              label={t('outline.enterFocusMode')}
              onClick={closePanelThen(() => onFocusBranch?.(nodeId))}
            />
          )}
          <PanelRow
            icon={node.completed ? <Circle size={18} /> : <CheckCircle size={18} />}
            label={node.completed ? t('contextMenu.unmarkComplete') : t('contextMenu.markComplete')}
            active={node.completed}
            onClick={closePanelThen(() => updateNode(nodeId, { completed: !node.completed }))}
          />
          {hasChildren && (
            <PanelRow
              icon={isCollapsed ? <CaretRight size={18} /> : <CaretDown size={18} />}
              label={isCollapsed ? t('actions.expand') : t('actions.collapse')}
              onClick={closePanelThen(() => toggleCollapse(nodeId))}
            />
          )}
          <PanelRow
            icon={<Copy size={18} />}
            label={t('contextMenu.copy')}
            onClick={closePanelThen(() => copyNodes([nodeId]))}
          />
          <PanelRow
            icon={<Scissors size={18} />}
            label={t('contextMenu.cut')}
            disabled={isRoot}
            onClick={closePanelThen(() => cutNodes([nodeId]))}
          />
          <PanelRow
            icon={<ClipboardText size={18} />}
            label={t('contextMenu.pasteAsChild')}
            disabled={!clipboard}
            onClick={closePanelThen(() => pasteNodes(nodeId))}
          />
        </div>
      )}

      {panel === 'style' && (
        <div className="mm-mobile-toolbar-panel">
          <div className="flex flex-wrap items-center gap-1 px-2 py-1.5">
            {[
              { key: 'bold', icon: TextB, prop: 'fontWeight' as const, val: 'bold', cur: node.style?.fontWeight },
              { key: 'italic', icon: TextItalic, prop: 'fontStyle' as const, val: 'italic', cur: node.style?.fontStyle },
              { key: 'underline', icon: TextUnderline, prop: 'textDecoration' as const, val: 'underline', cur: node.style?.textDecoration },
              { key: 'strikethrough', icon: TextStrikethrough, prop: 'textDecoration' as const, val: 'line-through', cur: node.style?.textDecoration },
            ].map(({ key, icon: Icon, prop, val, cur }) => (
              <NotionButton
                variant="ghost"
                key={key}
                className={cn('mm-mobile-format-btn', cur === val && 'is-active')}
                onClick={() =>
                  updateNode(nodeId, { style: { ...node.style, [prop]: cur === val ? undefined : val } })
                }
                title={t(`contextMenu.${key}`)}
                aria-pressed={cur === val}
              >
                <Icon size={18} />
              </NotionButton>
            ))}
            <div className="w-px h-5 bg-[var(--mm-border)] mx-1" />
            {([['h1', TextHOne], ['h2', TextHTwo], ['h3', TextHThree]] as const).map(([level, Icon]) => (
              <NotionButton
                variant="ghost"
                key={level}
                className={cn('mm-mobile-format-btn', node.style?.headingLevel === level && 'is-active')}
                onClick={() =>
                  updateNode(nodeId, {
                    style: {
                      ...node.style,
                      headingLevel: node.style?.headingLevel === level ? undefined : level,
                    },
                  })
                }
                title={t(`contextMenu.${level === 'h1' ? 'heading1' : level === 'h2' ? 'heading2' : 'heading3'}`)}
                aria-pressed={node.style?.headingLevel === level}
              >
                <Icon size={18} />
              </NotionButton>
            ))}
            <NotionButton
              variant="ghost"
              className={cn('mm-mobile-format-btn', !node.style?.headingLevel && 'is-active')}
              onClick={() => updateNode(nodeId, { style: { ...node.style, headingLevel: undefined } })}
              title={t('contextMenu.normalText')}
              aria-pressed={!node.style?.headingLevel}
            >
              <TextT size={18} />
            </NotionButton>
          </div>
          <div className="flex items-center gap-2 px-2 pt-1.5 pb-0.5 text-[13px] text-[var(--mm-text-muted)] select-none">
            <Palette size={16} className="flex-shrink-0" />
            <span>{t('contextMenu.textColor')}</span>
          </div>
          <ColorPalette
            colors={QUICK_TEXT_COLORS as unknown as string[]}
            activeColor={node.style?.textColor}
            onSelect={(color) => updateNode(nodeId, { style: { ...node.style, textColor: color } })}
          />
          <div className="flex items-center gap-2 px-2 pt-1.5 pb-0.5 text-[13px] text-[var(--mm-text-muted)] select-none">
            <Highlighter size={16} className="flex-shrink-0" />
            <span>{t('contextMenu.highlight')}</span>
          </div>
          <ColorPalette
            colors={QUICK_BG_COLORS as unknown as string[]}
            activeColor={node.style?.bgColor}
            onSelect={(color) => updateNode(nodeId, { style: { ...node.style, bgColor: color } })}
          />
        </div>
      )}

      <div className="mm-mobile-toolbar-row">
        <NotionButton variant="ghost" className="mm-mobile-toolbar-btn" onClick={handleAddChild}>
          <Plus size={18} />
          <span>{t('actions.addChild')}</span>
        </NotionButton>
        <NotionButton
          variant="ghost"
          className="mm-mobile-toolbar-btn"
          disabled={isRoot}
          onClick={handleAddSibling}
        >
          <PlusCircle size={18} />
          <span>{t('contextMenu.addSibling')}</span>
        </NotionButton>
        <NotionButton variant="ghost" className="mm-mobile-toolbar-btn" onClick={handleEdit}>
          <Pencil size={18} />
          <span>{t('contextMenu.edit')}</span>
        </NotionButton>
        <NotionButton
          variant="ghost"
          className={cn('mm-mobile-toolbar-btn', panel === 'style' && 'is-active')}
          onClick={() => onPanelChange(panel === 'style' ? null : 'style')}
          aria-expanded={panel === 'style'}
        >
          <Palette size={18} />
          <span>{t('toolbar.style')}</span>
        </NotionButton>
        <NotionButton
          variant="ghost"
          className="mm-mobile-toolbar-btn destructive"
          disabled={isRoot}
          onClick={handleDelete}
        >
          <Trash size={18} />
          <span>{t('actions.delete')}</span>
        </NotionButton>
        <NotionButton
          variant="ghost"
          className={cn('mm-mobile-toolbar-btn', panel === 'more' && 'is-active')}
          onClick={() => onPanelChange(panel === 'more' ? null : 'more')}
          aria-expanded={panel === 'more'}
        >
          <DotsThree size={18} />
          <span>{t('node.moreActions')}</span>
        </NotionButton>
      </div>
    </div>
  );
};
