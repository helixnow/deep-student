import React, { useEffect, useLayoutEffect, useRef, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { Z_INDEX } from '@/config/zIndex';
import {
  Plus,
  Pencil,
  CheckCircle,
  Circle,
  TextB,
  TextItalic,
  TextUnderline,
  TextStrikethrough,
  TextHOne,
  TextHTwo,
  TextHThree,
  TextT,
  Smiley,
  Link,
  LineSegment,
  Palette,
  Highlighter,
  CaretRight,
  CaretDown,
  Trash,
  Copy,
  Scissors,
  ClipboardText,
  MagnifyingGlassPlus,
  CornersOut,
  Note,
  X,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { useMindMapStore } from '../../store';
import { findNodeById, findParentNode } from '../../utils/node/find';
import { QUICK_TEXT_COLORS, QUICK_BG_COLORS } from '../../constants';
import { EmojiPicker } from '../shared/EmojiPicker';

interface CanvasContextMenuProps {
  isOpen: boolean;
  position: { x: number; y: number };
  nodeId: string | null;
  /** 右键关联线时传入；与 nodeId 互斥 */
  associationId?: string | null;
  /** 画布空白处右键：与 nodeId / associationId 互斥 */
  paneMenu?: boolean;
  onClose: () => void;
  onOpenResourcePicker?: (nodeId: string) => void;
  onFocusBranch?: (nodeId: string) => void;
  /** 进入「添加关联线」连线模式 */
  onStartAssociation?: (nodeId: string) => void;
  onEditAssociationLabel?: (associationId: string) => void;
  onDeleteAssociation?: (associationId: string) => void;
  /** 画布空白菜单：适应视图 */
  onFitView?: () => void;
  /** 画布空白菜单：当前处于分支专注模式时提供退出入口 */
  onExitFocusMode?: (() => void) | null;
}

/** 菜单外壳：对齐 AppMenu 的 --menu-shell-* 语言（与全局下拉/右键菜单同族） */
const MENU_SHELL_CLASS = cn(
  'mindmap-container fixed min-w-[200px] max-w-[248px]',
  'max-h-[calc(100vh-16px)] overflow-y-auto overscroll-contain',
  'p-[var(--menu-shell-padding)] rounded-[var(--menu-shell-radius)]',
  'border border-[var(--menu-shell-border)] bg-[var(--menu-shell-surface)]',
  'text-[var(--menu-shell-foreground)] shadow-[var(--menu-shell-shadow)]',
  '[backdrop-filter:var(--menu-shell-backdrop-filter)]',
  'ui-zoom-fade-in outline-none',
);

/** 键盘导航可达的菜单项标记（MenuItem / 格式按钮 / 色板都会带上） */
const MENU_ITEM_ATTR = 'data-mm-menuitem';

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
    role="menuitem"
    {...{ [MENU_ITEM_ATTR]: '' }}
    className={cn(
      'flex items-center gap-2 w-full px-2.5 py-1.5 rounded-[var(--menu-shell-row-radius)] text-[13px] text-left transition-colors',
      '[@media(pointer:coarse)]:min-h-[40px]',
      'focus-visible:outline-none focus-visible:bg-[var(--menu-shell-row-hover)]',
      destructive
        ? 'text-destructive hover:bg-destructive/10 focus-visible:bg-destructive/10'
        : active
          ? 'text-primary font-medium hover:bg-[var(--menu-shell-row-hover)]'
          : 'text-[var(--menu-shell-foreground)] hover:bg-[var(--menu-shell-row-hover)]',
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
  <div className="h-px bg-[var(--menu-shell-border)] my-1 mx-2" />
);

/** 内联颜色选择面板 */
export const ColorPalette: React.FC<{
  colors: string[];
  activeColor?: string;
  onSelect: (color: string | undefined) => void;
}> = ({ colors, activeColor, onSelect }) => {
  const { t } = useTranslation('mindmap');
  return (
    <div className="flex flex-wrap items-center gap-1 px-2 py-1.5">
      {colors.map(color => {
        const selected = activeColor === color;
        const label = t('contextMenu.selectColor', {
          defaultValue: '选择颜色 {{color}}',
          color,
        });
        return (
          <NotionButton
            key={color}
            variant="ghost" size="icon" iconOnly
            {...{ [MENU_ITEM_ATTR]: '' }}
            className={cn(
              '!w-[18px] !h-[18px] !min-w-0 !p-0 !rounded-full border-2 hover:scale-125 flex-shrink-0',
              'motion-reduce:hover:scale-100',
              '[@media(pointer:coarse)]:!w-6 [@media(pointer:coarse)]:!h-6',
              selected ? 'border-primary scale-110' : 'border-transparent',
            )}
            style={{ backgroundColor: color }}
            onClick={(e) => { e.stopPropagation(); onSelect(color); }}
            aria-label={label}
            aria-pressed={selected}
            title={label}
          />
        );
      })}
      <NotionButton variant="ghost" size="icon" iconOnly {...{ [MENU_ITEM_ATTR]: '' }} className="!w-[18px] !h-[18px] !min-w-0 !p-0 !rounded-full [@media(pointer:coarse)]:!w-6 [@media(pointer:coarse)]:!h-6 border border-[var(--menu-shell-border)] text-muted-foreground hover:bg-[var(--menu-shell-row-hover)] flex-shrink-0" onClick={(e) => { e.stopPropagation(); onSelect(undefined); }} aria-label={t('contextMenu.clearColor', { defaultValue: '清除颜色' })}>
        <X className="w-2.5 h-2.5" />
      </NotionButton>
    </div>
  );
};

export const CanvasContextMenu: React.FC<CanvasContextMenuProps> = ({
  isOpen,
  position,
  nodeId,
  associationId = null,
  paneMenu = false,
  onClose,
  onOpenResourcePicker,
  onFocusBranch,
  onStartAssociation,
  onEditAssociationLabel,
  onDeleteAssociation,
  onFitView,
  onExitFocusMode,
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
  const expandAll = useMindMapStore(s => s.expandAll);
  const collapseAll = useMindMapStore(s => s.collapseAll);

  /** 「添加图标」内联展开的 emoji 面板 */
  const [showIconPanel, setShowIconPanel] = useState(false);
  /** 钳位后的最终坐标；null = 尚未测量（隐藏渲染，避免越界闪跳） */
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null);

  const isAssociationMenu = !!associationId && !nodeId;
  const association = associationId
    ? document.associations?.find((a) => a.id === associationId) ?? null
    : null;

  const node = nodeId ? findNodeById(document.root, nodeId) : null;
  const isRoot = nodeId === document.root.id;
  const hasChildren = node ? node.children.length > 0 : false;
  const isCollapsed = node?.collapsed ?? false;

  /**
   * 执行菜单动作。格式类操作（颜色/加粗/标题等）传 keepOpen 保持菜单打开，
   * 支持连续调整；动作类（删除/新建等）默认关闭。
   */
  const exec = useCallback((action: () => void, opts?: { keepOpen?: boolean }) => {
    action();
    if (!opts?.keepOpen) onClose();
  }, [onClose]);

  // 打开/切换目标时收起 emoji 面板
  useEffect(() => {
    setShowIconPanel(false);
  }, [isOpen, nodeId]);

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
    // 菜单内部滚动（如 emoji 面板）不应触发关闭
    const handleScroll = (e: Event) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return;
      onClose();
    };

    window.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('keydown', handleEscape);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      window.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('keydown', handleEscape);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [isOpen, onClose]);

  // 打开时把焦点移入菜单容器（方向键立即可用），关闭时归还原焦点
  useEffect(() => {
    if (!isOpen) return;
    const prevActive = window.document.activeElement;
    const frame = requestAnimationFrame(() => menuRef.current?.focus({ preventScroll: true }));
    return () => {
      cancelAnimationFrame(frame);
      const active = window.document.activeElement;
      // 只有焦点仍属于菜单（或已丢到 body）时才归还，避免抢走动作设置的编辑焦点
      const focusIsOurs = active === window.document.body || (menuRef.current?.contains(active) ?? false);
      if (focusIsOurs && prevActive instanceof HTMLElement && prevActive.isConnected) {
        prevActive.focus({ preventScroll: true });
      }
    };
  }, [isOpen]);

  // 越界钳位：渲染后同步测量，定位完成前保持不可见，避免第一帧闪跳
  useLayoutEffect(() => {
    if (!isOpen) {
      setCoords(null);
      return;
    }
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let x = position.x;
    let y = position.y;
    if (x + rect.width > vw - 8) x = vw - rect.width - 8;
    if (y + rect.height > vh - 8) y = vh - rect.height - 8;
    if (x < 8) x = 8;
    if (y < 8) y = 8;
    setCoords(prev => (prev?.left === x && prev.top === y ? prev : { left: x, top: y }));
  }, [isOpen, position, showIconPanel]);

  /** 方向键 / Home / End 在菜单项间移动焦点（roving focus） */
  const handleMenuKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const menu = menuRef.current;
    if (!menu) return;
    const items = Array.from(
      menu.querySelectorAll<HTMLElement>(`[${MENU_ITEM_ATTR}]:not(:disabled)`),
    );
    if (items.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    const current = items.indexOf(window.document.activeElement as HTMLElement);
    let next: number;
    if (e.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % items.length;
    else if (e.key === 'ArrowUp') next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else next = items.length - 1;
    items[next]?.focus({ preventScroll: true });
  }, []);

  const menuStyle: React.CSSProperties = {
    position: 'fixed',
    left: coords?.left ?? position.x,
    top: coords?.top ?? position.y,
    zIndex: Z_INDEX.contextMenu,
    visibility: coords ? 'visible' : 'hidden',
  };

  if (!isOpen) return null;

  if (isAssociationMenu && association) {
    return createPortal(
      <div
        ref={menuRef}
        role="menu"
        tabIndex={-1}
        aria-label={t('association.menuLabel', { defaultValue: '关联线菜单' })}
        className={MENU_SHELL_CLASS}
        style={menuStyle}
        onKeyDown={handleMenuKeyDown}
      >
        <MenuItem
          icon={<Pencil className="w-4 h-4" />}
          label={t('association.editLabel', { defaultValue: '编辑标签' })}
          onClick={() => exec(() => onEditAssociationLabel?.(association.id))}
        />
        <MenuSeparator />
        <MenuItem
          icon={<Trash className="w-4 h-4" />}
          label={t('association.delete', { defaultValue: '删除关联线' })}
          shortcut="Del"
          destructive
          onClick={() => exec(() => onDeleteAssociation?.(association.id))}
        />
      </div>,
      window.document.body,
    );
  }

  // 画布空白处右键菜单：新建主题 / 粘贴 / 适应视图 / 全部展开折叠
  if (paneMenu && !nodeId && !associationId) {
    return createPortal(
      <div
        ref={menuRef}
        role="menu"
        tabIndex={-1}
        aria-label={t('contextMenu.paneMenuLabel', { defaultValue: '画布菜单' })}
        className={MENU_SHELL_CLASS}
        style={menuStyle}
        onKeyDown={handleMenuKeyDown}
      >
        <MenuItem
          icon={<Plus className="w-4 h-4" />}
          label={t('contextMenu.addTopic', { defaultValue: '新建主题' })}
          onClick={() => exec(() => {
            const newId = addNode(document.root.id);
            if (newId) {
              setFocusedNodeId(newId);
              requestAnimationFrame(() => setEditingNodeId(newId));
            }
          })}
        />
        <MenuItem
          icon={<ClipboardText className="w-4 h-4" />}
          label={t('contextMenu.paste', { defaultValue: '粘贴' })}
          shortcut="⌘V"
          disabled={!clipboard}
          onClick={() => exec(() => pasteNodes(document.root.id))}
        />
        <MenuSeparator />
        <MenuItem
          icon={<CornersOut className="w-4 h-4" />}
          label={t('contextMenu.fitView', { defaultValue: '适应视图' })}
          shortcut="⌘0"
          onClick={() => exec(() => onFitView?.())}
        />
        {onExitFocusMode && (
          <MenuItem
            icon={<MagnifyingGlassPlus className="w-4 h-4" />}
            label={t('contextMenu.exitFocusMode', { defaultValue: '退出专注模式' })}
            onClick={() => exec(() => onExitFocusMode())}
          />
        )}
        <MenuSeparator />
        <MenuItem
          icon={<CaretDown className="w-4 h-4" />}
          label={t('toolbar.expandAll', { defaultValue: '展开全部' })}
          onClick={() => exec(() => expandAll())}
        />
        <MenuItem
          icon={<CaretRight className="w-4 h-4" />}
          label={t('toolbar.collapseAll', { defaultValue: '折叠全部' })}
          onClick={() => exec(() => collapseAll())}
        />
      </div>,
      window.document.body,
    );
  }

  if (!nodeId || !node) return null;

  /** 格式类快捷按钮（加粗/标题等）：保持菜单打开，可连续操作 */
  const formatBtnClass = (activeState: boolean) => cn(
    'w-7 h-7 [@media(pointer:coarse)]:w-9 [@media(pointer:coarse)]:h-9 flex items-center justify-center rounded-[var(--menu-shell-row-radius)]',
    'hover:bg-[var(--menu-shell-row-hover)] focus-visible:outline-none focus-visible:bg-[var(--menu-shell-row-hover)]',
    activeState && 'bg-[var(--menu-shell-row-active)] text-primary',
  );

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      tabIndex={-1}
      aria-label={t('contextMenu.nodeMenuLabel', { defaultValue: '节点菜单' })}
      className={MENU_SHELL_CLASS}
      style={menuStyle}
      onKeyDown={handleMenuKeyDown}
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
        icon={<Note className="w-4 h-4" />}
        label={node.note ? t('contextMenu.editNote') : t('contextMenu.addNote')}
        shortcut="⇧Enter"
        onClick={() => exec(() => {
          setEditingNoteNodeId(nodeId);
        })}
      />

      <MenuItem
        icon={<Link className="w-4 h-4" />}
        label={t('contextMenu.linkResource')}
        onClick={() => exec(() => {
          if (nodeId) onOpenResourcePicker?.(nodeId);
        })}
      />

      <MenuItem
        icon={<LineSegment className="w-4 h-4" />}
        label={t('association.add', { defaultValue: '添加关联线' })}
        onClick={() => exec(() => {
          if (nodeId) onStartAssociation?.(nodeId);
        })}
      />

      {!isRoot && (
        <MenuItem
          icon={<MagnifyingGlassPlus className="w-4 h-4" />}
          label={t('outline.enterFocusMode')}
          onClick={() => exec(() => {
            if (nodeId) onFocusBranch?.(nodeId);
          })}
        />
      )}

      <MenuSeparator />

      <MenuItem
        icon={node.completed
          ? <Circle className="w-4 h-4" />
          : <CheckCircle className="w-4 h-4" />}
        label={node.completed ? t('contextMenu.unmarkComplete') : t('contextMenu.markComplete')}
        active={node.completed}
        onClick={() => exec(() => updateNode(nodeId, { completed: !node.completed }), { keepOpen: true })}
      />
      {/* 添加图标：内联展开 emoji 面板（不再另开弹层） */}
      <MenuItem
        icon={node.style?.icon
          ? <span className="text-sm leading-none">{node.style.icon}</span>
          : <Smiley className="w-4 h-4" />}
        label={t('contextMenu.addIcon', { defaultValue: '添加图标' })}
        onClick={() => setShowIconPanel(v => !v)}
      />
      {showIconPanel && (
        <EmojiPicker
          value={node.style?.icon}
          onChange={(emoji) => exec(
            () => updateNode(nodeId, { style: { ...node.style, icon: emoji } }),
            { keepOpen: true },
          )}
          onClose={() => setShowIconPanel(false)}
          className="!w-full !border-0 !bg-transparent !shadow-none !rounded-none px-1.5 pb-1"
        />
      )}
      {/* B / I / U / S | H1 / H2 / H3 / T */}
      <div className="flex flex-wrap items-center gap-1 px-2 py-1" role="group" aria-label={t('contextMenu.textStyleGroup', { defaultValue: '文本样式' })}>
        {[
          { key: 'bold', icon: TextB, prop: 'fontWeight' as const, val: 'bold', cur: node.style?.fontWeight },
          { key: 'italic', icon: TextItalic, prop: 'fontStyle' as const, val: 'italic', cur: node.style?.fontStyle },
          { key: 'underline', icon: TextUnderline, prop: 'textDecoration' as const, val: 'underline', cur: node.style?.textDecoration },
          { key: 'strikethrough', icon: TextStrikethrough, prop: 'textDecoration' as const, val: 'line-through', cur: node.style?.textDecoration },
        ].map(({ key, icon: Icon, prop, val, cur }) => (
          <NotionButton variant="ghost" key={key}
            {...{ [MENU_ITEM_ATTR]: '' }}
            className={formatBtnClass(cur === val)}
            onClick={() => exec(() => updateNode(nodeId, { style: { ...node.style, [prop]: cur === val ? undefined : val } }), { keepOpen: true })}
            aria-pressed={cur === val}
            title={t(`contextMenu.${key}`)}
          ><Icon className="w-4 h-4" /></NotionButton>
        ))}
        <div className="w-px h-4 bg-[var(--menu-shell-border)] mx-0.5" />
        {([['h1', TextHOne], ['h2', TextHTwo], ['h3', TextHThree]] as const).map(([level, Icon]) => (
          <NotionButton variant="ghost" key={level}
            {...{ [MENU_ITEM_ATTR]: '' }}
            className={formatBtnClass(node.style?.headingLevel === level)}
            onClick={() => exec(() => updateNode(nodeId, { style: { ...node.style, headingLevel: node.style?.headingLevel === level ? undefined : level } }), { keepOpen: true })}
            aria-pressed={node.style?.headingLevel === level}
            title={t(`contextMenu.${level === 'h1' ? 'heading1' : level === 'h2' ? 'heading2' : 'heading3'}`)}
          ><Icon className="w-4 h-4" /></NotionButton>
        ))}
        <NotionButton variant="ghost"
          {...{ [MENU_ITEM_ATTR]: '' }}
          className={formatBtnClass(!node.style?.headingLevel)}
          onClick={() => exec(() => updateNode(nodeId, { style: { ...node.style, headingLevel: undefined } }), { keepOpen: true })}
          aria-pressed={!node.style?.headingLevel}
          title={t('contextMenu.normalText')}
        ><TextT className="w-4 h-4" /></NotionButton>
      </div>
      <div className="flex items-center gap-2 px-2 pt-1.5 pb-0.5 text-[13px] text-muted-foreground select-none">
        <Palette className="w-4 h-4 flex-shrink-0" />
        <span>{t('contextMenu.textColor')}</span>
      </div>
      <ColorPalette
        colors={QUICK_TEXT_COLORS as unknown as string[]}
        activeColor={node.style?.textColor}
        onSelect={(color) => exec(() => updateNode(nodeId, {
          style: { ...node.style, textColor: color },
        }), { keepOpen: true })}
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
        }), { keepOpen: true })}
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
        icon={<ClipboardText className="w-4 h-4" />}
        label={t('contextMenu.pasteAsChild')}
        shortcut="⌘V"
        disabled={!clipboard}
        onClick={() => exec(() => pasteNodes(nodeId))}
      />

      <MenuSeparator />

      {hasChildren && (
        <MenuItem
          icon={isCollapsed
            ? <CaretRight className="w-4 h-4" />
            : <CaretDown className="w-4 h-4" />}
          label={isCollapsed ? t('actions.expand') : t('actions.collapse')}
          shortcut={isCollapsed ? '⌘]' : '⌘['}
          onClick={() => exec(() => toggleCollapse(nodeId))}
        />
      )}

      {!isRoot && (
        <>
          {hasChildren && <MenuSeparator />}
          <MenuItem
            icon={<Trash className="w-4 h-4" />}
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
