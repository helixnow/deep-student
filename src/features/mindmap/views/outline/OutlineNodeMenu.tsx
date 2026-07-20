/**
 * 大纲行「⋯」菜单：结构操作 / 文本格式 / 颜色 / 剪贴板 / 折叠 / 删除。
 * 快捷键文案随当前 keymap 与平台变化。
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  CaretRight,
  CaretDown,
  Plus,
  DotsThree,
  Trash,
  TextB,
  TextItalic,
  TextUnderline,
  TextStrikethrough,
  TextHOne,
  TextHTwo,
  TextHThree,
  TextT,
  Link as LinkIcon,
  CheckCircle,
  Circle,
  Palette,
  Highlighter,
  Note,
  Copy,
  Scissors,
  ClipboardText,
  X,
} from '@phosphor-icons/react';
import {
  AppMenu,
  AppMenuTrigger,
  AppMenuContent,
  AppMenuItem,
  AppMenuSeparator,
} from '@/components/ui/app-menu';
import { NotionButton } from '@/components/ui/NotionButton';
import { cn } from '@/lib/utils';
import { useMindMapStore } from '../../store';
import type { MindMapNode } from '../../types';
import type { MindMapKeymap } from '../../utils/mindmapPreferences';
import { QUICK_TEXT_COLORS, QUICK_BG_COLORS } from '../../constants';
import { getOutlineShortcutLabels, useOutlineStoreActions } from './outlineShared';

export interface OutlineNodeMenuProps {
  node: MindMapNode;
  isRoot: boolean;
  parentId: string | null;
  indexInParent: number;
  keymap: MindMapKeymap;
  onEditNote: () => void;
  onOpenResourcePicker: (nodeId: string) => void;
}

export const OutlineNodeMenu: React.FC<OutlineNodeMenuProps> = ({
  node,
  isRoot,
  parentId,
  indexInParent,
  keymap,
  onEditNote,
  onOpenResourcePicker,
}) => {
  const { t } = useTranslation('mindmap');
  const {
    updateNode,
    addNode,
    deleteNode,
    toggleCollapse,
    setFocusedNodeId,
    copyNodes,
    cutNodes,
    pasteNodes,
  } = useOutlineStoreActions();
  const hasClipboard = useMindMapStore(state => !!state.clipboard);

  const isTaskNode = node.completed !== undefined;
  const hasChildren = !!node.children && node.children.length > 0;
  const isCollapsed = !!node.collapsed;
  const shortcuts = getOutlineShortcutLabels(keymap);

  return (
    <AppMenu>
      <AppMenuTrigger asChild>
        <NotionButton variant="ghost"
          className="action-btn"
          onClick={(e) => e.stopPropagation()}
        >
          <DotsThree size={16} />
        </NotionButton>
      </AppMenuTrigger>
      <AppMenuContent align="end" className="min-w-[180px]">
        <AppMenuItem
          icon={<Plus className="w-4 h-4" />}
          shortcut={shortcuts.addChild}
          onClick={() => {
            const newId = addNode(node.id, 0);
            if (node.collapsed) toggleCollapse(node.id);
            setTimeout(() => setFocusedNodeId(newId), 0);
          }}
        >
          {t('actions.addChild')}
        </AppMenuItem>
        {!isRoot && parentId && (
          <AppMenuItem
            icon={<Plus className="w-4 h-4" />}
            shortcut={shortcuts.addSibling}
            onClick={() => {
              const newId = addNode(parentId, indexInParent + 1);
              setTimeout(() => setFocusedNodeId(newId), 0);
            }}
          >
            {t('contextMenu.addSibling')}
          </AppMenuItem>
        )}
        <AppMenuItem
          icon={<Note size={16} />}
          shortcut={shortcuts.note}
          onClick={onEditNote}
        >
          {node.note ? t('contextMenu.editNote') : t('contextMenu.addNote')}
        </AppMenuItem>
        <AppMenuItem
          icon={<LinkIcon size={16} />}
          onClick={() => onOpenResourcePicker(node.id)}
        >
          {t('contextMenu.linkResource')}
        </AppMenuItem>
        <AppMenuSeparator />
        {isTaskNode ? (
          <>
            <AppMenuItem
              icon={node.completed
                ? <Circle size={16} />
                : <CheckCircle size={16} />}
              shortcut={shortcuts.toggleComplete}
              onClick={() => updateNode(node.id, { completed: !node.completed })}
            >
              {node.completed ? t('contextMenu.unmarkComplete') : t('contextMenu.markComplete')}
            </AppMenuItem>
            <AppMenuItem
              icon={<Circle size={16} />}
              onClick={() => updateNode(node.id, { completed: undefined })}
            >
              {t('mindmap:outline.removeTask', { defaultValue: '移除任务' })}
            </AppMenuItem>
          </>
        ) : (
          <AppMenuItem
            icon={<CheckCircle size={16} />}
            onClick={() => updateNode(node.id, { completed: false })}
          >
            {t('mindmap:outline.convertToTask', { defaultValue: '转为任务' })}
          </AppMenuItem>
        )}
        {/* 文本格式 B / I / U / S */}
        <div className="flex items-center gap-1 px-2 py-1">
          <NotionButton variant="ghost"
            className={cn("w-7 h-7 flex items-center justify-center rounded", node.style?.fontWeight === 'bold' && "bg-accent")}
            onClick={(e) => { e.stopPropagation(); updateNode(node.id, { style: { ...node.style, fontWeight: node.style?.fontWeight === 'bold' ? undefined : 'bold' } }); }}
            title={t('contextMenu.bold')}
          ><TextB size={16} /></NotionButton>
          <NotionButton variant="ghost"
            className={cn("w-7 h-7 flex items-center justify-center rounded", node.style?.fontStyle === 'italic' && "bg-accent")}
            onClick={(e) => { e.stopPropagation(); updateNode(node.id, { style: { ...node.style, fontStyle: node.style?.fontStyle === 'italic' ? undefined : 'italic' } }); }}
            title={t('contextMenu.italic')}
          ><TextItalic size={16} /></NotionButton>
          <NotionButton variant="ghost"
            className={cn("w-7 h-7 flex items-center justify-center rounded", node.style?.textDecoration === 'underline' && "bg-accent")}
            onClick={(e) => { e.stopPropagation(); updateNode(node.id, { style: { ...node.style, textDecoration: node.style?.textDecoration === 'underline' ? undefined : 'underline' } }); }}
            title={t('contextMenu.underline')}
          ><TextUnderline size={16} /></NotionButton>
          <NotionButton variant="ghost"
            className={cn("w-7 h-7 flex items-center justify-center rounded", node.style?.textDecoration === 'line-through' && "bg-accent")}
            onClick={(e) => { e.stopPropagation(); updateNode(node.id, { style: { ...node.style, textDecoration: node.style?.textDecoration === 'line-through' ? undefined : 'line-through' } }); }}
            title={t('contextMenu.strikethrough')}
          ><TextStrikethrough size={16} /></NotionButton>
          <div className="w-px h-4 bg-border mx-0.5" />
          {([['h1', TextHOne], ['h2', TextHTwo], ['h3', TextHThree]] as const).map(([level, Icon]) => (
            <NotionButton variant="ghost" key={level}
              className={cn("w-7 h-7 flex items-center justify-center rounded", node.style?.headingLevel === level && "bg-accent")}
              onClick={(e) => { e.stopPropagation(); updateNode(node.id, { style: { ...node.style, headingLevel: node.style?.headingLevel === level ? undefined : level } }); }}
              title={t(`contextMenu.${level === 'h1' ? 'heading1' : level === 'h2' ? 'heading2' : 'heading3'}`)}
            ><Icon size={16} /></NotionButton>
          ))}
          <NotionButton variant="ghost"
            className={cn("w-7 h-7 flex items-center justify-center rounded", !node.style?.headingLevel && "bg-accent")}
            onClick={(e) => { e.stopPropagation(); updateNode(node.id, { style: { ...node.style, headingLevel: undefined } }); }}
            title={t('contextMenu.normalText')}
          ><TextT size={16} /></NotionButton>
        </div>
        <AppMenuSeparator />
        <div className="flex items-center gap-2 px-2 pt-1.5 pb-0.5 text-[13px] text-muted-foreground select-none">
          <Palette size={16} className="flex-shrink-0" />
          <span>{t('contextMenu.textColor')}</span>
        </div>
        <div className="flex items-center gap-1 px-2 py-1.5">
          {QUICK_TEXT_COLORS.map(color => (
            <NotionButton variant="ghost"
              key={color}
              className={cn(
                "w-[18px] h-[18px] rounded-full border-2 transition-transform hover:scale-125 flex-shrink-0",
                node.style?.textColor === color ? "border-primary scale-110" : "border-transparent"
              )}
              style={{ backgroundColor: color }}
              onClick={(e) => {
                e.stopPropagation();
                updateNode(node.id, { style: { ...node.style, textColor: color } });
              }}
            />
          ))}
          <NotionButton variant="ghost"
            className="w-[18px] h-[18px] rounded-full border border-border flex items-center justify-center text-muted-foreground hover:bg-[var(--interactive-hover)] flex-shrink-0"
            onClick={(e) => {
              e.stopPropagation();
              updateNode(node.id, { style: { ...node.style, textColor: undefined } });
            }}
          >
            <X className="w-2.5 h-2.5" />
          </NotionButton>
        </div>
        <div className="flex items-center gap-2 px-2 pt-1.5 pb-0.5 text-[13px] text-muted-foreground select-none">
          <Highlighter size={16} className="flex-shrink-0" />
          <span>{t('contextMenu.highlight')}</span>
        </div>
        <div className="flex items-center gap-1 px-2 py-1.5">
          {QUICK_BG_COLORS.map(color => (
            <NotionButton variant="ghost"
              key={color}
              className={cn(
                "w-[18px] h-[18px] rounded-full border-2 transition-transform hover:scale-125 flex-shrink-0",
                node.style?.bgColor === color ? "border-primary scale-110" : "border-transparent"
              )}
              style={{ backgroundColor: color }}
              onClick={(e) => {
                e.stopPropagation();
                updateNode(node.id, { style: { ...node.style, bgColor: color } });
              }}
            />
          ))}
          <NotionButton variant="ghost"
            className="w-[18px] h-[18px] rounded-full border border-border flex items-center justify-center text-muted-foreground hover:bg-[var(--interactive-hover)] flex-shrink-0"
            onClick={(e) => {
              e.stopPropagation();
              updateNode(node.id, { style: { ...node.style, bgColor: undefined } });
            }}
          >
            <X className="w-2.5 h-2.5" />
          </NotionButton>
        </div>
        <AppMenuSeparator />
        <AppMenuItem
          icon={<Copy className="w-4 h-4" />}
          shortcut={shortcuts.copy}
          onClick={() => copyNodes([node.id])}
        >
          {t('contextMenu.copy')}
        </AppMenuItem>
        <AppMenuItem
          icon={<Scissors className="w-4 h-4" />}
          shortcut={shortcuts.cut}
          disabled={isRoot}
          onClick={() => cutNodes([node.id])}
        >
          {t('contextMenu.cut')}
        </AppMenuItem>
        <AppMenuItem
          icon={<ClipboardText size={16} />}
          shortcut={shortcuts.paste}
          disabled={!hasClipboard}
          onClick={() => pasteNodes(node.id)}
        >
          {t('contextMenu.pasteAsChild')}
        </AppMenuItem>
        {hasChildren && (
          <>
            <AppMenuSeparator />
            <AppMenuItem
              icon={isCollapsed
                ? <CaretRight size={16} />
                : <CaretDown size={16} />}
              shortcut={isCollapsed ? shortcuts.expand : shortcuts.collapse}
              onClick={() => toggleCollapse(node.id)}
            >
              {isCollapsed ? t('actions.expand') : t('actions.collapse')}
            </AppMenuItem>
          </>
        )}
        {!isRoot && (
          <>
            <AppMenuSeparator />
            <AppMenuItem
              icon={<Trash size={16} />}
              shortcut="Del"
              destructive
              onClick={() => deleteNode(node.id)}
            >
              {t('actions.delete')}
            </AppMenuItem>
          </>
        )}
      </AppMenuContent>
    </AppMenu>
  );
};
