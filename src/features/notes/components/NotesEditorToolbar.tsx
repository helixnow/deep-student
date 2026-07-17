/**
 * 笔记编辑器顶部工具栏
 * 提供常用的 Markdown 格式化操作
 */

import React, { useCallback, useState } from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
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
} from '@phosphor-icons/react';
import { useNotesOptional } from '../NotesContext';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import { isMacOS } from '@/utils/platform';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/shad/Popover';

interface NotesEditorToolbarProps {
  /** 可选：直接传入 editor，用于白板等非 NotesContext 场景 */
  editor?: CrepeEditorApi | null;
  /** 是否只读 */
  readOnly?: boolean;
}

/** 按平台格式化快捷键文案（macOS 符号风格对齐 NotesHeader：⌥⌘L / ⌘⇧P） */
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
    { icon: <Minus />, label: tr('notes:toolbar.horizontalRule', '分隔线'), action: handleHorizontalRule },
    { icon: <FileCode />, label: tr('notes:toolbar.codeBlock', '代码块'), shortcut: formatShortcut({ alt: true, key: 'C' }, mac), action: handleCodeBlock },
    { icon: <Image />, label: tr('notes:toolbar.image', '图片'), action: handleImage },
    { icon: <Table />, label: tr('notes:toolbar.table', '表格'), action: handleTable },
  ];

  // 桌面端外露的高频按钮（按 label 匹配 formatActions，分组间加分隔线）。
  // 窄屏 / 触屏由 CSS（.notes-editor-toolbar-inline）整体隐藏，回退到溢出菜单。
  const inlineGroups: string[][] = [
    [tr('notes:toolbar.bold', '粗体'), tr('notes:toolbar.italic', '斜体'), tr('notes:toolbar.strikethrough', '删除线'), tr('notes:toolbar.code', '行内代码')],
    [tr('notes:toolbar.heading1', '一级标题'), tr('notes:toolbar.heading2', '二级标题')],
    [tr('notes:toolbar.bulletList', '无序列表'), tr('notes:toolbar.orderedList', '有序列表'), tr('notes:toolbar.taskList', '任务列表')],
    [tr('notes:toolbar.quote', '引用'), tr('notes:toolbar.link', '链接')],
  ];
  const actionByLabel = new Map(formatActions.map((item) => [item.label, item]));

  const toolbarLabel = tr('notes:toolbar.label', '格式化');

  return (
    <div className="notes-editor-toolbar" role="toolbar" aria-label={toolbarLabel}>
      <div className="notes-editor-toolbar-inline">
        {inlineGroups.map((group, groupIndex) => (
          <React.Fragment key={groupIndex}>
            {groupIndex > 0 && <span className="notes-editor-toolbar-divider" aria-hidden="true" />}
            {group.map((label) => {
              const item = actionByLabel.get(label);
              if (!item) return null;
              return (
                <CommonTooltip key={label} content={item.label} shortcut={item.shortcut} position="bottom">
                  <NotionButton
                    variant="ghost"
                    size="icon"
                    iconOnly
                    disabled={isDisabled}
                    aria-label={item.label}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={item.action}
                  >
                    {React.cloneElement(item.icon, { className: 'h-4 w-4' })}
                  </NotionButton>
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
            <NotionButton
              variant="ghost"
              size="icon"
              iconOnly
              disabled={isDisabled}
              className={overflowOpen ? 'notes-editor-format-trigger active' : 'notes-editor-format-trigger'}
              aria-label={toolbarLabel}
              aria-haspopup="menu"
              aria-expanded={overflowOpen}
            >
              <TextAa className="h-4 w-4" />
            </NotionButton>
          </PopoverTrigger>
        </CommonTooltip>
        <PopoverContent align="start" sideOffset={4} className="notes-toolbar-overflow w-52 p-1" role="menu">
          {formatActions.map((item) => (
            <NotionButton
              key={item.label}
              variant="ghost"
              size="sm"
              role="menuitem"
              className="notes-toolbar-overflow-item"
              aria-label={item.label}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => { item.action(); setOverflowOpen(false); }}
            >
              {React.cloneElement(item.icon, { className: 'h-4 w-4 shrink-0' })}
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.shortcut && <kbd>{item.shortcut}</kbd>}
            </NotionButton>
          ))}
        </PopoverContent>
      </Popover>
    </div>
  );
};

export default NotesEditorToolbar;
