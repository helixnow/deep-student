/**
 * 「B 站链接」弹窗：贴链接 → 解析（标题 / 分 P / 字幕轨）→ 导入。
 *
 * - create：新建链接条目（不下载视频，播放走内嵌播放器）；同一视频同一分 P 再导入复用原条目。
 *   多 P 视频列出全部分 P 可勾选，逐 P 导入（每 P 一个条目），每 P 之间节流，可随时停止
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
import { Checkbox } from '@/components/ui/shad/Checkbox';
import { Input } from '@/components/ui/shad/Input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/shad/Select';
import { getErrorMessage } from '@/utils/errorUtils';
import { formatMediaRefTimestamp } from './mediaRefTime';
import { MediaCommandError } from './mediaTranscriptApi';
import { bilibiliLinkApi, type BilibiliProbe } from './bilibiliLinkApi';
import { BilibiliAccountPanel } from './BilibiliAccountPanel';

export type BilibiliLinkDialogMode =
  | { kind: 'create' }
  | { kind: 'attach'; resourceId: string; name: string }
  | { kind: 'refetch'; resourceId: string; name: string; url: string; page: number };

export interface BilibiliBatchSummary {
  total: number;
  created: number;
  updated: number;
  /** 没有字幕、被跳过的分 P */
  skipped: number[];
  failed: Array<{ page: number; message: string }>;
  /** 停止或被风控提前结束时没处理的分 P 数 */
  remaining: number;
}

export interface BilibiliLinkDialogResult {
  fileId: string;
  /** create：是否新建了条目（false = 复用已有条目、只替换字幕） */
  created: boolean;
  segments: number;
  name: string;
  /** 多 P 批量导入的汇总（单个导入时为空） */
  batch?: BilibiliBatchSummary;
}

export interface BilibiliLinkDialogProps {
  open: boolean;
  mode: BilibiliLinkDialogMode;
  onOpenChange: (open: boolean) => void;
  onDone?: (result: BilibiliLinkDialogResult) => void;
  /** 批量导入每 P 之间的间隔 */
  batchIntervalMs?: number;
  /** 单 P 请求失败后重试前的等待 */
  retryDelayMs?: number;
}

const BATCH_INTERVAL_MS = 400;
const RETRY_DELAY_MS = 3000;
const PAGE_LIST_LIMIT = 8;

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

type PageOutcome =
  | { kind: 'ok'; created: boolean; fileId: string; segments: number }
  | { kind: 'no-subtitle' }
  | { kind: 'failed'; message: string; blocked: boolean };

type Translate = (key: string, options?: Record<string, unknown>) => unknown;

/** 批量导入结果的一句话汇总（新建 + 更新 / 跳过 / 失败 / 停止） */
export function summarizeBilibiliBatch(summary: BilibiliBatchSummary, t: Translate, language?: string): string {
  const sep = (language ?? '').toLowerCase().startsWith('zh') ? '、' : ', ';
  const pageList = (pages: number[]) =>
    pages.slice(0, PAGE_LIST_LIMIT).map((p) => `P${p}`).join(sep) +
    (pages.length > PAGE_LIST_LIMIT ? ` (+${pages.length - PAGE_LIST_LIMIT})` : '');
  const parts = [String(t('learningHub:mediaBilibili.batchDone', { count: summary.created + summary.updated }))];
  if (summary.skipped.length > 0) {
    parts.push(String(t('learningHub:mediaBilibili.batchSkipped', { pages: pageList(summary.skipped) })));
  }
  if (summary.failed.length > 0) {
    parts.push(
      String(
        t('learningHub:mediaBilibili.batchFailed', {
          pages: pageList(summary.failed.map((f) => f.page)),
          message: summary.failed[summary.failed.length - 1].message,
        }),
      ),
    );
  }
  if (summary.remaining > 0) {
    parts.push(String(t('learningHub:mediaBilibili.batchStopped', { count: summary.remaining })));
  }
  return parts.join(sep === '、' ? '；' : '; ');
}

export const BilibiliLinkDialog: React.FC<BilibiliLinkDialogProps> = ({
  open,
  mode,
  onOpenChange,
  onDone,
  batchIntervalMs = BATCH_INTERVAL_MS,
  retryDelayMs = RETRY_DELAY_MS,
}) => {
  const { t } = useTranslation(['learningHub', 'common']);
  const titleId = useId();
  const fixedLink = mode.kind === 'refetch';
  const [input, setInput] = useState('');
  const [probe, setProbe] = useState<BilibiliProbe | null>(null);
  const [page, setPage] = useState<number | null>(null);
  const [selectedPages, setSelectedPages] = useState<Set<number>>(() => new Set());
  const [lan, setLan] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [batch, setBatch] = useState<{ index: number; total: number; page: number; part: string } | null>(null);
  const [stopRequested, setStopRequested] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const stopRef = useRef(false);
  const batchRunningRef = useRef(false);

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
      setSelectedPages(new Set([result.page]));
      setLan(result.defaultLan);
    } catch (err: unknown) {
      if (request !== requestRef.current) return;
      setProbe(null);
      setError(getErrorMessage(err));
    } finally {
      if (request === requestRef.current) setProbing(false);
    }
  }, []);

  // 打开时重置；重新获取模式直接解析条目自己的链接（批量导入进行中不重置）
  useEffect(() => {
    if (!open || batchRunningRef.current) return;
    requestRef.current += 1;
    setProbe(null);
    setLan(null);
    setError(null);
    setProbing(false);
    setImporting(false);
    setBatch(null);
    setStopRequested(false);
    setSelectedPages(new Set());
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

  const multiPage = mode.kind === 'create' && (probe?.pages.length ?? 0) > 1;
  const busy = probing || importing;

  const handlePageChange = useCallback(
    (value: string) => {
      const next = Number(value);
      if (!Number.isFinite(next) || next === page) return;
      setPage(next);
      void runProbe(input, next);
    },
    [input, page, runProbe],
  );

  const togglePage = useCallback((value: number) => {
    setSelectedPages((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }, []);

  const canImport = (() => {
    if (!probe || busy) return false;
    if (!multiPage) return probe.tracks.length > 0;
    if (selectedPages.size === 0) return false;
    // 只勾了已知没有字幕的那一 P
    return !(selectedPages.size === 1 && selectedPages.has(probe.page) && probe.tracks.length === 0);
  })();

  const importPage = useCallback(
    async (url: string, pageNo: number): Promise<PageOutcome> => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          const result = await bilibiliLinkApi.create(url, pageNo, lan);
          return { kind: 'ok', created: result.created, fileId: result.fileId, segments: result.segments };
        } catch (err: unknown) {
          const code = err instanceof MediaCommandError ? err.code : 'unknown';
          if (code === 'bilibili-no-subtitle') return { kind: 'no-subtitle' };
          const transient = code === 'bilibili-request-failed';
          if (transient && attempt === 0 && !stopRef.current) {
            await sleep(retryDelayMs);
            continue;
          }
          return { kind: 'failed', message: getErrorMessage(err), blocked: transient };
        }
      }
    },
    [lan, retryDelayMs],
  );

  const runBatch = useCallback(
    async (current: BilibiliProbe, pages: number[]) => {
      const url = `https://www.bilibili.com/video/${current.bvid}`;
      const summary: BilibiliBatchSummary = { total: pages.length, created: 0, updated: 0, skipped: [], failed: [], remaining: 0 };
      let firstFileId = '';
      let segments = 0;
      stopRef.current = false;
      batchRunningRef.current = true;
      try {
        for (let i = 0; i < pages.length; i += 1) {
          if (stopRef.current) {
            summary.remaining = pages.length - i;
            break;
          }
          const pageNo = pages[i];
          setBatch({
            index: i + 1,
            total: pages.length,
            page: pageNo,
            part: current.pages.find((p) => p.page === pageNo)?.part ?? '',
          });
          const outcome = await importPage(url, pageNo);
          if (outcome.kind === 'ok') {
            if (outcome.created) summary.created += 1;
            else summary.updated += 1;
            firstFileId ||= outcome.fileId;
            segments += outcome.segments;
          } else if (outcome.kind === 'no-subtitle') {
            summary.skipped.push(pageNo);
          } else {
            summary.failed.push({ page: pageNo, message: outcome.message });
            // 重试后仍是网络 / 风控错误：继续只会接着失败，停下来
            if (outcome.blocked) {
              summary.remaining = pages.length - i - 1;
              break;
            }
          }
          if (i < pages.length - 1 && !stopRef.current) await sleep(batchIntervalMs);
        }
      } finally {
        batchRunningRef.current = false;
        setBatch(null);
      }
      onDone?.({ fileId: firstFileId, created: summary.created > 0, segments, name: current.title, batch: summary });
      onOpenChange(false);
    },
    [batchIntervalMs, importPage, onDone, onOpenChange],
  );

  const handleImport = useCallback(async () => {
    if (!probe || !canImport) return;
    setImporting(true);
    setStopRequested(false);
    setError(null);
    try {
      const pages = multiPage ? [...selectedPages].sort((a, b) => a - b) : [page ?? probe.page];
      if (mode.kind === 'create' && pages.length > 1) {
        await runBatch(probe, pages);
        return;
      }
      if (mode.kind === 'create') {
        const result = await bilibiliLinkApi.create(input.trim(), pages[0], lan);
        onDone?.({ fileId: result.fileId, created: result.created, segments: result.segments, name: result.name });
      } else {
        const transcript = await bilibiliLinkApi.importSubtitle(mode.resourceId, input.trim(), pages[0], lan);
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
  }, [canImport, input, lan, mode, multiPage, onDone, onOpenChange, page, probe, runBatch, selectedPages]);

  const requestStop = useCallback(() => {
    stopRef.current = true;
    setStopRequested(true);
  }, []);

  // 批量导入进行中关闭（Esc / 遮罩 / 关闭按钮）= 停止：做完当前这一 P 再关
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next && batchRunningRef.current) {
        requestStop();
        return;
      }
      onOpenChange(next);
    },
    [onOpenChange, requestStop],
  );

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
  const importCount = multiPage ? selectedPages.size : 1;

  return (
    <DsDialog open={open} onOpenChange={handleOpenChange} aria-labelledby={titleId} maxWidth="max-w-lg">
      <DsDialogHeader>
        <DsDialogTitle id={titleId}>{title}</DsDialogTitle>
        <DsDialogDescription>{description}</DsDialogDescription>
      </DsDialogHeader>
      <DsDialogBody className="space-y-4 py-4" data-bilibili-dialog={mode.kind}>
        <BilibiliAccountPanel />
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
            readOnly={fixedLink || importing}
            onChange={(event) => setInput(event.target.value)}
            placeholder={t('learningHub:mediaBilibili.linkPlaceholder')}
            aria-label={t('learningHub:mediaBilibili.linkLabel')}
            className="h-9 flex-1 text-sm"
            data-bilibili-link-input=""
          />
          {!fixedLink && (
            <DsButton type="submit" variant="ghost" size="sm" disabled={!input.trim() || busy} className="shrink-0 gap-1.5">
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
                // referrerPolicy 必须写在 src 前：React 按书写顺序设属性，WebKit 一拿到 src
                // 就带着本地 Referer 发请求，B 站图床防盗链回 403
                <img
                  referrerPolicy="no-referrer"
                  src={probe.cover}
                  alt=""
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
                  {[
                    probe.owner,
                    multiPage
                      ? t('learningHub:mediaBilibili.pageCount', { count: probe.pages.length })
                      : pageDurationMs > 0
                        ? formatMediaRefTimestamp(pageDurationMs / 1000)
                        : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>
            </div>

            {multiPage ? (
              <div className="flex flex-col gap-1.5 text-xs text-muted-foreground" data-bilibili-pages="">
                <div className="flex items-center justify-between gap-2">
                  <span>
                    {t('learningHub:mediaBilibili.pagesLabel', {
                      selected: selectedPages.size,
                      total: probe.pages.length,
                    })}
                  </span>
                  <div className="flex shrink-0 items-center gap-1">
                    <DsButton
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => setSelectedPages(new Set(probe.pages.map((p) => p.page)))}
                      data-bilibili-select-all=""
                    >
                      {t('learningHub:mediaBilibili.selectAll')}
                    </DsButton>
                    <DsButton
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => setSelectedPages(new Set())}
                      data-bilibili-select-none=""
                    >
                      {t('learningHub:mediaBilibili.selectNone')}
                    </DsButton>
                  </div>
                </div>
                <ul
                  className="max-h-56 overflow-y-auto overscroll-contain rounded-md border border-border"
                  aria-label={t('learningHub:mediaBilibili.pageLabel')}
                >
                  {probe.pages.map((p) => {
                    const checkboxId = `${titleId}-p${p.page}`;
                    return (
                      <li key={p.page} className="flex items-center gap-2 px-2.5 py-1.5 text-sm text-foreground">
                        <Checkbox
                          id={checkboxId}
                          checked={selectedPages.has(p.page)}
                          onCheckedChange={() => togglePage(p.page)}
                          disabled={busy}
                          data-bilibili-page-check={p.page}
                        />
                        <label htmlFor={checkboxId} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">P{p.page}</span>
                          <span className="min-w-0 flex-1 truncate">{p.part || probe.title}</span>
                          {p.durationMs > 0 ? (
                            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                              {formatMediaRefTimestamp(p.durationMs / 1000)}
                            </span>
                          ) : null}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : probe.pages.length > 1 ? (
              <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
                {t('learningHub:mediaBilibili.pageLabel')}
                <Select value={String(page ?? probe.page)} onValueChange={handlePageChange} disabled={busy || fixedLink}>
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
                <Select value={lan ?? probe.tracks[0].lan} onValueChange={setLan} disabled={busy}>
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
                {multiPage && selectedPages.size > 1 ? (
                  <span className="leading-relaxed">{t('learningHub:mediaBilibili.batchTrackHint')}</span>
                ) : null}
              </label>
            ) : (
              <p className="rounded-md bg-muted/60 px-3 py-2 text-xs leading-relaxed text-muted-foreground" data-bilibili-no-tracks="">
                {multiPage
                  ? t('learningHub:mediaBilibili.noTracksPage', { page: probe.page })
                  : t('learningHub:mediaBilibili.noTracks')}
              </p>
            )}

            {mode.kind === 'create' && !multiPage && probe.existingId ? (
              <p className="text-xs leading-relaxed text-muted-foreground" data-bilibili-existing="">
                {t('learningHub:mediaBilibili.existing')}
              </p>
            ) : null}
          </div>
        ) : null}

        {batch ? (
          <div className="space-y-1.5" role="status" aria-live="polite" data-bilibili-batch-progress="">
            <p className="truncate text-xs text-muted-foreground tabular-nums">
              {t('learningHub:mediaBilibili.batchProgress', {
                index: batch.index,
                total: batch.total,
                page: batch.page,
                part: batch.part,
              })}
            </p>
            <span
              className="block h-1 w-full overflow-hidden rounded-full bg-[color:var(--surface-muted)]"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={batch.total}
              aria-valuenow={batch.index - 1}
            >
              <span
                className="block h-full rounded-full bg-primary"
                style={{ width: `${Math.round(((batch.index - 1) / batch.total) * 100)}%` }}
              />
            </span>
          </div>
        ) : null}

        {error ? (
          <p className="break-words text-xs leading-relaxed text-destructive" role="alert" data-bilibili-error="">
            {error}
          </p>
        ) : null}
      </DsDialogBody>
      <DsDialogFooter>
        {batch ? (
          <DsButton variant="ghost" size="sm" onClick={requestStop} disabled={stopRequested} data-bilibili-stop="">
            {stopRequested ? t('learningHub:mediaBilibili.stopping') : t('learningHub:mediaBilibili.stop')}
          </DsButton>
        ) : (
          <DsButton variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={importing}>
            {t('common:cancel')}
          </DsButton>
        )}
        <DsButton
          variant="primary"
          size="sm"
          onClick={() => void handleImport()}
          disabled={!canImport}
          className="gap-1.5"
          data-bilibili-confirm=""
        >
          {importing ? <CircleNotch size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
          {mode.kind !== 'create'
            ? t('learningHub:mediaBilibili.confirmAttach')
            : importCount > 1
              ? t('learningHub:mediaBilibili.confirmBatch', { count: importCount })
              : t('learningHub:mediaBilibili.confirmCreate')}
        </DsButton>
      </DsDialogFooter>
    </DsDialog>
  );
};

export default BilibiliLinkDialog;
