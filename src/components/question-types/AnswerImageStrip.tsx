/**
 * 图片作答展示组件：信封解码 → 缩略图条 + 文字补充。
 *
 * 供三处共用：作答区回显（未提交预览 / 已提交只读）、提交结果卡、
 * 历史回看。缩略图经 vfs_get_attachment_content 取 base64（与题目图片
 * 同款路径），带 LRU 式缓存避免切题重取。
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Image as ImageIcon, X } from '@phosphor-icons/react';

import type { QuestionImage } from '@/api/questionBankApi';
import { fetchImageAnswerDataUrl } from './imageAnswerUpload';

/** data URL 缓存：会话级模块缓存（key = 附件 id），容量 50 与题目图片回显一致 */
const dataUrlCache = new Map<string, string>();
const DATA_URL_CACHE_MAX = 50;

function cachePut(id: string, url: string): void {
  dataUrlCache.set(id, url);
  if (dataUrlCache.size > DATA_URL_CACHE_MAX) {
    const oldest = dataUrlCache.keys().next().value;
    if (oldest !== undefined) dataUrlCache.delete(oldest);
  }
}

export interface AnswerImageStripProps {
  images: QuestionImage[];
  /** 已提交/只读模式下隐藏删除按钮 */
  readOnly?: boolean;
  onRemove?: (id: string) => void;
}

export const AnswerImageStrip: React.FC<AnswerImageStripProps> = ({
  images,
  readOnly = false,
  onRemove,
}) => {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    const missing = images.filter(
      (img) => !dataUrlCache.has(img.id) && !urls[img.id] && !failed.has(img.id),
    );
    if (missing.length === 0) return;
    (async () => {
      const loaded: Record<string, string> = {};
      const errors = new Set<string>();
      await Promise.all(
        missing.map(async (img) => {
          try {
            const url = await fetchImageAnswerDataUrl(img);
            if (url) {
              loaded[img.id] = url;
              cachePut(img.id, url);
            } else {
              errors.add(img.id);
            }
          } catch {
            errors.add(img.id);
          }
        }),
      );
      if (cancelled) return;
      if (Object.keys(loaded).length > 0) setUrls((prev) => ({ ...prev, ...loaded }));
      if (errors.size > 0) setFailed((prev) => new Set([...prev, ...errors]));
    })();
    return () => {
      cancelled = true;
    };
    // urls/failed 只作去重输入，避免循环依赖告警：missing 计算已含其语义
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [images]);

  const resolveUrl = (id: string): string | undefined =>
    dataUrlCache.get(id) ?? urls[id];

  return (
    <div className="flex flex-wrap gap-2">
      {images.map((img) => (
        <div
          key={img.id}
          className="relative w-20 h-20 rounded-md overflow-hidden border border-border/60 bg-muted/40 shrink-0"
        >
          {resolveUrl(img.id) ? (
            <img
              src={resolveUrl(img.id)}
              alt={img.name}
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center text-muted-foreground">
              <ImageIcon size={20} />
              {failed.has(img.id) && (
                <span className="text-[10px] mt-1 px-1 text-center">加载失败</span>
              )}
            </div>
          )}
          {!readOnly && onRemove && (
            <button
              type="button"
              aria-label="移除图片"
              className="absolute top-0.5 right-0.5 p-0.5 rounded-full bg-background/80 text-foreground hover:bg-background"
              onClick={() => onRemove(img.id)}
            >
              <X size={12} weight="bold" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
};

export interface ImageAnswerDisplayProps {
  images: QuestionImage[];
  text: string;
}

/** 已提交信封的只读展示（结果卡 / 历史回看） */
export const ImageAnswerDisplay: React.FC<ImageAnswerDisplayProps> = ({ images, text }) => {
  const { t } = useTranslation(['practice']);
  return (
    <div className="space-y-2">
      <div className="text-xs text-muted-foreground">
        {t('editor.imageAnswerCount', { count: images.length, defaultValue: `手写图片作答（${images.length} 张）` })}
      </div>
      <AnswerImageStrip images={images} readOnly />
      {text.trim() && (
        <div className="text-sm whitespace-pre-wrap border-l-2 border-border pl-2">{text}</div>
      )}
    </div>
  );
};
