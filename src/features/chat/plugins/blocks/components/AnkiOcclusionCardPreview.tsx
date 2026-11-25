/**
 * Chat V2 - Anki 图像遮挡（Image Occlusion）卡片预览子组件
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { cn } from '@/utils/cn';
import { ImageOcclusionOverlay } from '@/components/anki/ImageOcclusionOverlay';
import type { OcclusionSpec } from '@/components/anki/utils/imageOcclusion';
import { buildImageDataUrl } from '@/features/chat/context/imagePayload';

type OcclusionImageState = {
  imageRef: string;
  src: string | null;
  status: 'loading' | 'ready' | 'unavailable';
};

interface ResolvedOcclusionImage {
  found?: boolean;
  content?: string | null;
  metadata?: Record<string, unknown>;
}

const DIRECT_OCCLUSION_IMAGE_URL = /^(?:data:image\/|blob:|https?:|asset:)/i;
const VFS_OCCLUSION_SOURCE_ID = /^(?:att|file|img|image|res)_[a-z0-9_.-]+$/i;

export function getVfsOcclusionSourceId(imageRef: string): string | null {
  const trimmed = imageRef.trim();
  if (/^vfs:\/\//i.test(trimmed)) {
    const sourceId = trimmed.replace(/^vfs:\/\//i, '').replace(/^\/+/, '');
    return sourceId || null;
  }
  return VFS_OCCLUSION_SOURCE_ID.test(trimmed) ? trimmed : null;
}

export function resolveImmediateOcclusionImageSrc(imageRef: string): string | null {
  const trimmed = imageRef.trim();
  if (!trimmed) return null;
  if (DIRECT_OCCLUSION_IMAGE_URL.test(trimmed)) return trimmed;
  if (getVfsOcclusionSourceId(trimmed)) return null;
  // 拒绝未知 URL scheme；普通绝对/相对文件路径才交给 Tauri asset protocol。
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^[a-z]:[\\/]/i.test(trimmed)) {
    return null;
  }
  try {
    return convertFileSrc(trimmed);
  } catch {
    return null;
  }
}

export function useOcclusionImage(imageRef: string): Pick<OcclusionImageState, 'src' | 'status'> {
  const vfsSourceId = useMemo(() => getVfsOcclusionSourceId(imageRef), [imageRef]);
  const immediateSrc = useMemo(
    () => resolveImmediateOcclusionImageSrc(imageRef),
    [imageRef],
  );
  const [resolved, setResolved] = useState<OcclusionImageState>(() => ({
    imageRef,
    src: immediateSrc,
    status: immediateSrc ? 'ready' : vfsSourceId ? 'loading' : 'unavailable',
  }));

  useEffect(() => {
    if (immediateSrc) {
      setResolved({ imageRef, src: immediateSrc, status: 'ready' });
      return;
    }
    if (!vfsSourceId) {
      setResolved({ imageRef, src: null, status: 'unavailable' });
      return;
    }

    let cancelled = false;
    setResolved({ imageRef, src: null, status: 'loading' });
    void invoke<ResolvedOcclusionImage[]>('vfs_resolve_resource_refs', {
      refs: [{
        sourceId: vfsSourceId,
        resourceId: vfsSourceId.startsWith('res_') ? vfsSourceId : undefined,
        resourceHash: '',
        type: 'image',
        name: vfsSourceId,
        injectModes: { image: ['image'] },
      }],
    })
      .then((resources) => {
        if (cancelled) return;
        const resource = resources[0];
        const mimeType =
          typeof resource?.metadata?.mimeType === 'string'
            ? resource.metadata.mimeType
            : 'image/png';
        const src =
          resource?.found && typeof resource.content === 'string'
            ? buildImageDataUrl(resource.content, mimeType)
            : null;
        setResolved({
          imageRef,
          src,
          status: src ? 'ready' : 'unavailable',
        });
      })
      .catch(() => {
        if (!cancelled) {
          setResolved({ imageRef, src: null, status: 'unavailable' });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [imageRef, immediateSrc, vfsSourceId]);

  if (resolved.imageRef !== imageRef) {
    return {
      src: immediateSrc,
      status: immediateSrc ? 'ready' : vfsSourceId ? 'loading' : 'unavailable',
    };
  }
  return { src: resolved.src, status: resolved.status };
}

export const AnkiOcclusionCardPreview: React.FC<{
  spec: OcclusionSpec;
  cardIndex: number;
}> = ({ spec, cardIndex }) => {
  const { t } = useTranslation('anki');
  const image = useOcclusionImage(spec.imageRef);
  return (
    <div
      data-testid="anki-occlusion-card-preview"
      data-card-index={cardIndex}
      className="rounded-lg border border-border/60 bg-muted/20 p-2"
    >
      <div className="flex justify-center">
        <div
          className={cn(
            'relative max-w-full overflow-hidden rounded-md bg-muted',
            image.src ? 'w-fit' : 'aspect-[4/3] w-80',
          )}
        >
          {image.src ? (
            <img
              src={image.src}
              alt={t('agent.occlusion.imageAlt')}
              loading="lazy"
              draggable={false}
              data-testid="anki-occlusion-image"
              className="block max-h-80 max-w-full object-contain"
            />
          ) : (
            <div
              aria-hidden="true"
              data-testid="anki-occlusion-image-placeholder"
              data-state={image.status}
              className="h-full min-h-32 w-full bg-muted"
            />
          )}
          <ImageOcclusionOverlay spec={spec} />
        </div>
      </div>
    </div>
  );
};
