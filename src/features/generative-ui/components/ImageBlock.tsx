/**
 * image 块 + 共用图片视图（choice 选项图片复用 GenerativeImageView）。
 *
 * 来源解析见 media/resolveGenerativeImage.ts：resource / pdf-page → Blob URL（卸载 revoke），
 * url → 仅公网 https，<img referrerPolicy="no-referrer" loading="lazy" decoding="async">。
 * 流式中不发请求，显示骨架；失败显示 alt +「图片不可用」。
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ImageBroken } from '@phosphor-icons/react';
import { Skeleton } from '@/components/ui/shad/Skeleton';
import { cn } from '@/utils/cn';
import type { GenerativeImageSource, ImageBlockProps } from '../schema';
import { useGenerativeImage } from '../media/useGenerativeImage';
import { useGenerativeInteraction } from './InteractionSubmitBar';

export interface GenerativeImageViewProps {
  source: GenerativeImageSource;
  alt: string;
  fit?: 'contain' | 'cover';
  /** 像素高度上限（schema 120..640） */
  maxHeight?: number;
  /** block：独立图片块；thumbnail：choice 选项缩略图 */
  variant?: 'block' | 'thumbnail';
  /** false 时不发请求（流式） */
  enabled?: boolean;
  className?: string;
}

export function GenerativeImageView({
  source,
  alt,
  fit = 'contain',
  maxHeight = 320,
  variant = 'block',
  enabled = true,
  className,
}: GenerativeImageViewProps) {
  const { t } = useTranslation('generativeUi');
  const state = useGenerativeImage(source, { enabled });
  const [imgFailed, setImgFailed] = useState(false);
  const src = state.status === 'ready' ? state.src : undefined;

  useEffect(() => {
    setImgFailed(false);
  }, [src]);

  const thumbnail = variant === 'thumbnail';
  const frameClass = cn(
    'relative flex w-full min-w-0 items-center justify-center overflow-hidden bg-muted/30',
    thumbnail ? 'rounded-[calc(var(--radius-shell-control)-4px)]' : 'rounded-[var(--radius-card)] border border-border/40',
    className,
  );
  const fixedHeight = thumbnail || fit === 'cover';
  const frameStyle: React.CSSProperties = fixedHeight
    ? { height: maxHeight }
    : { maxHeight, minHeight: Math.min(maxHeight, 120) };

  if (state.status === 'idle' || state.status === 'loading') {
    return (
      <div className={frameClass} style={{ height: thumbnail ? maxHeight : Math.min(maxHeight, 200) }} data-generative-image-state="loading">
        <Skeleton className="absolute inset-0 rounded-none" />
        <span className="sr-only" role="status">
          {t('image.loading')}
        </span>
      </div>
    );
  }

  if (state.status === 'error' || imgFailed || !src) {
    const reason = state.status === 'error' ? state.reason : 'load_failed';
    return (
      <div
        className={cn(frameClass, 'flex-col gap-1.5 px-3 py-4 text-center')}
        style={thumbnail ? { height: maxHeight } : { minHeight: Math.min(maxHeight, 120) }}
        role="img"
        aria-label={t('image.unavailable_with_alt', { alt })}
        data-generative-image-state="error"
        data-generative-image-reason={reason}
      >
        <ImageBroken className={cn('shrink-0 text-muted-foreground', thumbnail ? 'h-5 w-5' : 'h-6 w-6')} aria-hidden />
        {!thumbnail ? (
          <span dir="auto" className="line-clamp-2 text-xs text-foreground break-words">
            {alt}
          </span>
        ) : null}
        <span className="text-xs text-muted-foreground">{t('image.unavailable')}</span>
      </div>
    );
  }

  return (
    <div className={frameClass} style={frameStyle} data-generative-image-state="ready" data-generative-image-kind={state.kind}>
      <img
        src={src}
        alt={alt}
        referrerPolicy="no-referrer"
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={() => setImgFailed(true)}
        className={cn(
          'block',
          fixedHeight ? 'h-full w-full' : 'h-auto max-w-full',
          fit === 'cover' ? 'object-cover' : 'object-contain',
        )}
        style={fixedHeight ? undefined : { maxHeight }}
      />
    </div>
  );
}

export function ImageBlock({ source, alt, caption, fit = 'contain', maxHeight = 320 }: ImageBlockProps) {
  const { isStreaming } = useGenerativeInteraction();
  return (
    <figure className="m-0 min-w-0 space-y-1.5" data-generative-image>
      <GenerativeImageView source={source} alt={alt} fit={fit} maxHeight={maxHeight} enabled={!isStreaming} />
      {caption ? (
        <figcaption dir="auto" className="px-0.5 text-xs text-muted-foreground break-words">
          {caption}
        </figcaption>
      ) : null}
    </figure>
  );
}
