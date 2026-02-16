import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Upload, FileText, AlertCircle, CheckCircle2, X } from 'lucide-react';
import { NotionDialog, NotionDialogHeader, NotionDialogTitle, NotionDialogDescription, NotionDialogBody, NotionDialogFooter } from './ui/NotionDialog';
import { NotionButton } from './ui/NotionButton';
import { Input } from './ui/shad/Input';
import { TauriAPI } from '../utils/tauriApi';
import { getErrorMessage } from '../utils/errorUtils';
import { showGlobalNotification } from './UnifiedNotification';
import { fileManager } from '../utils/fileManager';

// ★ 文档31清理：subject 已废弃
interface ImportConversationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImportSuccess?: (conversationId: string | undefined) => void;
}

export const ImportConversationDialog: React.FC<ImportConversationDialogProps> = ({
  open,
  onOpenChange,
  onImportSuccess,
}) => {
  const { t } = useTranslation('chat_host');
  
  const [selectedFile, setSelectedFile] = useState<string>('');
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  // ★ 2026-01 清理：使用 conversationId
  const [importResult, setImportResult] = useState<{
    conversationId?: string;
    message?: string;
  } | null>(null);

  const handleSelectFile = async () => {
    try {
      const result = await fileManager.pickSingleFile({
        title: t('import.select_file'),
        filters: [{ name: t('import.file_filter_json'), extensions: ['json'] }],
      });
      
      if (result) {
        setSelectedFile(result);
        setError(null);
        setWarnings([]);
        setImportResult(null);
      }
    } catch (err: unknown) {
      console.error('选择文件失败:', err);
      showGlobalNotification('error', t('import.error_title'), getErrorMessage(err));
    }
  };

  const handleImport = async () => {
    if (!selectedFile) {
      setError(t('import.file_placeholder'));
      return;
    }

    setImporting(true);
    setError(null);
    setWarnings([]);
    setImportResult(null);

    try {
      // 🎯 直接传递文件路径给后端，使用统一文件管理器读取
      // 这样支持移动端的特殊路径（content://, ph:// 等）
      const response = await TauriAPI.importConversationSnapshot(selectedFile);
      
      if (response.success) {
        // ★ 2026-01 清理：使用 conversationId
        setImportResult({
          conversationId: response.conversationId,
          message: response.message,
        });
        
        if (response.warnings && response.warnings.length > 0) {
          setWarnings(response.warnings);
        }
        
        showGlobalNotification('success', t('import.success_title'), t('import.success_message'));
        
        // 通知父组件
        if (onImportSuccess) {
          // ★ 2026-01 清理：使用 conversationId
          onImportSuccess(response.conversationId);
        }
      }
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      setError(message);
      showGlobalNotification('error', t('import.error_title'), message);
    } finally {
      setImporting(false);
    }
  };

  const handleClose = () => {
    if (!importing) {
      setSelectedFile('');
      setError(null);
      setWarnings([]);
      setImportResult(null);
      onOpenChange(false);
    }
  };

  return (
    <NotionDialog open={open} onOpenChange={handleClose} maxWidth="max-w-[480px]">
        <NotionDialogHeader>
          <NotionDialogTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5" />
            {t('import.dialog_title')}
          </NotionDialogTitle>
          <NotionDialogDescription>
            {t('import.format_hint')}
          </NotionDialogDescription>
        </NotionDialogHeader>
        <NotionDialogBody nativeScroll>
        <div className="space-y-4">
          {/* 文件选择 */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">
              {t('import.select_file')}
            </label>
            <div className="flex gap-2">
              <Input
                value={selectedFile ? selectedFile.split('/').pop() || selectedFile : ''}
                readOnly
                placeholder={t('import.file_placeholder')}
                className="flex-1"
              />
              <NotionButton
                type="button"
                variant="default"
                size="sm"
                onClick={handleSelectFile}
                disabled={importing}
              >
                <FileText className="mr-1 h-4 w-4" />
                {t('import.choose_file')}
              </NotionButton>
            </div>
          </div>

          {/* 错误信息 */}
          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950/30 p-3 flex items-start gap-2">
              <AlertCircle className="h-5 w-5 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
              <div className="flex-1 text-sm text-red-600 dark:text-red-400">
                {error}
              </div>
            </div>
          )}

          {/* 警告信息 */}
          {warnings.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30 p-3">
              <div className="flex items-center gap-2 mb-2">
                <AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                <span className="text-sm font-medium text-amber-900 dark:text-amber-100">
                  {t('import.warnings_title')}
                </span>
              </div>
              <ul className="text-xs text-amber-800 dark:text-amber-200 space-y-1 ml-6 list-disc">
                {warnings.map((warning, idx) => (
                  <li key={idx}>{warning}</li>
                ))}
              </ul>
            </div>
          )}

          {/* 成功信息 */}
          {importResult && (
            <div className="rounded-lg border border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950/30 p-3 flex items-start gap-2">
              <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400 flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <div className="text-sm font-medium text-green-900 dark:text-green-100">
                  {importResult.message}
                </div>
                {/* ★ 2026-01 清理：使用 conversationId */}
                <div className="text-xs text-green-700 dark:text-green-300 mt-1">
                  ID: {(importResult.conversationId || '').slice(0, 8)}...
                </div>
              </div>
            </div>
          )}
        </div>
        </NotionDialogBody>

        <NotionDialogFooter>
          <NotionButton
            type="button"
            variant="default"
            onClick={handleClose}
            disabled={importing}
          >
            {importResult ? (
              <>
                <X className="mr-1 h-4 w-4" />
                {t('import.close_button')}
              </>
            ) : (
              t('import.cancel')
            )}
          </NotionButton>
          
          {importResult ? (
            <NotionButton
              type="button"
              variant="primary"
              onClick={() => {
                if (onImportSuccess && importResult) {
                  // ★ 2026-01 清理：使用 conversationId
                  onImportSuccess(importResult.conversationId);
                }
                handleClose();
              }}
            >
              {t('import.view_imported')}
            </NotionButton>
          ) : (
            <NotionButton
              type="button"
              variant="primary"
              onClick={handleImport}
              disabled={!selectedFile || importing}
            >
              <Upload className="mr-1 h-4 w-4" />
              {importing ? t('import.importing') : t('import.import_button')}
            </NotionButton>
          )}
        </NotionDialogFooter>
    </NotionDialog>
  );
};

