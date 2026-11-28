import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { open, save } from '@tauri-apps/plugin-dialog';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { NotesAPI } from '@/utils/notesApi';
import { notesDstuAdapter } from '@/dstu/adapters/notesDstuAdapter';
import { isWebUiShell } from '@/utils/platform';
import { abortStagedUpload, stageBlobUpload } from '@/utils/stagedUpload';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { flushAllDirtyContent } from '../content/contentDirtyRegistry';
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

const isMarkdownFilename = (name: string): boolean => /\.(md|markdown|txt)$/i.test(name.trim());
const isZipFilename = (name: string): boolean => /\.zip$/i.test(name.trim());

function extractErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as { message?: unknown }).message === 'string' &&
    (error as { message: string }).message.trim()
  ) {
    return (error as { message: string }).message;
  }
  return fallback;
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
  const [webImportFiles, setWebImportFiles] = useState<File[]>([]);
  const [nativeImportPaths, setNativeImportPaths] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [importConflictStrategy, setImportConflictStrategy] = useState<ImportConflictStrategy>('skip');
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const webImportInputRef = useRef<HTMLInputElement | null>(null);

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
    } catch (error: unknown) {
      showGlobalNotification('error', extractErrorMessage(error, t('export.failed')));
    } finally {
      setExportPathLoading(false);
    }
  };

  const confirmExport = async () => {
    if (!exportTargetPath) return;
    setExporting(true);
    try {
      // C16：导出前等待保存屏障——用户刚输入或仍有失败草稿时，
      // 不能导出一个不包含屏幕最新内容的归档却显示成功。
      const flushed = await flushAllDirtyContent();
      if (!flushed) {
        showGlobalNotification('warning', t('export.unsaved_blocked', {
          defaultValue: '仍有笔记未能保存，为避免导出遗漏最新内容已暂停导出。请重试。',
        }));
        return;
      }
      const result = await NotesAPI.exportNotes({ outputPath: exportTargetPath });
      // Remember when the library was last exported (shown inside the panel).
      void NotesAPI.setPref(NOTES_LIBRARY_LAST_EXPORT_PREF, String(Date.now())).catch(() => {});
      showGlobalNotification('success', t('export.success_desc', {
        count: result.note_count,
        path: result.output_path,
      }));
      onOpenChange(false);
    } catch (error) {
      showGlobalNotification('error', extractErrorMessage(error, t('export.failed')));
    } finally {
      setExporting(false);
    }
  };

  const pickImportFile = async () => {
    const isTauriEnv = typeof window !== 'undefined' && Boolean((window as unknown as Record<string, unknown>).__TAURI_INTERNALS__);
    if (!isTauriEnv || isWebUiShell()) {
      webImportInputRef.current?.click();
      return;
    }
    try {
      const selected = await open({
        title: t('import.file.dialog_title'),
        multiple: true,
        filters: [{ name: t('import.filter_name'), extensions: ['zip', 'md', 'markdown', 'txt'] }],
      });
      if (typeof selected === 'string') {
        setWebImportFiles([]);
        setNativeImportPaths([selected]);
        setImportFilePath(selected);
      } else if (Array.isArray(selected) && selected.length > 0) {
        const valid = selected.filter((item): item is string => typeof item === 'string' && item.length > 0);
        if (valid.length > 0) {
          setWebImportFiles([]);
          setNativeImportPaths(valid);
          setImportFilePath(valid.join(', '));
        }
      }
    } catch {
      webImportInputRef.current?.click();
    }
  };

  const handleWebImportInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files ? Array.from(event.target.files) : [];
    event.target.value = '';
    if (picked.length === 0) return;
    setNativeImportPaths([]);
    setWebImportFiles(picked);
    setImportFilePath(picked.map((f) => f.name).join(', '));
  };

  const confirmImport = async () => {
    if (!importFilePath) return;
    setImporting(true);
    setImportProgress(null);
    try {
      if (webImportFiles.length > 0) {
        const zipFiles = webImportFiles.filter((file) => isZipFilename(file.name));
        const mdFiles = webImportFiles.filter((file) => isMarkdownFilename(file.name));
        if (zipFiles.length === 0 && mdFiles.length === 0) {
          throw new Error(t('import.unsupported_format', { defaultValue: '不支持的文件格式' }));
        }
        let importedCount = 0;
        let subjectCount = 0;
        let skippedCount = 0;
        let overwrittenCount = 0;

        for (const zipFile of zipFiles) {
          let stagedUploadId: string | null = null;
          try {
            stagedUploadId = await stageBlobUpload(zipFile, { name: zipFile.name });
            const result = await NotesAPI.importNotes({
              filePath: `dstu-staged:${stagedUploadId}`,
              conflictStrategy: importConflictStrategy,
            });
            stagedUploadId = null;
            importedCount += result.note_count;
            subjectCount += (result as { subject_count?: number }).subject_count || 0;
            skippedCount += result.skipped_count || 0;
            overwrittenCount += result.overwritten_count || 0;
          } catch (error) {
            if (stagedUploadId) {
              void abortStagedUpload(stagedUploadId);
            }
            throw error;
          }
        }

        const failedNames: string[] = [];
        for (const file of mdFiles) {
          const content = await file.text();
          const result = await notesDstuAdapter.importMarkdownContent(file.name, content);
          if (result.ok) {
            importedCount += 1;
          } else {
            failedNames.push(file.name);
          }
        }
        if (failedNames.length > 0 && importedCount === 0 && zipFiles.length === 0) {
          showGlobalNotification('error', t('import.failed'));
          return;
        }
        showGlobalNotification(
          failedNames.length > 0 ? 'warning' : 'success',
          t('import.success_with_overwrite', {
            note_count: importedCount,
            subject_count: subjectCount,
            skipped: skippedCount + failedNames.length,
            overwritten: overwrittenCount,
          }),
        );
        setWebImportFiles([]);
        setNativeImportPaths([]);
        setImportFilePath('');
        await onImported();
        onOpenChange(false);
        return;
      }

      const paths = nativeImportPaths.length > 0 ? nativeImportPaths : [importFilePath];
      const mdPaths = paths.filter((p) => isMarkdownFilename(p));
      const archivePaths = paths.filter((p) => !isMarkdownFilename(p));

      let importedCount = 0;
      let subjectCount = 0;
      let skippedCount = 0;
      let overwrittenCount = 0;

      const failedNames: string[] = [];
      if (mdPaths.length > 0) {
        const { readTextFile } = await import('@tauri-apps/plugin-fs');
        for (const p of mdPaths) {
          const content = await readTextFile(p);
          const baseName = p.split(/[/\\]/).pop() || 'note.md';
          const result = await notesDstuAdapter.importMarkdownContent(baseName, content);
          if (result.ok) {
            importedCount += 1;
          } else {
            failedNames.push(baseName);
          }
        }
      }

      for (const archivePath of archivePaths) {
        const result = await NotesAPI.importNotes({
          filePath: archivePath,
          conflictStrategy: importConflictStrategy,
        });
        importedCount += result.note_count;
        subjectCount += (result as { subject_count?: number }).subject_count || 0;
        skippedCount += result.skipped_count || 0;
        overwrittenCount += result.overwritten_count || 0;
      }

      if (failedNames.length > 0 && importedCount === 0 && archivePaths.length === 0) {
        showGlobalNotification('error', t('import.failed'));
        return;
      }

      showGlobalNotification(
        failedNames.length > 0 ? 'warning' : 'success',
        t('import.success_with_overwrite', {
          note_count: importedCount,
          subject_count: subjectCount,
          skipped: skippedCount + failedNames.length,
          overwritten: overwrittenCount,
        }),
      );
      setNativeImportPaths([]);
      setImportFilePath('');
      await onImported();
      onOpenChange(false);
    } catch (error) {
      showGlobalNotification('error', extractErrorMessage(error, t('import.failed')));
    } finally {
      setImporting(false);
      setImportProgress(null);
    }
  };

  return (
    <>
      <input
        ref={webImportInputRef}
        type="file"
        accept=".zip,.md,.markdown,.txt,text/markdown,text/plain,application/zip"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        data-testid="notes-library-import-input"
        onChange={handleWebImportInputChange}
      />
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
        onImportFilePathChange={(next) => {
          setImportFilePath(next);
          if (!next) {
            setWebImportFiles([]);
            setNativeImportPaths([]);
          }
        }}
        onPickImportFile={() => { void pickImportFile(); }}
        importing={importing}
        onConfirmImport={() => { void confirmImport(); }}
        importConflictStrategy={importConflictStrategy}
        onImportConflictStrategyChange={setImportConflictStrategy}
        importProgress={importProgress}
      />
    </>
  );
}
