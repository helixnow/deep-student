/**
 * DocumentUploadPanel - 文档上传面板
 *
 * 提供文件拖拽上传功能，包括：
 * - 拖拽/选择文件上传
 * - 已选文件列表显示
 * - 处理和清除操作
 * 
 * ★ 2026-01 清理：错题库导入入口已移除
 */

import React, { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Upload, X, BookOpen, Loader2 } from 'lucide-react';
import { NotionButton } from '@/components/ui/NotionButton';
import { UnifiedDragDropZone } from '@/components/shared/UnifiedDragDropZone';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { cn } from '@/utils/cn';

export interface SelectedFile {
  name: string;
  size: number;
  type?: string;
}

export interface DocumentUploadPanelProps {
  /** 已选择的文件列表 */
  selectedFiles: SelectedFile[];
  /** 是否正在处理文件 */
  isProcessingFiles: boolean;
  /** 是否正在拖拽处理 */
  isDragProcessing: boolean;
  /** 是否正在生成卡片 */
  isGenerating: boolean;
  /** @deprecated 2026-01 清理：错题功能已废弃，保留兼容 */
  isApplyingMistakeImport?: boolean;
  /** 是否正在拖拽 */
  isDragging: boolean;
  /** 拖拽状态变化回调 */
  onDragStateChange: (isDragging: boolean) => void;
  /** 文件放置回调 */
  onFilesDropped: (files: File[]) => void;
  /** 移除文件回调 */
  onRemoveFile: (index: number) => void;
  /** 处理选中文件回调 */
  onProcessFiles: () => void;
  /** 清除已选文件回调 */
  onClearFiles: () => void;
  /** @deprecated 2026-01 清理：错题功能已废弃，保留兼容 */
  onOpenMistakeImport?: () => void;
  /** 获取支持的文件扩展名 */
  getSupportedExtensions?: () => string;
}

/**
 * 文档上传面板组件
 */
export function DocumentUploadPanel({
  selectedFiles,
  isProcessingFiles,
  isDragProcessing,
  isGenerating,
  isApplyingMistakeImport: _isApplyingMistakeImport,
  isDragging,
  onDragStateChange,
  onFilesDropped,
  onRemoveFile,
  onProcessFiles,
  onClearFiles,
  onOpenMistakeImport: _onOpenMistakeImport,
  getSupportedExtensions,
}: DocumentUploadPanelProps) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const supportedExtensions = getSupportedExtensions?.() || 'PDF, DOCX, TXT, MD, CSV, JSON, XML';
  // ★ 2026-01 清理：错题导入功能已废弃
  const isImporting = false;
  const isDisabled = isProcessingFiles || isGenerating;

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) {
      onFilesDropped(files);
    }
    e.target.value = '';
  };

  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] shadow-sm flex-1 min-h-[300px] min-w-0">
      {/* 选中文件数提示 */}
      {selectedFiles.length > 0 && (
        <div className="flex items-center justify-end px-5 pt-5 pb-3 shrink-0">
          <span className="text-xs text-[hsl(var(--muted-foreground))]">
            {t('upload_selected_files', { count: selectedFiles.length })}
          </span>
        </div>
      )}

      {/* 导入进度提示 */}
      {isImporting && (
        <div className="px-5 pb-3 flex items-center text-xs text-muted-foreground shrink-0">
          <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
          {t('import_in_progress')}
        </div>
      )}

      {/* 拖拽上传区域 */}
      <UnifiedDragDropZone
        zoneId="anki-upload"
        onFilesDropped={onFilesDropped}
        onDragStateChange={onDragStateChange}
        enabled={!isDisabled}
        acceptedFileTypes={[{
          extensions: ['pdf', 'docx', 'txt', 'md', 'csv', 'json', 'xml'],
          mimeTypes: [
            'application/pdf',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'text/plain',
            'text/markdown',
            'text/csv',
            'application/json',
            'application/xml',
          ],
          description: 'Document',
        }]}
        maxFiles={5}
        showOverlay={false}
        className="flex flex-1 min-h-0"
        style={{ minHeight: 0 }}
      >
        <div
          className={cn(
            'group relative flex flex-1 min-h-0 min-w-0 flex-col items-center justify-center gap-3 overflow-hidden border-0 bg-gradient-to-br from-card/70 via-background/80 to-card/60 px-6 py-9 text-center shadow-inner transition-all duration-300',
            isDragging && 'shadow-[0_18px_50px_-30px_hsl(var(--foreground)/0.45)]',
            isProcessingFiles || isDragProcessing ? 'opacity-80 cursor-wait' : 'cursor-pointer'
          )}
        >
          {/* 背景装饰 */}
          <span
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,_hsl(var(--muted-foreground)/0.22)_0%,_transparent_65%)] transition-opacity duration-300 dark:bg-[radial-gradient(circle_at_top,_hsl(var(--muted-foreground)/0.32)_0%,_transparent_70%)]"
            style={{ opacity: isDragging ? 1 : 0.45 }}
          />

          {/* 上传图标和提示 */}
          <div className="relative flex flex-col items-center gap-2 text-[hsl(var(--foreground))] z-10">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[hsl(var(--card))] shadow-sm transition group-hover:scale-105">
              <Upload className="h-6 w-6 text-[hsl(var(--foreground))]" aria-hidden />
            </div>
            <p className="text-xs text-[hsl(var(--muted-foreground))] break-words text-center px-2">
              {supportedExtensions} · {t('upload_drag_text')}
            </p>
          </div>

          {/* 隐藏的文件输入 */}
          <input
            type="file"
            ref={fileInputRef}
            accept=".pdf,.docx,.txt,.md,.csv,.json,.xml"
            onChange={handleFileInputChange}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0 z-20"
            id="anki-file-input"
            multiple
          />

          {/* 选择按钮 */}
          <div className="relative flex items-center gap-3 z-10">
            <NotionButton
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              className="border-[hsl(var(--border))] bg-[hsl(var(--card))] text-[hsl(var(--foreground))] hover:border-[hsl(var(--ring))] hover:bg-[hsl(var(--accent))]"
            >
              {t('upload_button')}
            </NotionButton>
          </div>
        </div>
      </UnifiedDragDropZone>

      {/* 已选文件列表 */}
      {selectedFiles.length > 0 && (
        <div className="px-5 pt-3 pb-5">
          <div className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-3 shadow-sm">
            {/* 文件列表头部 */}
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-[hsl(var(--muted-foreground))]">
                {t('upload_selected_files', { count: selectedFiles.length })}
              </span>
              {/* ★ 2026-01 清理：错题库导入按钮已移除 */}
            </div>

            {/* 文件滚动列表 */}
            <CustomScrollArea
              className="max-h-[35vh] -mr-2"
              viewportClassName="space-y-2 pr-2"
              trackOffsetTop={8}
              trackOffsetBottom={8}
              trackOffsetRight={0}
            >
              {selectedFiles.map((file, index) => (
                <div
                  key={index}
                  className="flex items-center justify-between gap-3 rounded-md bg-muted border px-2 py-1.5"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="truncate text-sm text-foreground" title={file.name}>
                      {file.name}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {(file.size / 1024 / 1024).toFixed(2)} MB
                    </span>
                  </div>
                  <NotionButton
                    variant="outline"
                    size="icon"
                    onClick={() => onRemoveFile(index)}
                    disabled={isProcessingFiles || isDragProcessing}
                  >
                    <X className="h-4 w-4" />
                  </NotionButton>
                </div>
              ))}
            </CustomScrollArea>

            {/* 操作按钮 */}
            <div className="mt-2 flex items-center gap-2">
              <NotionButton
                size="sm"
                onClick={onProcessFiles}
                disabled={isProcessingFiles || isDragProcessing || selectedFiles.length === 0}
              >
                {isProcessingFiles || isDragProcessing
                  ? t('upload_processing_text')
                  : t('upload_process_button')}
              </NotionButton>
              <NotionButton
                variant="outline"
                size="sm"
                onClick={onClearFiles}
                disabled={isProcessingFiles || isDragProcessing}
              >
                {t('upload_clear_button')}
              </NotionButton>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default DocumentUploadPanel;
