/**
 * `dstu-media/src/media/bilibili.rs`: link parsing, default subtitle track choice
 * and the small JSON link descriptor stored in the VFS blob.
 */
import type { BiliLinkDescriptor, BiliSubtitleTrack } from '../api.ts';
import type { BiliAttemptLike } from './bilibili-stream.ts';
import { MediaError } from './errors.ts';
import { BILIBILI_LINK_EXTENSION } from './media-types.ts';
import { validateUrl } from './bilibili-policy.ts';
import { rustTrim } from './transcript.ts';

export const ERR_INVALID_LINK = 'bilibili-invalid-link';
export const ERR_UNSUPPORTED_LINK = 'bilibili-unsupported-link';
export const ERR_UNAVAILABLE = 'bilibili-video-unavailable';
export const ERR_NO_SUBTITLE = 'bilibili-no-subtitle';
export const ERR_REQUEST = 'bilibili-request-failed';

export const DESCRIPTOR_KIND = 'bilibili';
export const DESCRIPTOR_VERSION = 1;
export const MAX_DESCRIPTOR_BYTES = 64 * 1024;
export const MAX_FILE_STEM_CHARS = 100;

const UNSUPPORTED_RE = /bilibili\.com\/(?:bangumi|cheese|audio)\/|live\.bilibili\.com/i;
const BV_RE = /(?:^|[^0-9A-Za-z])([Bb][Vv][0-9A-Za-z]{10})(?:[^0-9A-Za-z]|$)/;
const AV_RE = /(?:^|[^0-9a-z])av(\d{1,19})(?:[^0-9]|$)/i;
const SHORT_LINK_RE = /(?:https?:\/\/)?(?:www\.)?(b23\.tv|bili2233\.cn)\/([0-9A-Za-z_-]+)/i;
const PAGE_RE = /[?&]p=(\d{1,5})/;
const BVID_RE = /^BV[0-9A-Za-z]{10}$/;
// Stop at Chinese punctuation/quotes; never send the surrounding share caption to transport.
const SHARE_LINK_RE = /(?<![\w./:@%-])(?:https?:\/\/)?(?:(?:(?:www|m)\.)?bilibili\.com\/video\/(?:BV[0-9A-Za-z]{10}|av\d+)(?![0-9A-Za-z])|(?:www\.)?(?:b23\.tv|bili2233\.cn)\/[0-9A-Za-z_-]+)(?:[/?#][A-Za-z0-9\-._~:/?#[\]@!$&()*+,;=%]*)?/i;

function shareLink(input: string): string | null {
  return input.match(SHARE_LINK_RE)?.[0].replace(/[.,!?;:)\]}]+$/, '') ?? null;
}

const BILIBILI_DOMAINS = ['hdslb.com', 'bilibili.com', 'biliapi.net', 'bilivideo.com', 'bilivideo.cn'];

export type BiliVideoId = { kind: 'bv'; value: string } | { kind: 'av'; value: number };
export interface BiliTarget { id: BiliVideoId; page: number | null }
export type ParsedLink = { kind: 'video'; target: BiliTarget } | { kind: 'short'; url: string };

export function bv(value: string): BiliVideoId { return { kind: 'bv', value }; }
export function av(value: number): BiliVideoId { return { kind: 'av', value }; }

function biliErr(code: string, message: string): MediaError {
  return new MediaError('Bilibili', message, code);
}

function captureU32(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 0xffff_ffff ? n : null;
}

function captureU64(raw: string): number | null {
  const n = BigInt(raw);
  return n <= 0xffff_ffff_ffff_ffffn ? Number(n) : null;
}

/** 视频页地址、分享文案、短链或裸 BV / av 号（bilibili.rs:121） */
export function parseLink(input: string): ParsedLink {
  try { return parseDirectLink(input); }
  catch (error) {
    const shared = extractBilibiliTargetFromShareText(input);
    if (shared !== null) return shared;
    throw error;
  }
}

function parseDirectLink(input: string): ParsedLink {
  const text = shareLink(input) ?? rustTrim(input);
  if (text === '') throw biliErr(ERR_INVALID_LINK, '请粘贴 B 站视频链接');
  if (UNSUPPORTED_RE.test(text)) {
    throw biliErr(ERR_UNSUPPORTED_LINK,
      '暂不支持番剧 / 影视、课堂、音频和直播链接，请粘贴普通视频的链接（含 BV 号）');
  }
  const pageMatch = PAGE_RE.exec(text);
  const page = pageMatch === null ? null : captureU32(pageMatch[1]!);
  const validPage = page !== null && page > 0 ? page : null;

  const bvMatch = BV_RE.exec(text);
  if (bvMatch !== null) {
    const raw = bvMatch[1]!;
    return { kind: 'video', target: { id: bv(`BV${raw.slice(2)}`), page: validPage } };
  }
  const avMatch = AV_RE.exec(text);
  if (avMatch !== null) {
    const aid = captureU64(avMatch[1]!);
    if (aid !== null && aid > 0) {
      return { kind: 'video', target: { id: av(aid), page: validPage } };
    }
  }
  const shortMatch = SHORT_LINK_RE.exec(text);
  if (shortMatch !== null) {
    const host = shortMatch[1]!.replace(/[A-Z]/g, c => c.toLowerCase());
    return { kind: 'short', url: `https://${host}/${shortMatch[2]!}${validPage === null ? '' : `?p=${validPage}`}` };
  }
  throw biliErr(ERR_INVALID_LINK,
    '没有认出 B 站视频链接：请粘贴视频页地址（含 BV 号）或 b23.tv 分享短链');
}

/** First shared video/short-link target, or null when no supported input is present. */
export function extractBilibiliTargetFromShareText(input: string): ParsedLink | null {
  try { return parseDirectLink(input); }
  catch (error) {
    if (error instanceof MediaError && (error.code === ERR_INVALID_LINK || error.code === ERR_UNSUPPORTED_LINK)) return null;
    throw error;
  }
}

export type BilibiliResolveErrorKind = 'login-expired' | 'vip-required' | 'page-out-of-range'
  | 'rate-limited' | 'network-timeout' | 'unsupported-format' | 'unknown';

export interface BilibiliResolveErrorClassification {
  kind: BilibiliResolveErrorKind;
  message: string;
  retryable: boolean;
}

/** Fixed actionable messages; do not echo upstream cookies, URLs or arbitrary error content. */
export function classifyBilibiliResolveError(error: unknown): BilibiliResolveErrorClassification {
  const record = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  const outer = record(error);
  const detail = record(outer.transport ?? outer.payload ?? error);
  const code = detail.businessCode ?? detail.apiCode ?? detail.code ?? outer.code;
  const status = detail.httpStatus ?? detail.status ?? outer.status;
  const text = `${String(code ?? '')} ${String(detail.message ?? outer.message ?? error)} ${String(outer.name ?? '')}`;
  if ([-352, -412].includes(Number(code)) || [412, 429].includes(Number(status))) {
    return { kind: 'rate-limited', message: 'B 站触发风控或限流，请稍后重试；持续失败时检查网络出口。', retryable: true };
  }
  if ([-101, -111].includes(Number(code)) || /login.expired|login.required|cookie.*(?:expired|invalid|失效|过期)|登录.*(?:失效|过期|缺失|未)|未登录/i.test(text)) {
    return { kind: 'login-expired', message: 'B 站登录态已失效，请更新 B 站 Cookie 后重试。', retryable: false };
  }
  if (/vip|大会员|会员专享|付费/i.test(text)) {
    return { kind: 'vip-required', message: '该视频需要大会员或付费权限，请使用有权限的账号。', retryable: false };
  }
  if (/page.*(?:range|invalid)|分\s*[pP].*(?:越界|不存在|超出)|分集.*(?:越界|不存在)/i.test(text)) {
    return { kind: 'page-out-of-range', message: '分 P 序号超出范围，请选择视频中存在的分 P。', retryable: false };
  }
  if (/风控|限流|频率|rate.limit/i.test(text)) {
    return { kind: 'rate-limited', message: 'B 站触发风控或限流，请稍后重试；持续失败时检查网络出口。', retryable: true };
  }
  if (/timeout|timed.out|aborterror|超时|network|网络|fetch failed|failed to fetch/i.test(text) || error instanceof TypeError) {
    return { kind: 'network-timeout', message: '连接 B 站失败或超时，请检查网络后重试。', retryable: true };
  }
  if (code === ERR_INVALID_LINK || code === ERR_UNSUPPORTED_LINK || /unsupported|格式不支持|不支持|未识别|没有认出/i.test(text)) {
    return { kind: 'unsupported-format', message: '请粘贴普通视频的 BV / av 号、视频页链接或 b23.tv 分享短链。', retryable: false };
  }
  return { kind: 'unknown', message: '暂时无法解析该 B 站视频，请检查链接或稍后重试。', retryable: true };
}

export function isBvid(value: string): boolean { return BVID_RE.test(value); }

export function pageUrl(bvid: string, page: number): string {
  return `https://www.bilibili.com/video/${bvid}?p=${page}`;
}

export function isBilibiliHost(host: string): boolean {
  const lower = host.replace(/[A-Z]/g, c => c.toLowerCase());
  return BILIBILI_DOMAINS.some(d => lower === d || lower.endsWith(`.${d}`));
}

/** `//host/x` 与 `http://` 统一成 https，且只接受 B 站自己的域名（bilibili.rs:189） */
export function normalizeBilibiliUrl(raw: string): URL | null {
  const trimmed = rustTrim(raw);
  if (trimmed === '') return null;
  const full = trimmed.startsWith('//') ? `https:${trimmed}` : trimmed;
  let url: URL;
  try { url = new URL(full); }
  catch { return null; }
  if (url.protocol === 'http:') url.protocol = 'https:';
  return url.protocol === 'https:' && url.hostname !== '' && isBilibiliHost(url.hostname) ? url : null;
}

/**
 * `BiliClient::follow_short_link`：最多跟 5 跳，循环 / 失效都报
 * `bilibili-invalid-link`。`strictHosts` 对应生产环境的出口策略校验
 * （测试客户端关闭，允许本地 HTTP 服务）。
 */
export async function followShortLink(
  client: BiliAttemptLike,
  raw: string,
  options: { strictHosts?: boolean; deadlineMs?: number } = {},
): Promise<string> {
  const strictHosts = options.strictHosts ?? false;
  const deadlineMs = options.deadlineMs ?? Date.now() + 24_000;
  let url: URL;
  try { url = new URL(raw); }
  catch { throw biliErr(ERR_INVALID_LINK, '短链地址无效'); }
  const visited = new Set<string>();
  for (let hop = 0; hop < 5; hop += 1) {
    if (strictHosts) {
      try { validateUrl(url, 'short_link'); }
      catch (error) {
        const payload = (error as { payload?: { code?: string } }).payload;
        throw new MediaError('Bilibili', (error as Error).message,
          payload?.code ?? ERR_INVALID_LINK);
      }
    }
    if (visited.has(url.toString())) throw biliErr(ERR_INVALID_LINK, '短链发生循环跳转');
    visited.add(url.toString());
    let parsed: ParsedLink | null = null;
    try { parsed = parseLink(url.toString()); }
    catch { parsed = null; }
    if (parsed !== null && parsed.kind === 'video') return url.toString();
    const response = await client.execute({
      url: url.toString(),
      headers: {},
      deadlineMs,
      kind: 'short_link',
    });
    const location = response.status >= 300 && response.status < 400
      ? response.header('location') : null;
    if (location === null) {
      throw biliErr(ERR_INVALID_LINK, '短链已失效或没有跳转到视频页');
    }
    try { url = new URL(location, url); }
    catch { throw biliErr(ERR_INVALID_LINK, '短链跳转地址无效'); }
  }
  if (strictHosts) {
    try { validateUrl(url, 'short_link'); }
    catch (error) {
      const payload = (error as { payload?: { code?: string } }).payload;
      throw new MediaError('Bilibili', (error as Error).message,
        payload?.code ?? ERR_INVALID_LINK);
    }
  }
  let finalParsed: ParsedLink | null = null;
  try { finalParsed = parseLink(url.toString()); }
  catch { finalParsed = null; }
  if (finalParsed !== null && finalParsed.kind === 'video') return url.toString();
  throw biliErr(ERR_INVALID_LINK, '短链跳转次数过多');
}

function trimStartAi(lan: string): string {
  let base = lan;
  while (base.startsWith('ai-')) base = base.slice(3);
  return base;
}

function trackRank(track: BiliSubtitleTrack): number {
  const lan = track.lan.replace(/[A-Z]/g, c => c.toLowerCase());
  const base = trimStartAi(lan);
  const hans = base === 'zh' || base === 'zh-cn' || base === 'zh-hans' || base === 'zh-sg';
  const chinese = base.startsWith('zh');
  if (!track.ai && hans) return 0;
  if (!track.ai && chinese) return 1;
  if (track.ai && hans) return 2;
  if (track.ai && chinese) return 3;
  if (!track.ai) return 4;
  return 5;
}

/** 默认字幕轨：UP 主简体中文 > 其它中文 > AI 简体中文 > …；`preferred` 精确命中时优先（:309） */
export function pickTrack(
  tracks: readonly BiliSubtitleTrack[],
  preferred?: string | null,
): BiliSubtitleTrack | null {
  if (preferred !== undefined && preferred !== null) {
    const lan = rustTrim(preferred);
    if (lan !== '') {
      const exact = tracks.find(t => t.lan === lan);
      if (exact !== undefined) return exact;
    }
  }
  let best: BiliSubtitleTrack | null = null;
  let bestRank = Infinity;
  for (const track of tracks) {
    const rank = trackRank(track);
    if (rank < bestRank) { best = track; bestRank = rank; }
  }
  return best;
}

/** `{标题}[ P{n} {分P标题}].bilibili`，去掉文件名非法字符（:895） */
export function descriptorFileName(
  descriptor: Pick<BiliLinkDescriptor, 'title' | 'part' | 'page' | 'pageCount' | 'bvid'>,
): string {
  const title = rustTrim(descriptor.title);
  const part = rustTrim(descriptor.part);
  const stem = descriptor.pageCount > 1
    ? part === '' || part === title ? `${title} P${descriptor.page}` : `${title} P${descriptor.page} ${part}`
    : title;
  let replaced = '';
  for (const ch of stem) replaced += /[\p{Cc}/\\:*?"<>|]/u.test(ch) ? ' ' : ch;
  const collapsed = replaced.split(/\p{White_Space}+/u).filter(s => s !== '').join(' ');
  const truncated = [...collapsed].slice(0, MAX_FILE_STEM_CHARS).join('');
  const cleaned = rustTrim(truncated.replace(/\.+$/, ''));
  return `${cleaned === '' ? descriptor.bvid : cleaned}.${BILIBILI_LINK_EXTENSION}`;
}

function descriptorInvalid(): MediaError {
  return new MediaError('InvalidInput', '不是有效的 B 站链接条目');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function u32Field(obj: Record<string, unknown>, key: string): number {
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw descriptorInvalid();
  }
  return value;
}

function u64Field(obj: Record<string, unknown>, key: string): number {
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw descriptorInvalid();
  }
  return value;
}

function i64Field(obj: Record<string, unknown>, key: string): number {
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || !Number.isSafeInteger(value)) {
    throw descriptorInvalid();
  }
  return value;
}

function stringField(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== 'string') throw descriptorInvalid();
  return value;
}

function optionalStringField(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw descriptorInvalid();
  return value;
}

/** `BiliLinkDescriptor::parse`（:932）：kind/bvid/page 校验 + cover/url 归一化 */
export function parseDescriptor(bytes: Uint8Array): BiliLinkDescriptor {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw descriptorInvalid(); }
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch { throw descriptorInvalid(); }
  if (!isRecord(raw)) throw descriptorInvalid();

  const descriptor: BiliLinkDescriptor = {
    kind: stringField(raw, 'kind'),
    version: u32Field(raw, 'version'),
    bvid: stringField(raw, 'bvid'),
    aid: u64Field(raw, 'aid'),
    cid: u64Field(raw, 'cid'),
    page: u32Field(raw, 'page'),
    pageCount: u32Field(raw, 'pageCount'),
    title: stringField(raw, 'title'),
    part: raw.part === undefined ? '' : stringField(raw, 'part'),
    owner: optionalStringField(raw, 'owner'),
    cover: optionalStringField(raw, 'cover'),
    durationMs: i64Field(raw, 'durationMs'),
    url: stringField(raw, 'url'),
  };
  if (descriptor.kind !== DESCRIPTOR_KIND || !isBvid(descriptor.bvid) || descriptor.page === 0) {
    throw descriptorInvalid();
  }
  const cover = descriptor.cover === null ? null : normalizeBilibiliUrl(descriptor.cover);
  descriptor.cover = cover === null ? null : cover.toString();
  descriptor.url = pageUrl(descriptor.bvid, descriptor.page);
  return descriptor;
}

/** `serde_json::to_vec_pretty` of the descriptor（:928） */
export function descriptorToBytes(descriptor: BiliLinkDescriptor): Uint8Array {
  const ordered: BiliLinkDescriptor = {
    kind: descriptor.kind,
    version: descriptor.version,
    bvid: descriptor.bvid,
    aid: descriptor.aid,
    cid: descriptor.cid,
    page: descriptor.page,
    pageCount: descriptor.pageCount,
    title: descriptor.title,
    part: descriptor.part,
    owner: descriptor.owner,
    cover: descriptor.cover,
    durationMs: descriptor.durationMs,
    url: descriptor.url,
  };
  return new TextEncoder().encode(JSON.stringify(ordered, null, 2));
}

/** `BiliClient::subtitle_url`（:834）：strict 时只认 B 站域名并升级 https */
export function resolveSubtitleUrl(raw: string, strictHosts: boolean): URL {
  let parsed: URL | null;
  if (strictHosts) parsed = normalizeBilibiliUrl(raw);
  else {
    try { parsed = new URL(rustTrim(raw)); }
    catch { parsed = null; }
  }
  if (parsed === null) throw biliErr(ERR_REQUEST, 'B 站返回的字幕地址无效');
  return parsed;
}
