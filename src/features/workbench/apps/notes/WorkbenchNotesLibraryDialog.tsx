import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { open, save } from '@tauri-apps/plugin-dialog';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { NotesAPI } from '@/utils/notesApi';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import {
  NotesLibraryManager,
  NOTES_LIBRARY_LAST_EXPORT_PREF,
  type ImportConflictStrategy,
  type ImportProgress,
} from '@/features/notes/NotesLibraryManager';

interface WorkbenchNotesLibraryDialogProps {
  open: boolean;
  initialTab: 'export' | 'import';
  onOpenChange: (open: boolean) => void;
  onImported: () => void | Promise<void>;
}

export function WorkbenchNotesLibraryDialog({
  open: dialogOpen,
  initialTab,
  onOpenChange,
  onImported,
}: WorkbenchNotesLibraryDialogProps) {
  const { t } = useTranslation('notes');
  const [activeTab, setActiveTab] = useState<'export' | 'import'>(initialTab);
  const [exportTargetPath, setExportTargetPath] = useState('');
  const [exportPathLoading, setExportPathLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importFilePath, setImportFilePath] = useState('');
  const [importing, setImporting] = useState(false);
  const [importConflictStrategy, setImportConflictStrategy] = useState<ImportConflictStrategy>('skip');
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);

  useEffect(() => {
    if (dialogOpen) setActiveTab(initialTab);
  }, [dialogOpen, initialTab]);

  useEffect(() => {
    if (!importing) return;
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void listen<ImportProgress>('notes-import-progress', (event) => {
      setImportProgress(event.payload);
    }).then((next) => {
      // The effect may be cleaned up before `listen` resolves; unhook immediately.
      if (disposed) next();
      else unlisten = next;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [importing]);

  const pickExportPath = async () => {
    setExportPathLoading(true);
    try {
      const selected = await save({
        title: t('export.destination.choose'),
        defaultPath: `notes_export_${new Date().toISOString().slice(0, 10)}.zip`,
        filters: [{ name: t('export.filter_name'), extensions: ['zip'] }],
      });
      if (selected) setExportTargetPath(selected);
    } finally {
      setExportPathLoading(false);
    }
  };

  const confirmExport = async () => {
    if (!exportTargetPath) return;
    setExporting(true);
    try {
      const result = await NotesAPI.exportNotes({ outputPath: exportTargetPath, includeVersions: true });
      // Remember when the library was last exported (shown inside the panel).
      void NotesAPI.setPref(NOTES_LIBRARY_LAST_EXPORT_PREF, String(Date.now())).catch(() => {});
      showGlobalNotification('success', t('export.success_desc', {
        count: result.note_count,
        path: result.output_path,
      }));
      onOpenChange(false);
    } catch (error) {
      showGlobalNotification('error', error instanceof Error ? error.message : t('export.failed'));
    } finally {
      setExporting(false);
    }
  };

  const pickImportFile = async () => {
    const selected = await open({
      title: t('import.file.dialog_title'),
      multiple: false,
      filters: [{ name: t('import.filter_name'), extensions: ['zip'] }],
    });
    if (typeof selected === 'string') setImportFilePath(selected);
  };

  const confirmImport = async () => {
    if (!importFilePath) return;
    setImporting(true);
    setImportProgress(null);
    try {
      const result = await NotesAPI.importNotes({
        filePath: importFilePath,
        conflictStrategy: importConflictStrategy,
      });
      showGlobalNotification('success', t('import.success_with_overwrite', {
        note_count: result.note_count,
        skipped: result.skipped_count || 0,
        overwritten: result.overwritten_count || 0,
      }));
      await onImported();
      onOpenChange(false);
    } catch (error) {
      showGlobalNotification('error', error instanceof Error ? error.message : t('import.failed'));
    } finally {
      setImporting(false);
      setImportProgress(null);
    }
  };

  return (
    <NotesLibraryManager
      open={dialogOpen}
      onOpenChange={onOpenChange}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      exportTargetPath={exportTargetPath}
      onExportTargetPathChange={setExportTargetPath}
      onPickExportPath={() => { void pickExportPath(); }}
      exportPathLoading={exportPathLoading}
      exporting={exporting}
      onConfirmExport={() => { void confirmExport(); }}
      importFilePath={importFilePath}
      onImportFilePathChange={setImportFilePath}
      onPickImportFile={() => { void pickImportFile(); }}
      importing={importing}
      onConfirmImport={() => { void confirmImport(); }}
      importConflictStrategy={importConflictStrategy}
      onImportConflictStrategyChange={setImportConflictStrategy}
      importProgress={importProgress}
    />
  );
}
