import React, { Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { Skeleton } from '@/components/ui/shad/Skeleton';
import { MindMapErrorBoundary } from '@/features/mindmap/MindMapErrorBoundary';

const GENERATIVE_EMBED_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const mindmapEmbedPropsSchema = z
  .object({
    id: z.string().optional(),
    mindmapId: z.string().min(1).max(128).regex(GENERATIVE_EMBED_ID_RE).optional(),
    versionId: z.string().min(1).max(128).regex(GENERATIVE_EMBED_ID_RE).optional(),
    title: z.string().max(120).optional(),
    height: z.number().min(200).max(600).optional().default(280),
  })
  .refine((data) => Boolean(data.mindmapId || data.versionId), {
    message: 'mindmapId or versionId is required',
  });

export type MindmapEmbedBlockProps = z.infer<typeof mindmapEmbedPropsSchema>;

const LazyMindMapEmbed = React.lazy(() =>
  import('@/features/mindmap/components/mindmap/MindMapEmbed').then((m) => ({
    default: m.MindMapEmbed,
  })),
);

export function MindmapEmbedBlock({ mindmapId, versionId, title, height }: MindmapEmbedBlockProps) {
  const { t } = useTranslation('generativeUi');
  const titleId = React.useId();
  const resolvedMindmapId = mindmapId ?? (versionId?.startsWith('mv_') ? undefined : versionId);
  const resolvedVersionId = versionId ?? (mindmapId?.startsWith('mv_') ? mindmapId : undefined);

  return (
    <div
      className="min-w-0 space-y-2"
      data-generative-mindmap-embed
      role="region"
      aria-labelledby={title ? titleId : undefined}
      aria-label={title ? undefined : t('a11y.mindmap_label')}
    >
      {title ? <h4 id={titleId} dir="auto" className="text-sm font-medium">{title}</h4> : null}
      <MindMapErrorBoundary>
        <Suspense fallback={<Skeleton className="w-full rounded-lg" style={{ height }} />}>
          <LazyMindMapEmbed
            mindmapId={resolvedMindmapId}
            versionId={resolvedVersionId}
            displayTitle={title}
            height={height}
            showOpenButton
          />
        </Suspense>
      </MindMapErrorBoundary>
    </div>
  );
}
