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
  /** 是否使用紧凑模式（用于白板嵌入） */
  compact?: boolean;
  /** 是否只读 */
  readOnly?: boolean;
}

export const NotesEditorToolbar: React.FC<NotesEditorToolbarProps> = ({ 
  editor: externalEditor,
  readOnly = false,
}) => {
  const { t } = useTranslation(['notes', 'common']);
  
  // 优先使用外部传入的 editor，否则从 context 获取
  // 使用 useNotesOptional 而非 useNotes，在没有 Provider 时返回 null
  const notesContext = useNotesOptional();
  const contextEditor = notesContext?.editor ?? null;
  
  const editor = externalEditor ?? contextEditor;
  const isDisabled = !editor || readOnly;
  const mod = isMacOS() ? '⌘' : 'Ctrl+';
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


  const formatActions = [
    { icon: <TextB />, label: t('notes:toolbar.bold'), shortcut: `${mod}B`, action: handleBold },
    { icon: <TextItalic />, label: t('notes:toolbar.italic'), shortcut: `${mod}I`, action: handleItalic },
    { icon: <TextStrikethrough />, label: t('notes:toolbar.strikethrough'), action: handleStrikethrough },
    { icon: <Code />, label: t('notes:toolbar.code'), shortcut: `${mod}E`, action: handleCode },
    { icon: <TextHOne />, label: t('notes:toolbar.heading1'), shortcut: `${mod}1`, action: handleHeading1 },
    { icon: <TextHTwo />, label: t('notes:toolbar.heading2'), shortcut: `${mod}2`, action: handleHeading2 },
    { icon: <TextHThree />, label: t('notes:toolbar.heading3'), shortcut: `${mod}3`, action: handleHeading3 },
    { icon: <List />, label: t('notes:toolbar.bulletList'), action: handleBulletList },
    { icon: <ListNumbers />, label: t('notes:toolbar.orderedList'), action: handleOrderedList },
    { icon: <CheckSquare />, label: t('notes:toolbar.taskList'), action: handleTaskList },
    { icon: <Quotes />, label: t('notes:toolbar.quote'), action: handleQuote },
    { icon: <Link />, label: t('notes:toolbar.link'), shortcut: `${mod}K`, action: handleLink },
    { icon: <Minus />, label: t('notes:toolbar.horizontalRule'), action: handleHorizontalRule },
    { icon: <FileCode />, label: t('notes:toolbar.codeBlock'), action: handleCodeBlock },
    { icon: <Image />, label: t('notes:toolbar.image'), action: handleImage },
    { icon: <Table />, label: t('notes:toolbar.table'), action: handleTable },
  ];

  return (
    <div className="notes-editor-toolbar" role="toolbar" aria-label={t('notes:toolbar.label')}>
      <Popover open={overflowOpen} onOpenChange={setOverflowOpen}>
        <CommonTooltip content={t('notes:toolbar.label')}>
          <PopoverTrigger asChild>
            <NotionButton
              variant="ghost"
              size="icon"
              iconOnly
              disabled={isDisabled}
              className={overflowOpen ? 'notes-editor-format-trigger active' : 'notes-editor-format-trigger'}
              aria-label={t('notes:toolbar.label')}
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
