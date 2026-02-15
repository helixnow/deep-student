/**
 * 笔记编辑器顶部工具栏
 * 提供常用的 Markdown 格式化操作
 */

import React, { useCallback } from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import { useTranslation } from 'react-i18next';
import type { CrepeEditorApi } from '@/components/crepe/types';
import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  CheckSquare,
  Quote,
  Minus,
  Link,
  Image,
  Table,
  FileCode,
} from 'lucide-react';
import { useNotesOptional } from '../NotesContext';
import { CommonTooltip } from '@/components/shared/CommonTooltip';

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
  // 使用 onMouseDown + preventDefault 阻止焦点转移
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!disabled) {
      onClick();
    }
  };

  const tooltipContent = shortcut ? `${label} (${shortcut})` : label;

  return (
    <CommonTooltip content={tooltipContent} disabled={!tooltipContent}>
      <NotionButton
        variant="ghost" size="icon" iconOnly
        onMouseDown={handleMouseDown}
        disabled={disabled}
        className={active ? 'active' : ''}
        aria-label={label}
        tabIndex={-1}
      >
        {icon}
      </NotionButton>
    </CommonTooltip>
  );
};

const Divider: React.FC = () => <div className="divider" />;

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


  return (
    <div className="notes-editor-toolbar">
      {/* 文本格式 */}
      <ToolbarButton
        icon={<Bold className="w-4 h-4" />}
        label={t('notes:toolbar.bold')}
        shortcut="⌘B"
        onClick={handleBold}
        disabled={isDisabled}
      />
      <ToolbarButton
        icon={<Italic className="w-4 h-4" />}
        label={t('notes:toolbar.italic')}
        shortcut="⌘I"
        onClick={handleItalic}
        disabled={isDisabled}
      />
      <ToolbarButton
        icon={<Strikethrough className="w-4 h-4" />}
        label={t('notes:toolbar.strikethrough')}
        onClick={handleStrikethrough}
        disabled={isDisabled}
      />
      <ToolbarButton
        icon={<Code className="w-4 h-4" />}
        label={t('notes:toolbar.code')}
        shortcut="⌘E"
        onClick={handleCode}
        disabled={isDisabled}
      />

      <Divider />

      {/* 标题 */}
      <ToolbarButton
        icon={<Heading1 className="w-4 h-4" />}
        label={t('notes:toolbar.heading1')}
        shortcut="⌘1"
        onClick={handleHeading1}
        disabled={isDisabled}
      />
      <ToolbarButton
        icon={<Heading2 className="w-4 h-4" />}
        label={t('notes:toolbar.heading2')}
        shortcut="⌘2"
        onClick={handleHeading2}
        disabled={isDisabled}
      />
      <ToolbarButton
        icon={<Heading3 className="w-4 h-4" />}
        label={t('notes:toolbar.heading3')}
        shortcut="⌘3"
        onClick={handleHeading3}
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
        icon={<ListOrdered className="w-4 h-4" />}
        label={t('notes:toolbar.orderedList')}
        onClick={handleOrderedList}
        disabled={isDisabled}
      />
      <ToolbarButton
        icon={<CheckSquare className="w-4 h-4" />}
        label={t('notes:toolbar.taskList')}
        onClick={handleTaskList}
        disabled={isDisabled}
      />

      <Divider />

      {/* 块元素 */}
      <ToolbarButton
        icon={<Quote className="w-4 h-4" />}
        label={t('notes:toolbar.quote')}
        onClick={handleQuote}
        disabled={isDisabled}
      />
      <ToolbarButton
        icon={<Minus className="w-4 h-4" />}
        label={t('notes:toolbar.horizontalRule')}
        onClick={handleHorizontalRule}
        disabled={isDisabled}
      />
      <ToolbarButton
        icon={<FileCode className="w-4 h-4" />}
        label={t('notes:toolbar.codeBlock')}
        onClick={handleCodeBlock}
        disabled={isDisabled}
      />

      <Divider />

      {/* 插入 */}
      <ToolbarButton
        icon={<Link className="w-4 h-4" />}
        label={t('notes:toolbar.link')}
        shortcut="⌘K"
        onClick={handleLink}
        disabled={isDisabled}
      />
      <ToolbarButton
        icon={<Image className="w-4 h-4" />}
        label={t('notes:toolbar.image')}
        onClick={handleImage}
        disabled={isDisabled}
      />
      <ToolbarButton
        icon={<Table className="w-4 h-4" />}
        label={t('notes:toolbar.table')}
        onClick={handleTable}
        disabled={isDisabled}
      />
    </div>
  );
};

export default NotesEditorToolbar;
