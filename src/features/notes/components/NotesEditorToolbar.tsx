/**
 * 笔记编辑器顶部工具栏
 * 提供常用的 Markdown 格式化操作
 *
 * 溢出策略：窄容器优先横向滚动（带渐隐 mask 提示可滑），
 * 极窄容器（CSS 容器查询 ≤560px / 触屏）由样式层收起内联区，
 * Popover 全量菜单仅作兜底并带方向键 roving tabindex。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { DsButton } from '@/components/ui/DsButton';
import { useTranslation } from 'react-i18next';
import type { CrepeEditorApi } from '@/components/crepe/types';
import type { Ctx } from '@milkdown/kit/ctx';
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
} from '@phosphor-icons/react';
import { useNotesOptional } from '../NotesContext';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import { isMacOS } from '@/utils/platform';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/shad/Popover';
import {
  insertEmptyCallout,
  insertEmptyToggle,
} from '@/components/crepe/plugins/slashMenuExtras';

interface NotesEditorToolbarProps {
  /** 可选：直接传入 editor，用于白板等非 NotesContext 场景 */
  editor?: CrepeEditorApi | null;
  /** 是否只读 */
  readOnly?: boolean;
}

/**
 * 按平台格式化快捷键文案（macOS 符号风格对齐 NotesHeader：⌥⌘L / ⌘⇧P）。
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
    // 对齐 NotesHeader：⌥⌘L、⌘⇧P
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
  const [menuActiveIndex, setMenuActiveIndex] = useState(0);
  useEffect(() => {
    if (overflowOpen) setMenuActiveIndex(0);
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
    editor?.insertImage();
  }, [editor]);

  const handleTable = useCallback(() => {
    editor?.insertTable();
  }, [editor]);

  const handleCodeBlock = useCallback(() => {
    editor?.insertCodeBlock();
  }, [editor]);

  /** 通过 Crepe ctx 运行插件级插入命令（callout / toggle 走 slash 菜单同款实现） */
  const runWithCtx = useCallback((fn: (ctx: Ctx) => void) => {
    const crepe = editor?.getCrepe?.();
    if (!crepe?.editor) return;
    try {
      crepe.editor.action(fn);
    } catch {
      // 编辑器未就绪 / 已销毁
    }
  }, [editor]);

  const handleCallout = useCallback(() => {
    runWithCtx(insertEmptyCallout);
  }, [runWithCtx]);

  const handleToggle = useCallback(() => {
    runWithCtx(insertEmptyToggle);
  }, [runWithCtx]);

  /** 插入 `[[` 触发 wikilink 自动补全浮层（与手动输入同一路径） */
  const handleWikilink = useCallback(() => {
    if (!editor) return;
    editor.focus();
    editor.insertAtCursor('[[');
  }, [editor]);

  // 快捷键文案对齐 Milkdown preset-commonmark / preset-gfm 真实 keymap；
  // Mod-K 由本阶段 linkKeymapPlugin 补齐（见 docs/revamp/07-shortcuts.md）
  const formatActions = [
    { icon: <TextB />, label: tr('notes:toolbar.bold', '粗体'), shortcut: formatShortcut({ key: 'B' }, mac), action: handleBold },
    { icon: <TextItalic />, label: tr('notes:toolbar.italic', '斜体'), shortcut: formatShortcut({ key: 'I' }, mac), action: handleItalic },
    { icon: <TextStrikethrough />, label: tr('notes:toolbar.strikethrough', '删除线'), shortcut: formatShortcut({ alt: true, key: 'X' }, mac), action: handleStrikethrough },
    { icon: <Code />, label: tr('notes:toolbar.code', '行内代码'), shortcut: formatShortcut({ key: 'E' }, mac), action: handleCode },
    { icon: <TextHOne />, label: tr('notes:toolbar.heading1', '一级标题'), shortcut: formatShortcut({ alt: true, key: '1' }, mac), action: handleHeading1 },
    { icon: <TextHTwo />, label: tr('notes:toolbar.heading2', '二级标题'), shortcut: formatShortcut({ alt: true, key: '2' }, mac), action: handleHeading2 },
    { icon: <TextHThree />, label: tr('notes:toolbar.heading3', '三级标题'), shortcut: formatShortcut({ alt: true, key: '3' }, mac), action: handleHeading3 },
    { icon: <List />, label: tr('notes:toolbar.bulletList', '无序列表'), shortcut: formatShortcut({ alt: true, key: '8' }, mac), action: handleBulletList },
    { icon: <ListNumbers />, label: tr('notes:toolbar.orderedList', '有序列表'), shortcut: formatShortcut({ alt: true, key: '7' }, mac), action: handleOrderedList },
    { icon: <CheckSquare />, label: tr('notes:toolbar.taskList', '任务列表'), action: handleTaskList },
    { icon: <Quotes />, label: tr('notes:toolbar.quote', '引用'), shortcut: formatShortcut({ shift: true, key: 'B' }, mac), action: handleQuote },
    { icon: <Link />, label: tr('notes:toolbar.link', '链接'), shortcut: formatShortcut({ key: 'K' }, mac), action: handleLink },
    { icon: <BracketsSquare />, label: tr('notes:toolbar.wikilink', '双链引用'), action: handleWikilink },
    { icon: <ChatCenteredText />, label: tr('notes:toolbar.callout', '高亮块'), action: handleCallout },
    { icon: <CaretCircleDown />, label: tr('notes:toolbar.toggle', '折叠块'), action: handleToggle },
    { icon: <Minus />, label: tr('notes:toolbar.horizontalRule', '分隔线'), action: handleHorizontalRule },
    { icon: <FileCode />, label: tr('notes:toolbar.codeBlock', '代码块'), shortcut: formatShortcut({ alt: true, key: 'C' }, mac), action: handleCodeBlock },
    { icon: <Image />, label: tr('notes:toolbar.image', '图片'), action: handleImage },
    { icon: <Table />, label: tr('notes:toolbar.table', '表格'), action: handleTable },
  ];

  // 桌面端外露的高频按钮（按 label 匹配 formatActions，分组间加分隔线）。
  // 窄容器优先横向滚动；极窄 / 触屏由 CSS（.notes-editor-toolbar-inline）整体隐藏，回退到溢出菜单。
  const inlineGroups: string[][] = [
    [tr('notes:toolbar.bold', '粗体'), tr('notes:toolbar.italic', '斜体'), tr('notes:toolbar.strikethrough', '删除线'), tr('notes:toolbar.code', '行内代码')],
    [tr('notes:toolbar.heading1', '一级标题'), tr('notes:toolbar.heading2', '二级标题')],
    [tr('notes:toolbar.bulletList', '无序列表'), tr('notes:toolbar.orderedList', '有序列表'), tr('notes:toolbar.taskList', '任务列表')],
    [tr('notes:toolbar.quote', '引用'), tr('notes:toolbar.link', '链接')],
    [tr('notes:toolbar.wikilink', '双链引用'), tr('notes:toolbar.callout', '高亮块'), tr('notes:toolbar.toggle', '折叠块')],
  ];
  const actionByLabel = new Map(formatActions.map((item) => [item.label, item]));

  const toolbarLabel = tr('notes:toolbar.label', '格式化');

  /** role="menu" 方向键 roving tabindex */
  const handleMenuKeyDown = useCallback((event: React.KeyboardEvent) => {
    const count = menuItemRefs.current.length;
    if (count === 0) return;
    let next: number | null = null;
    switch (event.key) {
      case 'ArrowDown':
        next = (menuActiveIndex + 1) % count;
        break;
      case 'ArrowUp':
        next = (menuActiveIndex - 1 + count) % count;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = count - 1;
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
          '!overflow-x-auto !overflow-y-hidden overscroll-x-contain',
          '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
          inlineOverflowing ? INLINE_SCROLL_MASK : '',
        ].filter(Boolean).join(' ')}
      >
        {inlineGroups.map((group, groupIndex) => (
          <React.Fragment key={groupIndex}>
            {groupIndex > 0 && <span className="notes-editor-toolbar-divider" aria-hidden="true" />}
            {group.map((label) => {
              const item = actionByLabel.get(label);
              if (!item) return null;
              return (
                <CommonTooltip key={label} content={item.label} shortcut={item.shortcut} position="bottom">
                  <DsButton
                    variant="ghost"
                    size="icon"
                    iconOnly
                    disabled={isDisabled}
                    aria-label={item.label}
                    className="flex-none ui-press hover:!bg-[var(--interactive-hover)] active:!bg-[var(--interactive-selected)]"
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
              variant="ghost"
              size="icon"
              iconOnly
              disabled={isDisabled}
              className={overflowOpen ? 'notes-editor-format-trigger active flex-none' : 'notes-editor-format-trigger flex-none'}
              aria-label={toolbarLabel}
              aria-haspopup="menu"
              aria-expanded={overflowOpen}
            >
              <TextAa className="h-4 w-4" />
            </DsButton>
          </PopoverTrigger>
        </CommonTooltip>
        <PopoverContent
          align="start"
          sideOffset={4}
          className="notes-toolbar-overflow w-52 p-1"
          role="menu"
          onKeyDown={handleMenuKeyDown}
        >
          {formatActions.map((item, index) => (
            <DsButton
              key={item.label}
              ref={(el) => { menuItemRefs.current[index] = el; }}
              variant="ghost"
              size="sm"
              role="menuitem"
              tabIndex={index === menuActiveIndex ? 0 : -1}
              className="notes-toolbar-overflow-item hover:!bg-[var(--interactive-hover)] active:!bg-[var(--interactive-selected)]"
              aria-label={item.label}
              onMouseDown={(event) => event.preventDefault()}
              onFocus={() => setMenuActiveIndex(index)}
              onClick={() => { item.action(); setOverflowOpen(false); }}
            >
              {React.cloneElement(item.icon, { className: 'h-4 w-4 shrink-0' })}
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.shortcut && <kbd>{item.shortcut}</kbd>}
            </DsButton>
          ))}
        </PopoverContent>
      </Popover>
    </div>
  );
};

export default NotesEditorToolbar;
