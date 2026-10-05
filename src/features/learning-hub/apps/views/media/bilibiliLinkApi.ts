/**
 * B 站链接 IPC 边界（media_bilibili_*）：解析链接、新建链接条目、给已有媒体导入 B 站字幕、
 * 读链接条目描述；以及内嵌播放器 / 外部打开的地址构造。
 *
 * 链接条目是 MIME `video/x-bilibili` 的 VFS File（`{标题}.bilibili`），没有本地音视频。
 * 错误沿用媒体命令的 `{code, message}`（code 以 `bilibili-` 开头），见 MediaCommandError。
 */
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { normalizeTranscript, toMediaCommandError, type MediaTranscript } from './mediaTranscriptApi';

export const BILIBILI_LINK_MIME = 'video/x-bilibili';

const BVID_RE = /^BV[0-9A-Za-z]{10}$/;

export function isBilibiliLinkItem(mimeType?: string | null, fileName?: string | null): boolean {
  return (mimeType ?? '').trim().toLowerCase() === BILIBILI_LINK_MIME || /\.bilibili$/i.test(fileName ?? '');
}

/** 显示名去掉 `.bilibili` 扩展名 */
export function stripBilibiliExtension(name: string): string {
  return name.replace(/\.bilibili$/i, '');
}

export interface BilibiliPage {
  page: number;
  cid: number;
  part: string;
  durationMs: number;
}

export interface BilibiliTrack {
  /** zh-CN / en-US / ai-zh … */
  lan: string;
  /** 「中文（中国）」「中文（自动生成）」… */
  lanDoc: string;
  /** B 站自动生成的 AI 字幕 */
  ai: boolean;
}

export interface BilibiliProbe {
  bvid: string;
  title: string;
  owner: string | null;
  cover: string | null;
  durationMs: number;
  pages: BilibiliPage[];
  /** 选中的分 P */
  page: number;
  tracks: BilibiliTrack[];
  defaultLan: string | null;
  url: string;
  /** 同一视频同一分 P 已有的链接条目（再导入复用、只替换字幕） */
  existingId: string | null;
}

export interface BilibiliCreateResult {
  fileId: string;
  name: string;
  created: boolean;
  segments: number;
  lan: string;
  lanDoc: string;
  ai: boolean;
}

export interface BilibiliLinkDescriptor {
  bvid: string;
  aid: number;
  cid: number;
  page: number;
  pageCount: number;
  title: string;
  part: string;
  owner: string | null;
  cover: string | null;
  durationMs: number;
  url: string;
}

type Raw = Record<string, unknown>;

const asObject = (raw: unknown): Raw => (raw && typeof raw === 'object' ? (raw as Raw) : {});
const pick = (r: Raw, camel: string, snake: string): unknown => r[camel] ?? r[snake];
const num = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const optStr = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);

function normalizePage(raw: unknown): BilibiliPage {
  const r = asObject(raw);
  return {
    page: num(r.page, 1),
    cid: num(r.cid),
    part: str(r.part),
    durationMs: num(pick(r, 'durationMs', 'duration_ms')),
  };
}

function normalizeTrack(raw: unknown): BilibiliTrack {
  const r = asObject(raw);
  const lan = str(r.lan);
  return { lan, lanDoc: str(pick(r, 'lanDoc', 'lan_doc')) || lan, ai: Boolean(r.ai) };
}

export function normalizeProbe(raw: unknown): BilibiliProbe {
  const r = asObject(raw);
  return {
    bvid: str(r.bvid),
    title: str(r.title),
    owner: optStr(r.owner),
    cover: optStr(r.cover),
    durationMs: num(pick(r, 'durationMs', 'duration_ms')),
    pages: Array.isArray(r.pages) ? r.pages.map(normalizePage) : [],
    page: num(r.page, 1),
    tracks: Array.isArray(r.tracks) ? r.tracks.map(normalizeTrack).filter((t) => t.lan) : [],
    defaultLan: optStr(pick(r, 'defaultLan', 'default_lan')),
    url: str(r.url),
    existingId: optStr(pick(r, 'existingId', 'existing_id')),
  };
}

export function normalizeCreateResult(raw: unknown): BilibiliCreateResult {
  const r = asObject(raw);
  return {
    fileId: str(pick(r, 'fileId', 'file_id')),
    name: str(r.name),
    created: Boolean(r.created),
    segments: num(r.segments),
    lan: str(r.lan),
    lanDoc: str(pick(r, 'lanDoc', 'lan_doc')),
    ai: Boolean(r.ai),
  };
}

export function normalizeLinkDescriptor(raw: unknown): BilibiliLinkDescriptor {
  const r = asObject(raw);
  const bvid = str(r.bvid);
  if (!BVID_RE.test(bvid)) {
    throw toMediaCommandError({ code: 'invalid-input', message: 'Invalid Bilibili link item' });
  }
  return {
    bvid,
    aid: num(r.aid),
    cid: num(r.cid),
    page: Math.max(1, num(r.page, 1)),
    pageCount: Math.max(1, num(pick(r, 'pageCount', 'page_count'), 1)),
    title: str(r.title),
    part: str(r.part),
    owner: optStr(r.owner),
    cover: optStr(r.cover),
    durationMs: num(pick(r, 'durationMs', 'duration_ms')),
    url: str(r.url),
  };
}

/** B 站外链播放器（player.bilibili.com，CSP frame-src 只放开这一个源） */
export function buildBilibiliEmbedUrl(
  link: Pick<BilibiliLinkDescriptor, 'bvid' | 'page'>,
  options: { startSeconds?: number; autoplay?: boolean } = {},
): string {
  if (!BVID_RE.test(link.bvid)) throw new Error(`Invalid BV id: ${link.bvid}`);
  const params = new URLSearchParams({
    isOutside: 'true',
    bvid: link.bvid,
    p: String(Math.max(1, Math.floor(link.page))),
    autoplay: options.autoplay ? '1' : '0',
    danmaku: '0',
  });
  const start = Math.max(0, Math.floor(options.startSeconds ?? 0));
  if (start > 0) params.set('t', String(start));
  return `https://player.bilibili.com/player.html?${params.toString()}`;
}

/** 视频页地址（可带起播秒数），用于「在 B 站打开」 */
export function buildBilibiliPageUrl(link: Pick<BilibiliLinkDescriptor, 'bvid' | 'page'>, seconds?: number): string {
  const start = Math.max(0, Math.floor(seconds ?? 0));
  const page = Math.max(1, Math.floor(link.page));
  return `https://www.bilibili.com/video/${encodeURIComponent(link.bvid)}?p=${page}${start > 0 ? `&t=${start}` : ''}`;
}

async function invoke<T = unknown>(command: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await tauriInvoke<T>(command, args);
  } catch (err: unknown) {
    throw toMediaCommandError(err);
  }
}

export const bilibiliLinkApi = {
  /** 解析链接：标题 / 分 P / 该分 P 的字幕轨 / 默认轨 / 已有条目 */
  async probe(input: string, page?: number | null): Promise<BilibiliProbe> {
    return normalizeProbe(await invoke('media_bilibili_probe', { input, page: page ?? null }));
  },

  /** 新建（或复用同一视频同一分 P 的）链接条目并导入字幕 */
  async create(input: string, page?: number | null, lan?: string | null): Promise<BilibiliCreateResult> {
    return normalizeCreateResult(
      await invoke('media_bilibili_create', { input, page: page ?? null, lan: lan ?? null }),
    );
  },

  /** 给已有媒体（本地视频，或链接条目自己）导入 B 站字幕，替换现有字幕 */
  async importSubtitle(
    resourceId: string,
    input: string,
    page?: number | null,
    lan?: string | null,
  ): Promise<MediaTranscript> {
    return normalizeTranscript(
      await invoke('media_bilibili_import_subtitle', {
        resourceId,
        input,
        page: page ?? null,
        lan: lan ?? null,
      }),
    );
  },

  async getLink(resourceId: string): Promise<BilibiliLinkDescriptor> {
    return normalizeLinkDescriptor(await invoke('media_bilibili_link_get', { resourceId }));
  },
};
