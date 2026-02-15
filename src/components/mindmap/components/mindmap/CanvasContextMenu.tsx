import React, { useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { Z_INDEX } from '@/config/zIndex';
import {
  Plus,
  Pencil,
  CheckCircle2,
  Circle,
  Bold,
  Palette,
  Highlighter,
  ChevronRight,
  ChevronDown,
  Trash2,
  Copy,
  Scissors,
  ClipboardPaste,
  StickyNote,
  X,
  Link2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { useMindMapStore } from '../../store';
import { findNodeById, findParentNode } from '../../utils/node/find';
import { QUICK_TEXT_COLORS, QUICK_BG_COLORS } from '../../constants';

interface CanvasContextMenuProps {
  isOpen: boolean;
  position: { x: number; y: number };
  nodeId: string | null;
  onClose: () => void;
  onOpenResourcePicker?: (nodeId: string) => void;
}

interface MenuItemProps {
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  destructive?: boolean;
  disabled?: boolean;
  active?: boolean;
  onClick: () => void;
}

const MenuItem: React.FC<MenuItemProps> = ({ icon, label, shortcut, destructive, disabled, active, onClick }) => (
  <NotionButton variant="ghost"
    className={cn(
      'flex items-center gap-2 w-full px-2 py-1.5 rounded text-[13px] text-left transition-colors',
      destructive
        ? 'text-destructive hover:bg-destructive/10'
        : active
          ? 'text-primary font-medium hover:bg-accent'
          : 'text-foreground hover:bg-accent',
      disabled && 'opacity-40 pointer-events-none'
    )}
    onClick={onClick}
    disabled={disabled}
  >
    <span className="w-4 h-4 flex-shrink-0 flex items-center justify-center">{icon}</span>
    <span className="flex-1">{label}</span>
    {active && (
      <span className="text-primary text-xs mr-1">✓</span>
    )}
    {shortcut && (
      <span className="text-[11px] text-muted-foreground ml-auto pl-2 flex-shrink-0">{shortcut}</span>
    )}
  </NotionButton>
);

const MenuSeparator: React.FC = () => (
  <div className="h-px bg-border my-1" />
);

/** 内联颜色选择面板 */
const ColorPalette: React.FC<{
  colors: string[];
  activeColor?: string;
  onSelect: (color: string | undefined) => void;
}> = ({ colors, activeColor, onSelect }) => (
  <div className="flex items-center gap-1 px-2 py-1.5">
    {colors.map(color => (
      <NotionButton
        key={color}
        variant="ghost" size="icon" iconOnly
        className={cn(
          "!w-[18px] !h-[18px] !min-w-0 !p-0 !rounded-full border-2 hover:scale-125 flex-shrink-0",
          activeColor === color ? "border-primary scale-110" : "border-transparent"
        )}
        style={{ backgroundColor: color }}
        onClick={(e) => { e.stopPropagation(); onSelect(color); }}
      />
    ))}
    <NotionButton variant="ghost" size="icon" iconOnly className="!w-[18px] !h-[18px] !min-w-0 !p-0 !rounded-full border border-border text-muted-foreground hover:bg-accent flex-shrink-0" onClick={(e) => { e.stopPropagation(); onSelect(undefined); }} aria-label="clear color">
      <X className="w-2.5 h-2.5" />
    </NotionButton>
  </div>
);

export const CanvasContextMenu: React.FC<CanvasContextMenuProps> = ({
  isOpen,
  position,
  nodeId,
  onClose,
  onOpenResourcePicker,
}) => {
  const { t } = useTranslation('mindmap');
  const menuRef = useRef<HTMLDivElement>(null);
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

  const node = nodeId ? findNodeById(document.root, nodeId) : null;
  const isRoot = nodeId === document.root.id;
  const hasChildren = node ? node.children.length > 0 : false;
  const isCollapsed = node?.collapsed ?? false;

  const exec = useCallback((action: () => void) => {
    action();
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as HTMLElement)) {
        onClose();
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const handleScroll = () => onClose();

    window.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('keydown', handleEscape);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      window.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('keydown', handleEscape);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen || !menuRef.current) return;
    const menu = menuRef.current;
    const rect = menu.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let x = position.x;
    let y = position.y;
    if (x + rect.width > vw - 8) x = vw - rect.width - 8;
    if (y + rect.height > vh - 8) y = vh - rect.height - 8;
    if (x < 8) x = 8;
    if (y < 8) y = 8;

    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
  }, [isOpen, position]);

  if (!isOpen || !nodeId || !node) return null;

  return createPortal(
    <div
      ref={menuRef}
      className="fixed min-w-[180px] max-w-[240px] p-1 rounded-lg border border-border bg-popover shadow-lg animate-in fade-in-0 zoom-in-95 duration-100"
      style={{ left: position.x, top: position.y, zIndex: Z_INDEX.contextMenu }}
    >
      <MenuItem
        icon={<Plus className="w-4 h-4" />}
        label={t('actions.addChild')}
        shortcut="Tab"
        onClick={() => exec(() => {
          const newId = addNode(nodeId, 0);
          if (newId) {
            setFocusedNodeId(newId);
            requestAnimationFrame(() => setEditingNodeId(newId));
          }
        })}
      />
      {!isRoot && (
        <MenuItem
          icon={<Plus className="w-4 h-4" />}
          label={t('contextMenu.addSibling')}
          shortcut="Enter"
          onClick={() => exec(() => {
            const parent = findParentNode(document.root, nodeId);
            if (parent) {
              const idx = parent.children.findIndex(c => c.id === nodeId);
              const newId = addNode(parent.id, idx + 1);
              if (newId) {
                setFocusedNodeId(newId);
                requestAnimationFrame(() => setEditingNodeId(newId));
              }
            }
          })}
        />
      )}
      <MenuItem
        icon={<Pencil className="w-4 h-4" />}
        label={t('contextMenu.edit')}
        shortcut="F2"
        onClick={() => exec(() => setEditingNodeId(nodeId))}
      />
      <MenuItem
        icon={<StickyNote className="w-4 h-4" />}
        label={node.note ? t('contextMenu.editNote') : t('contextMenu.addNote')}
        shortcut="⇧Enter"
        onClick={() => exec(() => {
          setEditingNoteNodeId(nodeId);
        })}
      />

      <MenuItem
        icon={<Link2 className="w-4 h-4" />}
        label={t('contextMenu.linkResource', '关联资源')}
        onClick={() => exec(() => {
          if (nodeId) onOpenResourcePicker?.(nodeId);
        })}
      />

      <MenuSeparator />

      <MenuItem
        icon={node.completed
          ? <Circle className="w-4 h-4" />
          : <CheckCircle2 className="w-4 h-4" />}
        label={node.completed ? t('contextMenu.unmarkComplete') : t('contextMenu.markComplete')}
        active={node.completed}
        onClick={() => exec(() => updateNode(nodeId, { completed: !node.completed }))}
      />
      <MenuItem
        icon={<Bold className="w-4 h-4" />}
        label={t('contextMenu.bold')}
        shortcut="⌘B"
        active={node.style?.fontWeight === 'bold'}
        onClick={() => exec(() => updateNode(nodeId, {
          style: {
            ...node.style,
            fontWeight: node.style?.fontWeight === 'bold' ? undefined : 'bold',
          },
        }))}
      />
      <div className="flex items-center gap-2 px-2 pt-1.5 pb-0.5 text-[13px] text-muted-foreground select-none">
        <Palette className="w-4 h-4 flex-shrink-0" />
        <span>{t('contextMenu.textColor')}</span>
      </div>
      <ColorPalette
        colors={QUICK_TEXT_COLORS as unknown as string[]}
        activeColor={node.style?.textColor}
        onSelect={(color) => exec(() => updateNode(nodeId, {
          style: { ...node.style, textColor: color },
        }))}
      />
      <div className="flex items-center gap-2 px-2 pt-1.5 pb-0.5 text-[13px] text-muted-foreground select-none">
        <Highlighter className="w-4 h-4 flex-shrink-0" />
        <span>{t('contextMenu.highlight')}</span>
      </div>
      <ColorPalette
        colors={QUICK_BG_COLORS as unknown as string[]}
        activeColor={node.style?.bgColor}
        onSelect={(color) => exec(() => updateNode(nodeId, {
          style: { ...node.style, bgColor: color },
        }))}
      />

      <MenuSeparator />

      <MenuItem
        icon={<Copy className="w-4 h-4" />}
        label={t('contextMenu.copy')}
        shortcut="⌘C"
        onClick={() => exec(() => copyNodes([nodeId]))}
      />
      <MenuItem
        icon={<Scissors className="w-4 h-4" />}
        label={t('contextMenu.cut')}
        shortcut="⌘X"
        disabled={isRoot}
        onClick={() => exec(() => cutNodes([nodeId]))}
      />
      <MenuItem
        icon={<ClipboardPaste className="w-4 h-4" />}
        label={t('contextMenu.pasteAsChild')}
        shortcut="⌘V"
        disabled={!clipboard}
        onClick={() => exec(() => pasteNodes(nodeId))}
      />

      <MenuSeparator />

      {hasChildren && (
        <MenuItem
          icon={isCollapsed
            ? <ChevronRight className="w-4 h-4" />
            : <ChevronDown className="w-4 h-4" />}
          label={isCollapsed ? t('actions.expand') : t('actions.collapse')}
          shortcut={isCollapsed ? '⌘]' : '⌘['}
          onClick={() => exec(() => toggleCollapse(nodeId))}
        />
      )}

      {!isRoot && (
        <>
          {hasChildren && <MenuSeparator />}
          <MenuItem
            icon={<Trash2 className="w-4 h-4" />}
            label={t('actions.delete')}
            shortcut="Del"
            destructive
            onClick={() => exec(() => deleteNode(nodeId))}
          />
        </>
      )}
    </div>,
    window.document.body
  );
};
