/**
 * 移动端笔记编辑器底部工具条（自包含，由宿主注入 commands）。
 * 固定于 visualViewport 底部，键盘弹出时贴键盘上沿。
 *
 * 信息架构（对齐 Notion / Bear 移动端）：
 * - 一级：「+」块插入 | 撤销重做 | B/I/S | 标题 | 列表 | 缩进
 * - 「+」展开内联块插入条：图片/有序列表/引用/链接/代码块/表格/块菜单
 *
 * 键盘遮挡高度通过 :root CSS 变量共享给编辑器（正文 padding、浮层 max-height）：
 * - --mobile-toolbar-keyboard-offset：键盘占用高度（px）
 * - --mobile-toolbar-height：工具条自身高度（px，含展开的插入条）
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  Plus,
  TextIndent,
  TextOutdent,
  TextB,
  TextItalic,
  TextStrikethrough,
  TextHOne,
  TextHTwo,
  TextHThree,
  List,
  ListNumbers,
  CheckSquare,
  Image,
  Quotes,
  LinkSimple,
  FileCode,
  Table,
  DotsThreeOutline,
  MagnifyingGlass,
  ArrowCounterClockwise,
  ArrowClockwise,
} from '@phosphor-icons/react';

import './MobileEditorToolbar.css';

/** 全部命令由宿主回调注入，不直接依赖编辑器实例 */
export type MobileEditorToolbarCommands = {
  toggleBold: () => void;
  toggleItalic: () => void;
  /** 可选：宿主未接线时按钮仍展示，点击为 no-op */
  toggleStrikethrough?: () => void;
  insertHeading: (level: 1 | 2 | 3) => void;
  toggleBulletList: () => void;
  toggleTaskList: () => void;
  indent: () => void;
  outdent: () => void;
  /** 一步完成的图片插入（Tauri 选图 → 上传 → 插入 URL） */
  insertImage: () => void;
  openSlash: () => void;
  undo: () => void;
  redo: () => void;
  /** 内联块插入条命令（可选，未注入时按钮不渲染） */
  toggleOrderedList?: () => void;
  toggleBlockquote?: () => void;
  insertLink?: () => void;
  insertCodeBlock?: () => void;
  insertTable?: () => void;
  /**
   * 可选：打开编辑器内查找替换面板。宿主（NotesCrepeEditor）用
   * setIsFindReplaceOpen(true) 等现有开面板机制接线；未注入时按钮不渲染。
   */
  openFind?: () => void;
};

/** 可选激活态；宿主可按选区 marks/节点透传，未传则不亮 */
export type MobileEditorToolbarActiveStates = {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  h1?: boolean;
  h2?: boolean;
  h3?: boolean;
  bullet?: boolean;
  task?: boolean;
};

export type MobileEditorToolbarProps = {
  commands: MobileEditorToolbarCommands;
  /** 受控可见性；false 时不渲染 */
  visible: boolean;
  /**
   * 滚动收起态：下滑阅读时滑出屏幕（保留 DOM，避免反复挂载）。
   * 键盘弹出（visualViewport 遮挡 > 0）期间忽略，保证输入时工具条常驻。
   */
  collapsed?: boolean;
  /** 可选：行内/块格式激活态，透传为 data-active */
  activeStates?: MobileEditorToolbarActiveStates;
  className?: string;
};

type ToolbarItem = {
  id: string;
  labelKey: string;
  defaultLabel: string;
  icon: React.ReactNode;
  onAction: () => void;
};

type ToolbarGroup = {
  id: string;
  items: ToolbarItem[];
};

const ICON_SIZE = 20;
const ICON_WEIGHT = 'regular' as const;

const TOGGLEABLE_ACTIONS = new Set<string>([
  'bold',
  'italic',
  'strikethrough',
  'h1',
  'h2',
  'h3',
  'bullet',
  'task',
]);

function computeViewportBottomOffset(): number {
  if (typeof window === 'undefined') return 0;
  const vv = window.visualViewport;
  if (!vv) return 0;
  // 布局视口底边到 visualViewport 底边的距离（键盘占用高度）
  return Math.max(0, Math.round(window.innerHeight - (vv.offsetTop + vv.height)));
}

/** 阻止按压把焦点从编辑器抢走：iOS/Android 走 touch/pointer，桌面走 mouse */
const preventFocusSteal = (event: { preventDefault: () => void }) => {
  event.preventDefault();
};

export const MobileEditorToolbar: React.FC<MobileEditorToolbarProps> = ({
  commands,
  visible,
  collapsed = false,
  activeStates,
  className,
}) => {
  const { t } = useTranslation(['notes']);
  const [bottomOffset, setBottomOffset] = useState(0);
  const [insertOpen, setInsertOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const tr = useCallback(
    (key: string, defaultValue: string): string => {
      const result = t(key, { defaultValue });
      if (typeof result === 'string') return result;
      return key.split('.').at(-1) ?? defaultValue;
    },
    [t],
  );

  useEffect(() => {
    if (!visible) return;

    const update = () => {
      setBottomOffset(computeViewportBottomOffset());
    };

    update();

    const vv = window.visualViewport;
    if (!vv) return;

    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    window.addEventListener('resize', update);

    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [visible]);

  // 把键盘遮挡高度 / 工具条高度共享给编辑器（正文 padding、slash 浮层 max-height）
  useLayoutEffect(() => {
    if (!visible || typeof document === 'undefined') return;
    const rootStyle = document.documentElement.style;
    rootStyle.setProperty('--mobile-toolbar-keyboard-offset', `${bottomOffset}px`);
    rootStyle.setProperty('--mobile-toolbar-height', `${rootRef.current?.offsetHeight ?? 52}px`);
    return () => {
      rootStyle.removeProperty('--mobile-toolbar-keyboard-offset');
      rootStyle.removeProperty('--mobile-toolbar-height');
    };
  }, [visible, bottomOffset, insertOpen]);

  if (!visible) return null;

  // 一级分组：插入 | 撤销重做 | B/I/S | 标题 | 列表 | 缩进
  const groups: ToolbarGroup[] = [
    {
      id: 'history',
      items: [
        {
          id: 'undo',
          labelKey: 'notes:mobileToolbar.undo',
          defaultLabel: '撤销',
          icon: <ArrowCounterClockwise size={ICON_SIZE} weight={ICON_WEIGHT} aria-hidden />,
          onAction: commands.undo,
        },
        {
          id: 'redo',
          labelKey: 'notes:mobileToolbar.redo',
          defaultLabel: '重做',
          icon: <ArrowClockwise size={ICON_SIZE} weight={ICON_WEIGHT} aria-hidden />,
          onAction: commands.redo,
        },
      ],
    },
    {
      id: 'inline',
      items: [
        {
          id: 'bold',
          labelKey: 'notes:mobileToolbar.bold',
          defaultLabel: '粗体',
          icon: <TextB size={ICON_SIZE} weight={ICON_WEIGHT} aria-hidden />,
          onAction: commands.toggleBold,
        },
        {
          id: 'italic',
          labelKey: 'notes:mobileToolbar.italic',
          defaultLabel: '斜体',
          icon: <TextItalic size={ICON_SIZE} weight={ICON_WEIGHT} aria-hidden />,
          onAction: commands.toggleItalic,
        },
        {
          id: 'strikethrough',
          labelKey: 'notes:mobileToolbar.strikethrough',
          defaultLabel: '删除线',
          icon: <TextStrikethrough size={ICON_SIZE} weight={ICON_WEIGHT} aria-hidden />,
          onAction: () => commands.toggleStrikethrough?.(),
        },
      ],
    },
    {
      id: 'blocks',
      items: [
        {
          id: 'h1',
          labelKey: 'notes:mobileToolbar.heading1',
          defaultLabel: '一级标题',
          icon: <TextHOne size={ICON_SIZE} weight={ICON_WEIGHT} aria-hidden />,
          onAction: () => commands.insertHeading(1),
        },
        {
          id: 'h2',
          labelKey: 'notes:mobileToolbar.heading2',
          defaultLabel: '二级标题',
          icon: <TextHTwo size={ICON_SIZE} weight={ICON_WEIGHT} aria-hidden />,
          onAction: () => commands.insertHeading(2),
        },
        {
          id: 'h3',
          labelKey: 'notes:mobileToolbar.heading3',
          defaultLabel: '三级标题',
          icon: <TextHThree size={ICON_SIZE} weight={ICON_WEIGHT} aria-hidden />,
          onAction: () => commands.insertHeading(3),
        },
        {
          id: 'bullet',
          labelKey: 'notes:mobileToolbar.bulletList',
          defaultLabel: '无序列表',
          icon: <List size={ICON_SIZE} weight={ICON_WEIGHT} aria-hidden />,
          onAction: commands.toggleBulletList,
        },
        {
          id: 'task',
          labelKey: 'notes:mobileToolbar.taskList',
          defaultLabel: '任务列表',
          icon: <CheckSquare size={ICON_SIZE} weight={ICON_WEIGHT} aria-hidden />,
          onAction: commands.toggleTaskList,
        },
      ],
    },
    {
      id: 'indent',
      items: [
        {
          id: 'outdent',
          labelKey: 'notes:mobileToolbar.outdent',
          defaultLabel: '减少缩进',
          icon: <TextOutdent size={ICON_SIZE} weight={ICON_WEIGHT} aria-hidden />,
          onAction: commands.outdent,
        },
        {
          id: 'indent',
          labelKey: 'notes:mobileToolbar.indent',
          defaultLabel: '增加缩进',
          icon: <TextIndent size={ICON_SIZE} weight={ICON_WEIGHT} aria-hidden />,
          onAction: commands.indent,
        },
      ],
    },
    // 查找入口：仅在宿主接线 openFind 后展示（打开编辑器内查找替换面板）
    ...(commands.openFind
      ? [{
          id: 'tools',
          items: [
            {
              id: 'find',
              labelKey: 'notes:mobileToolbar.find',
              defaultLabel: '查找',
              icon: <MagnifyingGlass size={ICON_SIZE} weight={ICON_WEIGHT} aria-hidden />,
              onAction: () => commands.openFind?.(),
            },
          ],
        }]
      : []),
  ];

  // 内联块插入条（替代仅插 `/` 的旧交互；slash 菜单保留为兜底入口）
  const insertItems: ToolbarItem[] = [
    {
      id: 'image',
      labelKey: 'notes:mobileToolbar.image',
      defaultLabel: '图片',
      icon: <Image size={ICON_SIZE} weight={ICON_WEIGHT} aria-hidden />,
      onAction: commands.insertImage,
    },
    ...(commands.toggleOrderedList
      ? [{
          id: 'ordered',
          labelKey: 'notes:mobileToolbar.orderedList',
          defaultLabel: '有序列表',
          icon: <ListNumbers size={ICON_SIZE} weight={ICON_WEIGHT} aria-hidden />,
          onAction: commands.toggleOrderedList,
        }]
      : []),
    ...(commands.toggleBlockquote
      ? [{
          id: 'quote',
          labelKey: 'notes:mobileToolbar.quote',
          defaultLabel: '引用',
          icon: <Quotes size={ICON_SIZE} weight={ICON_WEIGHT} aria-hidden />,
          onAction: commands.toggleBlockquote,
        }]
      : []),
    ...(commands.insertLink
      ? [{
          id: 'link',
          labelKey: 'notes:mobileToolbar.link',
          defaultLabel: '链接',
          icon: <LinkSimple size={ICON_SIZE} weight={ICON_WEIGHT} aria-hidden />,
          onAction: commands.insertLink,
        }]
      : []),
    ...(commands.insertCodeBlock
      ? [{
          id: 'codeblock',
          labelKey: 'notes:mobileToolbar.codeBlock',
          defaultLabel: '代码块',
          icon: <FileCode size={ICON_SIZE} weight={ICON_WEIGHT} aria-hidden />,
          onAction: commands.insertCodeBlock,
        }]
      : []),
    ...(commands.insertTable
      ? [{
          id: 'table',
          labelKey: 'notes:mobileToolbar.table',
          defaultLabel: '表格',
          icon: <Table size={ICON_SIZE} weight={ICON_WEIGHT} aria-hidden />,
          onAction: commands.insertTable,
        }]
      : []),
    {
      id: 'slash',
      labelKey: 'notes:mobileToolbar.slash',
      defaultLabel: '块菜单',
      icon: <DotsThreeOutline size={ICON_SIZE} weight={ICON_WEIGHT} aria-hidden />,
      onAction: commands.openSlash,
    },
  ];

  const toolbarLabel = tr('notes:mobileToolbar.label', '移动端编辑工具条');
  const insertLabel = tr('notes:mobileToolbar.insert', '插入');

  const renderButton = (item: ToolbarItem, extraProps?: React.ButtonHTMLAttributes<HTMLButtonElement>) => {
    const label = tr(item.labelKey, item.defaultLabel);
    const isToggleable = TOGGLEABLE_ACTIONS.has(item.id);
    const isActive = Boolean(
      isToggleable &&
        activeStates?.[item.id as keyof MobileEditorToolbarActiveStates],
    );
    return (
      <button
        key={item.id}
        type="button"
        className="mobile-editor-toolbar__btn"
        aria-label={label}
        aria-pressed={isToggleable ? isActive : undefined}
        data-action={item.id}
        data-active={isActive ? 'true' : undefined}
        // 避免点按钮抢走编辑器焦点（P0-1：触屏走 pointer/touch，不触发 mousedown）
        onMouseDown={preventFocusSteal}
        onPointerDown={preventFocusSteal}
        onClick={item.onAction}
        {...extraProps}
      >
        {item.icon}
      </button>
    );
  };

  // Portal 到 body：宿主位于 MobileSlidingLayout 带 transform 的滑动轨道内，
  // transform 会让 position:fixed 相对轨道而非视口定位，导致工具条随手势滑动错位。
  // 与 suggestOverlay.ts 的 body 挂载范式一致；不改 MobileSlidingLayout 的 transform 机制。
  if (typeof document === 'undefined') return null;

  // 键盘弹出期间忽略滚动收起（输入中需要常驻的格式化入口）
  const isCollapsed = collapsed && bottomOffset === 0;

  return createPortal(
    <div
      ref={rootRef}
      className={['mobile-editor-toolbar', className].filter(Boolean).join(' ')}
      role="toolbar"
      aria-label={toolbarLabel}
      data-testid="mobile-editor-toolbar"
      data-collapsed={isCollapsed ? 'true' : undefined}
      style={
        {
          '--mobile-toolbar-keyboard-offset': `${bottomOffset}px`,
        } as React.CSSProperties
      }
    >
      {insertOpen && (
        <div
          className="mobile-editor-toolbar__insert-row"
          role="group"
          aria-label={insertLabel}
          data-testid="mobile-editor-toolbar-insert-row"
        >
          {insertItems.map((item) => renderButton(item, {
            onClick: () => {
              item.onAction();
              setInsertOpen(false);
            },
          }))}
        </div>
      )}
      <div className="mobile-editor-toolbar__scroller" data-testid="mobile-editor-toolbar-scroller">
        <button
          type="button"
          className="mobile-editor-toolbar__btn"
          aria-label={insertLabel}
          aria-expanded={insertOpen}
          data-action="insert-toggle"
          data-active={insertOpen ? 'true' : undefined}
          onMouseDown={preventFocusSteal}
          onPointerDown={preventFocusSteal}
          onClick={() => setInsertOpen((open) => !open)}
        >
          <Plus size={ICON_SIZE} weight={ICON_WEIGHT} aria-hidden />
        </button>
        {groups.map((group) => (
          <React.Fragment key={group.id}>
            <span
              className="mobile-editor-toolbar__sep"
              role="separator"
              aria-hidden="true"
              data-testid="mobile-editor-toolbar-sep"
            />
            {group.items.map((item) => renderButton(item))}
          </React.Fragment>
        ))}
      </div>
    </div>,
    document.body,
  );
};

export default MobileEditorToolbar;

/** 供测试 / 接线代理复用的 bottom offset 计算 */
export { computeViewportBottomOffset };
