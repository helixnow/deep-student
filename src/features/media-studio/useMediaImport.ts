/**
 * 导入交互：桌面对话框 / 手机系统选择器 / 拖放 → importMediaSources，带进度与结果通知。
 * 单个文件导入成功后直接进入它的学习页（同资源库导入单个音视频的体验）。
 */
import { useCallback, useRef, useState, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { isMobilePlatform } from '@/utils/platform';
import { getErrorMessage } from '@/utils/errorUtils';
import {
  importMediaSources,
  pickMediaPaths,
  type MediaImportProgress,
  type MediaImportSource,
} from './importMedia';
import { useMediaStudioNavStore } from './mediaStudioNavigation';

export interface MediaImportController {
  importing: boolean;
  progress: MediaImportProgress | null;
  /** 打开系统选择器（手机走隐藏 file input，需把 inputRef / onInputChange 挂到 <input>） */
  pick: () => void;
  importSources: (sources: MediaImportSource[]) => Promise<void>;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onInputChange: (event: ChangeEvent<HTMLInputElement>) => void;
  /** 是否使用 file input（手机） */
  usesFileInput: boolean;
}

export function useMediaImport(options: { onImported?: () => void } = {}): MediaImportController {
  const { t } = useTranslation(['mediaStudio']);
  const [progress, setProgress] = useState<MediaImportProgress | null>(null);
  const [importing, setImporting] = useState(false);
  const busyRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const usesFileInput = isMobilePlatform();
  const { onImported } = options;

  const importSources = useCallback(async (sources: MediaImportSource[]) => {
    if (busyRef.current || sources.length === 0) return;
    busyRef.current = true;
    setImporting(true);
    try {
      const result = await importMediaSources(sources, setProgress);
      const imported = result.imported.length;
      const skipped = result.skipped.length;
      if (imported > 0) onImported?.();
      if (result.failed.length > 0) {
        const detail = result.failed
          .slice(0, 3)
          .map((f) => (f.reason ? `${f.name}（${f.reason}）` : f.name))
          .join('；');
        showGlobalNotification(
          imported > 0 ? 'warning' : 'error',
          imported > 0
            ? t('mediaStudio:import.partial', { imported, failed: result.failed.length })
            : t('mediaStudio:import.failed'),
          detail,
        );
      } else if (imported > 0) {
        showGlobalNotification(
          'success',
          t('mediaStudio:import.success', { count: imported }),
          skipped > 0 ? t('mediaStudio:import.skipped', { count: skipped }) : undefined,
        );
      } else if (skipped > 0) {
        showGlobalNotification('warning', t('mediaStudio:import.notMedia', { count: skipped }));
      }
      if (imported === 1 && result.failed.length === 0) {
        useMediaStudioNavStore.getState().openStudy(result.imported[0].id);
      }
    } catch (error: unknown) {
      showGlobalNotification('error', getErrorMessage(error), t('mediaStudio:import.failed'));
    } finally {
      busyRef.current = false;
      setImporting(false);
      setProgress(null);
    }
  }, [onImported, t]);

  const pick = useCallback(() => {
    if (busyRef.current) return;
    if (usesFileInput) {
      inputRef.current?.click();
      return;
    }
    void pickMediaPaths(t('mediaStudio:import.filterName'))
      .then((paths) => importSources(paths.map((path) => ({ kind: 'path' as const, path }))))
      .catch((error: unknown) => {
        showGlobalNotification('error', getErrorMessage(error), t('mediaStudio:import.failed'));
      });
  }, [importSources, t, usesFileInput]);

  const onInputChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    // 允许再次选择同一文件
    event.target.value = '';
    void importSources(files.map((file) => ({ kind: 'file' as const, file })));
  }, [importSources]);

  return { importing, progress, pick, importSources, inputRef, onInputChange, usesFileInput };
}
