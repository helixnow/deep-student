/**
 * 音视频库列表行：16:9 缩略图（B 站封面 / 类型图标，底边是观看进度）· 名称 · 时长 / 最近观看 ·
 * 转写状态徽章 · ⋯ 菜单。进度条画在缩略图里，各行高度一致。
 * 触屏：整行 ≥ 64px、⋯ 按钮 44px；长按与 ⋯ 打开同一个 AppMenu（本仓无底部动作表基元）。
 */
import React, { memo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CheckCircle,
  CircleNotch,
  DotsThree,
  FileArrowDown,
  FileArrowUp,
  FilmStrip,
  FolderOpen,
  MusicNotes,
  PencilSimple,
  Television,
  Trash,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import {
  AppMenu,
  AppMenuContent,
  AppMenuItem,
  AppMenuSeparator,
  AppMenuTrigger,
} from '@/components/ui/app-menu';
import { useLongPress } from '@/hooks/mobile/useLongPress';
import type { TranscriptExportFormat } from '@/features/learning-hub/apps/views/media/mediaTranscriptApi';
import { stripBilibiliExtension } from '@/features/learning-hub/apps/views/media/bilibiliLinkApi';
import type { MediaLibraryItem } from '../api';
import {
  formatDuration,
  formatRelativeTime,
  transcriptChip,
  watchRatio,
  type StatusChipTone,
} from '../libraryModel';
import { useBreakpoint } from '@/hooks/useBreakpoint';

export type MediaRowAction =
  | { type: 'rename' }
  | { type: 'importSubtitle' }
  | { type: 'bilibiliSubtitle' }
  | { type: 'exportSubtitle'; format: TranscriptExportFormat }
  | { type: 'reveal' }
  | { type: 'delete' };

const CHIP_TONE_CLASS: Record<StatusChipTone, string> = {
  // utility 底在暗色下近乎透明，「未转写」读起来像裸文字；与其它状态同为实底胶囊
  neutral: 'study-shell-badge--muted',
  primary: 'study-shell-badge--primary',
  success: 'study-shell-badge--success',
  warning: 'study-shell-badge--warning',
  danger: 'study-shell-badge--danger',
};

export interface MediaStatusChipProps {
  item: MediaLibraryItem;
  className?: string;
}

export const MediaStatusChip: React.FC<MediaStatusChipProps> = ({ item, className }) => {
  const { t } = useTranslation(['mediaStudio']);
  const chip = transcriptChip(item);
  const label =
    chip.key === 'running' && chip.total
      ? t('mediaStudio:status.runningCount', { completed: chip.completed ?? 0, total: chip.total })
      : t(`mediaStudio:status.${chip.key}`);
  return (
    <span
      className={cn('study-shell-badge study-shell-badge--borderless shrink-0', CHIP_TONE_CLASS[chip.tone], className)}
      data-transcript-chip={chip.key}
    >
      {chip.busy ? (
        <CircleNotch size={11} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
      ) : null}
      {label}
    </span>
  );
};

interface MediaThumbProps {
  item: MediaLibraryItem;
  icon: React.ReactNode;
  /** 观看进度 0..1；null 不画（未开始 / 看完 / 时长未知） */
  ratio: number | null;
}

/** 16:9 缩略图：B 站条目显示封面（加载失败退回图标），左上角「B 站」角标；底边观看进度 */
const MediaThumb: React.FC<MediaThumbProps> = ({ item, icon, ratio }) => {
  const { t } = useTranslation(['mediaStudio']);
  const [coverFailed, setCoverFailed] = useState(false);
  const cover = item.coverUrl && !coverFailed ? item.coverUrl : null;
  return (
    <span
      className="relative flex h-12 w-[86px] shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-shell-control)] bg-[color:var(--surface-muted)] text-muted-foreground"
    >
      {cover ? (
        // referrerPolicy 必须写在 src 前：WebKit 一拿到 src 就发请求，带本地 Referer 会被图床 403
        <img
          referrerPolicy="no-referrer"
          src={cover}
          alt=""
          loading="lazy"
          draggable={false}
          onError={() => setCoverFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <span aria-hidden="true">{icon}</span>
      )}
      {item.isLink ? (
        <span
          className="absolute left-1 top-1 rounded px-1 text-[10px] font-medium leading-4 text-white"
          style={{ background: 'rgb(0 0 0 / 0.55)' }}
          data-media-link-badge=""
        >
          {t('mediaStudio:row.bilibiliBadge')}
        </span>
      ) : null}
      {ratio !== null ? (
        <span
          className="absolute inset-x-0 bottom-0 block h-[3px] bg-black/25"
          role="progressbar"
          aria-label={t('mediaStudio:row.progress')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(ratio * 100)}
        >
          <span className="block h-full bg-primary" style={{ width: `${Math.round(ratio * 100)}%` }} />
        </span>
      ) : null}
    </span>
  );
};

export interface MediaLibraryRowProps {
  item: MediaLibraryItem;
  now: number;
  onOpen: (item: MediaLibraryItem) => void;
  onAction: (item: MediaLibraryItem, action: MediaRowAction) => void;
}

export const MediaLibraryRow = memo(function MediaLibraryRow({ item, now, onOpen, onAction }: MediaLibraryRowProps) {
  const { t, i18n } = useTranslation(['mediaStudio', 'learningHub', 'common']);
  const [menuOpen, setMenuOpen] = useState(false);
  // 状态徽章只渲染一处：手机与元信息同行，桌面在行尾（不能靠 sm:hidden——
  // study-shell-badge 自带 display 会盖掉 hidden，导致两处同时出现）
  const { isSmallScreen } = useBreakpoint();
  const longPress = useLongPress({ onLongPress: () => setMenuOpen(true) });

  const duration = formatDuration(item.durationMs);
  const ratio = watchRatio(item);
  const finished = Boolean(item.progress?.finished);
  const hasTranscript = item.transcript.completedSegments > 0;
  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN';
  const meta = [
    duration,
    item.lastWatchedAt
      ? t('mediaStudio:row.lastWatched', { time: formatRelativeTime(item.lastWatchedAt, now, locale) })
      : t('mediaStudio:row.notStarted'),
    item.folderName,
  ].filter(Boolean).join(' · ');

  const Icon = item.isLink ? Television : item.kind === 'audio' ? MusicNotes : FilmStrip;
  const displayName = item.isLink ? stripBilibiliExtension(item.name) : item.name;
  const act = useCallback((action: MediaRowAction) => onAction(item, action), [item, onAction]);

  return (
    <li data-media-row={item.id}>
      <div
        className={cn(
          'study-shell-secondary-card flex items-center gap-3 px-3 py-2.5',
          'min-h-16',
        )}
      >
        {/* 主体：整块可点进入学习页 */}
        <DsButton
          variant="ghost"
          onClick={() => onOpen(item)}
          {...longPress.bind}
          aria-label={t('mediaStudio:row.open', { name: displayName })}
          className="!h-auto min-w-0 flex-1 !justify-start gap-3 !p-0 text-left hover:!bg-transparent"
        >
          <MediaThumb item={item} icon={<Icon size={20} weight="duotone" />} ratio={finished ? null : ratio} />
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 truncate text-sm font-medium text-foreground">{displayName}</span>
              {finished ? (
                <CheckCircle size={14} weight="fill" className="shrink-0 text-success" aria-label={t('mediaStudio:row.finished')} />
              ) : null}
            </span>
            <span className="flex min-w-0 items-center gap-2">
              {/* 手机：状态徽章与元信息同一行（桌面在行尾） */}
              {isSmallScreen ? <MediaStatusChip item={item} /> : null}
              <span className="min-w-0 truncate text-xs text-muted-foreground tabular-nums">{meta}</span>
            </span>
          </span>
        </DsButton>

        {isSmallScreen ? null : <MediaStatusChip item={item} />}

        <AppMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <AppMenuTrigger asChild>
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              aria-label={t('mediaStudio:row.more', { name: displayName })}
              title={t('common:more')}
              className="!h-8 !w-8 shrink-0 text-muted-foreground"
            >
              <DotsThree size={18} weight="bold" aria-hidden="true" />
            </DsButton>
          </AppMenuTrigger>
          <AppMenuContent align="end" width={220}>
            <AppMenuItem icon={<FileArrowUp size={15} aria-hidden="true" />} onClick={() => act({ type: 'importSubtitle' })}>
              {t('learningHub:mediaTranscript.import')}
            </AppMenuItem>
            <AppMenuItem icon={<Television size={15} aria-hidden="true" />} onClick={() => act({ type: 'bilibiliSubtitle' })}>
              {item.isLink ? t('learningHub:mediaBilibili.refetch') : t('learningHub:mediaBilibili.fromLink')}
            </AppMenuItem>
            {(['srt', 'vtt', 'txt'] as const).map((format) => (
              <AppMenuItem
                key={format}
                icon={<FileArrowDown size={15} aria-hidden="true" />}
                disabled={!hasTranscript}
                onClick={() => act({ type: 'exportSubtitle', format })}
              >
                {t(
                  format === 'srt'
                    ? 'learningHub:mediaTranscript.exportSrt'
                    : format === 'vtt'
                      ? 'learningHub:mediaTranscript.exportVtt'
                      : 'learningHub:mediaTranscript.exportTxt',
                )}
              </AppMenuItem>
            ))}
            <AppMenuSeparator />
            <AppMenuItem icon={<PencilSimple size={15} aria-hidden="true" />} onClick={() => act({ type: 'rename' })}>
              {t('mediaStudio:row.rename')}
            </AppMenuItem>
            <AppMenuItem icon={<FolderOpen size={15} aria-hidden="true" />} onClick={() => act({ type: 'reveal' })}>
              {t('mediaStudio:row.reveal')}
            </AppMenuItem>
            <AppMenuSeparator />
            <AppMenuItem icon={<Trash size={15} aria-hidden="true" />} destructive onClick={() => act({ type: 'delete' })}>
              {t('mediaStudio:row.delete')}
            </AppMenuItem>
          </AppMenuContent>
        </AppMenu>
      </div>
    </li>
  );
});
