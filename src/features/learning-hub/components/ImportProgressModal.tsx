/**
 * 教材导入进度模态框
 * 
 * 显示 PDF 导入的实时进度，包括：
 * - 当前阶段（校验、复制、渲染、保存）
 * - 页面渲染进度
 * - 整体进度百分比
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { NotionDialog, NotionDialogHeader, NotionDialogTitle, NotionDialogBody } from '@/components/ui/NotionDialog';
import { Progress } from '@/components/ui/shad/Progress';
import { Loader2, CheckCircle, XCircle, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';

/** 导入进度阶段 */
export type ImportStage = 'hashing' | 'copying' | 'rendering' | 'parsing' | 'indexing' | 'saving' | 'done' | 'error';

/** 导入进度状态 */
export interface ImportProgressState {
  /** 是否正在导入 */
  isImporting: boolean;
  /** 当前文件名 */
  fileName: string;
  /** 当前阶段 */
  stage: ImportStage;
  /** 当前页码（仅 rendering 阶段有效） */
  currentPage?: number;
  /** 总页数（仅 rendering 阶段有效） */
  totalPages?: number;
  /** 进度百分比 0-100 */
  progress: number;
  /** 错误信息（仅 error 阶段有效） */
  error?: string;
}

interface ImportProgressModalProps {
  /** 进度状态 */
  state: ImportProgressState;
  /** 关闭回调（仅在完成或错误时可关闭） */
  onClose?: () => void;
}

/** 阶段图标 */
const StageIcon: React.FC<{ stage: ImportStage; className?: string }> = ({ stage, className }) => {
  switch (stage) {
    case 'done':
      return <CheckCircle className={cn('text-[hsl(var(--success))]', className)} />;
    case 'error':
      return <XCircle className={cn('text-destructive', className)} />;
    default:
      return <Loader2 className={cn('animate-spin text-primary', className)} />;
  }
};

export const ImportProgressModal: React.FC<ImportProgressModalProps> = ({
  state,
  onClose,
}) => {
  const { t } = useTranslation('learningHub');
  const { isImporting, fileName, stage, currentPage, totalPages, progress, error } = state;

  // 阶段文本映射
  const getStageText = (): string => {
    switch (stage) {
      case 'hashing':
        return t('import.stage.hashing');
      case 'copying':
        return t('import.stage.copying');
      case 'rendering':
        if (currentPage !== undefined && totalPages !== undefined) {
          return t('import.stage.renderingWithPage', { current: currentPage, total: totalPages });
        }
        return t('import.stage.rendering');
      case 'parsing':
        return t('import.stage.parsing');
      case 'indexing':
        return t('import.stage.indexing');
      case 'saving':
        return t('import.stage.saving');
      case 'done':
        return t('import.stage.done');
      case 'error':
        return error || t('import.stage.error');
      default:
        return t('import.stage.preparing');
    }
  };

  // 是否可以关闭（仅完成或错误时）
  const canClose = stage === 'done' || stage === 'error';

  return (
    <NotionDialog
      open={isImporting}
      onOpenChange={(open) => {
        if (!open && canClose && onClose) {
          onClose();
        }
      }}
      maxWidth="max-w-[400px]"
      closeOnOverlay={canClose}
      showClose={canClose}
    >
        <NotionDialogHeader>
          <NotionDialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            {t('import.title')}
          </NotionDialogTitle>
        </NotionDialogHeader>
        <NotionDialogBody nativeScroll>

        <div className="space-y-4 py-4">
          {/* 文件名 */}
          <div className="flex items-center gap-3">
            <StageIcon stage={stage} className="h-5 w-5 flex-shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium truncate" title={fileName}>
                {fileName}
              </p>
              <p className={cn(
                'text-xs mt-0.5',
                stage === 'error' ? 'text-destructive' : 'text-muted-foreground'
              )}>
                {getStageText()}
              </p>
            </div>
          </div>

          {/* 进度条 */}
          <div className="space-y-1.5">
            <Progress value={progress} className="h-2" />
            <p className="text-xs text-muted-foreground text-right">
              {progress}%
            </p>
          </div>

          {/* 错误详情 */}
          {stage === 'error' && error && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}
        </div>
        </NotionDialogBody>
    </NotionDialog>
  );
};

export default ImportProgressModal;
