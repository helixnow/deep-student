/**
 * Chat V2 - ModelRetryDialog 模型重试对话框
 *
 * 点击消息中的模型名称时弹出，复用 MultiSelectModelPanel 来选择模型。
 * 选择一个或多个模型后点击"重试"按钮进行重试。
 */

import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { NotionDialog, NotionDialogHeader, NotionDialogTitle, NotionDialogBody, NotionDialogFooter } from '@/components/ui/NotionDialog';
import { NotionButton } from '@/components/ui/NotionButton';
import { MultiSelectModelPanel } from '../plugins/chat/MultiSelectModelPanel';
import type { ModelInfo } from '../utils/parseModelMentions';

// ============================================================================
// 类型定义
// ============================================================================

export interface ModelRetryDialogProps {
  /** 对话框是否打开 */
  open: boolean;
  /** 关闭对话框回调 */
  onClose: () => void;
  /** 当前模型 ID */
  currentModelId?: string;
  /** 是否禁用（流式生成中） */
  disabled?: boolean;
  /** 选择模型后重试的回调，返回选中的模型ID数组 */
  onRetry: (modelIds: string[]) => void;
}

// ============================================================================
// 组件实现
// ============================================================================

/**
 * ModelRetryDialog - 模型重试对话框
 * 
 * 复用现有的 MultiSelectModelPanel，用户选择模型后点击"重试"按钮进行重试
 */
export const ModelRetryDialog: React.FC<ModelRetryDialogProps> = ({
  open,
  onClose,
  currentModelId,
  disabled = false,
  onRetry,
}) => {
  const { t } = useTranslation(['chatV2']);

  // 选中的模型列表
  const [selectedModels, setSelectedModels] = useState<ModelInfo[]>([]);

  // 选择模型
  const handleSelectModel = useCallback((model: ModelInfo) => {
    setSelectedModels((prev) => {
      if (prev.some((m) => m.id === model.id)) return prev;
      return [...prev, model];
    });
  }, []);

  // 取消选择模型
  const handleDeselectModel = useCallback((modelId: string) => {
    setSelectedModels((prev) => prev.filter((m) => m.id !== modelId));
  }, []);

  // 关闭对话框时重置状态
  const handleClose = useCallback(() => {
    setSelectedModels([]);
    onClose();
  }, [onClose]);

  // 执行重试
  const handleRetry = useCallback(() => {
    if (selectedModels.length === 0) return;
    const modelIds = selectedModels.map((m) => m.id);
    onRetry(modelIds);
    handleClose();
  }, [selectedModels, onRetry, handleClose]);

  return (
    <NotionDialog open={open} onOpenChange={(isOpen) => !isOpen && handleClose()} maxWidth="max-w-md">
        <NotionDialogHeader>
          <NotionDialogTitle className="flex items-center gap-2">
            <RotateCcw className="h-5 w-5 text-primary" />
            {t('chatV2:messageItem.modelRetry.dialogTitle')}
          </NotionDialogTitle>
        </NotionDialogHeader>
        <NotionDialogBody nativeScroll>

        {/* 复用现有的多选模型面板 */}
        <MultiSelectModelPanel
          selectedModels={selectedModels}
          onSelectModel={handleSelectModel}
          onDeselectModel={handleDeselectModel}
          onClose={handleClose}
          disabled={disabled}
        />

        </NotionDialogBody>
        <NotionDialogFooter>
          <NotionButton variant="ghost" onClick={handleClose}>
            {t('chatV2:common.cancel')}
          </NotionButton>
          <NotionButton
            onClick={handleRetry}
            disabled={selectedModels.length === 0 || disabled}
            className="gap-2"
          >
            <RotateCcw className="h-4 w-4" />
            {selectedModels.length > 1
              ? t('chatV2:messageItem.modelRetry.retryParallel', { count: selectedModels.length })
              : t('chatV2:messageItem.modelRetry.retry')}
          </NotionButton>
        </NotionDialogFooter>
    </NotionDialog>
  );
};

export default ModelRetryDialog;
