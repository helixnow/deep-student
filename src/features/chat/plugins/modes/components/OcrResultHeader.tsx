/**
 * Chat V2 - OCR 结果头部组件
 *
 * 显示 OCR 识别结果（题目、答案等）
 * 用于 analysis 模式在 OCR 完成后显示识别结果
 */

import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore, type StoreApi } from 'zustand';
import { cn } from '@/utils/cn';
import { NotionButton } from '@/components/ui/NotionButton';
import {
  CaretDown,
  CaretRight,
  CheckCircle,
  WarningCircle,
  Scan,
  ArrowClockwise,
} from '@phosphor-icons/react';
import type { ChatStore } from '../../../core/types';
import type { AnalysisModeState, OcrMeta } from '../analysis';
import { retryOcr } from '../analysis';

// ============================================================================
// 类型定义
// ============================================================================

export interface OcrResultHeaderProps {
  /** Store 实例（用于读取 modeState） */
  store: StoreApi<ChatStore>;
}

// ============================================================================
// OCR 结果头部组件
// ============================================================================

/**
 * OcrResultHeader - OCR 结果显示组件
 *
 * 功能：
 * 1. 可折叠/展开的 OCR 结果
 * 2. 显示题目文本
 * 3. 显示答案/解析（如果有）
 * 4. 显示识别状态（成功/失败）
 * 5. 支持重试 OCR
 * 6. 支持暗色/亮色主题
 */
export const OcrResultHeader: React.FC<OcrResultHeaderProps> = ({ store }) => {
  const { t } = useTranslation('chatV2');
  const [isExpanded, setIsExpanded] = useState(true);

  // 使用 useStore 订阅状态
  const mode = useStore(store, (s) => s.mode);
  const modeState = useStore(store, (s) => s.modeState as unknown as AnalysisModeState | null);

  // 如果不是 analysis 模式或没有 modeState，不渲染
  if (!modeState || mode !== 'analysis') {
    return null;
  }

  const { ocrStatus, ocrMeta, ocrError } = modeState;

  // 只在 success 或 error 状态时显示结果
  if (ocrStatus !== 'success' && ocrStatus !== 'error') {
    return null;
  }

  const toggleExpanded = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  // 重试 OCR
  const handleRetry = useCallback(async () => {
    try {
      // 🔧 P1修复：调用 retryOcr 执行实际的 OCR 重试
      // retryOcr 会检查并发保护、重置状态、调用后端
      await retryOcr(store.getState());
    } catch (error: unknown) {
      console.error('[OcrResultHeader] Retry OCR failed:', error);
    }
  }, [store]);

  return (
    <div
      className={cn(
        'rounded-lg border',
        ocrStatus === 'success'
          ? 'bg-success/5 border-success/30 dark:bg-success/10 dark:border-success/20'
          : 'bg-destructive/5 border-destructive/30 dark:bg-destructive/10 dark:border-destructive/20',
        'transition-colors'
      )}
    >
      {/* 折叠头部 */}
      <NotionButton
        variant="ghost"
        size="sm"
        onClick={toggleExpanded}
        className="w-full !justify-start gap-2 !px-3 !py-2 !rounded-lg"
      >
        {/* 展开/折叠图标 */}
        {isExpanded ? (
          <CaretDown size={16} className="text-muted-foreground" />
        ) : (
          <CaretRight size={16} className="text-muted-foreground" />
        )}

        {/* OCR 图标 */}
        <Scan
          className={cn(
            'w-4 h-4',
            ocrStatus === 'success' ? 'text-success' : 'text-destructive'
          )}
        />

        {/* 标题 */}
        <span className="font-medium text-foreground">
          {t('analysis.ocrResult.title')}
        </span>

        {/* 状态图标 */}
        {ocrStatus === 'success' ? (
          <CheckCircle size={16} className="text-success ml-auto" />
        ) : (
          <div className="flex items-center gap-2 ml-auto">
            <WarningCircle size={16} className="text-destructive" />
            <NotionButton variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); handleRetry(); }} className="text-primary hover:bg-primary/10">
              <ArrowClockwise size={12} />
              {t('analysis.ocrResult.retry')}
            </NotionButton>
          </div>
        )}
      </NotionButton>

      {/* 内容区域 */}
      {isExpanded && (
        <div className={cn('px-3 pb-3', 'border-t border-border/30')}>
          {ocrStatus === 'success' && ocrMeta ? (
            <OcrMetaDisplay ocrMeta={ocrMeta} />
          ) : (
            <div className="pt-2 text-sm text-destructive">
              {ocrError || t('analysis.ocrResult.unknownError')}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// OCR 元数据显示子组件
// ============================================================================

interface OcrMetaDisplayProps {
  ocrMeta: OcrMeta;
}

const OcrMetaDisplay: React.FC<OcrMetaDisplayProps> = ({ ocrMeta }) => {
  const { t } = useTranslation('chatV2');

  return (
    <div className="pt-2 space-y-3">
      {/* 题目文本 */}
      <div>
        <div className="text-xs font-medium text-muted-foreground mb-1">
          {t('analysis.ocrResult.question')}
        </div>
        <div className="text-sm text-foreground whitespace-pre-wrap">
          {ocrMeta.question || t('analysis.ocrResult.noQuestion')}
        </div>
      </div>

      {/* 答案/解析（如果有） */}
      {ocrMeta.answer && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1">
            {t('analysis.ocrResult.answer')}
          </div>
          <div className="text-sm text-foreground whitespace-pre-wrap">
            {ocrMeta.answer}
          </div>
        </div>
      )}

      {/* 额外信息 */}
      {ocrMeta.questionType && (
        <div className="flex flex-wrap gap-2 text-xs">
          <span
            className={cn(
              'px-2 py-0.5 rounded-full',
              'bg-muted text-muted-foreground'
            )}
          >
            {ocrMeta.questionType}
          </span>
        </div>
      )}
    </div>
  );
};
