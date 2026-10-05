/**
 * 「B 站链接」弹窗：贴链接 → 解析（标题 / 分 P / 字幕轨）→ 导入。
 *
 * - create：新建链接条目（不下载视频，播放走内嵌播放器）；同一视频同一分 P 再导入复用原条目
 * - attach：给本地媒体导入同一视频在 B 站上的字幕（替换现有字幕，免去转写费用）
 * - refetch：链接条目重新获取自己的字幕（链接固定，可换字幕轨）
 */
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleNotch, Television } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import {
  DsDialog,
  DsDialogBody,
  DsDialogDescription,
  DsDialogFooter,
  DsDialogHeader,
  DsDialogTitle,
} from '@/components/ui/DsDialog';
import { Input } from '@/components/ui/shad/Input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/shad/Select';
import { getErrorMessage } from '@/utils/errorUtils';
import { formatMediaRefTimestamp } from './mediaRefTime';
import { bilibiliLinkApi, type BilibiliProbe } from './bilibiliLinkApi';

export type BilibiliLinkDialogMode =
  | { kind: 'create' }
  | { kind: 'attach'; resourceId: string; name: string }
  | { kind: 'refetch'; resourceId: string; name: string; url: string; page: number };

export interface BilibiliLinkDialogResult {
  fileId: string;
  /** create：是否新建了条目（false = 复用已有条目、只替换字幕） */
  created: boolean;
  segments: number;
  name: string;
}

export interface BilibiliLinkDialogProps {
  open: boolean;
  mode: BilibiliLinkDialogMode;
  onOpenChange: (open: boolean) => void;
  onDone?: (result: BilibiliLinkDialogResult) => void;
}

export const BilibiliLinkDialog: React.FC<BilibiliLinkDialogProps> = ({ open, mode, onOpenChange, onDone }) => {
  const { t } = useTranslation(['learningHub', 'common']);
  const titleId = useId();
  const fixedLink = mode.kind === 'refetch';
  const [input, setInput] = useState('');
  const [probe, setProbe] = useState<BilibiliProbe | null>(null);
  const [page, setPage] = useState<number | null>(null);
  const [lan, setLan] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const runProbe = useCallback(async (link: string, pageArg: number | null) => {
    const text = link.trim();
    if (!text) return;
    const request = ++requestRef.current;
    setProbing(true);
    setError(null);
    try {
      const result = await bilibiliLinkApi.probe(text, pageArg);
      if (request !== requestRef.current) return;
      setProbe(result);
      setPage(result.page);
      setLan(result.defaultLan);
    } catch (err: unknown) {
      if (request !== requestRef.current) return;
      setProbe(null);
      setError(getErrorMessage(err));
    } finally {
      if (request === requestRef.current) setProbing(false);
    }
  }, []);

  // 打开时重置；重新获取模式直接解析条目自己的链接
  useEffect(() => {
    if (!open) return;
    requestRef.current += 1;
    setProbe(null);
    setLan(null);
    setError(null);
    setProbing(false);
    setImporting(false);
    if (mode.kind === 'refetch') {
      setInput(mode.url);
      setPage(mode.page);
      void runProbe(mode.url, mode.page);
    } else {
      setInput('');
      setPage(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在打开时按当时的模式初始化
  }, [open]);

  const handlePageChange = useCallback(
    (value: string) => {
      const next = Number(value);
      if (!Number.isFinite(next) || next === page) return;
      setPage(next);
      void runProbe(input, next);
    },
    [input, page, runProbe],
  );

  const canImport = Boolean(probe && probe.tracks.length > 0 && !probing && !importing);

  const handleImport = useCallback(async () => {
    if (!probe || !canImport) return;
    setImporting(true);
    setError(null);
    try {
      if (mode.kind === 'create') {
        const result = await bilibiliLinkApi.create(input.trim(), page, lan);
        onDone?.({ fileId: result.fileId, created: result.created, segments: result.segments, name: result.name });
      } else {
        const transcript = await bilibiliLinkApi.importSubtitle(mode.resourceId, input.trim(), page, lan);
        onDone?.({
          fileId: mode.resourceId,
          created: false,
          segments: transcript.segments.filter((s) => s.status === 'done').length,
          name: mode.name,
        });
      }
      onOpenChange(false);
    } catch (err: unknown) {
      setError(getErrorMessage(err));
    } finally {
      setImporting(false);
    }
  }, [canImport, input, lan, mode, onDone, onOpenChange, page, probe]);

  const title =
    mode.kind === 'create'
      ? t('learningHub:mediaBilibili.dialogTitleCreate')
      : mode.kind === 'attach'
        ? t('learningHub:mediaBilibili.dialogTitleAttach')
        : t('learningHub:mediaBilibili.dialogTitleRefetch');
  const description =
    mode.kind === 'create'
      ? t('learningHub:mediaBilibili.dialogDescCreate')
      : mode.kind === 'attach'
        ? t('learningHub:mediaBilibili.dialogDescAttach', { name: mode.name })
        : t('learningHub:mediaBilibili.dialogDescRefetch');

  const selectedPage = probe?.pages.find((p) => p.page === page) ?? null;
  const pageDurationMs = selectedPage?.durationMs || probe?.durationMs || 0;

  return (
    <DsDialog open={open} onOpenChange={onOpenChange} aria-labelledby={titleId} maxWidth="max-w-lg">
      <DsDialogHeader>
        <DsDialogTitle id={titleId}>{title}</DsDialogTitle>
        <DsDialogDescription>{description}</DsDialogDescription>
      </DsDialogHeader>
      <DsDialogBody className="space-y-4 py-4" data-bilibili-dialog={mode.kind}>
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void runProbe(input, null);
          }}
        >
          <Input
            autoFocus={!fixedLink}
            value={input}
            readOnly={fixedLink}
            onChange={(event) => setInput(event.target.value)}
            placeholder={t('learningHub:mediaBilibili.linkPlaceholder')}
            aria-label={t('learningHub:mediaBilibili.linkLabel')}
            className="h-9 flex-1 text-sm"
            data-bilibili-link-input=""
          />
          {!fixedLink && (
            <DsButton type="submit" variant="ghost" size="sm" disabled={!input.trim() || probing} className="shrink-0 gap-1.5">
              {probing ? <CircleNotch size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
              {t('learningHub:mediaBilibili.parse')}
            </DsButton>
          )}
        </form>

        {probing && !probe ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
            <CircleNotch size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
            {t('learningHub:mediaBilibili.parsing')}
          </p>
        ) : null}

        {probe ? (
          <div className="space-y-3" data-bilibili-probe={probe.bvid}>
            <div className="flex items-start gap-3">
              {probe.cover ? (
                <img
                  src={probe.cover}
                  alt=""
                  referrerPolicy="no-referrer"
                  className="h-[54px] w-24 shrink-0 rounded-md bg-muted object-cover"
                />
              ) : (
                <span className="flex h-[54px] w-24 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                  <Television size={20} weight="duotone" aria-hidden="true" />
                </span>
              )}
              <div className="min-w-0 flex-1 space-y-1">
                <p className="line-clamp-2 text-sm font-medium text-foreground">{probe.title}</p>
                <p className="truncate text-xs text-muted-foreground tabular-nums">
                  {[probe.owner, pageDurationMs > 0 ? formatMediaRefTimestamp(pageDurationMs / 1000) : null]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>
            </div>

            {probe.pages.length > 1 ? (
              <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
                {t('learningHub:mediaBilibili.pageLabel')}
                <Select value={String(page ?? probe.page)} onValueChange={handlePageChange} disabled={probing || importing || fixedLink}>
                  <SelectTrigger className="h-9 text-sm" data-bilibili-page-select="">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {probe.pages.map((p) => (
                      <SelectItem key={p.page} value={String(p.page)}>
                        {t('learningHub:mediaBilibili.pageOption', { page: p.page, part: p.part || probe.title })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            ) : null}

            {probe.tracks.length > 0 ? (
              <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
                {t('learningHub:mediaBilibili.trackLabel')}
                <Select value={lan ?? probe.tracks[0].lan} onValueChange={setLan} disabled={probing || importing}>
                  <SelectTrigger className="h-9 text-sm" data-bilibili-track-select="">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {probe.tracks.map((track) => (
                      <SelectItem key={track.lan} value={track.lan}>
                        {track.ai
                          ? t('learningHub:mediaBilibili.trackAiOption', { name: track.lanDoc })
                          : track.lanDoc}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            ) : (
              <p className="rounded-md bg-muted/60 px-3 py-2 text-xs leading-relaxed text-muted-foreground" data-bilibili-no-tracks="">
                {t('learningHub:mediaBilibili.noTracks')}
              </p>
            )}

            {mode.kind === 'create' && probe.existingId ? (
              <p className="text-xs leading-relaxed text-muted-foreground" data-bilibili-existing="">
                {t('learningHub:mediaBilibili.existing')}
              </p>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <p className="break-words text-xs leading-relaxed text-destructive" role="alert" data-bilibili-error="">
            {error}
          </p>
        ) : null}
      </DsDialogBody>
      <DsDialogFooter>
        <DsButton variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={importing}>
          {t('common:cancel')}
        </DsButton>
        <DsButton
          variant="primary"
          size="sm"
          onClick={() => void handleImport()}
          disabled={!canImport}
          className="gap-1.5"
          data-bilibili-confirm=""
        >
          {importing ? <CircleNotch size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
          {mode.kind === 'create'
            ? t('learningHub:mediaBilibili.confirmCreate')
            : t('learningHub:mediaBilibili.confirmAttach')}
        </DsButton>
      </DsDialogFooter>
    </DsDialog>
  );
};

export default BilibiliLinkDialog;
