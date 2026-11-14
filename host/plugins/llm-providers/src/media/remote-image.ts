/**
 * Bridge for Rust `dstu_util::utils::fetch::fetch_binary_with_cache`.
 *
 * Rust `build_request` performs a blocking download on a cache miss. The Host
 * request builder is synchronous, so the production path is split in two:
 *
 * 1. `prepareRemoteImages` (async, called by the request preparation entry)
 *    downloads http(s) image parts through the installed downloader (the
 *    plugin entry installs `host/platform/net-policy`'s `fetchBinaryWithCache`)
 *    and rewrites them to `data:` URLs. The downloaded
 *    bytes are also kept in a lane-local cache.
 * 2. `remoteImageBase64Payload` (sync, called inside `buildRequest`) inlines
 *    `data:` URLs and serves the lane-local cache, preserving the Rust
 *    fetch-failure path when an image could not be downloaded.
 */
import type { JsonObject, JsonValue } from '../../api.ts';
import { encodeBase64 } from '../base64.ts';

export interface RemoteImageFetcher {
  /** Returns bytes already fetched/cached by the caller; never performs blocking network I/O. */
  fetchImage(url: string): { bytes: Uint8Array; mimeType?: string } | undefined;
}

/** SSRF-checked binary download; `null` result is Rust's `fetch_binary_with_cache -> None`. */
export type RemoteImageDownloader = (url: string) => Promise<{ bytes: Uint8Array; mimeType?: string | null } | null>;

let fetcher: RemoteImageFetcher | null = null;
let downloader: RemoteImageDownloader | null = null;
const preparedImages = new Map<string, { bytes: Uint8Array; mimeType?: string }>();

export function setRemoteImageFetcher(value: RemoteImageFetcher | null): void {
  fetcher = value;
}

export function remoteImageFetcher(): RemoteImageFetcher | null { return fetcher; }

/** Installed by the desktop plugin entry; without one, remote parts keep their URL (the None path). */
export function setRemoteImageDownloader(value: RemoteImageDownloader | null): void {
  downloader = value;
}

/** Bytes downloaded by `prepareRemoteImages` for a URL. */
export function cachedRemoteImage(url: string): { bytes: Uint8Array; mimeType?: string } | undefined {
  return preparedImages.get(url);
}

function isHttpUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://');
}

function dataUrl(bytes: Uint8Array, mimeType: string | undefined): string {
  return `data:${mimeType ?? 'application/octet-stream'};base64,${encodeBase64(bytes)}`;
}

/** Collect image URLs from OpenAI/Anthropic image parts without touching other strings. */
function collectImageUrls(body: JsonValue): string[] {
  const urls = new Set<string>();
  const visit = (value: JsonValue): void => {
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (value === null || typeof value !== 'object') return;
    const object = value as JsonObject;
    const type = typeof object.type === 'string' ? object.type : undefined;
    if (type === 'image_url') {
      const imageUrl = object.image_url;
      if (typeof imageUrl === 'string') {
        if (isHttpUrl(imageUrl)) urls.add(imageUrl);
      } else if (imageUrl !== null && typeof imageUrl === 'object' && !Array.isArray(imageUrl)) {
        const url = (imageUrl as JsonObject).url;
        if (typeof url === 'string' && isHttpUrl(url)) urls.add(url);
      }
    }
    if (type === 'image') {
      const source = object.source;
      if (source !== null && typeof source === 'object' && !Array.isArray(source)) {
        const sourceObject = source as JsonObject;
        const url = sourceObject.url;
        if (sourceObject.type === 'url' && typeof url === 'string' && isHttpUrl(url)) urls.add(url);
      }
    }
    for (const item of Object.values(object)) visit(item as JsonValue);
  };
  visit(body);
  return [...urls];
}

function rewriteImageUrls(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(item => rewriteImageUrls(item));
  if (value === null || typeof value !== 'object') return value;
  const object = value as JsonObject;
  const result: JsonObject = {};
  for (const [key, item] of Object.entries(object)) result[key] = rewriteImageUrls(item as JsonValue);
  const type = typeof result.type === 'string' ? result.type : undefined;
  if (type === 'image_url') {
    const imageUrl = result.image_url;
    if (typeof imageUrl === 'string') {
      const cached = preparedImages.get(imageUrl);
      if (cached !== undefined) result.image_url = dataUrl(cached.bytes, cached.mimeType);
    } else if (imageUrl !== null && typeof imageUrl === 'object' && !Array.isArray(imageUrl)) {
      const wrapper = imageUrl as JsonObject;
      const url = wrapper.url;
      if (typeof url === 'string') {
        const cached = preparedImages.get(url);
        if (cached !== undefined) result.image_url = { ...wrapper, url: dataUrl(cached.bytes, cached.mimeType) };
      }
    }
  }
  if (type === 'image') {
    const source = result.source;
    if (source !== null && typeof source === 'object' && !Array.isArray(source)) {
      const sourceObject = source as JsonObject;
      const url = sourceObject.url;
      if (sourceObject.type === 'url' && typeof url === 'string') {
        const cached = preparedImages.get(url);
        if (cached !== undefined) {
          result.source = {
            type: 'base64',
            media_type: cached.mimeType ?? 'application/octet-stream',
            data: encodeBase64(cached.bytes),
          };
        }
      }
    }
  }
  return result;
}

/**
 * Production remote-image preparation: download every http(s) image part with
 * the platform SSRF-checked cache, then return a body whose image parts are
 * `data:` URLs. Download failures keep the original URL, matching Rust's
 * `fetch_binary_with_cache -> None` path (the part is skipped by the adapter).
 */
export async function prepareRemoteImages(body: JsonValue): Promise<JsonValue> {
  const urls = collectImageUrls(body);
  const download = downloader;
  await Promise.all(urls.map(async url => {
    const fetched = download === null ? null : await download(url);
    if (fetched !== null) {
      preparedImages.set(url, { bytes: fetched.bytes, mimeType: fetched.mimeType ?? undefined });
    }
  }));
  return rewriteImageUrls(body);
}

/** providers/mod.rs:3509 `create_base64_payload` http(s) branch. */
export function remoteImageBase64Payload(url: string): [string, string] | undefined {
  if (!url.startsWith('http://') && !url.startsWith('https://')) return undefined;
  let fetched: { bytes: Uint8Array; mimeType?: string } | undefined;
  try {
    fetched = preparedImages.get(url) ?? (fetcher === null ? undefined : fetcher.fetchImage(url));
  } catch {
    // Rust `fetch_binary_with_cache` swallows transport failures and returns None.
    return undefined;
  }
  if (fetched === undefined) return undefined;
  const mediaType = fetched.mimeType ?? 'application/octet-stream';
  return [mediaType, encodeBase64(fetched.bytes)];
}
