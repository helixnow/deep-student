/**
 * 「保存为笔记」目录选择流程（共享）。
 *
 * 用法：
 * ```tsx
 * const saveAsNote = useSaveAsNoteFlow({ openSource: 'pdf-selection' });
 * // 触发：saveAsNote.start({ content, title });
 * // 渲染：<SaveAsNoteFolderPicker {...saveAsNote.pickerProps} />
 * ```
 *
 * 移动端契约：
 * - 窄屏走 FolderPickerDialog 的 inline 全屏子屏（不用桌面 Dialog，窄屏不会溢出），
 *   外层套 fixed inset-0 让它脱离宿主气泡/面板的裁剪
 * - Android 返回键先关 picker：inline 形态由 FolderPickerDialog 自己
 *   registerBackHandler(BACK_PRIORITY.overlay) 承接
 * - inline 分支用 MobileSubviewChromeProvider value={null} 隔离统一顶栏通道：
 *   fixed 全屏承载脱离了宿主页面布局，即使树上有宿主（learning-hub 移动分支）
 *   也不能把顶栏推给它——fixed 层会盖住统一顶栏，且 screen:'center' 与
 *   PDF 划词所在的右屏不匹配。隔离后 FolderPickerDialog 视为无宿主，
 *   恢复自绘「返回 + 标题」行（Wave2-C R6 08-chrome §A）
 *
 * 两种落点（同一对话框内显式选择，默认仍是新建）：
 * - 新建笔记（默认）：选目录 → saveTextAsNote
 * - 追加到已有笔记：目录选择器底部条左侧的入口切到 AppendToNotePicker，
 *   选笔记 → appendTextToNote（正文末尾 `---` 分隔追加，不改目标笔记 _origin）。
 *   窄屏同样走 fixed 承载 + 统一顶栏隔离；返回键/返回箭头回到目录选择步骤
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NotePencil } from '@phosphor-icons/react';
import { MobileSubviewChromeProvider } from '@/components/layout';
import { DsButton } from '@/components/ui/DsButton';
import { FolderPickerDialog } from '@/features/learning-hub/components/finder/FolderPickerDialog';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { saveTextAsNoteAndNotify, type SaveTextAsNoteResult } from './saveTextAsNote';
import { appendTextToNoteAndNotify, type AppendTextToNoteResult } from './appendTextToNote';
import { AppendToNotePicker, type AppendTargetNote } from './AppendToNotePicker';
import type { NoteOrigin } from '@/features/notes/noteOrigin';

export interface SaveAsNoteRequest {
  /** 笔记正文 */
  content: string;
  /** 标题；缺省时从正文首行推导 */
  title?: string;
  /** 标签 */
  tags?: string[];
  /** 来源（见 saveTextAsNote） */
  origin?: NoteOrigin;
}

export interface SaveAsNoteFolderPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (folderId: string | null) => void;
  title: string;
  /** 窄屏用全屏子屏而非桌面 Dialog */
  inline: boolean;
  /** 「追加到已有笔记」确认；缺省时不提供追加入口 */
  onConfirmAppend?: (note: AppendTargetNote) => void;
  /** 追加步骤的标题 */
  appendTitle?: string;
}

export interface SaveAsNoteFlow {
  /** 打开目录选择器；确认后写入并弹出带「打开笔记」的 toast */
  start: (request: SaveAsNoteRequest) => void;
  /** 是否有一次保存正在进行（目录已选、正在写入） */
  isSaving: boolean;
  /** 直接展开到 <SaveAsNoteFolderPicker /> 上 */
  pickerProps: SaveAsNoteFolderPickerProps;
}

export interface UseSaveAsNoteFlowOptions {
  /** DSTU_OPEN_NOTE 的 source（决定 Chat / Workbench 谁来打开，见 openNoteEvent.ts） */
  openSource?: string;
  /** 保存完成回调（成功或失败都会调用） */
  onSaved?: (result: SaveTextAsNoteResult) => void;
  /** 追加完成回调（成功或失败都会调用） */
  onAppended?: (result: AppendTextToNoteResult) => void;
}

export function useSaveAsNoteFlow(options?: UseSaveAsNoteFlowOptions): SaveAsNoteFlow {
  const { t } = useTranslation(['chatV2', 'learningHub']);
  const { isSmallScreen } = useBreakpoint();
  const [pending, setPending] = useState<SaveAsNoteRequest | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const openSource = options?.openSource;
  const onSaved = options?.onSaved;
  const onAppended = options?.onAppended;

  const start = useCallback((request: SaveAsNoteRequest) => {
    if (!request.content?.trim()) return;
    setPending(request);
  }, []);

  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) setPending(null);
  }, []);

  const handleConfirm = useCallback((folderId: string | null) => {
    const request = pending;
    setPending(null);
    if (!request) return;
    setIsSaving(true);
    void saveTextAsNoteAndNotify(
      { content: request.content, title: request.title, tags: request.tags, folderId, origin: request.origin },
      { openSource },
    ).then((result) => {
      setIsSaving(false);
      onSaved?.(result);
    });
  }, [pending, openSource, onSaved]);

  // 追加：只写正文（来源行随正文），origin 仅用于补聊天来源行，不改目标笔记 _origin
  const handleConfirmAppend = useCallback((note: AppendTargetNote) => {
    const request = pending;
    setPending(null);
    if (!request) return;
    setIsSaving(true);
    void appendTextToNoteAndNotify(
      { noteId: note.id, content: request.content, origin: request.origin, title: request.title },
      { openSource },
    ).then((result) => {
      setIsSaving(false);
      onAppended?.(result);
    });
  }, [pending, openSource, onAppended]);

  const pickerProps = useMemo<SaveAsNoteFolderPickerProps>(() => ({
    open: pending !== null,
    onOpenChange: handleOpenChange,
    onConfirm: handleConfirm,
    onConfirmAppend: handleConfirmAppend,
    title: t('chatV2:selectionToolbar.saveAsNotePickFolder', '选择保存目录'),
    appendTitle: t('chatV2:selectionToolbar.appendToNote', '追加到已有笔记'),
    inline: isSmallScreen,
  }), [pending, handleOpenChange, handleConfirm, handleConfirmAppend, t, isSmallScreen]);

  return { start, isSaving, pickerProps };
}

/**
 * 目录选择器渲染壳。
 *
 * 窄屏：外层 fixed inset-0 让 FolderPickerDialog 的 inline 子屏铺满视口，
 * 不受宿主（消息气泡 / PDF 面板）的 overflow 裁剪影响。
 * 同时用 MobileSubviewChromeProvider value={null} 切断统一顶栏通道：
 * fixed 承载自成一屏，标题/返回必须由 FolderPickerDialog 自绘
 * （hosted=false），不得推给会被本层盖住的宿主顶栏。
 * 桌面 Dialog 分支不隔离——中屏「移动到…」等真接管场景不走本壳。
 */
export const SaveAsNoteFolderPicker: React.FC<SaveAsNoteFolderPickerProps> = ({
  open,
  onOpenChange,
  onConfirm,
  title,
  inline,
  onConfirmAppend,
  appendTitle,
}) => {
  const { t } = useTranslation('chatV2');
  // 每次打开都从「新建笔记」开始：默认行为不变，追加是显式选择
  const [mode, setMode] = useState<'create' | 'append'>('create');
  useEffect(() => {
    if (!open) setMode('create');
  }, [open]);
  const backToCreate = useCallback(() => setMode('create'), []);
  const cancelAll = useCallback(() => onOpenChange(false), [onOpenChange]);

  if (!open) return null;

  const appendEntry = onConfirmAppend ? (
    <DsButton
      variant="ghost"
      size="sm"
      onClick={() => setMode('append')}
      className="gap-1.5 px-2 max-w-full"
    >
      <NotePencil size={14} className="shrink-0" aria-hidden="true" />
      <span className="truncate">{t('selectionToolbar.appendToNote', '追加到已有笔记')}</span>
    </DsButton>
  ) : undefined;

  const body = mode === 'append' && onConfirmAppend ? (
    <AppendToNotePicker
      open={open}
      inline={inline}
      title={appendTitle || t('selectionToolbar.appendToNote', '追加到已有笔记')}
      onBack={backToCreate}
      onCancel={cancelAll}
      onConfirm={onConfirmAppend}
    />
  ) : (
    <FolderPickerDialog
      open={open}
      onOpenChange={onOpenChange}
      onConfirm={onConfirm}
      title={title}
      inline={inline || undefined}
      footerStart={appendEntry}
    />
  );

  if (inline) {
    return (
      <MobileSubviewChromeProvider value={null}>
        <div className="fixed inset-0 z-[var(--z-modal,1200)]">
          {body}
        </div>
      </MobileSubviewChromeProvider>
    );
  }

  return body;
};
