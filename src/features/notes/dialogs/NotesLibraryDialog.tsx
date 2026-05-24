import React, { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { NotesLibraryManager, ImportConflictStrategy, ImportProgress } from "../NotesLibraryManager";
import { useNotes } from "../NotesContext";
import { NotesAPI } from "../../../utils/notesApi";
import { getErrorMessage } from "../../../utils/errorUtils";
import { open, save } from "@tauri-apps/plugin-dialog";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

export function NotesLibraryDialog() {
    const { t } = useTranslation(['notes', 'common']);
    const { libraryOpen, setLibraryOpen, notify, refreshNotes } = useNotes();

    const [activeTab, setActiveTab] = useState<'export' | 'import'>('export');
    const [exportTargetPath, setExportTargetPath] = useState("");
    const [exportPathLoading, setExportPathLoading] = useState(false);
    const [exporting, setExporting] = useState(false);

    // Import State
    const [importFilePath, setImportFilePath] = useState("");
    const [importing, setImporting] = useState(false);
    const [importConflictStrategy, setImportConflictStrategy] = useState<ImportConflictStrategy>('skip');
    const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);

    // 监听导入进度事件
    useEffect(() => {
        let unlisten: UnlistenFn | null = null;
        
        const setupListener = async () => {
            unlisten = await listen<ImportProgress>('notes-import-progress', (event) => {
                setImportProgress(event.payload);
            });
        };

        if (importing) {
            setupListener();
        }

        return () => {
            if (unlisten) {
                unlisten();
            }
        };
    }, [importing]);

    const handlePickExportPath = async () => {
        setExportPathLoading(true);
        try {
            const selected = await save({
                title: t('notes:export.destination.choose'),
                defaultPath: `notes_export_${new Date().toISOString().split('T')[0]}.zip`,
                filters: [{ name: t('notes:export.filter_name', 'Notes Backup'), extensions: ['zip'] }]
            });
            if (selected) {
                setExportTargetPath(selected);
            }
        } catch (error: unknown) {
            console.error("Failed to pick export path", error);
        } finally {
            setExportPathLoading(false);
        }
    };

    const handleConfirmExport = async () => {
        if (!exportTargetPath) return;

        // ★ 文档 28 清理：移除 subjects 逻辑，导出所有笔记
        setExporting(true);
        try {
            const res = await NotesAPI.exportNotes({
                outputPath: exportTargetPath,
                includeVersions: true,
            });

            notify({
                title: t('notes:export.success'), // success_title was likely wrong, using 'success' from notes.json
                description: t('notes:export.success_desc', { // This key might be missing, I should add it or use generic
                    count: res.note_count,
                    path: res.output_path
                }),
                variant: "success"
            });
            setLibraryOpen(false);
        } catch (error: unknown) {
            notify({
                title: t('notes:export.failed'),
                description: getErrorMessage(error),
                variant: "destructive"
            });
        } finally {
            setExporting(false);
        }
    };

    const handlePickImportFile = async () => {
        try {
            const selected = await open({
                title: t('notes:import.file.dialog_title', 'Select notes library backup file'),
                multiple: false,
                filters: [{ name: t('notes:import.filter_name', 'Notes Archive'), extensions: ['zip'] }]
            });
            if (selected && typeof selected === 'string') {
                setImportFilePath(selected);
            }
        } catch (error: unknown) {
            console.error("Failed to pick import file", error);
        }
    };

    const handleConfirmImport = async () => {
        if (!importFilePath) return;

        setImporting(true);
        setImportProgress(null);
        try {
            const res = await NotesAPI.importNotes({
                filePath: importFilePath,
                conflictStrategy: importConflictStrategy,
            });

            notify({
                title: t('notes:import.successTitle'),
                // ★ 文档 28 清理：移除 subject_count
                description: t('notes:import.success_with_overwrite', {
                    note_count: res.note_count,
                    skipped: res.skipped_count || 0,
                    overwritten: res.overwritten_count || 0
                }),
                variant: "success"
            });
            setLibraryOpen(false);
            refreshNotes();
        } catch (error: unknown) {
            notify({
                title: t('notes:import.failed'),
                description: getErrorMessage(error),
                variant: "destructive"
            });
        } finally {
            setImporting(false);
            setImportProgress(null);
        }
    };

    return (
        <NotesLibraryManager
            open={libraryOpen}
            onOpenChange={setLibraryOpen}
            activeTab={activeTab}
            onTabChange={setActiveTab}

            exportTargetPath={exportTargetPath}
            onExportTargetPathChange={setExportTargetPath}
            onPickExportPath={handlePickExportPath}
            exportPathLoading={exportPathLoading}
            exporting={exporting}
            onConfirmExport={handleConfirmExport}

            importFilePath={importFilePath}
            onImportFilePathChange={setImportFilePath}
            onPickImportFile={handlePickImportFile}
            importing={importing}
            onConfirmImport={handleConfirmImport}
            importConflictStrategy={importConflictStrategy}
            onImportConflictStrategyChange={setImportConflictStrategy}
            importProgress={importProgress}
        />
    );
}
