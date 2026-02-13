/**
 * AiContentLabel - 统一 AI 生成内容标识组件
 * 
 * 依据《人工智能生成合成内容标识办法》(2025年9月1日施行) 要求，
 * 对所有 AI 生成/合成的文本、图片等内容添加显式标识。
 * 
 * 使用方式：
 *   <AiContentLabel />                    -- 默认内联标签
 *   <AiContentLabel variant="badge" />    -- 小徽章
 *   <AiContentLabel variant="footnote" /> -- 脚注样式
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

export type AiContentLabelVariant = 'inline' | 'badge' | 'footnote';

export interface AiContentLabelProps {
  /** 标识变体：inline（默认内联）、badge（小徽章）、footnote（脚注） */
  variant?: AiContentLabelVariant;
  /** 自定义 className */
  className?: string;
  /** 是否显示图标 */
  showIcon?: boolean;
}

/**
 * AI 内容标识图标 (sparkle)
 */
const AiSparkleIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    className={cn('inline-block', className)}
    width="12"
    height="12"
    viewBox="0 0 16 16"
    fill="currentColor"
    aria-hidden="true"
  >
    <path d="M8 0 L9.5 5.5 L16 8 L9.5 10.5 L8 16 L6.5 10.5 L0 8 L6.5 5.5 Z" />
  </svg>
);

export const AiContentLabel: React.FC<AiContentLabelProps> = ({
  variant = 'inline',
  className,
  showIcon = true,
}) => {
  const { t } = useTranslation('common');

  const label = t('aiContentLabel.label', 'AI 生成');

  if (variant === 'badge') {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full',
          'text-[10px] leading-none font-medium',
          'bg-blue-500/10 text-blue-600 dark:text-blue-400',
          'select-none',
          className
        )}
        title={t('aiContentLabel.tooltip', '此内容由人工智能生成，可能存在错误，请注意甄别')}
        role="note"
        aria-label={t('aiContentLabel.ariaLabel', 'AI 生成内容')}
      >
        {showIcon && <AiSparkleIcon className="w-2.5 h-2.5" />}
        {label}
      </span>
    );
  }

  if (variant === 'footnote') {
    return (
      <div
        className={cn(
          'flex items-center gap-1 mt-2 pt-2 border-t border-border/40',
          'text-[11px] text-muted-foreground/60 select-none',
          className
        )}
        role="note"
        aria-label={t('aiContentLabel.ariaLabel', 'AI 生成内容')}
      >
        {showIcon && <AiSparkleIcon className="w-3 h-3" />}
        <span>{t('aiContentLabel.footnote', '以上内容由 AI 生成，仅供参考')}</span>
      </div>
    );
  }

  // Default: inline
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1',
        'text-[11px] text-muted-foreground/60 select-none',
        className
      )}
      title={t('aiContentLabel.tooltip', '此内容由人工智能生成，可能存在错误，请注意甄别')}
      role="note"
      aria-label={t('aiContentLabel.ariaLabel', 'AI 生成内容')}
    >
      {showIcon && <AiSparkleIcon className="w-3 h-3" />}
      <span>{label}</span>
    </span>
  );
};

export default AiContentLabel;
