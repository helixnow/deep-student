import type React from 'react';
import type { DstuNode } from '@/dstu';
import { MagnifyingGlass, PenNib, Plus, X, Trash } from '@phosphor-icons/react';
import {
  AppMenu,
  AppMenuContent,
  AppMenuItem,
  AppMenuTrigger,
} from '@/components/ui/app-menu';
import { Input } from '@/components/ui/shad/Input';
import { DsButton } from '@/components/ui/DsButton';
import {
  FolderIcon,
  NoteIcon,
  ExamIcon,
  TextbookIcon,
  TranslationIcon,
  EssayIcon,
  MindmapIcon,
} from '../icons';
import type { SidebarT } from './sidebarConstants';

export interface SidebarMobileToolbarProps {
  t: SidebarT;
  mobileSearchExpanded: boolean;
  setMobileSearchExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  searchPlaceholder: string;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  canSearchInCurrentView: boolean;
  mobileCreateMenuOpen: boolean;
  setMobileCreateMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  mobileCreateMenuTriggerRef: React.MutableRefObject<HTMLButtonElement | null>;
  canCreateInCurrentView: boolean;
  handleNewFolder: () => void;
  handleNewNote: () => Promise<void>;
  setCreatingLearningNote: React.Dispatch<React.SetStateAction<boolean>>;
  handleImportMarkdownNote: (folderId?: string | null) => Promise<void>;
  handleNewExam: () => Promise<void>;
  handleNewTextbook: () => Promise<void>;
  handleNewTranslation: () => Promise<void>;
  handleNewEssay: () => Promise<void>;
  handleNewMindMap: () => Promise<void>;
  handleNewInk: () => Promise<void>;
  isTrashView: boolean;
  handleEmptyTrash: () => void;
  items: DstuNode[];
}

/** P1-20: 移动端顶部工具栏（搜索 + 新建文件夹 + 新建笔记 + 清空回收站） */
export function SidebarMobileToolbar({
  t,
  mobileSearchExpanded,
  setMobileSearchExpanded,
  searchPlaceholder,
  searchQuery,
  setSearchQuery,
  canSearchInCurrentView,
  mobileCreateMenuOpen,
  setMobileCreateMenuOpen,
  mobileCreateMenuTriggerRef,
  canCreateInCurrentView,
  handleNewFolder,
  handleNewNote,
  setCreatingLearningNote,
  handleImportMarkdownNote,
  handleNewExam,
  handleNewTextbook,
  handleNewTranslation,
  handleNewEssay,
  handleNewMindMap,
  handleNewInk,
  isTrashView,
  handleEmptyTrash,
  items,
}: SidebarMobileToolbarProps) {
  return (
    <div
      className="flex shrink-0 items-center gap-1 border-b border-[color:var(--shell-chrome-border)] bg-[color:var(--shell-titlebar-surface)] px-2 py-1.5"
    >
      {mobileSearchExpanded ? (
        // 搜索框展开态
        <div className="flex-1 flex items-center gap-1">
          <Input
            type="search"
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            // iOS 保留 16px 地板，同时继续响应界面字号缩放。
            className="h-[var(--touch-target-size)] text-[max(16px,var(--font-size-lg))] flex-1"
            autoFocus
            disabled={!canSearchInCurrentView}
          />
          <DsButton
            variant="ghost"
            size="icon"
            iconOnly
            onClick={() => {
              setMobileSearchExpanded(false);
              setSearchQuery('');
            }}
            aria-label={t('common:close')}
          >
            <X className="w-5 h-5" />
          </DsButton>
        </div>
      ) : (
        // 工具栏按钮（移动端触控目标 ≥44px；刷新在顶栏，此处仅搜索/新建）
        <>
          <DsButton
            variant="ghost"
            size="icon"
            iconOnly
            onClick={() => setMobileSearchExpanded(true)}
            title={t('finder.search.title')}
            aria-label={t('finder.search.title')}
            disabled={!canSearchInCurrentView}
          >
            <MagnifyingGlass className="w-5 h-5" />
          </DsButton>
          <AppMenu open={mobileCreateMenuOpen} onOpenChange={setMobileCreateMenuOpen}>
            <AppMenuTrigger asChild>
              <DsButton
                ref={mobileCreateMenuTriggerRef}
                variant="ghost"
                size="icon"
                iconOnly
                title={t('finder.toolbar.new')}
                aria-label={t('finder.toolbar.new')}
                disabled={!canCreateInCurrentView}
              >
                <Plus className="w-5 h-5" />
              </DsButton>
            </AppMenuTrigger>
            <AppMenuContent align="end" className="min-w-[180px]">
              <AppMenuItem
                icon={<FolderIcon size={16} />}
                onClick={handleNewFolder}
              >
                {t('finder.toolbar.newFolder')}
              </AppMenuItem>
              <AppMenuItem
                icon={<NoteIcon size={16} />}
                onClick={handleNewNote}
              >
                {t('finder.toolbar.newNote')}
              </AppMenuItem>
              <AppMenuItem
                icon={<NoteIcon size={16} />}
                onClick={() => setCreatingLearningNote(true)}
              >
                {t('notes:learning.create.menu', { defaultValue: '新建学习笔记…' })}
              </AppMenuItem>
              <AppMenuItem
                icon={<NoteIcon size={16} />}
                onClick={() => {
                  void handleImportMarkdownNote();
                }}
              >
                {t('finder.toolbar.importMarkdown')}
              </AppMenuItem>
              <AppMenuItem
                icon={<ExamIcon size={16} />}
                onClick={handleNewExam}
              >
                {t('finder.toolbar.newExam')}
              </AppMenuItem>
              <AppMenuItem
                icon={<TextbookIcon size={16} />}
                onClick={handleNewTextbook}
              >
                {t('finder.toolbar.newTextbook')}
              </AppMenuItem>
              <AppMenuItem
                icon={<TranslationIcon size={16} />}
                onClick={handleNewTranslation}
              >
                {t('finder.toolbar.newTranslation')}
              </AppMenuItem>
              <AppMenuItem
                icon={<EssayIcon size={16} />}
                onClick={handleNewEssay}
              >
                {t('finder.toolbar.newEssay')}
              </AppMenuItem>
              <AppMenuItem
                icon={<MindmapIcon size={16} />}
                onClick={handleNewMindMap}
              >
                {t('finder.toolbar.newMindMap')}
              </AppMenuItem>
              <AppMenuItem icon={<PenNib size={16} />} onClick={() => { void handleNewInk(); }}>
                {t('finder.toolbar.newInk')}
              </AppMenuItem>
            </AppMenuContent>
          </AppMenu>
          {/* 回收站视图显示清空按钮 */}
          {isTrashView && (
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              className="text-destructive hover:text-destructive"
              onClick={handleEmptyTrash}
              title={t('finder.actions.emptyTrash')}
              aria-label={t('finder.actions.emptyTrash')}
            >
              <Trash className="w-5 h-5" />
            </DsButton>
          )}
          <div className="flex-1" />
          {/* 项目数显示 */}
          <span className="text-xs text-muted-foreground">
            {items.length}
          </span>
        </>
      )}
    </div>
  );
}
