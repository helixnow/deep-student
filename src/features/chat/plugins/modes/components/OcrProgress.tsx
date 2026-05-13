/**
 * Chat V2 - OCR 进度组件
 *
 * 显示 OCR 识别进度条
 * 用于 analysis 模式在 OCR 进行中时显示
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { useStore, type StoreApi } from 'zustand';
import { cn } from '@/utils/cn';
import { Loader2, ScanText } from 'lucide-react';
import type { ChatStore } from '../../../core/types';
import type { AnalysisModeState } from '../analysis';

// ============================================================================
// 类型定义
// ============================================================================

export interface OcrProgressProps {
  /** Store 实例（用于读取 modeState） */
  store: StoreApi<ChatStore>;
}

// ============================================================================
// OCR 进度组件
// ============================================================================

/**
 * OcrProgress - OCR 进度条组件
 *
 * 功能：
 * 1. 显示 OCR 识别进度（0-100%）
 * 2. 显示当前状态文本
 * 3. 支持暗色/亮色主题
 */
export const OcrProgress: React.FC<OcrProgressProps> = ({ store }) => {
  const { t } = useTranslation('chatV2');

  // 🔧 P2修复：使用 useStore 订阅状态变化，确保进度条实时更新
  const mode = useStore(store, (s) => s.mode);
  const modeState = useStore(store, (s) => s.modeState as unknown as AnalysisModeState | null);

  // 如果不是 analysis 模式或没有 modeState，不渲染
  if (!modeState || mode !== 'analysis') {
    return null;
  }

  const { ocrStatus, ocrProgress, ocrError } = modeState;

  // 只在 pending 或 running 状态时显示进度
  if (ocrStatus !== 'pending' && ocrStatus !== 'running') {
    return null;
  }

  // 计算进度百分比
  const progressPercent = Math.min(Math.max(ocrProgress, 0), 100);

  return (
    <div
      className={cn(
        'rounded-lg border p-4',
        'bg-muted/30 border-border/50',
        'dark:bg-muted/20 dark:border-border/30',
        'transition-colors'
      )}
    >
      {/* 头部：图标 + 状态文本 */}
      <div className="flex items-center gap-3 mb-3">
        {/* OCR 图标 */}
        <div
          className={cn(
            'flex items-center justify-center',
            'w-8 h-8 rounded-full',
            'bg-primary/10 text-primary'
          )}
        >
          {ocrStatus === 'running' ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <ScanText className="w-4 h-4" />
          )}
        </div>

        {/* 状态文本 */}
        <div className="flex-1">
          <div className="text-sm font-medium text-foreground">
            {ocrStatus === 'pending'
              ? t('analysis.ocr.pending')
              : t('analysis.ocr.running')}
          </div>
          <div className="text-xs text-muted-foreground">
            {t('analysis.ocr.progressText', { progress: progressPercent })}
          </div>
        </div>
      </div>

      {/* 进度条 */}
      <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
        <div
          className={cn(
            'h-full rounded-full transition-all duration-300',
            'bg-primary'
          )}
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      {/* 错误信息（如果有） */}
      {ocrError && (
        <div className="mt-2 text-xs text-destructive">{ocrError}</div>
      )}
    </div>
  );
};
