import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowsClockwise,
  Cards,
  ClockCounterClockwise,
  CornersIn,
  CornersOut,
  DownloadSimple,
  MagnifyingGlass,
  NoteBlank,
  Robot,
  Trash,
  TreeStructure,
} from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { openQuickAssistantWindow } from '@/quick-assistant/window';
import { isMacOS, isMobilePlatform } from '@/utils/platform';
import { moveNoteToTrash } from '../moveNoteToTrash';
import { NotePageLayoutOptions } from './NotePageLayoutOptions';

export interface NotesPageActionsMenuProps {
  noteId?: string;
  noteTitle?: string;
  readOnly: boolean;
  effectiveReadOnly: boolean;
  editorReady: boolean;
  hasMobileResourceMenu: boolean;
  isTouchEditingSurface: boolean;
  templateMenuOpen: boolean;
  templatePanelId: string;
  onToggleTemplateMenu: () => void;
  generatingCards: boolean;
  onGenerateCards: () => void;
  generatingMindmap: boolean;
  onGenerateMindmap: () => void;
  syncingHandout: boolean;
  onSyncHandoutToMindmap: () => void;
  onOpenHistory: () => void;
  isFindReplaceOpen: boolean;
  onToggleFindReplace: () => void;
  readingModeAction?: React.ReactNode;
  focusMode: boolean;
  onToggleFocusMode: () => void;
  hasMoreWindowedContent?: boolean;
  hostBusy: boolean;
  onMaterializeFullDocument: () => void;
  onMoveToTrash?: () => void | Promise<void>;
  movingToTrash?: boolean;
  acrWindowId?: string;
  /** Optional extra view-group entries (e.g. Source Mode toggle). */
  extraViewActions?: React.ReactNode;
}

export const NotesPageActionsMenu: React.FC<NotesPageActionsMenuProps> = ({
  noteId,
  noteTitle,
  readOnly,
  effectiveReadOnly,
  editorReady,
  hasMobileResourceMenu,
  isTouchEditingSurface,
  templateMenuOpen,
  templatePanelId,
  onToggleTemplateMenu,
  generatingCards,
  onGenerateCards,
  generatingMindmap,
  onGenerateMindmap,
  syncingHandout,
  onSyncHandoutToMindmap,
  onOpenHistory,
  isFindReplaceOpen,
  onToggleFindReplace,
  readingModeAction,
  focusMode,
  onToggleFocusMode,
  hasMoreWindowedContent,
  hostBusy,
  onMaterializeFullDocument,
  onMoveToTrash,
  movingToTrash = false,
  acrWindowId,
  extraViewActions,
}) => {
  const { t, i18n } = useTranslation(['notes']);
  const menuItemRole = hasMobileResourceMenu ? 'menuitem' : undefined;
  const [internalMovingToTrash, setInternalMovingToTrash] = React.useState(false);
  const isMovingToTrash = Boolean(movingToTrash || internalMovingToTrash);

  return (
    <div className="notes-page-actions">
      <NotePageLayoutOptions noteId={noteId ?? undefined} showFullWidth={!isTouchEditingSurface} />

      <div className="notes-action-group-label">{t('notes:chrome.note_tools')}</div>
      {!readOnly && (
        <DsButton
          variant="ghost"
          size="sm"
          disabled={effectiveReadOnly || !editorReady}
          role={menuItemRole}
          aria-expanded={templateMenuOpen}
          aria-controls={templatePanelId}
          onClick={onToggleTemplateMenu}
        >
          <NoteBlank size={16} />
          <span>{t('notes:toolbar.note_templates', 'Note templates')}</span>
        </DsButton>
      )}
      {(!isTouchEditingSurface || effectiveReadOnly) && (
        <DsButton
          variant="ghost"
          size="sm"
          role={menuItemRole}
          onClick={onGenerateCards}
          disabled={!editorReady || generatingCards}
          aria-busy={generatingCards || undefined}
        >
          <Cards size={16} />
          <span>{t('notes:toolbar.generateCards', '生成卡片')}</span>
        </DsButton>
      )}
      <DsButton
        variant="ghost"
        size="sm"
        role={menuItemRole}
        onClick={onGenerateMindmap}
        disabled={!editorReady || generatingMindmap}
        aria-busy={generatingMindmap || undefined}
      >
        <TreeStructure size={16} />
        <span>{t('notes:toolbar.generateMindmap', '生成思维导图')}</span>
      </DsButton>
      <DsButton
        variant="ghost"
        size="sm"
        role={menuItemRole}
        onClick={onSyncHandoutToMindmap}
        disabled={!editorReady || !noteId || syncingHandout}
        aria-busy={syncingHandout || undefined}
      >
        <ArrowsClockwise size={16} />
        <span>{t('notes:toolbar.syncHandoutToMindmap', '同步回思维导图')}</span>
      </DsButton>
      {/* 快捷助手窗口仅桌面端可用（移动端后端为空实现）：移动端不展示，桌面失败要告知 */}
      {!isMobilePlatform() && (
        <DsButton
          variant="ghost"
          size="sm"
          role={menuItemRole}
          onClick={() => {
            void openQuickAssistantWindow().catch((error) =>
              showGlobalNotification(
                'error',
                t('notes:toolbar.ask_agent_failed', {
                  defaultValue: '无法打开助手窗口：{{error}}',
                  error: String(error),
                }),
              ),
            );
          }}
        >
          <Robot size={16} />
          <span>{t('notes:toolbar.ask_agent', 'Ask Agent')}</span>
        </DsButton>
      )}
      {noteId && (
        <DsButton
          variant="ghost"
          size="sm"
          role={menuItemRole}
          onClick={onOpenHistory}
        >
          <ClockCounterClockwise size={16} />
          <span>{t('notes:header.history', '历史版本')}</span>
        </DsButton>
      )}

      <div className="notes-action-group-label">{t('notes:chrome.view')}</div>
      <DsButton
        variant="ghost"
        size="sm"
        role={menuItemRole}
        onClick={onToggleFindReplace}
        aria-pressed={isFindReplaceOpen}
      >
        <MagnifyingGlass size={16} />
        <span>{t('notes:toolbar.find_replace')}</span>
        <kbd>{isMacOS() ? '⌘F' : 'Ctrl+F'}</kbd>
      </DsButton>
      {(isTouchEditingSurface || hasMobileResourceMenu) && readingModeAction}
      <DsButton
        variant="ghost"
        size="sm"
        role={menuItemRole}
        onClick={onToggleFocusMode}
        aria-pressed={focusMode}
      >
        {focusMode ? <CornersIn size={16} /> : <CornersOut size={16} />}
        <span>
          {focusMode
            ? t('notes:toolbar.exit_focus_mode', 'Exit focus mode')
            : t('notes:toolbar.focus_mode', 'Focus mode')}
        </span>
        <kbd>{isMacOS() ? '⌘⇧U' : 'Ctrl+Shift+U'}</kbd>
      </DsButton>
      {extraViewActions}
      {hasMoreWindowedContent && (
        <DsButton
          variant="ghost"
          size="sm"
          disabled={hostBusy || !editorReady}
          role={menuItemRole}
          onClick={onMaterializeFullDocument}
        >
          <span>{t('notes:chrome.load_full_document')}</span>
        </DsButton>
      )}

      <div className="notes-action-group-label">{t('notes:chrome.export')}</div>
      {(['plain', 'layout'] as const).map((layout) => (
        <DsButton
          key={layout}
          variant="ghost"
          size="sm"
          role={menuItemRole}
          disabled={!noteId || hostBusy}
          onClick={() => {
            if (noteId) {
              void import('@/features/learning-hub/utils/exportResource')
                .then(({ exportResourceById }) =>
                  exportResourceById(
                    noteId,
                    i18n.getFixedT(null, 'learningHub'),
                    acrWindowId,
                    layout,
                  ),
                )
                .catch((error) => {
                  showGlobalNotification('error', error instanceof Error ? error.message : String(error));
                });
            }
          }}
        >
          <DownloadSimple size={16} />
          <span>{t(`notes:chrome.export_${layout}`)}</span>
        </DsButton>
      ))}
      {(['default', 'handout'] as const).map((template) => (
        <DsButton
          key={`docx-${template}`}
          variant="ghost"
          size="sm"
          role={menuItemRole}
          disabled={!noteId || hostBusy}
          onClick={() => {
            if (noteId) {
              void import('../noteDocxExport')
                .then(({ exportNoteAsDocx }) =>
                  exportNoteAsDocx(noteId, template, acrWindowId),
                )
                .catch((error) => {
                  showGlobalNotification('error', error instanceof Error ? error.message : String(error));
                });
            }
          }}
        >
          <DownloadSimple size={16} />
          <span>
            {t(
              template === 'handout'
                ? 'notes:chrome.export_docx_handout'
                : 'notes:chrome.export_docx',
            )}
          </span>
        </DsButton>
      ))}
      {!readOnly && (
        <>
          <div className="my-1 border-t border-border/60" />
          <div className="notes-action-group-label">{t('notes:chrome.manage', { defaultValue: '管理' })}</div>
          <DsButton
            variant="ghost"
            size="sm"
            role={menuItemRole}
            disabled={!noteId || readOnly || hostBusy || isMovingToTrash}
            className="text-destructive hover:text-destructive"
            data-no-focus-return="true"
            onClick={() => {
              if (!noteId || readOnly || hostBusy || isMovingToTrash) return;
              if (onMoveToTrash) {
                void onMoveToTrash();
                return;
              }
              setInternalMovingToTrash(true);
              void moveNoteToTrash({ noteId, noteTitle }).finally(() => {
                setInternalMovingToTrash(false);
              });
            }}
          >
            <Trash size={16} aria-hidden="true" />
            <span>{t('notes:actions.move_to_trash', { defaultValue: '移至回收站' })}</span>
          </DsButton>
        </>
      )}
    </div>
  );
};
