import type React from 'react';
import { open as dialogOpen } from '@tauri-apps/plugin-dialog';
import { createEmpty } from '@/dstu';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { isAndroidMobileShell, isWebUiShell } from '@/utils/platform';
import { pickWebViewFiles } from '@/utils/pickWebViewFiles';

const hasNativeTauriDialog = (): boolean =>
  typeof window !== 'undefined'
  && Boolean((window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
  && !isWebUiShell()
  && !isAndroidMobileShell();
import { dstuNodeToResourceListItem } from '../types';
import type { LearningHubSidebarProps } from '../types';
import type { ImportProgressState } from '../components/ImportProgressModal';
import {
  DOCUMENT_EXTENSIONS,
  IMAGE_EXTENSIONS,
  MEDIA_EXTENSIONS,
  type SidebarT,
} from './sidebarConstants';
import { isImportActionInFlight } from './importActions';

// U03 弱网连点幂等锁：以组件级 isMountedRef 为 key（跨重渲染共享、卸载自动 GC）
const inFlightCreateLocks = new WeakMap<object, Set<string>>();

function getCreateLocks(instanceKey: object): Set<string> {
  let locks = inFlightCreateLocks.get(instanceKey);
  if (!locks) {
    locks = new Set<string>();
    inFlightCreateLocks.set(instanceKey, locks);
  }
  return locks;
}

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
  importFiles: (files: File[]) => Promise<void>;
  openWebFileInput?: () => boolean;
  /** 可选外部在途锁集合（未传时按 isMountedRef 自动按实例隔离） */
  inFlightActionsRef?: React.MutableRefObject<Set<string>>;
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
  importFiles,
  openWebFileInput,
  inFlightActionsRef,
}: ResourceCreatorsContext) {
  const runWithActionLock = async (lockKey: string, task: () => Promise<void>): Promise<void> => {
    const locks = inFlightActionsRef?.current ?? getCreateLocks(isMountedRef);
    if (locks.has(lockKey)) return;
    locks.add(lockKey);
    try {
      await task();
    } finally {
      locks.delete(lockKey);
    }
  };

  const createEmptyResource = async (
    type: 'note' | 'exam' | 'translation' | 'essay' | 'mindmap',
    successMessageKey:
      | 'finder.create.noteSuccess'
      | 'finder.create.examSuccess'
      | 'finder.create.translationSuccess'
      | 'finder.create.essaySuccess'
      | 'finder.create.mindmapSuccess',
    selectCreated: boolean,
  ): Promise<void> => {
    if (!ensureCreatableView()) return;
    const lockKey = `create:${type}:${currentCreatableFolderId ?? 'root'}`;
    await runWithActionLock(lockKey, async () => {
      try {
        const result = await createEmpty({
          type,
          folderId: currentCreatableFolderId,
        });

        // ★ MEDIUM-005: 检查组件是否已卸载
        if (!isMountedRef.current) return;

        if (result.ok) {
          showGlobalNotification('success', t(successMessageKey));
          handleRefresh();
          if (selectCreated) {
            // 列表选中跟到新建的条目（否则高亮还停在之前选中的文件上）
            setSelectedIds(new Set([result.value.id]));
          }
          // 打开右侧应用面板
          if (onOpenApp) {
            onOpenApp(dstuNodeToResourceListItem(result.value, type));
          }
        } else {
          showGlobalNotification('error', result.error.toUserMessage());
        }
      } catch (err) {
        debugLog.error(`[LearningHubSidebar] createEmpty(${type}) error:`, err);
        if (isMountedRef.current) {
          showGlobalNotification(
            'error',
            err instanceof Error ? err.message : t('finder.create.failed', { defaultValue: '创建失败，请重试' }),
          );
        }
      }
    });
  };

  // ★ 2025-12-13: 改为与题目集/翻译/作文一致，直接创建空笔记
  const handleNewNote = () => createEmptyResource('note', 'finder.create.noteSuccess', false);

  // ★ 创建空题目集文件并打开应用面板
  const handleNewExam = () => createEmptyResource('exam', 'finder.create.examSuccess', false);

  const handleNewTextbook = (): Promise<void> => {
    if (!ensureCreatableView()) return Promise.resolve();
    if (importProgress.isImporting || isImportActionInFlight(isMountedRef)) {
      showGlobalNotification('info', t('finder.dragDrop.importInProgress', { defaultValue: '正在导入中，请稍候…' }));
      return Promise.resolve(); // 防止重复点击
    }

    // WebUI / 移动壳：在点击事件同步调用栈内直接拉起隐藏文件输入，
    // 避免菜单关闭（AppMenuItem setOpen(false)）或 async 锁微任务打断用户手势激活导致静默丢文件。
    if (!hasNativeTauriDialog() && openWebFileInput?.()) {
      return Promise.resolve();
    }

    return runWithActionLock('import:textbook', async () => {
      try {
        if (!hasNativeTauriDialog()) {
          const files = await pickWebViewFiles(true);
          if (files.length === 0) return;
          await importFiles(files);
          return;
        }
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
              extensions: ['txt', 'md', 'html', 'htm', 'vtt'],
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
    });
  };

  // ★ 创建空翻译文件并打开应用面板
  const handleNewTranslation = () =>
    createEmptyResource('translation', 'finder.create.translationSuccess', true);

  // ★ 创建空作文文件并打开应用面板
  const handleNewEssay = () => createEmptyResource('essay', 'finder.create.essaySuccess', true);

  // ★ 创建空思维导图文件并打开应用面板
  const handleNewMindMap = () =>
    createEmptyResource('mindmap', 'finder.create.mindmapSuccess', true);

  return {
    handleNewNote,
    handleNewExam,
    handleNewTextbook,
    handleNewTranslation,
    handleNewEssay,
    handleNewMindMap,
  };
}
