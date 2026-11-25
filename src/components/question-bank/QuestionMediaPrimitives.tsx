import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  CaretDown,
  CaretUp,
  Check,
  X,
  CircleNotch,
  WarningCircle,
  ImageIcon,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { MarkdownRenderer } from '@/features/chat/components/renderers';
import { LatexText } from '@/components/LatexText';
import { QUESTION_IMAGE_LOAD_ERROR } from '@/components/questionImageLoader';
import { isSourceQuestionImage, type QuestionImage } from '@/api/questionBankApi';

/** 内联放大预览图片：点击在题目区内展开/收起，不使用遮罩层灯箱 */
export const InlineZoomImage: React.FC<{
  src: string;
  alt: string;
  collapsedClassName?: string;
}> = React.memo(({ src, alt, collapsedClassName = 'max-h-64' }) => {
  const [expanded, setExpanded] = React.useState(false);
  const { t } = useTranslation('practice');
  return (
    <button
      type="button"
      onClick={() => setExpanded(v => !v)}
      className={cn(
        'block w-full focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40',
        expanded ? 'cursor-zoom-out' : 'cursor-zoom-in'
      )}
      aria-expanded={expanded}
      aria-label={expanded ? t('editor.imageCollapse') : t('editor.imageExpand')}
      title={expanded ? t('editor.imageCollapse') : t('editor.imageExpand')}
    >
      <img
        src={src}
        alt={alt}
        loading="lazy"
        className={cn(
          'w-full object-contain transition-[max-height] duration-300 ease-out',
          expanded ? 'max-h-[70vh]' : collapsedClassName
        )}
      />
    </button>
  );
});
InlineZoomImage.displayName = 'InlineZoomImage';

/** 题干 Markdown 渲染 memo 化：计时器每秒 tick 等无关重渲染时跳过富文本重渲染 */
export const QuestionContentBlock = React.memo<{ content: string }>(({ content }) => (
  <MarkdownRenderer content={content} />
));
QuestionContentBlock.displayName = 'QuestionContentBlock';

/** 题目图片占位：已加载显示图片，失败显示错误占位，其余显示加载动画 */
export const QuestionImageSlot: React.FC<{
  url: string | undefined;
  alt: string;
  collapsedClassName: string;
  placeholderClassName: string;
  iconSize: number;
}> = ({ url, alt, collapsedClassName, placeholderClassName, iconSize }) => {
  const { t } = useTranslation('exam_sheet');
  if (url && url !== QUESTION_IMAGE_LOAD_ERROR) {
    return <InlineZoomImage src={url} alt={alt} collapsedClassName={collapsedClassName} />;
  }
  if (url === QUESTION_IMAGE_LOAD_ERROR) {
    return (
      <div
        role="img"
        aria-label={t('image.load_failed')}
        className={cn('w-full flex flex-col items-center justify-center gap-1 text-xs text-muted-foreground', placeholderClassName)}
      >
        <WarningCircle size={iconSize} />
        <span>{t('image.load_failed')}</span>
      </div>
    );
  }
  return (
    <div className={cn('w-full flex items-center justify-center text-muted-foreground', placeholderClassName)}>
      <CircleNotch size={iconSize} className="animate-spin" />
    </div>
  );
};

/** 自动关联的原始图片折叠气泡 — 默认展开 */
export const SourceImagesBubble: React.FC<{
  images: QuestionImage[];
  imageUrls: Record<string, string>;
}> = ({ images, imageUrls }) => {
  const [expanded, setExpanded] = React.useState(true);
  const { t } = useTranslation('exam_sheet');

  return (
    <div className="rounded-lg border border-border/40 bg-muted/10 overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center gap-2 px-3 py-2 [@media(pointer:coarse)]:min-h-[var(--touch-target-size)] text-xs text-muted-foreground hover:bg-[var(--interactive-hover)] transition-colors"
        onClick={() => setExpanded(v => !v)}
      >
        <ImageIcon size={14} className="flex-shrink-0" />
        <span className="flex-1 text-left">
          {t('image.source_images_bubble', {
            count: images.length,
          })}
        </span>
        {expanded ? <CaretUp size={14} /> : <CaretDown size={14} />}
      </button>
      {expanded && (
        <div className={cn(
          'grid gap-2 p-2 pt-0',
          images.length === 1 ? 'grid-cols-1' : 'grid-cols-2'
        )}>
          {images.map((img) => (
            <div key={img.id} className="rounded-lg overflow-hidden border border-border/30 bg-muted/20">
              <QuestionImageSlot
                url={imageUrls[img.id]}
                alt={img.name}
                collapsedClassName="max-h-64"
                placeholderClassName="h-24"
                iconSize={16}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

/** 题目图片区：区分确认图片（裁剪/上传）与自动关联来源截图 */
export const QuestionImagesSection: React.FC<{
  images: QuestionImage[];
  imageUrls: Record<string, string>;
  collapsedClassName: string;
  placeholderClassName: string;
  iconSize: number;
  singleGridClassName?: string;
}> = ({
  images,
  imageUrls,
  collapsedClassName,
  placeholderClassName,
  iconSize,
  singleGridClassName = 'grid-cols-1',
}) => {
  if (images.length === 0) return null;
  // 新数据用 role 区分题干/材料/选项图与来源截图；旧数据回退 crop_ 命名
  const confirmedImages = images.filter(img => !isSourceQuestionImage(img));
  const sourceImages = images.filter(img => isSourceQuestionImage(img));
  return (
    <>
      {confirmedImages.length > 0 && (
        <div className={cn(
          'grid gap-2',
          confirmedImages.length === 1 ? singleGridClassName : 'grid-cols-2'
        )}>
          {confirmedImages.map((img) => (
            <div key={img.id} className="rounded-lg overflow-hidden border border-border/40 bg-muted/20">
              <QuestionImageSlot
                url={imageUrls[img.id]}
                alt={img.name}
                collapsedClassName={collapsedClassName}
                placeholderClassName={placeholderClassName}
                iconSize={iconSize}
              />
            </div>
          ))}
        </div>
      )}
      {sourceImages.length > 0 && (
        <SourceImagesBubble images={sourceImages} imageUrls={imageUrls} />
      )}
    </>
  );
};

export interface OptionButtonProps {
  optionKey: string;
  content: string;
  isSelected: boolean;
  /** 整题判定（无标准答案时由 AI 评判给出；null = 待判定） */
  isCorrect?: boolean | null;
  isSubmitted: boolean;
  correctAnswer?: string;
  /** 稳定回调 + optionKey，配合 React.memo 避免计时器 tick 等无关渲染 */
  onSelect: (key: string) => void;
  type: 'single' | 'multiple';
  /** 内联键盘快捷键提示（桌面端），如 "1" */
  shortcutHint?: string;
}

export const OptionButton: React.FC<OptionButtonProps> = React.memo(({
  optionKey,
  content,
  isSelected,
  isCorrect,
  isSubmitted,
  correctAnswer,
  onSelect,
  shortcutHint,
}) => {
  const { t } = useTranslation('practice');
  // 扫描/OCR 导入的试卷常没有答案：此时不能拿空答案比对（会把选对的也标成「错误」），
  // 选中项的对错跟随整题判定（AI 评判），判定前保持中性。
  const hasAnswerKey = Boolean(correctAnswer?.trim());
  // 大小写归一：后端返回小写字母答案时也能正确高亮
  const isThisCorrect = hasAnswerKey
    ? correctAnswer!.toUpperCase().includes(optionKey.toUpperCase())
    : isSelected && isCorrect === true;
  const isWrong = isSubmitted && isSelected && (hasAnswerKey ? !isThisCorrect : isCorrect === false);
  const showCorrect = isSubmitted && isThisCorrect;
  // 已提交、待 AI 判定：保留选中态，不提前给对错
  const isPendingVerdict = isSubmitted && isSelected && !showCorrect && !isWrong;

  const handleClick = React.useCallback(() => onSelect(optionKey), [onSelect, optionKey]);

  return (
    <DsButton
      variant="ghost" size="sm"
      onClick={handleClick}
      disabled={isSubmitted}
      className={cn(
        'group w-full !justify-start !h-auto !p-0 !rounded-xl border transition-all',
        // 未提交：按压缩放反馈（ui-press 使用独立 scale 属性）
        !isSubmitted && 'ui-press',
        !isSubmitted && !isSelected && 'border-border/45 bg-card/60 hover:bg-foreground/[0.03] hover:border-border/80',
        // 选中：描边 + 浅色填充
        !isSubmitted && isSelected && 'border-primary/45 bg-primary/[0.06]',
        showCorrect && 'border-success/40 bg-success/[0.06]',
        // 答错：轻微 shake
        isWrong && 'border-destructive/35 bg-destructive/[0.05] qbank-anim-shake',
        isPendingVerdict && 'border-primary/45 bg-primary/[0.06]',
        isSubmitted && !isSelected && !isThisCorrect && 'border-border/35 bg-card/30 opacity-50',
        'disabled:cursor-default'
      )}
    >
      <div className="flex w-full items-start gap-3 px-4 py-3 text-left">
        {/* 选项键帽 - 24×24 等宽 */}
        <div className={cn(
          'flex-shrink-0 w-6 h-6 rounded-md border flex items-center justify-center font-mono text-xs font-medium transition-colors',
          // 默认 - 极细描边
          !isSubmitted && !isSelected && 'border-border/60 bg-background/80 text-muted-foreground group-hover:border-border',
          // 选中 - 主题色填充
          !isSubmitted && isSelected && 'border-primary bg-primary text-primary-foreground',
          // 正确 - 绿色填充 + 对勾弹入
          showCorrect && 'border-success bg-success text-success-foreground qbank-anim-pop',
          // 错误 - 红色填充
          isWrong && 'border-destructive bg-destructive text-destructive-foreground',
          isPendingVerdict && 'border-primary bg-primary text-primary-foreground',
          // 已提交非选中非正确
          isSubmitted && !isSelected && !isThisCorrect && 'border-border/40 bg-background/50 text-muted-foreground/50'
        )}>
          {showCorrect ? (
            <Check size={13} weight="bold" />
          ) : isWrong ? (
            <X size={13} />
          ) : (
            optionKey
          )}
        </div>

        {/* 选项内容 */}
        <div className="flex-1 min-w-0 pt-0.5">
          <LatexText
            content={content}
            className={cn(
              'text-sm leading-relaxed',
              !isSubmitted && 'text-foreground',
              showCorrect && 'text-success',
              isWrong && 'text-destructive',
              isSubmitted && !isSelected && !isThisCorrect && 'text-foreground/50'
            )}
          />
        </div>

        {/* 内联快捷键提示：仅悬停未提交时淡入 */}
        {!isSubmitted && shortcutHint && (
          <kbd className="flex-shrink-0 hidden sm:inline-flex items-center justify-center min-w-[20px] h-5 px-1 rounded border border-border/50 bg-background/80 font-mono text-2xs text-muted-foreground/75 opacity-0 group-hover:opacity-100 transition-opacity">
            {shortcutHint}
          </kbd>
        )}

        {/* 状态文字 - 简洁风格：简洁文字标识 */}
        {showCorrect && (
          <span className="flex-shrink-0 text-xs text-success ui-rise-in">
            {t('editor.correct')}
          </span>
        )}
        {isWrong && (
          <span className="flex-shrink-0 text-xs text-destructive ui-rise-in">
            {t('editor.wrong')}
          </span>
        )}
      </div>
    </DsButton>
  );
});
OptionButton.displayName = 'OptionButton';
