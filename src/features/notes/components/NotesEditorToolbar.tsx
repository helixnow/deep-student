/**
 * 笔记编辑器顶部工具栏
 * 提供常用的 Markdown 格式化操作
 */

import React, { useCallback, useState } from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import { useTranslation } from 'react-i18next';
import type { CrepeEditorApi } from '@/components/crepe/types';
import {
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
  DotsThree,
} from '@phosphor-icons/react';
import { useNotesOptional } from '../NotesContext';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import { isMacOS } from '@/utils/platform';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/shad/Popover';

interface ToolbarButtonProps {
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}

const ToolbarButton: React.FC<ToolbarButtonProps> = ({
  icon,
  label,
  shortcut,
  onClick,
  disabled = false,
  active = false,
}) => {
  // Pointer interaction keeps the editor selection; keyboard activation stays native.
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
  };

  const tooltipContent = shortcut ? `${label} (${shortcut})` : label;

  return (
    <CommonTooltip content={tooltipContent} disabled={!tooltipContent}>
      <NotionButton
        variant="ghost" size="icon" iconOnly
        onMouseDown={handleMouseDown}
        onClick={onClick}
        disabled={disabled}
        className={active ? 'active' : ''}
        aria-label={label}
        aria-pressed={active || undefined}
      >
        {icon}
      </NotionButton>
    </CommonTooltip>
  );
};

const Divider: React.FC = () => <div className="divider" role="separator" />;

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
  compact = false,
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


  const overflowActions = [
    { icon: <TextStrikethrough />, label: t('notes:toolbar.strikethrough'), action: handleStrikethrough },
    { icon: <TextHOne />, label: t('notes:toolbar.heading1'), action: handleHeading1 },
    { icon: <TextHThree />, label: t('notes:toolbar.heading3'), action: handleHeading3 },
    { icon: <ListNumbers />, label: t('notes:toolbar.orderedList'), action: handleOrderedList },
    { icon: <Quotes />, label: t('notes:toolbar.quote'), action: handleQuote },
    { icon: <Minus />, label: t('notes:toolbar.horizontalRule'), action: handleHorizontalRule },
    { icon: <FileCode />, label: t('notes:toolbar.codeBlock'), action: handleCodeBlock },
    { icon: <Image />, label: t('notes:toolbar.image'), action: handleImage },
    { icon: <Table />, label: t('notes:toolbar.table'), action: handleTable },
  ];

  return (
    <div className="notes-editor-toolbar" role="toolbar" aria-label={t('notes:toolbar.label', '格式化')}>
      <ToolbarButton
        icon={<TextB className="w-4 h-4" />}
        label={t('notes:toolbar.bold')}
        shortcut={`${mod}B`}
        onClick={handleBold}
        disabled={isDisabled}
      />
      <ToolbarButton
        icon={<TextItalic className="w-4 h-4" />}
        label={t('notes:toolbar.italic')}
        shortcut={`${mod}I`}
        onClick={handleItalic}
        disabled={isDisabled}
      />
      <ToolbarButton
        icon={<Code className="w-4 h-4" />}
        label={t('notes:toolbar.code')}
        shortcut={`${mod}E`}
        onClick={handleCode}
        disabled={isDisabled}
      />

      <Divider />

      <ToolbarButton
        icon={<TextHTwo className="w-4 h-4" />}
        label={t('notes:toolbar.heading2')}
        shortcut={`${mod}2`}
        onClick={handleHeading2}
        disabled={isDisabled}
      />
      <Divider />

      {/* 列表 */}
      <ToolbarButton
        icon={<List className="w-4 h-4" />}
        label={t('notes:toolbar.bulletList')}
        onClick={handleBulletList}
        disabled={isDisabled}
      />
      <ToolbarButton
        icon={<CheckSquare className="w-4 h-4" />}
        label={t('notes:toolbar.taskList')}
        onClick={handleTaskList}
        disabled={isDisabled}
      />

      <Divider />

      {/* 插入 */}
      <ToolbarButton
        icon={<Link className="w-4 h-4" />}
        label={t('notes:toolbar.link')}
        shortcut={`${mod}K`}
        onClick={handleLink}
        disabled={isDisabled}
      />
      {!compact && (
        <Popover open={overflowOpen} onOpenChange={setOverflowOpen}>
          <CommonTooltip content={t('common:more', '更多')}>
            <PopoverTrigger asChild>
              <NotionButton variant="ghost" size="icon" iconOnly disabled={isDisabled} aria-label={t('common:more', '更多')}>
                <DotsThree className="h-4 w-4" weight="bold" />
              </NotionButton>
            </PopoverTrigger>
          </CommonTooltip>
          <PopoverContent align="end" sideOffset={4} className="notes-toolbar-overflow w-48 p-1" role="menu">
            {overflowActions.map((item) => (
              <NotionButton key={item.label} variant="ghost" size="sm" role="menuitem" className="notes-toolbar-overflow-item" onClick={() => { item.action(); setOverflowOpen(false); }}>
                {React.cloneElement(item.icon, { className: 'h-4 w-4' })}
                <span>{item.label}</span>
              </NotionButton>
            ))}
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
};

export default NotesEditorToolbar;
