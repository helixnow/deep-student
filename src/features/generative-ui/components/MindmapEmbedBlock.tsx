import React, { Suspense } from 'react';
import { z } from 'zod';
import { Skeleton } from '@/components/ui/shad/Skeleton';

export const mindmapEmbedPropsSchema = z.object({
  id: z.string().optional(),
  mindmapId: z.string().min(1).max(128),
  versionId: z.string().max(128).optional(),
  title: z.string().max(120).optional(),
  height: z.number().min(200).max(600).optional().default(280),
});

export type MindmapEmbedBlockProps = z.infer<typeof mindmapEmbedPropsSchema>;

const LazyMindMapEmbed = React.lazy(() =>
  import('@/features/mindmap/components/mindmap/MindMapEmbed').then((m) => ({
    default: m.MindMapEmbed,
  })),
);

export function MindmapEmbedBlock({ mindmapId, versionId, title, height }: MindmapEmbedBlockProps) {
  return (
    <div className="min-w-0 space-y-2" data-generative-mindmap-embed>
      {title ? <div className="text-sm font-medium">{title}</div> : null}
      <Suspense fallback={<Skeleton className="w-full rounded-lg" style={{ height }} />}>
        <LazyMindMapEmbed
          mindmapId={mindmapId}
          versionId={versionId}
          height={height}
          showOpenButton
        />
      </Suspense>
    </div>
  );
}
