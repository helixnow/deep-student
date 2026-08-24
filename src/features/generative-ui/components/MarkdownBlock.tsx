import React from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { Card, CardContent, CardHeader } from '@/components/ui/shad/Card';
import { cn } from '@/lib/utils';
import { MarkdownRenderer } from '@/features/chat/components/renderers/MarkdownRenderer';
import { GenerativeUIErrorBoundary } from './GenerativeUIErrorBoundary';
import { sanitizeGenerativeMarkdown } from '../utils/sanitizeGenerativeMarkdown';

export const MARKDOWN_TITLE_MAX = 120;
export const MARKDOWN_BODY_MAX = 20000;

export const markdownPropsSchema = z.object({
  id: z.string().optional(),
  title: z.string().max(MARKDOWN_TITLE_MAX).optional(),
  body: z.string().min(1).max(MARKDOWN_BODY_MAX),
  variant: z.enum(['default', 'compact']).optional(),
});

export type MarkdownBlockProps = z.infer<typeof markdownPropsSchema>;

/** 渲染入参允许残缺 props：schema 失败时组件内部降级，不抛错。 */
export type MarkdownBlockRenderProps = Partial<MarkdownBlockProps> & {
  isStreaming?: boolean;
};

function resolveTitle(
  parsed: ReturnType<typeof markdownPropsSchema.safeParse>,
  rawTitle: unknown,
): string | undefined {
  if (parsed.success && parsed.data.title?.trim()) {
    return parsed.data.title.trim();
  }
  if (typeof rawTitle === 'string' && rawTitle.trim()) {
    return rawTitle.trim().slice(0, MARKDOWN_TITLE_MAX);
  }
  return undefined;
}

export function MarkdownBlock(props: MarkdownBlockRenderProps) {
  const { t } = useTranslation('generativeUi');
  const titleId = React.useId();
  const parsed = markdownPropsSchema.safeParse(props);

  const title = resolveTitle(parsed, props.title);
  const variant =
    parsed.success && parsed.data.variant
      ? parsed.data.variant
      : props.variant === 'compact' || props.variant === 'default'
        ? props.variant
        : 'default';
  const body = parsed.success ? sanitizeGenerativeMarkdown(parsed.data.body.trim()) : '';
  const isEmpty = !body;
  const isCompact = variant === 'compact';
  const isStreaming = props.isStreaming === true;
  const emptyLabel = t('blocks.markdown.empty');

  return (
    <Card
      className="min-w-0"
      role="region"
      aria-labelledby={title ? titleId : undefined}
      aria-label={title ? undefined : t('a11y.markdown_label')}
      data-generative-markdown
      data-variant={variant}
      data-empty={isEmpty || undefined}
      data-streaming={isStreaming || undefined}
    >
      {title ? (
        <CardHeader className={cn('space-y-2', isCompact ? 'p-2 pb-2' : 'p-4 pb-2')}>
          <h4 id={titleId} dir="auto" className="text-sm font-medium">
            {title}
          </h4>
        </CardHeader>
      ) : null}
      <CardContent className={cn(isCompact ? 'p-2' : 'p-4', title && 'pt-0')}>
        <div dir="auto">
          {isEmpty ? (
            <p className="text-sm text-muted-foreground" data-testid="markdown-block-empty">
              {emptyLabel}
            </p>
          ) : (
            <GenerativeUIErrorBoundary>
              <MarkdownRenderer content={body} isStreaming={isStreaming} className="text-sm" />
            </GenerativeUIErrorBoundary>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
