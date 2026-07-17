/**
 * 移动端笔记编辑器底部工具条（自包含，由宿主注入 commands）。
 * 固定于 visualViewport 底部，键盘弹出时贴键盘上沿。
 */

import React, { useCallback, useEffect, useState } from 'react';
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
  CheckSquare,
  Image,
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
  insertImage: () => void;
  openSlash: () => void;
  undo: () => void;
  redo: () => void;
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
  /** 可选：行内/块格式激活态，透传为 data-active */
  activeStates?: MobileEditorToolbarActiveStates;
  className?: string;
};

type ToolbarItem = {
  id: keyof MobileEditorToolbarActiveStates | 'undo' | 'redo' | 'outdent' | 'indent' | 'image' | 'slash';
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

export const MobileEditorToolbar: React.FC<MobileEditorToolbarProps> = ({
  commands,
  visible,
  activeStates,
  className,
}) => {
  const { t } = useTranslation(['notes']);
  const [bottomOffset, setBottomOffset] = useState(0);

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

  if (!visible) return null;

  // 分组：撤销重做 | 缩进 | B/I/S | 标题列表 | 图片/slash
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
      id: 'insert',
      items: [
        {
          id: 'image',
          labelKey: 'notes:mobileToolbar.image',
          defaultLabel: '图片',
          icon: <Image size={ICON_SIZE} weight={ICON_WEIGHT} aria-hidden />,
          onAction: commands.insertImage,
        },
        {
          id: 'slash',
          labelKey: 'notes:mobileToolbar.slash',
          defaultLabel: '块菜单',
          icon: <Plus size={ICON_SIZE} weight={ICON_WEIGHT} aria-hidden />,
          onAction: commands.openSlash,
        },
      ],
    },
  ];

  const toolbarLabel = tr('notes:mobileToolbar.label', '移动端编辑工具条');

  return (
    <div
      className={['mobile-editor-toolbar', className].filter(Boolean).join(' ')}
      role="toolbar"
      aria-label={toolbarLabel}
      data-testid="mobile-editor-toolbar"
      style={
        {
          '--mobile-toolbar-keyboard-offset': `${bottomOffset}px`,
        } as React.CSSProperties
      }
    >
      <div className="mobile-editor-toolbar__scroller" data-testid="mobile-editor-toolbar-scroller">
        {groups.map((group, groupIndex) => (
          <React.Fragment key={group.id}>
            {groupIndex > 0 ? (
              <span
                className="mobile-editor-toolbar__sep"
                role="separator"
                aria-hidden="true"
                data-testid="mobile-editor-toolbar-sep"
              />
            ) : null}
            {group.items.map((item) => {
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
                  // 避免点按钮抢走编辑器焦点
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={item.onAction}
                >
                  {item.icon}
                </button>
              );
            })}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
};

export default MobileEditorToolbar;

/** 供测试 / 接线代理复用的 bottom offset 计算 */
export { computeViewportBottomOffset };
