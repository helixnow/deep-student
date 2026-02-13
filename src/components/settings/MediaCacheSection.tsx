/**
 * 媒体缓存管理组件
 *
 * 提供 PDF/图片预处理缓存的统计和清理功能：
 * - PDF 页面预览图片缓存
 * - 压缩图片缓存
 * - OCR 文本缓存
 * - 向量索引缓存
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  DataGovernanceApi,
  type MediaCacheStats,
  type ClearMediaCacheOptions as ClearMediaCacheParams,
  type ClearMediaCacheResult,
} from '@/api/dataGovernance';
import { useTranslation } from 'react-i18next';
import {
  Trash2,
  RefreshCw,
  HardDrive,
  Image,
  FileText,
  Database,
  AlertTriangle,
  CheckCircle2,
  Loader2,
} from 'lucide-react';
import { NotionButton } from '../ui/NotionButton';
import { Checkbox } from '../ui/shad/Checkbox';
import { Label } from '../ui/shad/Label';
import { showGlobalNotification } from '../UnifiedNotification';
import { getErrorMessage } from '../../utils/errorUtils';
import { formatBytes } from '@/types/dataGovernance';
import { debugLog } from '../../debug-panel/debugMasterSwitch';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/shad/AlertDialog';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

// MediaCacheStats, ClearMediaCacheParams, ClearMediaCacheResult are imported from DataGovernanceApi

export const MediaCacheSection: React.FC = () => {
  const { t } = useTranslation(['data', 'common']);
  const [stats, setStats] = useState<MediaCacheStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  // 清理选项
  const [clearOptions, setClearOptions] = useState<ClearMediaCacheParams>({
    clearPdfPreview: true,
    clearCompressedImages: true,
    clearOcrText: true,
    clearVectorIndex: false, // 向量索引默认不清理
  });

  // 加载缓存统计
  const loadStats = useCallback(async () => {
    setLoading(true);
    try {
      const result = await DataGovernanceApi.getMediaCacheStats();
      setStats(result);
    } catch (error: unknown) {
      console.error('[MediaCacheSection] Failed to load media cache stats:', error);
      showGlobalNotification(
        'error',
        t('data:governance.cache.load_stats_failed'),
        getErrorMessage(error)
      );
    } finally {
      setLoading(false);
    }
  }, [t]);

  // 初始加载
  useEffect(() => {
    loadStats();
  }, [loadStats]);

  // 执行清理
  const handleClear = async () => {
    setShowConfirm(false);
    setClearing(true);

    try {
      const result = await DataGovernanceApi.clearMediaCache(clearOptions);

      showGlobalNotification(
        'success',
        t('data:governance.cache.clear_success'),
        t('data:governance.cache.clear_success_detail', {
          size: formatBytes(result.totalBytesFreed),
          count: result.filesReset,
        })
      );

      // 重新加载统计
      await loadStats();
    } catch (error: unknown) {
      console.error('[MediaCacheSection] Failed to clear media cache:', error);
      showGlobalNotification(
        'error',
        t('data:governance.cache.clear_failed'),
        getErrorMessage(error)
      );
    } finally {
      setClearing(false);
    }
  };

  // 计算选中的清理项大小
  const selectedSize = stats
    ? (clearOptions.clearPdfPreview ? stats.pdfPreviewSize : 0) +
      (clearOptions.clearCompressedImages ? stats.compressedImageSize : 0) +
      (clearOptions.clearVectorIndex ? stats.vectorIndexSize : 0)
    : 0;

  return (
    <div className="space-y-8">
      {/* 缓存概览 */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Image className="h-4 w-4" />
            {t('data:governance.cache.stats.pdf_preview')}
          </div>
          <div className="flex items-baseline gap-2">
            <div className="text-2xl font-semibold text-foreground">
              {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : (stats?.pdfPreviewCount ?? 0)}
            </div>
            {!loading && (
              <span className="text-xs text-muted-foreground">
                {formatBytes(stats?.pdfPreviewSize ?? 0)}
              </span>
            )}
          </div>
        </div>

        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Image className="h-4 w-4" />
            {t('data:governance.cache.stats.compressed_images')}
          </div>
          <div className="flex items-baseline gap-2">
            <div className="text-2xl font-semibold text-foreground">
              {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : (stats?.compressedImageCount ?? 0)}
            </div>
            {!loading && (
              <span className="text-xs text-muted-foreground">
                {formatBytes(stats?.compressedImageSize ?? 0)}
              </span>
            )}
          </div>
        </div>

        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <FileText className="h-4 w-4" />
            {t('data:governance.cache.stats.ocr_text')}
          </div>
          <div className="text-2xl font-semibold text-foreground">
            {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : (stats?.ocrTextCount ?? 0)}
          </div>
        </div>

        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Database className="h-4 w-4" />
            {t('data:governance.cache.stats.vector_index')}
          </div>
          <div className="flex items-baseline gap-2">
            <div className="text-2xl font-semibold text-foreground">
              {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : (stats?.vectorIndexCount ?? 0)}
            </div>
            {!loading && (
              <span className="text-xs text-muted-foreground">
                {formatBytes(stats?.vectorIndexSize ?? 0)}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* 总缓存大小 */}
      <div className="rounded-lg border border-border/40 p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <HardDrive className="h-4 w-4 text-muted-foreground" />
            <div>
              <div className="text-sm font-medium text-foreground">
                {t('data:governance.cache.total_size')}
              </div>
              <div className="text-xs text-muted-foreground">
                {t('data:governance.cache.total_size_desc')}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-lg font-semibold text-foreground">
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                formatBytes(stats?.totalSize ?? 0)
              )}
            </div>
            <NotionButton
              variant="ghost"
              size="sm"
              onClick={loadStats}
              disabled={loading}
              className="h-7 w-7 p-0"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            </NotionButton>
          </div>
        </div>
      </div>

      <div className="border-t border-border/40" />

      {/* 缓存清理 */}
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-base font-medium text-foreground">
              <Trash2 className="h-4 w-4" />
              {t('data:governance.cache.pick_types')}
            </div>
          </div>
          <div className="flex items-center gap-3">
            {selectedSize > 0 && (
              <span className="text-xs text-muted-foreground">
                {t('data:governance.cache.estimated_free')}: {formatBytes(selectedSize)}
              </span>
            )}
            <NotionButton
              variant="danger"
              size="sm"
              onClick={() => setShowConfirm(true)}
              disabled={
                clearing ||
                (!clearOptions.clearPdfPreview &&
                  !clearOptions.clearCompressedImages &&
                  !clearOptions.clearOcrText &&
                  !clearOptions.clearVectorIndex)
              }
              className="h-8"
            >
              {clearing ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  {t('data:governance.cache.clearing')}
                </>
              ) : (
                <>
                  <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                  {t('data:governance.cache.clear_cache')}
                </>
              )}
            </NotionButton>
          </div>
        </div>

        <div className="rounded-lg border border-border/40 divide-y divide-border/40">
          <ClearOption
            checked={clearOptions.clearPdfPreview}
            onChange={(checked) =>
              setClearOptions((prev) => ({ ...prev, clearPdfPreview: checked }))
            }
            label={t('data:governance.cache.options.pdf_preview')}
            description={t('data:governance.cache.options.pdf_preview_desc')}
            size={stats?.pdfPreviewSize}
          />

          <ClearOption
            checked={clearOptions.clearCompressedImages}
            onChange={(checked) =>
              setClearOptions((prev) => ({ ...prev, clearCompressedImages: checked }))
            }
            label={t('data:governance.cache.options.compressed_images')}
            description={t('data:governance.cache.options.compressed_images_desc')}
            size={stats?.compressedImageSize}
          />

          <ClearOption
            checked={clearOptions.clearOcrText}
            onChange={(checked) =>
              setClearOptions((prev) => ({ ...prev, clearOcrText: checked }))
            }
            label={t('data:governance.cache.options.ocr_text')}
            description={t('data:governance.cache.options.ocr_text_desc')}
          />

          <ClearOption
            checked={clearOptions.clearVectorIndex}
            onChange={(checked) =>
              setClearOptions((prev) => ({ ...prev, clearVectorIndex: checked }))
            }
            label={t('data:governance.cache.options.vector_index')}
            description={t('data:governance.cache.options.vector_index_desc')}
            size={stats?.vectorIndexSize}
            warning
          />
        </div>
      </div>

      {/* 确认对话框 */}
      <AlertDialog open={showConfirm} onOpenChange={setShowConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('data:governance.cache.confirm_title')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              <div className="space-y-2">
                <p>{t('data:governance.cache.confirm_desc')}</p>
                <ul className="list-disc list-inside text-sm space-y-1">
                  {clearOptions.clearPdfPreview && (
                    <li>
                      {t('data:governance.cache.stats.pdf_preview')} ({stats?.pdfPreviewCount ?? 0}{' '}
                      {t('data:governance.cache.unit_items')})
                    </li>
                  )}
                  {clearOptions.clearCompressedImages && (
                    <li>
                      {t('data:governance.cache.options.compressed_images')} ({stats?.compressedImageCount ?? 0}{' '}
                      {t('data:governance.cache.unit_items')})
                    </li>
                  )}
                  {clearOptions.clearOcrText && (
                    <li>
                      {t('data:governance.cache.options.ocr_text')} ({stats?.ocrTextCount ?? 0}{' '}
                      {t('data:governance.cache.unit_items')})
                    </li>
                  )}
                  {clearOptions.clearVectorIndex && (
                    <li className="text-destructive">
                      {t('data:governance.cache.options.vector_index')} ({stats?.vectorIndexCount ?? 0}{' '}
                      {t('data:governance.cache.unit_items')})
                    </li>
                  )}
                </ul>
                {clearOptions.clearVectorIndex && (
                  <div className="flex items-start gap-2 p-3 mt-3 rounded-md bg-destructive/10 text-destructive">
                    <AlertTriangle className="h-5 w-5 flex-shrink-0 mt-0.5" />
                    <div className="text-sm">
                      {t('data:governance.cache.vector_index_warning')}
                    </div>
                  </div>
                )}
                <p className="mt-3">
                  {t('data:governance.cache.estimated_free_space')}:{' '}
                  <strong>{formatBytes(selectedSize)}</strong>
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleClear}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('data:governance.cache.confirm_clear')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

// 清理选项
interface ClearOptionProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description: string;
  size?: number;
  warning?: boolean;
}

const ClearOption: React.FC<ClearOptionProps> = ({
  checked,
  onChange,
  label,
  description,
  size,
  warning,
}) => (
  <div
    className="flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors hover:bg-muted/30"
    onClick={() => onChange(!checked)}
  >
    <Checkbox
      id={label}
      checked={checked}
      onCheckedChange={onChange}
      onClick={(e) => e.stopPropagation()}
    />
    <div className="flex-1 min-w-0">
      <Label
        htmlFor={label}
        className="font-medium text-sm text-foreground cursor-pointer"
      >
        {label}
      </Label>
      <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
    </div>
    <div className="flex items-center gap-2 shrink-0">
      {warning && (
        <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
      )}
      {size !== undefined && size > 0 && (
        <span className="text-xs font-mono text-muted-foreground">
          {formatBytes(size)}
        </span>
      )}
    </div>
  </div>
);

export default MediaCacheSection;
