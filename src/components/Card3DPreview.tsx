import React, { useState, useRef, useEffect, useMemo, CSSProperties } from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import { useTranslation } from 'react-i18next';
import { AnkiCard, AnkiCardTemplate, CustomAnkiTemplate } from '../types';
import { TemplateRenderService } from '../services/templateRenderService';
import { ShadowDomPreview } from './ShadowDomPreview'; // 导入新的 ShadowDomPreview 组件
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import './Card3DPreview.css';

interface Card3DPreviewProps {
  cards: AnkiCard[];
  /** 单模板（向后兼容） */
  template?: AnkiCardTemplate;
  /** 多模板映射：templateId → 模板对象（优先使用） */
  templateMap?: Map<string, CustomAnkiTemplate>;
  /** 调试上下文（用于定位 UI 与数据源不一致） */
  debugContext?: {
    blockId?: string;
    documentId?: string;
  };
  onCardClick?: (card: AnkiCard, index: number) => void;
}

export const Card3DPreview: React.FC<Card3DPreviewProps> = ({ cards, template, templateMap, debugContext, onCardClick }) => {
  const { t } = useTranslation('common');
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isAutoPlay, setIsAutoPlay] = useState(false);
  const [flippedCards, setFlippedCards] = useState<Set<number>>(new Set());
  const [touchStart, setTouchStart] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const autoPlayRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [maxCardHeight, setMaxCardHeight] = useState<number>(0);
  const heightRef = useRef<number>(0);

  const extractQuestion = (card: AnkiCard): string => {
    const fields = (card.fields ?? {}) as Record<string, unknown>;
    const extraFields = (card.extra_fields ?? {}) as Record<string, unknown>;
    const fieldQuestion =
      fields.question ??
      fields.Question ??
      extraFields.question ??
      extraFields.Question;
    if (typeof fieldQuestion === 'string' && fieldQuestion.trim()) return fieldQuestion.trim();
    const front = card.front ?? '';
    if (front.trim().startsWith('{') && front.trim().endsWith('}')) {
      try {
        const parsed = JSON.parse(front) as Record<string, unknown>;
        const q = parsed.Question ?? parsed.question ?? parsed.front;
        if (typeof q === 'string' && q.trim()) return q.trim();
      } catch {
        // ignore
      }
    }
    return front.replace(/\s+/g, ' ').trim().slice(0, 80);
  };

  const buildSignature = (input: AnkiCard[]): string =>
    input
      .map((card) => `${card.id ?? 'no-id'}::${card.template_id ?? 'no-template'}::${extractQuestion(card)}`)
      .join('|');

  // 增量渲染日志：卡片数量变化时记录
  const prevCardsLenRef = useRef(0);
  useEffect(() => {
    if (cards.length !== prevCardsLenRef.current) {
      const added = cards.length - prevCardsLenRef.current;
      if (added > 0) {
        try {
          const newCards = cards.slice(prevCardsLenRef.current);
          const templateIds = [...new Set(newCards.map(c => c.template_id).filter(Boolean))];
          const resolvedCount = newCards.filter(c => {
            if (templateMap && c.template_id) return templateMap.has(c.template_id);
            return !!template;
          }).length;
          window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', { detail: {
            level: resolvedCount < added ? 'warn' : 'debug',
            phase: 'render:card3d',
            summary: `3D render +${added} cards (total=${cards.length}) | templates=${templateIds.join(',') || 'null'} | resolved=${resolvedCount}/${added}`,
            detail: { added, total: cards.length, templateIds, resolved: resolvedCount, hasTemplateMap: !!(templateMap && templateMap.size > 0), hasFallback: !!template },
          }}));
        } catch { /* */ }
      }
      prevCardsLenRef.current = cards.length;
    }
  }, [cards.length, cards, templateMap, template]);

  useEffect(() => {
    const blockId = debugContext?.blockId;
    if (!blockId) return;

    const uiSignature = buildSignature(cards);
    const uiIds = cards.map((card) => card.id ?? 'no-id');
    const canonical = (window as any).__chatankiCardSourceByBlock?.[blockId] as
      | {
          source: string;
          blockStatus?: string;
          documentId?: string;
          cardIds: string[];
          signature: string;
          updatedAt: string;
        }
      | undefined;

    const current = cards[currentIndex] ?? cards[0];
    const currentQuestion = current ? extractQuestion(current) : '';

    try {
      if (canonical) {
        const canonicalIds = canonical.cardIds ?? [];
        const missingInUi = canonicalIds.filter((id) => !uiIds.includes(id));
        const extraInUi = uiIds.filter((id) => !canonicalIds.includes(id));
        const signatureMismatch = canonical.signature !== uiSignature;
        window.dispatchEvent(
          new CustomEvent('chatanki-debug-lifecycle', {
            detail: {
              level: signatureMismatch || missingInUi.length || extraInUi.length ? 'error' : 'debug',
              phase: 'render:ui-source-check',
              summary:
                signatureMismatch || missingInUi.length || extraInUi.length
                  ? `UI/source mismatch block=${blockId.slice(0, 8)} uiCards=${cards.length} sourceCards=${canonicalIds.length}`
                  : `UI/source aligned block=${blockId.slice(0, 8)} cards=${cards.length}`,
              detail: {
                blockId,
                documentId: debugContext?.documentId ?? null,
                sourceDocumentId: canonical.documentId ?? null,
                sourceUpdatedAt: canonical.updatedAt,
                source: canonical.source,
                sourceBlockStatus: canonical.blockStatus ?? null,
                uiCardsCount: cards.length,
                sourceCardsCount: canonicalIds.length,
                missingInUi,
                extraInUi,
                uiSignature,
                sourceSignature: canonical.signature,
                currentIndex,
                currentCardId: current?.id ?? null,
                currentQuestion,
              },
            },
          }),
        );
      } else {
        window.dispatchEvent(
          new CustomEvent('chatanki-debug-lifecycle', {
            detail: {
              level: 'warn',
              phase: 'render:ui-source-check',
              summary: `No source snapshot for block=${blockId.slice(0, 8)} while UI is rendering ${cards.length} cards`,
              detail: {
                blockId,
                documentId: debugContext?.documentId ?? null,
                uiCardsCount: cards.length,
                uiIds,
                uiSignature,
                currentIndex,
                currentCardId: current?.id ?? null,
                currentQuestion,
              },
            },
          }),
        );
      }
    } catch {
      // debug only
    }
  }, [cards, currentIndex, debugContext?.blockId, debugContext?.documentId]);

  // Auto-play functionality
  useEffect(() => {
    if (isAutoPlay && cards.length > 1) {
      autoPlayRef.current = setInterval(() => {
        setCurrentIndex((prev) => (prev + 1) % cards.length);
      }, 3000);
    } else if (autoPlayRef.current) {
      clearInterval(autoPlayRef.current);
    }
    return () => {
      if (autoPlayRef.current) clearInterval(autoPlayRef.current);
    };
  }, [isAutoPlay, cards.length]);

  // 简化的高度计算：依赖自然高度流动
  useEffect(() => {
    const readCssPx = (el: HTMLElement, varName: string, fallback: number) => {
      const value = getComputedStyle(el).getPropertyValue(varName).trim();
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    };

    const calculateHeight = () => {
      if (!containerRef.current) return;
      
      requestAnimationFrame(() => {
        const readHeight = (el: Element | null) => {
          if (!el) return 0;
          const node = el as HTMLElement;
          return node.scrollHeight || node.offsetHeight || 0;
        };

        // 优先使用当前卡片（及邻近卡片）高度，避免被远端超长卡片拉高
        const currentEl = containerRef.current!.querySelector(
          `.card-3d[data-card-index="${currentIndex}"] .card-3d-inner`,
        );
        const prevEl = containerRef.current!.querySelector(
          `.card-3d[data-card-index="${currentIndex - 1}"] .card-3d-inner`,
        );
        const nextEl = containerRef.current!.querySelector(
          `.card-3d[data-card-index="${currentIndex + 1}"] .card-3d-inner`,
        );

        let max = Math.max(readHeight(currentEl), readHeight(prevEl), readHeight(nextEl));

        if (max === 0) {
          const cardEls = containerRef.current!.querySelectorAll('.card-3d-inner');
          cardEls.forEach((el) => {
            const height = readHeight(el);
            if (height > max) max = height;
          });
        }
        
        // 与 CSS 变量对齐，避免紧凑模式出现高度偏差
        const topOffset = readCssPx(containerRef.current!, '--card-top-offset', 120);
        const bufferSpace = readCssPx(containerRef.current!, '--card-height-buffer', 60);
        const newHeight = Math.max(topOffset + max + bufferSpace, 0);
        if (Math.abs(newHeight - heightRef.current) > 4) {
          heightRef.current = newHeight;
          setMaxCardHeight(newHeight);
        }
      });
    };
    
    // 使用ResizeObserver监听所有大小变化
    const resizeObserver = new ResizeObserver(() => {
      calculateHeight();
    });
    
    // 监听整个容器和所有卡片内容
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
      
      // 监听所有卡片内容包装器
      const contentWrappers = containerRef.current.querySelectorAll('.card-3d-content-wrapper');
      contentWrappers.forEach(wrapper => {
        resizeObserver.observe(wrapper);
      });
    }
    
    // 初始计算
    setTimeout(calculateHeight, 100);
    
    // 监听 ShadowDom 内容载入（用于图片/字体延迟导致的高度变化）
    const handleShadowContentLoaded = () => calculateHeight();
    containerRef.current?.addEventListener('shadowContentLoaded', handleShadowContentLoaded as EventListener);

    // 监听窗口尺寸变化
    window.addEventListener('resize', calculateHeight);
    
    return () => {
      window.removeEventListener('resize', calculateHeight);
      containerRef.current?.removeEventListener('shadowContentLoaded', handleShadowContentLoaded as EventListener);
      resizeObserver.disconnect();
    };
  }, [cards, currentIndex, template, templateMap]);

  /**
   * 根据卡片的 template_id 解析出对应的模板对象
   * 优先级：templateMap[card.template_id] → template（单模板 fallback）
   */
  const resolveTemplate = (card: AnkiCard): CustomAnkiTemplate | AnkiCardTemplate | undefined => {
    if (templateMap && card.template_id) {
      const resolved = templateMap.get(card.template_id);
      if (resolved) return resolved;
    }
    if (templateMap && templateMap.size > 1 && !card.template_id) {
      // 多模板场景下，缺少 template_id 的卡片不做模糊回退，避免“预览模板串台”。
      return undefined;
    }
    return template;
  };

  const renderCardFront = (card: AnkiCard) => {
    try {
      const cardTemplate = resolveTemplate(card);
      if (!cardTemplate) {
        try {
          window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', { detail: {
            level: 'warn', phase: 'render:card3d',
            summary: `No template for card ${(card.id || '?').slice(0, 8)} | template_id=${card.template_id ?? 'null'} → fallback to plain text`,
            detail: { cardId: card.id, templateId: card.template_id, hasTemplateMap: !!(templateMap && templateMap.size > 0) },
          }}));
        } catch { /* */ }
        return `<div style="padding:16px;font-size:14px;">${card.front || '—'}</div>`;
      }
      const rendered = TemplateRenderService.renderCard(card, cardTemplate as any);
      return rendered.front;
    } catch (error: unknown) {
      debugLog.error('Card3DPreview renderCardFront error', {
        error,
        cardId: card.id,
      });
      try {
        window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', { detail: {
          level: 'error', phase: 'render:card3d',
          summary: `Render FAILED for card ${(card.id || '?').slice(0, 8)} | template_id=${card.template_id ?? 'null'}: ${error instanceof Error ? error.message : String(error)}`,
          detail: { cardId: card.id, templateId: card.template_id, error: String(error) },
        }}));
      } catch { /* */ }
      return `<div class="render-error">${t('card3DPreview.errorRenderingCard')}</div>`;
    }
  };

  const renderCardBack = (card: AnkiCard) => {
    try {
      const cardTemplate = resolveTemplate(card);
      if (!cardTemplate) {
        return `<div style="padding:16px;font-size:14px;">${card.back || '—'}</div>`;
      }
      const rendered = TemplateRenderService.renderCard(card, cardTemplate as any);
      let back = rendered.back;
      if (back.includes('{{FrontSide}}')) {
        back = back.replace('{{FrontSide}}', `${rendered.front}<hr id="answer">`);
      }
      return back;
    } catch (error: unknown) {
      debugLog.error('Card3DPreview renderCardBack error', { error, cardId: card.id });
      return `<div class="render-error">${t('card3DPreview.errorRenderingCard')}</div>`;
    }
  };

  const handleFlipCurrent = () => {
    setFlippedCards((prev) => {
      const next = new Set(prev);
      if (next.has(currentIndex)) {
        next.delete(currentIndex);
      } else {
        next.add(currentIndex);
      }
      return next;
    });
  };

  const handlePrevious = () => {
    setCurrentIndex((prev) => (prev - 1 + cards.length) % cards.length);
  };

  const handleNext = () => {
    setCurrentIndex((prev) => (prev + 1) % cards.length);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // SOTA可访问性增强：支持更多键盘操作
    switch (e.key) {
      case 'ArrowLeft':
      case 'a':
      case 'A':
        handlePrevious();
        break;
      case 'ArrowRight':
      case 'd':
      case 'D':
        handleNext();
        break;
      case ' ':
      case 'p':
      case 'P':
        e.preventDefault();
        setIsAutoPlay(!isAutoPlay);
        break;
      case 'f':
      case 'F':
        e.preventDefault();
        handleFlipCurrent();
        break;
      case 'Home':
        e.preventDefault();
        setCurrentIndex(0);
        break;
      case 'End':
        e.preventDefault();
        setCurrentIndex(cards.length - 1);
        break;
      case '1':
      case '2':
      case '3':
      case '4':
      case '5':
      case '6':
      case '7':
      case '8':
      case '9':
        e.preventDefault();
        const num = parseInt(e.key);
        if (num <= cards.length) {
          setCurrentIndex(num - 1);
        }
        break;
    }
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    setTouchStart(e.touches[0].clientX);
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    const touchEnd = e.changedTouches[0].clientX;
    const diff = touchStart - touchEnd;
    
    if (Math.abs(diff) > 50) {
      if (diff > 0) handleNext();
      else handlePrevious();
    }
  };

  const handleWheel = (e: React.WheelEvent) => {
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      if (e.deltaX > 0) handleNext();
      else handlePrevious();
    }
  };

  const getCardTransform = (index: number): CSSProperties => {
    const diff = index - currentIndex;
    const absIndex = Math.abs(diff);
    
    if (absIndex > 4) {
      return {
        visibility: 'hidden',
        opacity: 0,
        transform: `translate(-50%, -50%)`,
        pointerEvents: 'none'
      };
    }

    const baseOffsetPercent = 70; // 缩小间距，让卡片部分重叠
    const translateXOffset = diff * baseOffsetPercent;
    const translateZ = -absIndex * 80;
    const rotateY = diff * -5;
    const scale = 1 - absIndex * 0.08;
    const opacity = 1;
    
    // 居中基础上叠加3D变换
    return {
      transform: `translate(calc(-50% + ${translateXOffset}%), 0) translateZ(${translateZ}px) rotateY(${rotateY}deg) scale(${scale})`,
      opacity,
      zIndex: 100 + cards.length - absIndex, // 确保卡片z-index始终高于其他元素
      visibility: 'visible',
      pointerEvents: 'auto'
    };
  };

  if (cards.length === 0) {
    return (
      <div className="card-3d-preview-empty">
        <p>{t('card3DPreview.noCardsToPreview')}</p>
      </div>
    );
  }

  return (
    <div 
      className="card-3d-preview-container"
      ref={containerRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onWheel={handleWheel}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      <div className="card-3d-controls">
        <NotionButton variant="ghost" size="sm" className="control-btn" onClick={() => setIsAutoPlay(!isAutoPlay)} title={isAutoPlay ? "Pause" : "Play"}>
          {isAutoPlay ? '⏸' : '▶'}
        </NotionButton>
        <NotionButton variant="ghost" size="sm" className={`control-btn${flippedCards.has(currentIndex) ? ' control-btn-active' : ''}`} onClick={handleFlipCurrent} title={t('card3DPreview.flipCard')}>
          🔄
        </NotionButton>
        <div className="card-counter">
          {currentIndex + 1} / {cards.length}
        </div>
      </div>

      <div className="card-3d-scene" style={{ 
        minHeight: maxCardHeight ? `${maxCardHeight}px` : '400px',
        // SOTA：使用CSS变量动态传递高度值，方便CSS中引用
        ['--dynamic-card-height' as any]: maxCardHeight ? `${maxCardHeight}px` : '400px'
      }}>
        <div className="card-3d-track">
          {cards.map((card, index) => {
            const cardTemplate = resolveTemplate(card);
            return (
            <div
              key={card.id}
              className={`card-3d${flippedCards.has(index) ? ' card-3d-flipped' : ''}`}
              data-card-index={index}
              style={getCardTransform(index)}
              onClick={() => onCardClick && onCardClick(card, index)}
            >
              <div className="card-3d-inner">
                <div className="card-3d-face card-3d-front">
                  <div className="card-3d-content-wrapper">
                    <ShadowDomPreview
                      htmlContent={renderCardFront(card)}
                      cssContent={(cardTemplate as any)?.css_style || ''}
                      fidelity="anki"
                    />
                  </div>
                </div>
                <div className="card-3d-face card-3d-back">
                  <div className="card-3d-content-wrapper">
                    <ShadowDomPreview
                      htmlContent={renderCardBack(card)}
                      cssContent={(cardTemplate as any)?.css_style || ''}
                      fidelity="anki"
                    />
                  </div>
                </div>
              </div>
              <div className="card-3d-shadow"></div>
            </div>
            );
          })}
        </div>
      </div>

      <div className="card-3d-navigation">
        <NotionButton variant="ghost" size="sm" className="nav-btn nav-prev" onClick={handlePrevious} disabled={cards.length <= 1}>
          ‹
        </NotionButton>
        <div className="nav-dots">
          {cards.map((_, index) => (
            <NotionButton
              key={index}
              variant="ghost" size="icon" iconOnly
              className={`nav-dot ${index === currentIndex ? 'active' : ''}`}
              onClick={() => setCurrentIndex(index)}
              aria-label={`Go to card ${index + 1}`}
            />
          ))}
        </div>
        <NotionButton variant="ghost" size="sm" className="nav-btn nav-next" onClick={handleNext} disabled={cards.length <= 1}>
          ›
        </NotionButton>
      </div>

      <div className="card-3d-instructions">
        <p>← → or A/D: Navigate • F: Flip • Space or P: Play/Pause • 1-9: Jump to card • Home/End: First/Last</p>
      </div>
    </div>
  );
};

export default Card3DPreview;
