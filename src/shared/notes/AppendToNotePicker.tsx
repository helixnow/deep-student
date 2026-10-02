/**
 * 「追加到已有笔记」笔记选择器（SaveAsNoteFolderPicker 的另一步）。
 *
 * - 列表：DSTU 智能文件夹模式 `dstu.list('/', { typeFilter: 'note' })`，后端按
 *   updated_at 倒序（最近编辑在前）；输入关键词后同一接口带 search（标题/正文）
 * - 桌面：DsDialog；窄屏（inline）：absolute inset-0 全屏子屏，外层由
 *   SaveAsNoteFolderPicker 套 fixed 承载 + 统一顶栏隔离（与 FolderPickerDialog 同契约），
 *   顶栏自绘「返回 + 标题」，Android 返回键 = 回到「新建笔记」目录选择步骤
 * - 移动端不自动聚焦搜索框（避免一进来就弹软键盘遮住列表）
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CaretLeft, CircleNotch, FileText, NotePencil } from '@phosphor-icons/react';
import { DsDialog, DsDialogHeader, DsDialogTitle, DsDialogFooter } from '@/components/ui/DsDialog';
import { DsButton } from '@/components/ui/DsButton';
import { Input } from '@/components/ui/shad/Input';
import { TouchTarget } from '@/components/ui/TouchTarget';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import { dstu, type DstuNode } from '@/dstu';
import { cn } from '@/lib/utils';

/** 列表条数上限：选择器只服务「找到要积累的那篇」，不做全量分页 */
export const APPEND_NOTE_LIST_LIMIT = 50;
/** 搜索防抖 */
const SEARCH_DEBOUNCE_MS = 200;

export interface AppendTargetNote {
  id: string;
  name: string;
}

export interface AppendToNotePickerProps {
  open: boolean;
  /** 窄屏全屏子屏 */
  inline: boolean;
  title: string;
  /** 回到「新建笔记」目录选择步骤 */
  onBack: () => void;
  /** 关闭整个流程 */
  onCancel: () => void;
  onConfirm: (note: AppendTargetNote) => void;
}

/** 从 DSTU 路径取所在目录（"/高考复习/函数/note_x" → "高考复习 / 函数"；根目录返回空串） */
function folderLabelOf(node: DstuNode): string {
  const segments = (node.path || '').split('/').filter(Boolean);
  return segments.slice(0, -1).join(' / ');
}

export const AppendToNotePicker: React.FC<AppendToNotePickerProps> = ({
  open,
  inline,
  title,
  onBack,
  onCancel,
  onConfirm,
}) => {
  const { t, i18n } = useTranslation(['chatV2', 'learningHub', 'common']);
  const [query, setQuery] = useState('');
  const [notes, setNotes] = useState<DstuNode[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const requestSeqRef = useRef(0);

  const load = useCallback(async (search: string) => {
    const seq = ++requestSeqRef.current;
    setIsLoading(true);
    setError(null);
    const keyword = search.trim();
    const result = await dstu.list('/', {
      typeFilter: 'note',
      search: keyword || undefined,
      limit: APPEND_NOTE_LIST_LIMIT,
      sortBy: 'updatedAt',
      sortOrder: 'desc',
    });
    // 只认最后一次请求，丢弃慢返回的旧关键词结果
    if (seq !== requestSeqRef.current) return;
    if (result.ok) {
      // 记忆笔记（AI 长期记忆）与内部目录不作为追加目标：学习内容追加进去会污染记忆
      const memoryRoot = await import('@/api/memoryApi')
        .then(({ getMemoryConfig }) => getMemoryConfig())
        .then((config) => config.memoryRootFolderTitle?.trim() || null)
        .catch(() => null);
      if (seq !== requestSeqRef.current) return;
      setNotes(result.value.filter((node) => {
        if (node.type !== 'note') return false;
        const top = (node.path ?? '').split('/')[0]?.trim();
        return top !== '__system__' && !(memoryRoot && top === memoryRoot && node.path.includes('/'));
      }));
    } else {
      setNotes([]);
      setError(result.error.toUserMessage());
    }
    setIsLoading(false);
  }, []);

  // 打开时重置；关键词变化防抖后重新查询（首次打开立即查）
  const openedRef = useRef(false);
  useEffect(() => {
    if (!open) {
      openedRef.current = false;
      requestSeqRef.current += 1;
      return;
    }
    const first = !openedRef.current;
    openedRef.current = true;
    if (first) {
      setSelectedId(null);
      void load(query);
      return;
    }
    const timer = window.setTimeout(() => { void load(query); }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [open, query, load]);

  // 📱 内联子屏：Android 返回键 = 回到上一步（目录选择）
  useEffect(() => {
    if (!open || !inline) return;
    return registerBackHandler(() => {
      onBack();
      return true;
    }, BACK_PRIORITY.overlay);
  }, [open, inline, onBack]);

  const selected = notes.find((note) => note.id === selectedId) ?? null;

  const handleConfirm = useCallback(() => {
    if (!selected) return;
    onConfirm({ id: selected.id, name: selected.name });
  }, [selected, onConfirm]);

  const formatDate = (ms: number) => {
    if (!Number.isFinite(ms) || ms <= 0) return '';
    try {
      return new Date(ms).toLocaleDateString(i18n.language || undefined, { month: 'short', day: 'numeric' });
    } catch {
      return '';
    }
  };

  const searchBox = (
    <div className={cn('shrink-0 pb-2', inline ? 'px-3 pt-2' : 'px-5 pt-1')}>
      <Input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('chatV2:selectionToolbar.appendToNoteSearchPlaceholder', '搜索笔记标题或内容')}
        aria-label={t('chatV2:selectionToolbar.appendToNoteSearchPlaceholder', '搜索笔记标题或内容')}
        autoFocus={!inline}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && selected) {
            e.preventDefault();
            handleConfirm();
          }
        }}
      />
      {!query.trim() && (
        <div className="px-1 pt-2 text-xs text-muted-foreground">
          {t('chatV2:selectionToolbar.appendToNoteRecent', '最近编辑')}
        </div>
      )}
    </div>
  );

  const listBody = isLoading && notes.length === 0 ? (
    <div className="flex items-center justify-center h-32 px-5">
      <CircleNotch size={20} className="animate-spin text-muted-foreground" />
    </div>
  ) : error ? (
    <div className="flex items-center justify-center h-32 px-5 text-sm text-destructive text-center">
      {error}
    </div>
  ) : notes.length === 0 ? (
    <div className="flex items-center justify-center h-32 px-5 text-sm text-muted-foreground text-center">
      {t('chatV2:selectionToolbar.appendToNoteEmpty', '没有找到笔记')}
    </div>
  ) : (
    <div
      className={cn('py-1', inline ? 'px-3' : 'px-5')}
      role="listbox"
      aria-label={title}
      data-testid="append-note-list"
    >
      {notes.map((note) => {
        const isSelected = note.id === selectedId;
        const folder = folderLabelOf(note);
        const date = formatDate(note.updatedAt);
        return (
          <TouchTarget asChild key={note.id}>
            <div
              role="option"
              aria-selected={isSelected}
              tabIndex={0}
              data-note-id={note.id}
              className={cn(
                'flex w-full items-center justify-start gap-2 py-2 px-3 rounded-md cursor-pointer',
                'transition-all duration-150 ease-out active:scale-[0.99]',
                'focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.35)]',
                isSelected && 'bg-primary/10 text-primary shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.2)]',
                !isSelected && 'hover:bg-[var(--interactive-hover)]',
              )}
              onClick={() => setSelectedId(note.id)}
              onDoubleClick={() => onConfirm({ id: note.id, name: note.name })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  if (isSelected) onConfirm({ id: note.id, name: note.name });
                  else setSelectedId(note.id);
                } else if (e.key === ' ') {
                  e.preventDefault();
                  setSelectedId(note.id);
                }
              }}
            >
              <FileText
                size={16}
                className={cn('shrink-0', isSelected ? 'text-primary' : 'text-muted-foreground')}
              />
              <div className="min-w-0 flex-1">
                <div className="text-sm truncate">
                  {note.name || t('chatV2:selectionToolbar.saveAsNoteDefaultTitle', '未命名笔记')}
                </div>
                <div className="text-xs text-muted-foreground truncate">
                  {folder || t('learningHub:finder.folderPicker.root', '根目录')}
                </div>
              </div>
              {date && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{date}</span>}
            </div>
          </TouchTarget>
        );
      })}
    </div>
  );

  const backToCreate = (
    <DsButton variant="ghost" size="sm" onClick={onBack} className="gap-1.5 px-2 max-w-full">
      <NotePencil size={14} className="shrink-0" aria-hidden="true" />
      <span className="truncate">{t('chatV2:selectionToolbar.appendToNoteBackToCreate', '改为新建笔记')}</span>
    </DsButton>
  );

  const confirmLabel = t('chatV2:selectionToolbar.appendToNoteConfirm', '追加');

  if (!open) return null;

  if (inline) {
    return (
      <div
        className="absolute inset-0 z-40 flex min-h-0 flex-col overflow-hidden bg-background"
        role="dialog"
        aria-label={title}
        data-testid="append-note-picker"
        data-inline="true"
      >
        <div className="flex items-center gap-1 border-b border-border/50 pl-1 pr-2 py-1.5 shrink-0">
          <DsButton
            variant="ghost"
            size="sm"
            onClick={onBack}
            aria-label={t('common:back')}
            className="gap-1 px-2 shrink-0"
          >
            <CaretLeft className="h-4 w-4" aria-hidden="true" />
            {t('common:back')}
          </DsButton>
          <h2 className="text-sm font-semibold truncate">{title}</h2>
        </div>

        {searchBox}

        <CustomScrollArea className="flex-1 min-h-0" fullHeight>
          {listBody}
        </CustomScrollArea>

        <div className="flex items-center justify-end gap-2 border-t border-border/50 px-3 py-2 shrink-0 bg-background pb-[calc(0.5rem+var(--mobile-safe-area-bottom,0px))]">
          <div className="mr-auto min-w-0">{backToCreate}</div>
          <DsButton variant="ghost" size="sm" onClick={onCancel} className="px-4">
            {t('common:cancel')}
          </DsButton>
          <DsButton variant="primary" size="sm" onClick={handleConfirm} disabled={!selected} className="px-4">
            {confirmLabel}
          </DsButton>
        </div>
      </div>
    );
  }

  return (
    <DsDialog
      open={open}
      onOpenChange={(next) => { if (!next) onCancel(); }}
      maxWidth="max-w-md"
    >
      <div data-testid="append-note-picker" data-inline="false" className="contents">
        <DsDialogHeader>
          <DsDialogTitle className="flex items-center gap-2">
            <NotePencil size={16} className="text-muted-foreground" />
            {title}
          </DsDialogTitle>
        </DsDialogHeader>

        {searchBox}

        <div className="h-[320px] max-h-[50vh] overflow-hidden mb-3">
          <CustomScrollArea className="h-full" fullHeight>
            {listBody}
          </CustomScrollArea>
        </div>

        <DsDialogFooter>
          <div className="mr-auto min-w-0">{backToCreate}</div>
          <DsButton variant="ghost" size="sm" onClick={onCancel}>
            {t('common:cancel')}
          </DsButton>
          <DsButton variant="primary" size="sm" onClick={handleConfirm} disabled={!selected}>
            {confirmLabel}
          </DsButton>
        </DsDialogFooter>
      </div>
    </DsDialog>
  );
};
