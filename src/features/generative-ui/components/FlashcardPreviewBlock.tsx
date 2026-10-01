import { flashcardPreviewPropsSchema } from '../schema';
export { flashcardPreviewPropsSchema } from '../schema';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/shad/Card';
import { Badge } from '@/components/ui/shad/Badge';
import type { z } from 'zod';

export type FlashcardPreviewProps = z.infer<typeof flashcardPreviewPropsSchema>;

export function FlashcardPreviewBlock({ front, back, tags, deckName }: FlashcardPreviewProps) {
  const { t } = useTranslation('generativeUi');
  const titleId = React.useId();
  const frontId = React.useId();
  const backId = React.useId();
  return (
    <Card className="min-w-0 border-primary/20" role="region" aria-labelledby={titleId}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle id={titleId} className="text-sm font-medium">{t('flashcard.preview_title')}</CardTitle>
          {deckName ? (
            <Badge variant="secondary" className="text-xs" dir="auto">
              {deckName}
            </Badge>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        <div aria-labelledby={frontId} aria-label={t('a11y.flashcard_front')}>
          <div id={frontId} className="text-xs text-muted-foreground mb-1">{t('flashcard.front')}</div>
          <div className="text-sm font-medium" dir="auto">{front}</div>
        </div>
        <div className="border-t border-border/40 pt-2" aria-labelledby={backId} aria-label={t('a11y.flashcard_back')}>
          <div id={backId} className="text-xs text-muted-foreground mb-1">{t('flashcard.back')}</div>
          <div className="text-sm text-muted-foreground" dir="auto">{back}</div>
        </div>
        {tags?.length ? (
          <div className="flex flex-wrap gap-1">
            {tags.map((tag) => (
              <Badge key={tag} variant="outline" className="text-xs" dir="auto">
                {tag}
              </Badge>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
