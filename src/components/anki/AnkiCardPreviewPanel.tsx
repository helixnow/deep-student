/**
 * Anki 卡片预览面板（内联组件，无 Modal 壳）。
 *
 * 由孤儿组件 AnkiCardPreviewModal 重构而来：
 * - 保留正反面切换、模板渲染（{{FrontSide}} 展开）与字段/标签展示；
 * - 去掉 UnifiedModal 壳、overlay 点击关闭等模态逻辑与从未接线的 JSON 编辑死代码；
 * - 可直接嵌入任意布局（页面、展开行、侧栏），移动端不再弹模态框。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import type { AnkiCard, CustomAnkiTemplate } from '@/types';
import { TemplateRenderService } from '@/services/templateRenderService';
import { IframePreview } from '@/components/SharedPreview';
import { cn } from '@/utils/cn';

export interface AnkiCardPreviewPanelProps {
  card: AnkiCard | null;
  template?: CustomAnkiTemplate | null;
  className?: string;
}

export const AnkiCardPreviewPanel: React.FC<AnkiCardPreviewPanelProps> = ({
  card,
  template,
  className,
}) => {
  const { t } = useTranslation();
  const [showFront, setShowFront] = useState(true);

  const cardIdentity = card ? card.id || `${card.front}-${card.back}` : null;
  useEffect(() => {
    setShowFront(true);
  }, [cardIdentity]);

  const renderedContent = useMemo(() => {
    if (!card) return { front: '', back: '' };
    if (template) {
      const rendered = TemplateRenderService.renderCard(card, template);
      const backWithFront = rendered.back.includes('{{FrontSide}}')
        ? rendered.back.replace('{{FrontSide}}', `${rendered.front}<hr id="answer">`)
        : rendered.back;
      return { front: rendered.front, back: backWithFront };
    }
    return { front: card.front || '', back: card.back || '' };
  }, [card, template]);

  if (!card) return null;

  return (
    <div className={cn('flex min-w-0 flex-col gap-3', className)}>
      {/* 正反面切换（触控 ≥44px） */}
      <div className="flex items-center gap-1.5" role="tablist" aria-label={t('anki:anki_card_preview')}>
        <DsButton
          type="button"
          variant={showFront ? 'default' : 'ghost'}
          size="sm"
          role="tab"
          aria-selected={showFront}
          onClick={() => setShowFront(true)}
          className="min-h-11 gap-1.5 text-sm sm:min-h-8"
        >
          <Eye size={14} />
          {t('anki:card_front')}
        </DsButton>
        <DsButton
          type="button"
          variant={!showFront ? 'default' : 'ghost'}
          size="sm"
          role="tab"
          aria-selected={!showFront}
          onClick={() => setShowFront(false)}
          className="min-h-11 gap-1.5 text-sm sm:min-h-8"
        >
          <Eye size={14} />
          {t('anki:card_back')}
        </DsButton>
      </div>

      {/* 卡面渲染 */}
      <div className="min-w-0 rounded-md border border-border/70 bg-card">
        <div className="px-3 pt-2 text-[11px] uppercase tracking-wide text-muted-foreground/70">
          {showFront ? t('anki:preview_front') : t('anki:preview_back')}
        </div>
        <div className="p-3">
          <IframePreview
            key={`${cardIdentity}-${showFront ? 'front' : 'back'}`}
            htmlContent={showFront ? renderedContent.front : renderedContent.back}
            cssContent={template?.css_style || ''}
          />
        </div>
      </div>

      {/* 卡片信息：标签 / 模板 / 额外字段 */}
      <div className="space-y-2 text-sm">
        {card.tags && card.tags.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground">{t('anki:tags')}:</span>
            {card.tags.map((tag, index) => (
              <span
                key={`${tag}-${index}`}
                className="rounded-sm bg-emerald-500/10 px-1.5 py-0.5 text-xs text-emerald-700 dark:text-emerald-400"
              >
                {tag}
              </span>
            ))}
          </div>
        ) : null}

        {template ? (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">{t('anki:template_label')}:</span>
            <span className="text-xs text-foreground/80">{template.name}</span>
          </div>
        ) : null}

        {card.fields && Object.keys(card.fields).length > 0 ? (
          <details>
            <summary className="cursor-pointer select-none py-1 text-xs text-muted-foreground">
              {t('anki:extra_fields')} ({Object.keys(card.fields).length})
            </summary>
            <div className="mt-1 space-y-1">
              {Object.entries(card.fields).map(([key, value]) => (
                <div key={key} className="flex min-w-0 items-baseline gap-2 text-xs">
                  <span className="shrink-0 text-muted-foreground">{key}:</span>
                  <span className="min-w-0 break-words text-foreground/80">{value}</span>
                </div>
              ))}
            </div>
          </details>
        ) : null}
      </div>
    </div>
  );
};

export default AnkiCardPreviewPanel;
