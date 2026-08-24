import React from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/shad/Card';
import { Badge } from '@/components/ui/shad/Badge';
import { z } from 'zod';

export const flashcardPreviewPropsSchema = z.object({
  id: z.string().optional(),
  front: z.string().min(1).max(500),
  back: z.string().min(1).max(1000),
  tags: z.array(z.string().max(40)).max(8).optional(),
  deckName: z.string().max(80).optional(),
});

export type FlashcardPreviewProps = z.infer<typeof flashcardPreviewPropsSchema>;

export function FlashcardPreviewBlock({ front, back, tags, deckName }: FlashcardPreviewProps) {
  const { t } = useTranslation('generativeUi');
  return (
    <Card className="min-w-0 border-primary/20">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium">{t('flashcard.preview_title')}</CardTitle>
          {deckName ? (
            <Badge variant="secondary" className="text-xs">
              {deckName}
            </Badge>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        <div>
          <div className="text-xs text-muted-foreground mb-1">{t('flashcard.front')}</div>
          <div className="text-sm font-medium">{front}</div>
        </div>
        <div className="border-t border-border/40 pt-2">
          <div className="text-xs text-muted-foreground mb-1">{t('flashcard.back')}</div>
          <div className="text-sm text-muted-foreground">{back}</div>
        </div>
        {tags?.length ? (
          <div className="flex flex-wrap gap-1">
            {tags.map((tag) => (
              <Badge key={tag} variant="outline" className="text-xs">
                {tag}
              </Badge>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
