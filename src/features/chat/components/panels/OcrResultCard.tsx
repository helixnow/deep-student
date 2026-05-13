import React, { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Hash } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/shad/Card';
import { Badge } from '@/components/ui/shad/Badge';
import { LatexText } from '@/components/LatexText';
import { Textarea } from '@/components/ui/shad/Textarea';
import { useTranslation } from 'react-i18next';

const NOTE_STACK_THRESHOLD = 860; // 聊天列不足 860px 时改为纵向堆叠，避免学习笔记被裁剪

interface OcrResultCardProps {
  ocrText: string;
  tags: string[];
  mistakeType?: string;
  images?: string[]; // 可选的题目图片URLs（data URL或可访问链接）
  onImageClick?: (index: number) => void; // 点击缩略图预览
  tagActions?: React.ReactNode;
  actions?: React.ReactNode;
  summary?: string | null; // 新增：聊天总结（展示为一行）
  note?: string | null;
  onNoteChange?: (nextValue: string) => void; // 🔧 改为实时自动保存模式
  isSavingNote?: boolean;
  noteError?: string | null;
  noteDisabled?: boolean; // 新增：禁用状态
}

export const OcrResultCard: React.FC<OcrResultCardProps> = ({
  ocrText,
  tags,
  mistakeType = '',
  images = [],
  onImageClick,
  tagActions,
  actions,
  summary,
  note,
  onNoteChange,
  isSavingNote = false,
  noteError,
  noteDisabled,
}) => {
  const { t } = useTranslation(['chatV2', 'common'], { keyPrefix: '' });
  const tCommon = (key: string, options?: Record<string, unknown>): string =>
    t(`common:analysis_metadata.${key}`, { returnObjects: false, ...options }) as string;
  const tOcr = (key: string) => t(`chatV2:ocr.${key}`);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [shouldStackNote, setShouldStackNote] = useState(false);

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const element = cardRef.current;
    if (!element) return;

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect?.width ?? element.clientWidth ?? 0;
      const next = width < NOTE_STACK_THRESHOLD;
      setShouldStackNote((prev) => (prev === next ? prev : next));
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // 确保数据有默认值
  const safeOcrText = ocrText || tOcr('noQuestionContent');
  const safeTags = tags || [];
  const safeImages = Array.isArray(images) ? images : [];
  const safeSummary = (summary || '').trim();
  const noteValue = note ?? '';
  const showEditableNote = typeof onNoteChange === 'function';
  const showReadonlyNote = !showEditableNote && noteValue.trim().length > 0;
  const hasNoteSection = showEditableNote || showReadonlyNote;
  
  const noteSection = showEditableNote ? (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          {tCommon('note_label')}
        </span>
        <span className="text-[11px] text-muted-foreground">
          {noteValue.trim().length === 0 ? tCommon('note_hint_empty') : tCommon('note_hint_saved')}
        </span>
      </div>
      <Textarea
        value={noteValue}
        onChange={(event) => onNoteChange(event.target.value)}
        placeholder={tCommon('note_placeholder')}
        disabled={noteDisabled}
        className="min-h-[220px] flex-1 rounded-md border-border bg-muted/30 text-sm text-foreground transition-colors focus-visible:ring-ring"
      />
      <div className="flex items-center justify-between text-[11px]">
        <span className={`font-medium ${isSavingNote ? 'text-primary' : 'text-muted-foreground'}`}>
          {isSavingNote ? tCommon('note_saving') : tCommon('note_autosave')}
        </span>
        {noteError ? (
          <span className="text-rose-500">{noteError}</span>
        ) : null}
      </div>
    </div>
  ) : showReadonlyNote ? (
    <div className="flex h-full flex-col gap-2">
      <span className="text-xs font-medium text-muted-foreground">
        {tCommon('note_label')}
      </span>
      <p className="flex-1 whitespace-pre-wrap text-sm leading-6 text-foreground">
        {noteValue}
      </p>
    </div>
  ) : null;

  return (
    <Card
      ref={cardRef}
      className="ocr-result-card relative mt-3 w-full flex-shrink-0 overflow-hidden border border-border bg-card shadow-sm sm:mt-4"
    >
      <CardContent className="relative px-4 py-3 sm:px-5 sm:py-4">
        <div
          className={clsx(
            'flex flex-col gap-4 sm:gap-6',
            hasNoteSection && !shouldStackNote && 'lg:flex-row lg:items-start lg:gap-8'
          )}
        >
          <div className={`${hasNoteSection ? 'flex-1' : 'w-full'} space-y-4 sm:space-y-6`}>
            <div className="space-y-2">
              <span className="text-[11px] font-medium text-muted-foreground sm:text-xs">{tOcr('questionContent')}</span>
              <div className="rounded-md border border-border bg-muted/30 p-3 text-xs leading-6 text-foreground sm:p-4 sm:text-sm">
                <LatexText
                  content={safeOcrText}
                  className="m-0 text-xs leading-6 text-foreground sm:text-sm"
                />
              </div>
            </div>

            <div className="space-y-2">
              <span className="text-[11px] font-medium text-muted-foreground sm:text-xs">{tCommon('summary_label')}</span>
              <div className="rounded-md border border-border bg-muted/30 p-3 text-xs leading-6 text-foreground sm:p-4 sm:text-sm">
                {safeSummary ? (
                  <LatexText
                    content={safeSummary}
                    className="m-0 text-xs leading-6 text-foreground sm:text-sm"
                  />
                ) : (
                  <span className="text-[11px] italic text-muted-foreground sm:text-xs">{tCommon('summary_empty_hint')}</span>
                )}
              </div>
            </div>

            {safeImages.length > 0 && (
              <div className="space-y-2">
                <span className="text-[11px] font-medium text-muted-foreground sm:text-xs">{tOcr('questionImages')}</span>
                <div className={`flex gap-2.5 sm:gap-3 ${safeImages.length === 1 ? 'flex-row' : 'flex-wrap'}`}>
                  {safeImages.map((src, idx) => {
                    const isFullUrl = typeof src === 'string' && /^(data:|tauri:\/\/|asset:\/\/|https?:\/\/)/.test(src);
                    const finalSrc = isFullUrl ? src : `data:image/*;base64,${src}`;
                    // 单张图片时使用横向自适应，多张图片时使用固定尺寸
                    const isSingleImage = safeImages.length === 1;
                    return (
                      <div
                        key={idx}
                        className={isSingleImage ? 'w-full' : ''}
                      >
                        <img
                          src={finalSrc}
                          alt={`Question image ${idx + 1}`}
                          className={`rounded-md border border-border bg-card object-contain ${
                            isSingleImage
                              ? 'w-full max-h-[300px]'
                              : 'h-20 w-20 object-cover sm:h-24 sm:w-24'
                          } ${
                            onImageClick ? 'cursor-pointer transition-transform hover:scale-[1.02]' : ''
                          }`}
                          onClick={() => onImageClick && onImageClick(idx)}
                          onError={(e) => {
                            e.currentTarget.style.display = 'none';
                          }}
                          onLoad={(e) => {
                            // 对于单张图片，根据图片的宽高比决定是否横向伸展
                            const img = e.currentTarget;
                            if (isSingleImage && img.naturalWidth && img.naturalHeight) {
                              const aspectRatio = img.naturalWidth / img.naturalHeight;
                              // 如果图片是横向的（宽高比大于1.2），移除高度限制，让容器自适应
                              if (aspectRatio > 1.2) {
                                img.classList.remove('max-h-[300px]');
                                img.style.maxHeight = 'none';
                                img.style.height = 'auto';
                              }
                            }
                          }}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-start gap-4 sm:gap-6">
              {mistakeType ? (
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-medium text-muted-foreground sm:text-xs">{tOcr('questionType')}</span>
                  <Badge variant="outline" className="border-border bg-muted/30 text-foreground">
                    {mistakeType}
                  </Badge>
                </div>
              ) : null}

              <div className="flex min-w-[12rem] flex-1 flex-col gap-2">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Hash className="h-3.5 w-3.5" />
                  <span className="text-[11px] font-medium sm:text-xs">{tOcr('tags')}</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {safeTags.length > 0 ? (
                    safeTags.map((tag, index) => (
                      <Badge
                        key={`${tag}-${index}`}
                        variant="outline"
                        className="border-border bg-muted/30 px-2.5 py-1 text-[11px] font-medium text-foreground sm:px-3 sm:text-xs"
                      >
                        {tag}
                      </Badge>
                    ))
                  ) : (
                    <span className="text-[11px] italic text-muted-foreground sm:text-xs">{tOcr('noTags')}</span>
                  )}
                  {tagActions ? <div className="flex items-center">{tagActions}</div> : null}
                </div>
              </div>

              {actions ? (
                <div className="ml-auto flex items-center gap-2 text-[11px] text-foreground sm:text-xs">
                  {actions}
                </div>
              ) : null}
            </div>
          </div>

          {hasNoteSection ? (
            <div
              className={clsx(
                'flex-shrink-0 border border-transparent bg-transparent p-0',
                shouldStackNote ? 'w-full' : 'lg:self-stretch lg:w-[300px] xl:w-[340px]'
              )}
            >
              {noteSection}
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
};
