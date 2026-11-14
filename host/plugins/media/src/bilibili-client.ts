/**
 * `dstu-media/src/media/bilibili.rs`: video lookup and subtitle download on top
 * of the B 站 HTTP client (`BiliClient::lookup` / `subtitle_tracks` /
 * `subtitle_bytes`).
 *
 * The link-item VFS import (`upsert_link_item`, `read_link_descriptor`) needs
 * the VFS repositories and stays in the command layer; everything here is
 * network + parsing only.
 */
import type { BiliLinkDescriptor, BiliSubtitleTrack } from '../api.ts';
import { MediaError } from './errors.ts';
import { API_LIMIT, decodeGrpcTracks, encodeGrpcRequest } from './bilibili-grpc.ts';
import {
  ERR_INVALID_LINK, ERR_NO_SUBTITLE, ERR_REQUEST, ERR_UNAVAILABLE,
  followShortLink, normalizeBilibiliUrl, pageUrl, parseLink, pickTrack,
  resolveSubtitleUrl, type BiliTarget,
} from './bilibili-links.ts';
import { BiliRequestError } from './bilibili-policy.ts';
import { BiliStreamClient, type BiliStreamClientOptions } from './bilibili-stream.ts';
import { toBase64 } from '../../../platform/crypto/encoding.ts';

const VIDEO_CACHE_TTL_MS = 10 * 60 * 1000;
const VIDEO_CACHE_MAX_ENTRIES = 64;
const MAX_SUBTITLE_BYTES = 20 * 1024 * 1024;
const PROTOCOL_TIMEOUT_MS = 24_000;

/** Rust `bilibili.rs::API_BASE`。 */
export const BILIBILI_API_BASE = 'https://api.bilibili.com';

/** `bilibili.rs::VIDEO_CACHE`：按出口/账号代次 + API base 隔离的 10 分钟视频信息缓存。 */
const VIDEO_CACHE = new Map<string, { at: number; video: BiliVideo }>();
let clientScopeCounter = 0;
function nextClientScope(): number {
  clientScopeCounter += 1;
  return clientScopeCounter;
}

export interface BiliPage {
  page: number;
  cid: number;
  part: string;
  durationMs: number;
}

export interface BiliVideo {
  bvid: string;
  aid: number;
  title: string;
  owner: string | null;
  cover: string | null;
  durationMs: number;
  pages: BiliPage[];
}

/** 内部字幕轨比线协议多一个 `url`（Rust 侧 `#[serde(skip)]`）。 */
export interface BiliTrackWithUrl extends BiliSubtitleTrack {
  url: string;
}

export type SubtitleState =
  | 'available' | 'none_confirmed' | 'login_required' | 'unsupported' | 'failed';

export interface BiliLookup {
  video: BiliVideo;
  page: BiliPage;
  tracks: BiliTrackWithUrl[];
  subtitleState: SubtitleState;
  subtitleError: { code: string; message: string } | null;
}

function biliErr(code: string, message: string): MediaError {
  return new MediaError('Bilibili', message, code);
}

function protocolError(message: string): MediaError {
  return biliErr('bilibili-protocol', message);
}

function subtitleProtocol(message: string): MediaError {
  return biliErr('bilibili-subtitle-protocol', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function u64(value: unknown, fallback: number | null = null): number {
  if (value === undefined || value === null) {
    if (fallback !== null) return fallback;
    throw protocolError('B 站接口返回了未知格式（可能为验证页面）');
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0
    || value > Number.MAX_SAFE_INTEGER) {
    throw protocolError('B 站接口返回了未知格式（可能为验证页面）');
  }
  return value;
}

function i64(value: unknown, fallback = 0): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value)
    || !Number.isSafeInteger(value)) {
    throw protocolError('B 站接口返回了未知格式（可能为验证页面）');
  }
  return value;
}

function str(value: unknown, fallback = ''): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') throw protocolError('B 站接口返回了未知格式（可能为验证页面）');
  return value;
}

function mapTransportError(error: unknown): MediaError {
  if (error instanceof BiliRequestError) {
    return new MediaError('Bilibili', error.message, error.payload.code);
  }
  if (error instanceof MediaError) return error;
  return new MediaError('Transport', (error as Error).message);
}

/** `ViewData` → `BiliVideo`（serde 默认值 + 单 P 兜底）。 */
export function parseViewData(value: unknown): BiliVideo {
  if (!isRecord(value)) throw protocolError('B 站接口返回了未知格式（可能为验证页面）');
  const bvid = value.bvid;
  if (typeof bvid !== 'string') {
    throw protocolError('B 站接口返回了未知格式（可能为验证页面）');
  }
  const aid = u64(value.aid);
  const cid = u64(value.cid, 0);
  const title = str(value.title);
  const duration = i64(value.duration);
  const pic = str(value.pic);
  const ownerRaw = value.owner;
  let owner: string | null = null;
  if (ownerRaw !== undefined && ownerRaw !== null) {
    if (!isRecord(ownerRaw)) throw protocolError('B 站接口返回了未知格式（可能为验证页面）');
    const name = str(ownerRaw.name);
    owner = name.trim() === '' ? null : name;
  }
  const pagesRaw = value.pages;
  let pages: BiliPage[] = [];
  if (pagesRaw !== undefined && pagesRaw !== null) {
    if (!Array.isArray(pagesRaw)) throw protocolError('B 站接口返回了未知格式（可能为验证页面）');
    pages = pagesRaw.map(raw => {
      if (!isRecord(raw)) throw protocolError('B 站接口返回了未知格式（可能为验证页面）');
      const page = u64(raw.page);
      const pageCid = u64(raw.cid);
      if (page > 0xffff_ffff) throw protocolError('B 站接口返回了未知格式（可能为验证页面）');
      return {
        page,
        cid: pageCid,
        part: str(raw.part),
        durationMs: Math.max(0, i64(raw.duration)) * 1000,
      };
    });
  }
  if (pages.length === 0 && cid > 0) {
    pages.push({
      page: 1,
      cid,
      part: title,
      durationMs: Math.max(0, duration) * 1000,
    });
  }
  return {
    bvid,
    aid,
    title,
    owner,
    cover: normalizeBilibiliUrl(pic)?.toString() ?? null,
    durationMs: Math.max(0, duration) * 1000,
    pages,
  };
}

/** `BiliLinkDescriptor::from_lookup`。 */
export function descriptorFromLookup(lookup: BiliLookup): BiliLinkDescriptor {
  const video = lookup.video;
  return {
    kind: 'bilibili',
    version: 1,
    bvid: video.bvid,
    aid: video.aid,
    cid: lookup.page.cid,
    page: lookup.page.page,
    pageCount: Math.max(video.pages.length, 1),
    title: video.title,
    part: lookup.page.part,
    owner: video.owner,
    cover: video.cover,
    durationMs: lookup.page.durationMs > 0 ? lookup.page.durationMs : video.durationMs,
    url: pageUrl(video.bvid, lookup.page.page),
  };
}

function singlePageSuffix(lookup: BiliLookup): string {
  return lookup.video.pages.length > 1 ? `第 ${lookup.page.page} P` : '这个视频';
}

function noSubtitleError(lookup: BiliLookup): MediaError {
  return biliErr(ERR_NO_SUBTITLE,
    `${singlePageSuffix(lookup)}没有可用字幕：UP 主没有上传字幕，B 站也没有生成 AI 字幕。`
    + '可以把视频下载到本地后导入，用语音识别转写');
}

interface DmSubtitleItem {
  lan: string;
  lanDoc: string;
  url: string;
  aiType: number;
}

function dmStr(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw subtitleProtocol('字幕列表格式无效');
  return value;
}

function parseDmSubtitleItem(raw: unknown): DmSubtitleItem {
  if (!isRecord(raw)) throw subtitleProtocol('字幕列表格式无效');
  const aiType = raw.ai_type;
  if (aiType !== undefined && aiType !== null
    && (typeof aiType !== 'number' || !Number.isSafeInteger(aiType))) {
    throw subtitleProtocol('字幕列表格式无效');
  }
  return {
    lan: dmStr(raw.lan),
    lanDoc: dmStr(raw.lan_doc),
    url: dmStr(raw.subtitle_url),
    aiType: typeof aiType === 'number' ? aiType : 0,
  };
}

export class BiliLookupClient extends BiliStreamClient {
  private readonly cacheScope: string;
  private readonly videoCache = VIDEO_CACHE;

  constructor(apiBase: string, options: BiliStreamClientOptions = {}) {
    super(apiBase, options);
    this.cacheScope = options.attempt?.cacheScope ?? `test:${nextClientScope()}`;
  }

  private async resolve(input: string): Promise<BiliTarget> {
    const parsed = parseLink(input);
    if (parsed.kind === 'video') return parsed.target;
    const location = await followShortLink(this, parsed.url, {
      strictHosts: this.strictHosts,
      deadlineMs: Date.now() + PROTOCOL_TIMEOUT_MS,
    });
    const resolved = parseLink(location);
    if (resolved.kind !== 'video') {
      throw biliErr(ERR_INVALID_LINK, '短链没有跳转到 B 站视频页，请改贴视频页地址');
    }
    const pageMatch = /[?&]p=(\d{1,5})/.exec(input);
    if (pageMatch !== null) {
      const page = Number.parseInt(pageMatch[1]!, 10);
      if (Number.isInteger(page)) resolved.target.page = page;
    }
    return resolved.target;
  }

  private async fetchVideo(id: { kind: 'bv' | 'av'; value: string | number }): Promise<BiliVideo> {
    const query: Array<[string, string]> = id.kind === 'bv'
      ? [['bvid', String(id.value)]]
      : [['aid', String(id.value)]];
    const data = await this.getApi<unknown>('/x/web-interface/view', query);
    if (data === null) throw biliErr(ERR_UNAVAILABLE, 'B 站没有返回这个视频的信息');
    return parseViewData(data);
  }

  private videoKey(id: { kind: 'bv' | 'av'; value: string | number }): string {
    return `${this.cacheScope}|${this.apiBase}|${id.kind}:${String(id.value)}`;
  }

  private async video(id: { kind: 'bv' | 'av'; value: string | number }): Promise<BiliVideo> {
    const key = this.videoKey(id);
    const cached = this.videoCache.get(key);
    if (cached !== undefined && Date.now() - cached.at < VIDEO_CACHE_TTL_MS) return cached.video;
    const video = await this.fetchVideo(id);
    const now = Date.now();
    for (const [cachedKey, entry] of this.videoCache) {
      if (now - entry.at >= VIDEO_CACHE_TTL_MS) this.videoCache.delete(cachedKey);
    }
    if (this.videoCache.size >= VIDEO_CACHE_MAX_ENTRIES) this.videoCache.clear();
    this.videoCache.set(key, { at: now, video });
    this.videoCache.set(this.videoKey({ kind: 'bv', value: video.bvid }),
      { at: now, video });
    return video;
  }

  /** `subtitle_tracks`：JSON 接口无法确认时回退 gRPC DmView。 */
  async subtitleTracks(aid: number, cid: number): Promise<BiliTrackWithUrl[]> {
    let data: unknown;
    try {
      data = await this.getApi<unknown>('/x/v2/dm/view', [
        ['type', '1'], ['oid', String(cid)], ['pid', String(aid)],
      ]);
    } catch (error) {
      if (error instanceof MediaError && error.code === 'bilibili-protocol') {
        return this.grpcSubtitleTracks(aid, cid);
      }
      throw error;
    }
    if (!isRecord(data)) {
      throw subtitleProtocol('字幕接口未返回状态，无法确认是否无字幕');
    }
    if (data.need_login_subtitle === true) {
      throw biliErr('bilibili-login-required', '当前出口需要登录后获取字幕');
    }
    const subtitle = data.subtitle;
    const rawTracks = isRecord(subtitle) && Array.isArray(subtitle.subtitles)
      ? subtitle.subtitles : null;
    if (rawTracks === null) return this.grpcSubtitleTracks(aid, cid);
    const tracks = rawTracks.map(parseDmSubtitleItem);
    if (tracks.length > 0
      && tracks.every(item => item.url.trim() === '' || item.lan.trim() === '')) {
      throw subtitleProtocol('字幕轨缺少地址或语言，无法确认是否无字幕');
    }
    return tracks
      .filter(item => item.url.trim() !== '' && item.lan.trim() !== '')
      .map(item => ({
        lan: item.lan,
        lanDoc: item.lanDoc.trim() === '' ? item.lan : item.lanDoc,
        ai: item.lan.startsWith('ai-') || item.aiType !== 0,
        url: item.url,
      }));
  }

  private async grpcSubtitleTracks(aid: number, cid: number): Promise<BiliTrackWithUrl[]> {
    const endpoint = this.strictHosts ? 'https://app.biliapi.net' : this.apiBase;
    const response = await this.execute({
      url: `${endpoint}/bilibili.community.service.dm.v1.DM/DmView`,
      method: 'POST',
      headers: {
        'content-type': 'application/grpc',
        'grpc-accept-encoding': 'identity,gzip',
      },
      body: encodeGrpcRequest(aid, cid),
      deadlineMs: Date.now() + PROTOCOL_TIMEOUT_MS,
      maxBytes: API_LIMIT,
      kind: 'api',
    });
    if (response.status !== 200) {
      throw biliErr(ERR_REQUEST, `字幕 gRPC 接口返回 HTTP ${response.status}`);
    }
    let decoded;
    try {
      decoded = decodeGrpcTracks(response.body,
        response.header('grpc-encoding'), response.header('grpc-status'));
    } catch (error) {
      throw mapTransportError(error);
    }
    return decoded.map(track => ({
      lan: track.lan,
      lanDoc: track.lanDoc === '' ? track.lan : track.lanDoc,
      ai: track.lan.startsWith('ai-') || track.aiMark !== 0 || track.aiType !== 0,
      url: track.url,
    }));
  }

  /** 链接 → 视频信息 + 选中的分 P（参数 page > 链接 `?p=` > 第 1 P）+ 字幕轨。 */
  async lookup(input: string, page: number | null = null): Promise<BiliLookup> {
    await this.attempt?.verifyIdentity();
    const target = await this.resolve(input);
    const video = await this.video(target.id);
    const wanted = page !== null && page > 0 ? page : target.page ?? 1;
    const selected = video.pages.find(candidate => candidate.page === wanted);
    if (selected === undefined) {
      throw biliErr(ERR_UNAVAILABLE,
        `这个视频没有第 ${wanted} P（共 ${video.pages.length} P）`);
    }
    let tracks: BiliTrackWithUrl[] = [];
    let subtitleState: SubtitleState;
    let subtitleError: { code: string; message: string } | null = null;
    try {
      tracks = await this.subtitleTracks(video.aid, selected.cid);
      subtitleState = tracks.length === 0 ? 'none_confirmed' : 'available';
    } catch (error) {
      const failure = mapTransportError(error);
      subtitleState = failure.code === 'bilibili-login-required'
        ? 'login_required'
        : failure.code.includes('unsupported') ? 'unsupported' : 'failed';
      subtitleError = { code: failure.code, message: failure.message };
      tracks = [];
    }
    await this.attempt?.verifyIdentity();
    return { video, page: selected, tracks, subtitleState, subtitleError };
  }

  /** `BiliClient::cover_data_url`：读取封面并嗅探 JPEG/PNG/WebP；失败返回 null。 */
  async coverDataUrl(raw: string | null): Promise<string | null> {
    if (raw === null) return null;
    const url = normalizeBilibiliUrl(raw);
    if (url === null) return null;
    let response: { status: number; body: Uint8Array };
    try {
      response = await this.execute({
        url: url.toString(),
        headers: {},
        deadlineMs: Date.now() + PROTOCOL_TIMEOUT_MS,
        maxBytes: 1024 * 1024,
        kind: 'cover',
      });
    } catch {
      return null;
    }
    if (response.status !== 200) return null;
    const body = response.body;
    let mime: string;
    if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) mime = 'image/jpeg';
    else if (body.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, i) => body[i] === byte)) mime = 'image/png';
    else if (body.length >= 12 && String.fromCharCode(...body.subarray(0, 4)) === 'RIFF'
      && String.fromCharCode(...body.subarray(8, 12)) === 'WEBP') mime = 'image/webp';
    else return null;
    return `data:${mime};base64,${toBase64(body)}`;
  }

  private async downloadSubtitle(track: BiliTrackWithUrl): Promise<{ status: number; body: Uint8Array }> {
    const url = resolveSubtitleUrl(track.url, this.strictHosts);
    return this.execute({
      url: url.toString(),
      headers: {},
      deadlineMs: Date.now() + PROTOCOL_TIMEOUT_MS,
      maxBytes: MAX_SUBTITLE_BYTES,
      kind: 'subtitle',
    });
  }

  /** 选中的字幕轨 + 原始字节（BCC/SRT/VTT 由调用方解析）。 */
  async subtitleBytes(
    lookup: BiliLookup,
    lan: string | null = null,
  ): Promise<[BiliTrackWithUrl, Uint8Array]> {
    if (lookup.subtitleError !== null) {
      throw biliErr(lookup.subtitleError.code, lookup.subtitleError.message);
    }
    const picked = pickTrack(lookup.tracks, lan);
    if (picked === null) throw noSubtitleError(lookup);
    let track = picked as BiliTrackWithUrl;
    let response = await this.downloadSubtitle(track);
    if (response.status === 403 || response.status === 404 || response.status === 410) {
      const tracks = await this.subtitleTracks(lookup.video.aid, lookup.page.cid);
      const fresh = pickTrack(tracks, track.lan);
      if (fresh === null || fresh.lan !== track.lan) {
        throw biliErr(ERR_NO_SUBTITLE, '原字幕轨已失效');
      }
      track = fresh as BiliTrackWithUrl;
      response = await this.downloadSubtitle(track);
    }
    if (response.status < 200 || response.status >= 300) {
      throw biliErr(ERR_REQUEST, `下载字幕失败：HTTP ${response.status}`);
    }
    await this.attempt?.verifyIdentity();
    return [track, response.body];
  }
}
