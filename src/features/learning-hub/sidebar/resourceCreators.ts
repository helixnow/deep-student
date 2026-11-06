import type React from 'react';
import { open as dialogOpen } from '@tauri-apps/plugin-dialog';
import { createEmpty } from '@/dstu';
import { createInk, createInkBoard } from '@/features/ink';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { dstuNodeToResourceListItem } from '../types';
import type { LearningHubSidebarProps } from '../types';
import type { ImportProgressState } from '../components/ImportProgressModal';
import {
  DOCUMENT_EXTENSIONS,
  IMAGE_EXTENSIONS,
  MEDIA_EXTENSIONS,
  type SidebarT,
} from './sidebarConstants';

export interface ResourceCreatorsContext {
  ensureCreatableView: () => boolean;
  currentCreatableFolderId: string | null;
  isMountedRef: React.MutableRefObject<boolean>;
  t: SidebarT;
  handleRefresh: () => Promise<void>;
  onOpenApp: LearningHubSidebarProps['onOpenApp'];
  setSelectedIds: (ids: Set<string>) => void;
  importProgress: ImportProgressState;
  importPaths: (paths: string[]) => Promise<void>;
}

/** 新建空资源（笔记/题目集/翻译/作文/思维导图）与「导入资料…」对话框 */
export function createResourceCreators({
  ensureCreatableView,
  currentCreatableFolderId,
  isMountedRef,
  t,
  handleRefresh,
  onOpenApp,
  setSelectedIds,
  importProgress,
  importPaths,
}: ResourceCreatorsContext) {
  const handleNewNote = async () => {
    if (!ensureCreatableView()) return;
    // ★ 2025-12-13: 改为与题目集/翻译/作文一致，直接创建空笔记
    const result = await createEmpty({
      type: 'note',
      folderId: currentCreatableFolderId,
    });

    // ★ MEDIUM-005: 检查组件是否已卸载
    if (!isMountedRef.current) return;

    if (result.ok) {
      showGlobalNotification('success', t('finder.create.noteSuccess'));
      handleRefresh();
      // 打开右侧应用面板
      if (onOpenApp) {
        onOpenApp(dstuNodeToResourceListItem(result.value, 'note'));
      }
    } else {
      showGlobalNotification('error', result.error.toUserMessage());
    }
  };

  const handleNewExam = async () => {
    if (!ensureCreatableView()) return;
    // ★ 创建空题目集文件并打开应用面板
    const result = await createEmpty({
      type: 'exam',
      folderId: currentCreatableFolderId,
    });

    // ★ MEDIUM-005: 检查组件是否已卸载
    if (!isMountedRef.current) return;

    if (result.ok) {
      showGlobalNotification('success', t('finder.create.examSuccess'));
      handleRefresh();
      // 打开右侧应用面板
      if (onOpenApp) {
        onOpenApp(dstuNodeToResourceListItem(result.value, 'exam'));
      }
    } else {
      showGlobalNotification('error', result.error.toUserMessage());
    }
  };

  const handleNewTextbook = async () => {
    if (!ensureCreatableView()) return;
    if (importProgress.isImporting) return; // 防止重复点击

    try {
      // 打开文件选择对话框。选中的文件与拖拽走同一条导入链路（importPaths）：
      // 文档按资料导入，Markdown 导入为笔记，图片 / 音视频作为附件导入
      const selected = await dialogOpen({
        multiple: true,
        filters: [
          {
            name: t('textbook.allSupported'),
            // 注：doc（旧版办公文档格式）不支持，无纯 Rust 解析库
            extensions: [
              ...DOCUMENT_EXTENSIONS,
              ...IMAGE_EXTENSIONS,
              ...MEDIA_EXTENSIONS,
            ],
          },
          {
            name: t('textbook.allDocuments'),
            extensions: [...DOCUMENT_EXTENSIONS],
          },
          {
            name: t('textbook.mediaFiles'),
            extensions: [...MEDIA_EXTENSIONS],
          },
          {
            name: t('textbook.imageFiles'),
            extensions: [...IMAGE_EXTENSIONS],
          },
          {
            name: t('textbook.pdfDocuments'),
            extensions: ['pdf'],
          },
          {
            name: t('textbook.wordDocuments'),
            extensions: ['docx'],
          },
          {
            name: t('textbook.excelFiles'),
            extensions: ['xlsx', 'xls', 'xlsb', 'ods', 'csv'],
          },
          {
            name: t('textbook.textFiles'),
            extensions: ['txt', 'md', 'html', 'htm'],
          },
          {
            name: t('textbook.presentationFiles'),
            extensions: ['pptx', 'epub', 'rtf'],
          },
          {
            name: t('textbook.dataFiles'),
            extensions: ['json', 'xml'],
          },
        ],
        title: t('textbook.selectFiles'),
      });

      if (!selected || (Array.isArray(selected) && selected.length === 0)) {
        return; // 用户取消选择
      }

      await importPaths(Array.isArray(selected) ? selected : [selected]);
    } catch (err) {
      debugLog.error('[LearningHubSidebar] handleNewTextbook error:', err);
      showGlobalNotification('error', t('textbook.importError'));
    }
  };

  const handleNewTranslation = async () => {
    if (!ensureCreatableView()) return;
    // ★ 创建空翻译文件并打开应用面板
    const result = await createEmpty({
      type: 'translation',
      folderId: currentCreatableFolderId,
    });

    // ★ MEDIUM-005: 检查组件是否已卸载
    if (!isMountedRef.current) return;

    if (result.ok) {
      showGlobalNotification('success', t('finder.create.translationSuccess'));
      handleRefresh();
      // 列表选中跟到新建的条目（否则高亮还停在之前选中的文件上）
      setSelectedIds(new Set([result.value.id]));
      if (onOpenApp) {
        onOpenApp(dstuNodeToResourceListItem(result.value, 'translation'));
      }
    } else {
      showGlobalNotification('error', result.error.toUserMessage());
    }
  };

  const handleNewEssay = async () => {
    if (!ensureCreatableView()) return;
    // ★ 创建空作文文件并打开应用面板
    const result = await createEmpty({
      type: 'essay',
      folderId: currentCreatableFolderId,
    });

    // ★ MEDIUM-005: 检查组件是否已卸载
    if (!isMountedRef.current) return;

    if (result.ok) {
      showGlobalNotification('success', t('finder.create.essaySuccess'));
      handleRefresh();
      // 列表选中跟到新建的条目（否则高亮还停在之前选中的文件上）
      setSelectedIds(new Set([result.value.id]));
      if (onOpenApp) {
        onOpenApp(dstuNodeToResourceListItem(result.value, 'essay'));
      }
    } else {
      showGlobalNotification('error', result.error.toUserMessage());
    }
  };

  const handleNewMindMap = async () => {
    if (!ensureCreatableView()) return;
    // ★ 创建空思维导图文件并打开应用面板
    const result = await createEmpty({
      type: 'mindmap',
      folderId: currentCreatableFolderId,
    });

    // ★ MEDIUM-005: 检查组件是否已卸载
    if (!isMountedRef.current) return;

    if (result.ok) {
      showGlobalNotification('success', t('finder.create.mindmapSuccess'));
      handleRefresh();
      // 列表选中跟到新建的条目（否则高亮还停在之前选中的文件上）
      setSelectedIds(new Set([result.value.id]));
      if (onOpenApp) {
        onOpenApp(dstuNodeToResourceListItem(result.value, 'mindmap'));
      }
    } else {
      showGlobalNotification('error', result.error.toUserMessage());
    }
  };

  const handleNewInk = async (
    folderId = currentCreatableFolderId,
    mode: 'paged' | 'board' = 'paged',
  ) => {
    if (mode !== 'paged' && mode !== 'board') {
      showGlobalNotification('error', t('finder.create.inkError'));
      return;
    }
    if (!ensureCreatableView()) return;

    try {
      const manifest = mode === 'board'
        ? await createInkBoard({
            title: t('finder.toolbar.newInk'),
            ruling: 'blank',
            operation_id: crypto.randomUUID(),
            folder_id: folderId,
          })
        : await createInk({
            title: t('finder.toolbar.newInk'),
            ruling: 'blank',
            width: 794,
            height: 1123,
            operation_id: crypto.randomUUID(),
            folder_id: folderId,
          });
      if (!isMountedRef.current) return;

      showGlobalNotification('success', t('finder.create.inkSuccess'));
      void handleRefresh();
      setSelectedIds(new Set([manifest.document_id]));
      onOpenApp?.({
        id: manifest.document_id,
        title: manifest.title,
        type: 'file',
        previewType: 'ink',
        updatedAt: Date.now(),
        sourceDb: 'attachments',
      });
    } catch (error) {
      if (!isMountedRef.current) return;
      debugLog.error('[LearningHubSidebar] handleNewInk error:', error);
      showGlobalNotification('error', t('finder.create.inkError'));
    }
  };

  return {
    handleNewNote,
    handleNewExam,
    handleNewTextbook,
    handleNewTranslation,
    handleNewEssay,
    handleNewMindMap,
    handleNewInk,
  };
}
