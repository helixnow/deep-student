/**
 * 模板渲染卡片预览组件
 *
 * 使用 TemplateRenderService 生成 HTML，通过 ShadowDomPreview 安全渲染。
 * 支持正面/背面切换，点击翻转。
 *
 * 适用场景：
 * - ChatAnki 卡片块中的折叠态预览
 * - ChatAnki 卡片块中的展开态只读预览
 */

import React, { useState, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { AnkiCard, CustomAnkiTemplate } from '@/types';
import { TemplateRenderService } from '@/services/templateRenderService';
import { ShadowDomPreview } from '@/components/ShadowDomPreview';

interface RenderedAnkiCardProps {
  card: AnkiCard;
  template: CustomAnkiTemplate;
  /** 是否允许点击翻转 */
  flippable?: boolean;
  /** 紧凑模式（去除 ShadowDOM 容器边距） */
  compact?: boolean;
  className?: string;
  onClick?: (e: React.MouseEvent) => void;
}

/**
 * 渲染单张 Anki 卡片，使用模板的 HTML/CSS
 */
export const RenderedAnkiCard: React.FC<RenderedAnkiCardProps> = ({
  card,
  template,
  flippable = true,
  compact = true,
  className,
  onClick,
}) => {
  const { t } = useTranslation('anki');
  const [showBack, setShowBack] = useState(false);

  const rendered = useMemo(() => {
    try {
      return TemplateRenderService.renderCard(card, template);
    } catch (err: unknown) {
      console.error('[RenderedAnkiCard] Render failed:', err);
      return null;
    }
  }, [card, template]);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (flippable) {
        e.stopPropagation();
        setShowBack((prev) => !prev);
      }
      onClick?.(e);
    },
    [flippable, onClick]
  );

  // 渲染失败时回退到纯文本（带提示）
  if (!rendered) {
    const front = card.front ?? card.fields?.Front ?? '';
    const back = card.back ?? card.fields?.Back ?? '';
    return (
      <div
        className={[
          'p-3 border rounded-lg bg-card',
          flippable ? 'cursor-pointer' : '',
          className,
        ].filter(Boolean).join(' ')}
        onClick={handleClick}
      >
        <div className="text-[10px] text-amber-600/70 mb-1">⚠ {t('chatV2.noContent')}</div>
        <div className="text-sm font-medium">{showBack ? back : front}</div>
      </div>
    );
  }

  const htmlContent = showBack ? rendered.back : rendered.front;
  const isEmpty = !htmlContent || htmlContent.trim() === '';

  // 渲染为空 HTML 时显示纯文本回退
  if (isEmpty) {
    const front = card.front ?? card.fields?.Front ?? '';
    const back = card.back ?? card.fields?.Back ?? '';
    const fallbackText = showBack ? back : front;
    return (
      <div
        className={[
          'p-3 border rounded-lg bg-card',
          flippable ? 'cursor-pointer' : '',
          className,
        ].filter(Boolean).join(' ')}
        onClick={handleClick}
      >
        {fallbackText ? (
          <div className="text-sm font-medium">{fallbackText}</div>
        ) : (
          <div className="text-sm text-muted-foreground italic">{t('chatV2.noContent')}</div>
        )}
        {flippable && (
          <div className="text-[10px] text-muted-foreground/60 text-right mt-1">
            {showBack ? t('chatV2.front') : t('chatV2.back')} ↩
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className={[
        'relative overflow-hidden rounded-lg border bg-card transition-all',
        flippable ? 'cursor-pointer' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      onClick={handleClick}
    >
      <ShadowDomPreview
        htmlContent={htmlContent}
        cssContent={template.css_style || ''}
        compact={compact}
        fidelity="anki"
      />
      {/* 翻转提示 */}
      {flippable && (
        <div className="absolute bottom-1 right-2 text-[10px] text-muted-foreground/60 select-none pointer-events-none">
          {showBack ? t('chatV2.front') : t('chatV2.back')} ↩
        </div>
      )}
    </div>
  );
};

/**
 * 纯文本卡片预览（无模板时的回退组件）
 */
export const PlainAnkiCard: React.FC<{
  card: AnkiCard;
  className?: string;
  onClick?: (e: React.MouseEvent) => void;
}> = ({ card, className, onClick }) => {
  const front = card.front ?? card.fields?.Front ?? '';
  const back = card.back ?? card.fields?.Back ?? '';

  return (
    <div className={className} onClick={onClick}>
      <div className="text-sm font-medium truncate">{front}</div>
      <div className="text-xs text-muted-foreground truncate mt-1">{back}</div>
    </div>
  );
};
