import type { CrepeFormattingState } from '@/components/crepe/formattingState';
import { insertImageFromDevice, runEditorCommand } from '../mobileEditorCommands';
import { LAYOUT_COMMANDS, type CrepeCommandId } from '@/components/crepe/commandRegistry';
import { layoutCommandLabel } from '@/components/crepe/commandMenus';
/**
 * 笔记编辑器顶部工具栏
 * 提供常用的 Markdown 格式化操作
 *
 * 溢出策略：窄容器优先横向滚动（带渐隐 mask 提示可滑），
 * 极窄容器（CSS 容器查询 ≤640px / 触屏）由样式层收起内联区，
 * Popover 全量菜单仅作兜底并带方向键 roving tabindex。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { DsButton } from '@/components/ui/DsButton';
import { useTranslation } from 'react-i18next';
import type { CrepeEditorApi } from '@/components/crepe/types';
import {
  TextAa,
  TextB,
  TextItalic,
  TextStrikethrough,
  Code,
  TextHOne,
  TextHTwo,
  TextHThree,
  List,
  ListNumbers,
  CheckSquare,
  Quotes,
  Minus,
  Link,
  Image,
  Table,
  FileCode,
  ChatCenteredText,
  CaretCircleDown,
  BracketsSquare,
  CaretDown,
} from '@phosphor-icons/react';
import { useNotesOptional } from '../NotesContext';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import { isMacOS } from '@/utils/platform';
import { isComposingKeyEvent } from '@/utils/isComposingKeyEvent';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/shad/Popover';
import { CustomScrollArea } from '@/components/custom-scroll-area';

interface NotesEditorToolbarProps {
  /** 可选：直接传入 editor，用于白板等非 NotesContext 场景 */
  editor?: CrepeEditorApi | null;
  /** 是否只读 */
  readOnly?: boolean;
  activeStates?: CrepeFormattingState;
  noteId?: string;
}

/**
 * 按平台格式化快捷键文案（macOS 符号风格：⌥⌘L / ⌘⇧P）。
 *
 * 快捷键单一来源说明（已对照真实 keymap 校验，替代原 formatKeymap TODO）：
 * - @milkdown/preset-commonmark：Mod-B 粗体、Mod-I 斜体、Mod-E 行内代码、
 *   Mod-Alt-1/2/3 标题、Mod-Alt-8 无序列表、Mod-Alt-7 有序列表、
 *   Mod-Shift-B 引用、Mod-Alt-C 代码块；
 * - @milkdown/preset-gfm：Mod-Alt-X 删除线；
 * - 本仓库 linkKeymap 插件：Mod-K 链接。
 * 任务列表 / 双链 / 高亮块 / 折叠块 / 分隔线 / 图片 / 表格无默认快捷键，不展示提示。
 * 若上游 keymap 调整，需同步更新 formatActions 中的 shortcut 声明。
 */
function formatShortcut(
  parts: { mod?: boolean; alt?: boolean; shift?: boolean; key: string },
  mac: boolean,
): string {
  const { mod = true, alt = false, shift = false, key } = parts;
  if (mac) {
    // macOS 符号风格：⌥⌘L、⌘⇧P
    if (alt && shift) return `⌥⇧⌘${key}`;
    if (alt) return `⌥⌘${key}`;
    if (shift) return `⌘⇧${key}`;
    return `${mod ? '⌘' : ''}${key}`;
  }
  const segs: string[] = [];
  if (mod) segs.push('Ctrl');
  if (alt) segs.push('Alt');
  if (shift) segs.push('Shift');
  segs.push(key);
  return segs.join('+');
}

/** 内联区横向滚动渐隐 mask（mask 通道允许 #000） */
const INLINE_SCROLL_MASK =
  '[mask-image:linear-gradient(to_right,transparent_0,#000_14px,#000_calc(100%_-_14px),transparent_100%)] [-webkit-mask-image:linear-gradient(to_right,transparent_0,#000_14px,#000_calc(100%_-_14px),transparent_100%)]';

export const NotesEditorToolbar: React.FC<NotesEditorToolbarProps> = ({ 
  editor: externalEditor,
  readOnly = false,
  activeStates = {},
  noteId,
}) => {
  const { t } = useTranslation(['notes', 'common']);

  /** t + defaultValue；兼容测试 mock 把 options 对象原样返回时回退到 key 末段 */
  const tr = useCallback(
    (key: string, defaultValue: string): string => {
      const result = t(key, { defaultValue });
      if (typeof result === 'string') return result;
      return key.split('.').at(-1) ?? defaultValue;
    },
    [t],
  );
  
  // 优先使用外部传入的 editor，否则从 context 获取
  // 使用 useNotesOptional 而非 useNotes，在没有 Provider 时返回 null
  const notesContext = useNotesOptional();
  const contextEditor = notesContext?.editor ?? null;
  
  const editor = externalEditor ?? contextEditor;
  const [, refreshCommands] = useState(0);
  useEffect(() => editor?.subscribeCommandState?.(() => refreshCommands(value => value + 1)), [editor]);
  const isDisabled = !editor || readOnly;
  const mac = isMacOS();
  const [overflowOpen, setOverflowOpen] = useState(false);

  // 内联区横向滚动：仅在真实溢出时展示渐隐 mask 提示
  const inlineRef = useRef<HTMLDivElement | null>(null);
  const [inlineOverflowing, setInlineOverflowing] = useState(false);
  useEffect(() => {
    const el = inlineRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const update = () => {
      setInlineOverflowing(el.scrollWidth > el.clientWidth + 1);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // 溢出菜单 roving tabindex（role="menu" 方向键导航）
  const menuItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const formatTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [menuActiveIndex, setMenuActiveIndex] = useState(0);
  useEffect(() => {
    if (!overflowOpen) return;
    const frame = requestAnimationFrame(() => {
      const index = menuItemRefs.current.findIndex(item => item && !item.disabled);
      if (index < 0) return;
      setMenuActiveIndex(index);
      menuItemRefs.current[index]?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [overflowOpen]);

  // 使用 ProseMirror 命令直接操作编辑器
  const handleBold = useCallback(() => {
    editor?.toggleBold();
  }, [editor]);

  const handleItalic = useCallback(() => {
    editor?.toggleItalic();
  }, [editor]);

  const handleStrikethrough = useCallback(() => {
    editor?.toggleStrikethrough();
  }, [editor]);

  const handleCode = useCallback(() => {
    editor?.toggleInlineCode();
  }, [editor]);

  const handleHeading1 = useCallback(() => {
    editor?.setHeading(1);
  }, [editor]);

  const handleHeading2 = useCallback(() => {
    editor?.setHeading(2);
  }, [editor]);

  const handleHeading3 = useCallback(() => {
    editor?.setHeading(3);
  }, [editor]);

  const handleBulletList = useCallback(() => {
    editor?.toggleBulletList();
  }, [editor]);

  const handleOrderedList = useCallback(() => {
    editor?.toggleOrderedList();
  }, [editor]);

  const handleTaskList = useCallback(() => {
    editor?.toggleTaskList();
  }, [editor]);

  const handleQuote = useCallback(() => {
    editor?.toggleBlockquote();
  }, [editor]);

  const handleHorizontalRule = useCallback(() => {
    editor?.insertHr();
  }, [editor]);

  const handleLink = useCallback(() => {
    editor?.insertLink();
  }, [editor]);

  const handleImage = useCallback(() => {
    void insertImageFromDevice(editor, noteId);
  }, [editor, noteId]);

  const handleTable = useCallback(() => {
    editor?.insertTable();
  }, [editor]);

  const handleCodeBlock = useCallback(() => {
    editor?.insertCodeBlock();
  }, [editor]);

  const handleCallout = useCallback(() => {
    runEditorCommand(editor, 'insert-callout');
  }, [editor]);

  const handleToggle = useCallback(() => {
    runEditorCommand(editor, 'insert-toggle');
  }, [editor]);

  /** 插入 `[[` 触发 wikilink 自动补全浮层（与手动输入同一路径） */
  const handleWikilink = useCallback(() => {
    if (!editor) return;
    runEditorCommand(editor, 'wikilink');
  }, [editor]);

  // 快捷键文案对齐 Milkdown preset-commonmark / preset-gfm 真实 keymap；
  // Mod-K 由本阶段 linkKeymapPlugin 补齐（见 docs/revamp/07-shortcuts.md）
  const commandIds: CrepeCommandId[] = ['bold', 'italic', 'strikethrough', 'inline-code', 'heading-1', 'heading-2', 'heading-3',
    'bullet-list', 'ordered-list', 'task-list', 'quote', 'link', 'wikilink', 'insert-callout', 'insert-toggle', 'hr', 'code-block', 'image', 'table'];
  const formatActions = [
    { active: activeStates.bold, icon: <TextB />, label: tr('notes:toolbar.bold', '粗体'), shortcut: formatShortcut({ key: 'B' }, mac), action: handleBold },
    { active: activeStates.italic, icon: <TextItalic />, label: tr('notes:toolbar.italic', '斜体'), shortcut: formatShortcut({ key: 'I' }, mac), action: handleItalic },
    { active: activeStates.strikethrough, icon: <TextStrikethrough />, label: tr('notes:toolbar.strikethrough', '删除线'), shortcut: formatShortcut({ alt: true, key: 'X' }, mac), action: handleStrikethrough },
    { active: activeStates.code, icon: <Code />, label: tr('notes:toolbar.code', '行内代码'), shortcut: formatShortcut({ key: 'E' }, mac), action: handleCode },
    { active: activeStates.h1, icon: <TextHOne />, label: tr('notes:toolbar.heading1', '一级标题'), shortcut: formatShortcut({ alt: true, key: '1' }, mac), action: handleHeading1 },
    { active: activeStates.h2, icon: <TextHTwo />, label: tr('notes:toolbar.heading2', '二级标题'), shortcut: formatShortcut({ alt: true, key: '2' }, mac), action: handleHeading2 },
    { active: activeStates.h3, icon: <TextHThree />, label: tr('notes:toolbar.heading3', '三级标题'), shortcut: formatShortcut({ alt: true, key: '3' }, mac), action: handleHeading3 },
    { active: activeStates.bullet, icon: <List />, label: tr('notes:toolbar.bulletList', '无序列表'), shortcut: formatShortcut({ alt: true, key: '8' }, mac), action: handleBulletList },
    { active: activeStates.ordered, icon: <ListNumbers />, label: tr('notes:toolbar.orderedList', '有序列表'), shortcut: formatShortcut({ alt: true, key: '7' }, mac), action: handleOrderedList },
    { active: activeStates.task, icon: <CheckSquare />, label: tr('notes:toolbar.taskList', '任务列表'), action: handleTaskList },
    { active: activeStates.quote, icon: <Quotes />, label: tr('notes:toolbar.quote', '引用'), shortcut: formatShortcut({ shift: true, key: 'B' }, mac), action: handleQuote },
    { active: activeStates.link, icon: <Link />, label: tr('notes:toolbar.link', '链接'), shortcut: formatShortcut({ key: 'K' }, mac), action: handleLink },
    { icon: <BracketsSquare />, label: tr('notes:toolbar.wikilink', '双链引用'), action: handleWikilink },
    { icon: <ChatCenteredText />, label: tr('notes:toolbar.callout', '高亮块'), action: handleCallout },
    { icon: <CaretCircleDown />, label: tr('notes:toolbar.toggle', '折叠块'), action: handleToggle },
    { icon: <Minus />, label: tr('notes:toolbar.horizontalRule', '分隔线'), action: handleHorizontalRule },
    { icon: <FileCode />, label: tr('notes:toolbar.codeBlock', '代码块'), shortcut: formatShortcut({ alt: true, key: 'C' }, mac), action: handleCodeBlock },
    { icon: <Image />, label: tr('notes:toolbar.image', '图片'), action: handleImage },
    { icon: <Table />, label: tr('notes:toolbar.table', '表格'), action: handleTable },
  ].map((item, index) => ({ ...item, command: commandIds[index],
    disabled: editor?.canExecuteCommand ? !editor.canExecuteCommand(commandIds[index], { toggle: true }) : false,
  })).concat(LAYOUT_COMMANDS.map(command => ({ command, disabled: !editor?.canExecuteCommand?.(command),
    icon: <Table />, label: layoutCommandLabel(command), action: () => runEditorCommand(editor, command),
  })));

  // 常驻只放四个高频动作；其余按文字/段落/插入/布局分组。
  const inlineGroups: CrepeCommandId[][] = [
    ['bold', 'italic'],
    ['bullet-list', 'link'],
  ];
  const actionByCommand = new Map(formatActions.map((item) => [item.command, item]));
  const menuGroups: Record<number, string> = {
    0: tr('notes:chrome.text_style', '文字样式'),
    4: tr('notes:chrome.paragraph', '段落'),
    11: tr('notes:chrome.insert', '插入'),
    19: tr('notes:layout.label', '页面布局'),
  };

  const toolbarLabel = tr('notes:toolbar.label', '格式化');

  /** role="menu" 方向键 roving tabindex */
  const handleMenuKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.defaultPrevented || isComposingKeyEvent(event)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setOverflowOpen(false);
      formatTriggerRef.current?.focus();
      return;
    }
    const enabledIndices = menuItemRefs.current.flatMap((item, index) => item && !item.disabled ? [index] : []);
    const count = enabledIndices.length;
    if (count === 0) return;
    const current = enabledIndices.indexOf(menuActiveIndex);
    let next: number | null = null;
    switch (event.key) {
      case 'ArrowDown':
        next = enabledIndices[(current + 1) % count];
        break;
      case 'ArrowUp':
        next = enabledIndices[(current < 0 ? count - 1 : current - 1 + count) % count];
        break;
      case 'Home':
        next = enabledIndices[0];
        break;
      case 'End':
        next = enabledIndices[count - 1];
        break;
      default:
        return;
    }
    event.preventDefault();
    setMenuActiveIndex(next);
    menuItemRefs.current[next]?.focus();
  }, [menuActiveIndex]);

  return (
    <div
      className="notes-editor-toolbar !shrink min-w-0"
      role="toolbar"
      aria-label={toolbarLabel}
    >
      <div
        ref={inlineRef}
        className={[
          'notes-editor-toolbar-inline',
          // 窄容器横向滚动兜底（覆盖样式层 overflow:hidden）；隐藏滚动条
          '!overflow-x-auto !overflow-y-hidden overscroll-x-contain scrollbar-none',
          inlineOverflowing ? INLINE_SCROLL_MASK : '',
        ].filter(Boolean).join(' ')}
      >
        {inlineGroups.map((group, groupIndex) => (
          <React.Fragment key={groupIndex}>
            {groupIndex > 0 && <span className="notes-editor-toolbar-divider" aria-hidden="true" />}
            {group.map((command) => {
              const item = actionByCommand.get(command);
              if (!item) return null;
              return (
                <CommonTooltip key={command} content={item.label} shortcut={item.shortcut} position="bottom">
                  <DsButton
                    variant="ghost"
                    size="icon"
                    iconOnly
                    disabled={isDisabled || item.disabled}
                    aria-label={item.label}
                    aria-pressed={item.active}
                    className="flex-none ui-press [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11 hover:!bg-[var(--interactive-hover)] active:!bg-[var(--interactive-selected)]"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={item.action}
                  >
                    {React.cloneElement(item.icon, { className: 'h-4 w-4' })}
                  </DsButton>
                </CommonTooltip>
              );
            })}
          </React.Fragment>
        ))}
        <span className="notes-editor-toolbar-divider" aria-hidden="true" />
      </div>
      <Popover open={overflowOpen} onOpenChange={setOverflowOpen}>
        <CommonTooltip content={toolbarLabel}>
          <PopoverTrigger asChild>
            <DsButton
              ref={formatTriggerRef}
              variant="ghost"
              size="sm"
              disabled={isDisabled}
              className={overflowOpen ? 'notes-editor-format-trigger active flex-none [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11' : 'notes-editor-format-trigger flex-none [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11'}
              aria-label={toolbarLabel}
              aria-haspopup="menu"
              aria-expanded={overflowOpen}
              onMouseDown={(event) => event.preventDefault()}
            >
              <TextAa className="h-4 w-4" />
              <span>{tr('notes:chrome.format', '格式')}</span>
              <CaretDown className="h-3 w-3" />
            </DsButton>
          </PopoverTrigger>
        </CommonTooltip>
        <PopoverContent
          align="start"
          sideOffset={4}
          className="notes-toolbar-overflow w-64 p-0"
          role="menu"
          aria-hidden={!overflowOpen || undefined}
          {...(!overflowOpen ? ({ inert: '' } as unknown as React.HTMLAttributes<HTMLDivElement>) : {})}
          onKeyDown={handleMenuKeyDown}
          onWheel={(event) => event.stopPropagation()}
        >
          <CustomScrollArea
            className="max-h-[min(70vh,480px)]"
            viewportClassName="p-1"
            fullHeight={false}
          >
            {formatActions.map((item, index) => (
              <React.Fragment key={item.command}>
                {menuGroups[index] && <div className="notes-action-group-label" role="presentation">{menuGroups[index]}</div>}
                <DsButton
                  ref={(el) => { menuItemRefs.current[index] = el; }}
                  variant="ghost"
                  size="sm"
                  role={item.active === undefined ? "menuitem" : "menuitemcheckbox"}
                  tabIndex={index === menuActiveIndex ? 0 : -1}
                  className="notes-toolbar-overflow-item [@media(pointer:coarse)]:!min-h-11 hover:!bg-[var(--interactive-hover)] active:!bg-[var(--interactive-selected)]"
                  aria-label={item.label}
                  aria-checked={item.active}
                  disabled={isDisabled || item.disabled}
                  onMouseDown={(event) => event.preventDefault()}
                  onFocus={() => setMenuActiveIndex(index)}
                  onClick={() => {
                    item.action();
                    setOverflowOpen(false);
                    if (menuItemRefs.current.includes(document.activeElement as HTMLButtonElement)) {
                      formatTriggerRef.current?.focus();
                    }
                  }}
                >
                  {React.cloneElement(item.icon, { className: 'h-4 w-4 shrink-0' })}
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.shortcut && <kbd>{item.shortcut}</kbd>}
                </DsButton>
              </React.Fragment>
            ))}
          </CustomScrollArea>
        </PopoverContent>
      </Popover>
    </div>
  );
};

export default NotesEditorToolbar;
