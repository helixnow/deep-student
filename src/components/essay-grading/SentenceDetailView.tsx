/**
 * 逐句详解视图 — 将行内标注展开为卡片式详解
 * 每个错误/替换/删除标注显示：分类标签 + 原文 → 修改 + 详细解释
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { StreamingMarker } from '@/essay-grading/streamingMarkerParser';
import { AlertTriangle, ArrowRight, Trash2, PenLine, Sparkles, type LucideIcon } from 'lucide-react';

interface SentenceDetailViewProps {
  markers: StreamingMarker[];
  className?: string;
}

/** 错误类型 → 颜色分组 */
const ERROR_BADGE_STYLES: Record<string, string> = {
  grammar: 'bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400 border-red-200 dark:border-red-800',
  tense: 'bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400 border-red-200 dark:border-red-800',
  agreement: 'bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400 border-red-200 dark:border-red-800',
  spelling: 'bg-orange-50 dark:bg-orange-950/30 text-orange-600 dark:text-orange-400 border-orange-200 dark:border-orange-800',
  punctuation: 'bg-orange-50 dark:bg-orange-950/30 text-orange-600 dark:text-orange-400 border-orange-200 dark:border-orange-800',
  article: 'bg-purple-50 dark:bg-purple-950/30 text-purple-600 dark:text-purple-400 border-purple-200 dark:border-purple-800',
  preposition: 'bg-purple-50 dark:bg-purple-950/30 text-purple-600 dark:text-purple-400 border-purple-200 dark:border-purple-800',
  word_form: 'bg-purple-50 dark:bg-purple-950/30 text-purple-600 dark:text-purple-400 border-purple-200 dark:border-purple-800',
  sentence_structure: 'bg-purple-50 dark:bg-purple-950/30 text-purple-600 dark:text-purple-400 border-purple-200 dark:border-purple-800',
  word_choice: 'bg-blue-50 dark:bg-blue-950/30 text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-800',
  expression: 'bg-blue-50 dark:bg-blue-950/30 text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-800',
  logic: 'bg-amber-50 dark:bg-amber-950/30 text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-800',
};
const DEFAULT_BADGE_STYLE = 'bg-muted/30 text-muted-foreground border-border/40';

/** 非 err 标记类型 → badge 配置 */
const MARKER_BADGE_CONFIG: Partial<Record<StreamingMarker['type'], { icon: LucideIcon; i18nKey: string; style: string }>> = {
  del: { icon: Trash2, i18nKey: 'essay_grading:markers.delete', style: 'bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400 border-red-200 dark:border-red-800' },
  replace: { icon: PenLine, i18nKey: 'essay_grading:markers.replace', style: 'bg-amber-50 dark:bg-amber-950/30 text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-800' },
  ins: { icon: Sparkles, i18nKey: 'essay_grading:markers.insert', style: 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800' },
  note: { icon: AlertTriangle, i18nKey: 'essay_grading:markers.note', style: 'bg-blue-50 dark:bg-blue-950/30 text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-800' },
};

/** 渲染标记卡片的内容区 */
const MarkerContent: React.FC<{ marker: StreamingMarker }> = ({ marker }) => {
  switch (marker.type) {
    case 'replace':
      return (
        <div className="flex items-start gap-2 text-sm">
          <span className="text-red-500/80 line-through">{marker.oldText}</span>
          <ArrowRight className="w-4 h-4 text-muted-foreground/40 shrink-0 mt-0.5" />
          <span className="text-emerald-600 dark:text-emerald-400 font-medium">{marker.newText}</span>
        </div>
      );
    case 'del':
      return <div className="text-sm text-red-500/80 line-through">{marker.content}</div>;
    case 'ins':
      return <div className="text-sm text-emerald-600 dark:text-emerald-400">{marker.content}</div>;
    case 'err':
      return (
        <div className="text-sm">
          <span className="text-red-500/80 underline decoration-wavy decoration-red-400/50">{marker.content}</span>
        </div>
      );
    case 'note':
      return (
        <div className="text-sm text-blue-600 dark:text-blue-400 border-b border-dashed border-blue-400/60 inline">
          {marker.content}
        </div>
      );
    default:
      return null;
  }
};

export const SentenceDetailView: React.FC<SentenceDetailViewProps> = ({ markers, className }) => {
  const { t } = useTranslation(['essay_grading']);

  // 过滤出有意义的标注（非纯文本/pending）
  const detailMarkers = markers.filter(
    (m) => m.type !== 'text' && m.type !== 'pending' && m.type !== 'good'
  );

  if (detailMarkers.length === 0) {
    return (
      <div className={cn('flex items-center justify-center py-12 text-muted-foreground/40 text-sm', className)}>
        {t('essay_grading:sections.no_corrections')}
      </div>
    );
  }

  return (
    <div className={cn('space-y-3', className)}>
      {detailMarkers.map((marker, index) => (
        <div
          key={index}
          className="rounded-lg border border-border/30 bg-card/50 overflow-hidden"
        >
          {/* 卡片头部：序号 + 分类标签 */}
          <div className="flex items-center gap-2 px-4 py-2 border-b border-border/20 bg-muted/10">
            <span className="text-xs text-muted-foreground/50 font-mono tabular-nums w-5">
              {index + 1}
            </span>
            {marker.type === 'err' && marker.errorType ? (
              <span className={cn(
                'px-2 py-0.5 text-xs font-medium rounded border',
                ERROR_BADGE_STYLES[marker.errorType] ?? DEFAULT_BADGE_STYLE
              )}>
                {t(`essay_grading:markers.error.${marker.errorType}`, { defaultValue: marker.errorType })}
              </span>
            ) : MARKER_BADGE_CONFIG[marker.type] ? (() => {
              const cfg = MARKER_BADGE_CONFIG[marker.type]!;
              const Icon = cfg.icon;
              return (
                <span className={cn('flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded border', cfg.style)}>
                  <Icon className="w-3 h-3" />
                  {t(cfg.i18nKey)}
                </span>
              );
            })() : null}
          </div>

          {/* 卡片内容 */}
          <div className="px-4 py-3 space-y-2">
            <MarkerContent marker={marker} />

            {/* 详细解释 */}
            {(marker.explanation || marker.reason || marker.comment) && (
              <div className="text-xs text-muted-foreground/70 leading-relaxed bg-muted/20 rounded px-3 py-2 mt-1">
                {marker.explanation || marker.reason || marker.comment}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
};
