/**
 * `dstu-media/src/media/bilibili_transport/policy.rs`: allow-list for outbound
 * Bilibili URLs, requests, credential scopes and response headers.
 */
import type { BiliError, RequestKind, Route } from '../api.ts';
import { utf8ByteLength } from '../../../platform/util/portable.ts';

export const MAX_REQUEST_BODY_BYTES = 64 * 1024;
export const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
const ALLOWED_METHODS = ['GET', 'HEAD', 'POST'];
const ALLOWED_HEADERS = ['range', 'if-range', 'content-type', 'grpc-accept-encoding', 'te'];
const RESPONSE_HEADERS = [
  'content-type', 'content-length', 'content-range', 'accept-ranges', 'etag',
  'last-modified', 'location', 'grpc-status', 'grpc-message', 'grpc-encoding',
];

export class BiliRequestError extends Error {
  readonly payload: BiliError;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'BiliRequestError';
    this.payload = {
      code: `bilibili-${code}`,
      message,
      stage: 'transport',
      requestId: 0,
      attemptId: '',
      route: 'native' as Route,
      retryable: code === 'timeout' || code === 'network' || code === 'bridge-offline',
      httpStatus: null,
      businessCode: null,
    };
  }
}

export interface BiliRequestPolicy {
  kind: RequestKind;
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: Uint8Array;
  maxBytes: number;
}

function domain(host: string, suffix: string): boolean {
  return host === suffix
    || (host.endsWith(suffix) && host.slice(0, -suffix.length).endsWith('.'));
}

function effectivePort(url: URL): number | null {
  if (url.port !== '') return Number(url.port);
  if (url.protocol === 'https:') return 443;
  if (url.protocol === 'http:') return 80;
  return null;
}

function hasFragment(url: URL): boolean {
  // Rust `Url::fragment()` is `Some("")` for a bare trailing `#`; Node keeps it in href.
  return url.href.includes('#');
}

function hostAllowed(host: string, kind: RequestKind): boolean {
  switch (kind) {
    case 'short_link':
      return ['b23.tv', 'www.b23.tv', 'bili2233.cn', 'www.bili2233.cn',
        'www.bilibili.com', 'm.bilibili.com', 'bilibili.com'].includes(host);
    case 'api':
      return host === 'api.bilibili.com' || host === 'app.biliapi.net';
    case 'passport':
      return host === 'passport.bilibili.com';
    case 'subtitle':
    case 'cover':
      return domain(host, 'hdslb.com');
    case 'media':
      return ['bilivideo.com', 'bilivideo.cn', 'akamaized.net', 'szbdyd.com', 'hdslb.com']
        .some(suffix => domain(host, suffix));
  }
}

export function validateUrl(url: URL, kind: RequestKind): void {
  const host = url.hostname;
  const port = effectivePort(url);
  const mediaPort = kind === 'media' && host.endsWith('.mcdn.bilivideo.cn') && url.port === '4483';
  if (url.protocol !== 'https:'
    || !(port === 443 || mediaPort)
    || url.username !== ''
    || url.password !== ''
    || hasFragment(url)
    || !hostAllowed(host, kind)) {
    throw new BiliRequestError('unsafe-url', 'B 站请求地址不在授权范围内');
  }
}

export function validateRequest(request: BiliRequestPolicy): void {
  validateUrl(request.url, request.kind);
  if (!ALLOWED_METHODS.includes(request.method)
    || request.body.length > MAX_REQUEST_BODY_BYTES
    || request.maxBytes === 0
    || request.maxBytes > MAX_RESPONSE_BYTES) {
    throw new BiliRequestError('invalid-request', 'B 站请求超出允许的能力');
  }
  for (const [name, value] of Object.entries(request.headers)) {
    if (!ALLOWED_HEADERS.includes(name)
      || utf8ByteLength(value) > 1024
      || value.includes('\r')
      || value.includes('\n')) {
      throw new BiliRequestError('unsafe-header', 'B 站请求头不在授权范围内');
    }
  }
}

export function credentialHost(url: URL): boolean {
  return url.hostname === 'api.bilibili.com' || url.hostname === 'passport.bilibili.com';
}

export function responseHeader(name: string): boolean {
  return RESPONSE_HEADERS.includes(name);
}

export interface ProgressiveVideoTrack {
  codec?: string;
  codecs?: string;
  codecId?: number;
  /** Bilibili DASH uses `codecid` in its JSON response. */
  codecid?: number;
  quality?: number;
  id?: number;
  width?: number;
  height?: number;
  bandwidth?: number;
  /** For muxed candidates. Separate DASH audio should likewise use AAC (mp4a). */
  audioCodec?: string;
}

/** Prefer the best AVC rendition, not an undecodable higher-resolution HEVC/AV1 track.
 * No transcoding is performed. For muxed tracks prefer AAC audio within the AVC pool.
 */
export function selectProgressiveCompatibleVideoTrack<T extends ProgressiveVideoTrack>(tracks: readonly T[]): T | null {
  const avc = tracks.filter(track => /avc1|h\.?264|\bavc\b/i.test(track.codec ?? track.codecs ?? '')
    || (track.codecId ?? track.codecid) === 7);
  const pool = avc.length > 0 ? avc : tracks;
  const aac = pool.filter(track => track.audioCodec === undefined || /mp4a|aac/i.test(track.audioCodec));
  const candidates = aac.length > 0 ? aac : pool;
  let best: T | null = null;
  for (const track of candidates) {
    if (best === null) { best = track; continue; }
    const spec = (item: T): number[] => [item.quality ?? item.id ?? 0, item.height ?? 0,
      (item.width ?? 0) * (item.height ?? 0), item.bandwidth ?? 0];
    const rank = spec(track);
    const previous = spec(best);
    for (let i = 0; i < rank.length; i += 1) {
      if (rank[i]! > previous[i]!) { best = track; break; }
      if (rank[i]! < previous[i]!) break;
    }
  }
  return best;
}
