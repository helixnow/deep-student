import type React from 'react';
import { useCallback } from 'react';
import { open as dialogOpen } from '@tauri-apps/plugin-dialog';
import { notesDstuAdapter } from '@/dstu/adapters/notesDstuAdapter';
import { extractDisplayFileName } from '@/utils/fileManager';
import type { DstuNode } from '@/dstu';
import { VfsError, VfsErrorCode, err } from '@/shared/result';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { pLimit } from '@/utils/concurrency';
import { dstuNodeToResourceListItem } from '../types';
import type { LearningHubSidebarProps } from '../types';
import { summarizeFailedMarkdownFiles } from '../dragDropRouting';
import type { SidebarT } from './sidebarConstants';

/** Markdown → 笔记导入（文件路径 / 浏览器 File 对象）与结果通知 */
export function useMarkdownNoteImport({
  currentCreatableFolderId,
  t,
  onOpenApp,
}: {
  currentCreatableFolderId: string | null;
  t: SidebarT;
  onOpenApp: LearningHubSidebarProps['onOpenApp'];
}) {
  const importMarkdownPathNotes = useCallback(async (
    filePaths: string[],
    folderId: string | null = currentCreatableFolderId,
  ) => {
    if (filePaths.length === 0) {
      return { importedNodes: [] as DstuNode[], failedCount: 0, firstError: null as string | null, failedFiles: [] as string[] };
    }

    const result = await notesDstuAdapter.importMarkdownFiles(
      filePaths.map((filePath) => ({
        filePath,
        titleHint: extractDisplayFileName(filePath),
      })),
      folderId,
    );

    if (!result.ok) {
      return {
        importedNodes: [] as DstuNode[],
        failedCount: filePaths.length,
        firstError: result.error.toUserMessage(),
        failedFiles: filePaths.map((filePath) => extractDisplayFileName(filePath)),
      };
    }

    return {
      importedNodes: result.value.imported,
      failedCount: result.value.failed.length,
      firstError: result.value.failed[0]?.message ?? null,
      failedFiles: result.value.failed.map((item) => extractDisplayFileName(item.file_path)),
    };
  }, [currentCreatableFolderId]);

  const importMarkdownFileObjects = useCallback(async (
    files: File[],
    folderId: string | null = currentCreatableFolderId,
  ) => {
    if (files.length === 0) {
      return { importedNodes: [] as DstuNode[], failedCount: 0, firstError: null as string | null, failedFiles: [] as string[] };
    }

    const limit = pLimit(3);
    const results = await Promise.all(
      files.map((file) => limit(async () => {
        try {
          const content = await file.text();
          const result = await notesDstuAdapter.importMarkdownContent(file.name, content, folderId);
          return { fileName: file.name, result };
        } catch (error) {
          return {
            fileName: file.name,
            result: err(new VfsError(
              VfsErrorCode.UNKNOWN,
              error instanceof Error ? error.message : t('finder.markdownImport.failed'),
            )),
          };
        }
      }))
    );

    const importedNodes: DstuNode[] = [];
    let failedCount = 0;
    let firstError: string | null = null;
    const failedFiles: string[] = [];

    for (const { fileName, result } of results) {
      if (result.ok) {
        importedNodes.push(result.value);
      } else {
        failedCount += 1;
        firstError ??= result.error.toUserMessage();
        failedFiles.push(fileName);
      }
    }

    return { importedNodes, failedCount, firstError, failedFiles };
  }, [currentCreatableFolderId, t]);

  const notifyMarkdownImportResult = useCallback((
    importedCount: number,
    failedCount: number,
    failedFiles: string[],
    firstError?: string | null,
  ) => {
    const failedFileSummary = summarizeFailedMarkdownFiles(failedFiles);
    const failedFilesText = failedFileSummary
      ? t('finder.markdownImport.failedFiles', { names: failedFileSummary })
      : null;

    if (importedCount > 0 && failedCount === 0) {
      showGlobalNotification('success', t('finder.markdownImport.success', { count: importedCount }));
      return;
    }

    if (importedCount > 0) {
      const baseMessage = t('finder.markdownImport.partial', {
        success: importedCount,
        failed: failedCount,
      });
      showGlobalNotification('warning', failedFilesText ? `${baseMessage}；${failedFilesText}` : baseMessage);
      return;
    }

    const baseError = firstError || t('finder.markdownImport.failed');
    showGlobalNotification('error', failedFilesText ? `${baseError}；${failedFilesText}` : baseError);
  }, [t]);

  const openImportedMarkdownNote = useCallback((node: DstuNode | null) => {
    if (!node || !onOpenApp) {
      return;
    }
    onOpenApp(dstuNodeToResourceListItem(node, 'note'));
  }, [onOpenApp]);

  return { importMarkdownPathNotes, importMarkdownFileObjects, notifyMarkdownImportResult, openImportedMarkdownNote };
}

export type MarkdownNoteImport = ReturnType<typeof useMarkdownNoteImport>;

export interface ImportMarkdownNoteFromDialogContext {
  ensureCreatableView: () => boolean;
  t: SidebarT;
  importMarkdownPathNotes: MarkdownNoteImport['importMarkdownPathNotes'];
  isMountedRef: React.MutableRefObject<boolean>;
  handleRefresh: () => Promise<void>;
  openImportedMarkdownNote: MarkdownNoteImport['openImportedMarkdownNote'];
  notifyMarkdownImportResult: MarkdownNoteImport['notifyMarkdownImportResult'];
}

/** 「导入 Markdown 为笔记…」：系统文件对话框选择 .md 后导入到 folderId */
export async function importMarkdownNoteFromDialog(
  {
    ensureCreatableView,
    t,
    importMarkdownPathNotes,
    isMountedRef,
    handleRefresh,
    openImportedMarkdownNote,
    notifyMarkdownImportResult,
  }: ImportMarkdownNoteFromDialogContext,
  folderId: string | null,
): Promise<void> {
  if (!ensureCreatableView()) return;

  try {
    const selected = await dialogOpen({
      multiple: true,
      filters: [{
        name: t('finder.markdownImport.filterName'),
        extensions: ['md', 'markdown'],
      }],
      title: t('finder.markdownImport.selectFiles'),
    });

    if (!selected || (Array.isArray(selected) && selected.length === 0)) {
      return;
    }

    const filePaths = Array.isArray(selected) ? selected : [selected];
    const { importedNodes, failedCount, firstError, failedFiles } = await importMarkdownPathNotes(filePaths, folderId);

    if (!isMountedRef.current) return;

    if (importedNodes.length > 0) {
      handleRefresh();
      openImportedMarkdownNote(importedNodes[0] ?? null);
    }

    notifyMarkdownImportResult(importedNodes.length, failedCount, failedFiles, firstError);
  } catch (error) {
    showGlobalNotification('error', error instanceof Error ? error.message : t('finder.markdownImport.failed'));
  }
}
