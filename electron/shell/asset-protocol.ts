/**
 * `asset://` 协议，逐分支移植 tauri-2.11.5 `src/protocol/asset.rs` `get_response`：
 * 路径 = URL path 去掉首个 `/` 后百分号解码；含 `..` → 403；不在作用域 → 403；不存在 → 404；
 * 无权限 → 403；其他 IO 错误 → 500（text/plain 错误文本）。
 * 有 `Range` 时：单区间最多返回 1000*1024 字节（206），多区间返回 `multipart/byteranges`，解析失败 416；
 * `HEAD` 返回 Content-Length 与空体；其余返回整个文件。所有响应带 `Access-Control-Allow-Origin: <窗口 origin>`。
 *
 * 与 Tauri 的差异（处理器运行在 Electron main 的事件循环里，同步读大文件会卡住所有窗口）：
 * - 文件 I/O 全部异步；整文件与 multipart 响应体以 ReadableStream 按 {@link ASSET_STREAM_CHUNK} 分块读出，
 *   内存占用与文件大小无关；读完、出错或渲染端取消时关闭文件句柄。
 * - 多区间段数超过 {@link MAX_RANGES} 时返回 416（Tauri 不限段数，`bytes=0-,0-,…` 可放大读取量）。
 */
import { randomBytes } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';
import { extname } from 'node:path';
import { components } from './path-ops.ts';
import type { FsScope } from './scope.ts';
import type { ShellPlatform } from './tauri-config.ts';

export interface AssetResponse {
  status: number;
  headers: Record<string, string>;
  /** `null`：不带响应体（HEAD）。整文件与 multipart 为流式体，交给 `new Response()` 原样转发。 */
  body: Uint8Array | ReadableStream<Uint8Array> | null;
}

/** Tauri `MAX_LEN`：单个区间最多返回的字节数。 */
export const MAX_LEN = 1000 * 1024;
/** 多区间请求允许的最大段数；浏览器、媒体元素与 pdf.js 只发单区间请求。 */
export const MAX_RANGES = 64;
/** 流式响应体每次读取的字节数。 */
export const ASSET_STREAM_CHUNK = 256 * 1024;
/** tauri-utils `MimeType::parse` 嗅探读取的字节数；小于它的文件直接复用已读内容。 */
const MIME_READ_LIMIT = 8192;

const MIME_BY_EXT: Record<string, string> = {
  '.aac': 'audio/aac',
  '.avi': 'video/x-msvideo',
  '.bin': 'application/octet-stream',
  '.bmp': 'image/bmp',
  '.css': 'text/css',
  '.csv': 'text/csv',
  '.flac': 'audio/flac',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.htm': 'text/html',
  '.html': 'text/html',
  '.ico': 'image/vnd.microsoft.icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.m4a': 'audio/mp4',
  '.m4v': 'video/mp4',
  '.md': 'text/markdown',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.oga': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.ogv': 'video/ogg',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.rtf': 'application/rtf',
  '.svg': 'image/svg+xml',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
  '.weba': 'audio/webm',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
};

/** tauri-utils `MimeType::parse`：先按内容嗅探（infer），失败再按扩展名，最后 octet-stream。 */
export function sniffMime(head: Uint8Array, path: string): string {
  const starts = (...bytes: number[]) => bytes.every((b, i) => head[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (starts(0x25, 0x50, 0x44, 0x46)) return 'application/pdf';
  if (starts(0x52, 0x49, 0x46, 0x46) && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) return 'image/webp';
  if (starts(0x1a, 0x45, 0xdf, 0xa3)) return 'video/webm';
  if (head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) {
    const brand = String.fromCharCode(...head.slice(8, 12));
    if (brand.startsWith('M4A')) return 'audio/mp4';
    if (brand.startsWith('qt')) return 'video/quicktime';
    if (brand.startsWith('heic') || brand.startsWith('heix') || brand.startsWith('mif1')) return 'image/heif';
    return 'video/mp4';
  }
  if (starts(0x49, 0x44, 0x33) || starts(0xff, 0xfb)) return 'audio/mpeg';
  if (starts(0x4f, 0x67, 0x67, 0x53)) return 'audio/ogg';
  if (starts(0x66, 0x4c, 0x61, 0x43)) return 'audio/x-flac';
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/** http-range 0.1 `HttpRange::parse`：返回 [start, length] 列表，不可满足或格式错误返回 null。 */
export function parseRange(header: string, size: number): Array<[number, number]> | null {
  const prefix = 'bytes=';
  if (!header.startsWith(prefix)) return null;
  const ranges: Array<[number, number]> = [];
  let noOverlap = false;
  for (const raw of header.slice(prefix.length).split(',')) {
    const part = raw.trim();
    const dash = part.indexOf('-');
    if (dash < 0) return null;
    const startStr = part.slice(0, dash).trim();
    const endStr = part.slice(dash + 1).trim();
    if (startStr === '') {
      if (!/^\d+$/.test(endStr)) return null;
      let length = Number(endStr);
      if (length === 0) {
        noOverlap = true;
        continue;
      }
      if (length > size) length = size;
      ranges.push([size - length, length]);
    } else {
      if (!/^\d+$/.test(startStr)) return null;
      const start = Number(startStr);
      if (start >= size) {
        noOverlap = true;
        continue;
      }
      let end: number;
      if (endStr === '') end = size - 1;
      else {
        if (!/^\d+$/.test(endStr)) return null;
        end = Number(endStr);
        if (start > end) return null;
        if (end >= size) end = size - 1;
      }
      ranges.push([start, end - start + 1]);
    }
  }
  if (noOverlap && ranges.length === 0) return null;
  return ranges;
}

async function readAt(handle: FileHandle, start: number, length: number): Promise<Uint8Array> {
  const buf = Buffer.alloc(length);
  let off = 0;
  while (off < length) {
    const { bytesRead } = await handle.read(buf, off, length - off, start + off);
    if (bytesRead === 0) break;
    off += bytesRead;
  }
  return buf.subarray(0, off);
}

/** 流式响应体的组成片段：固定字节，或文件中的 `[start, end)` 区间。 */
type BodyPiece = { kind: 'bytes'; data: Uint8Array } | { kind: 'file'; start: number; end: number };

/** 按顺序输出片段；文件区间每次最多读 {@link ASSET_STREAM_CHUNK} 字节。流结束、出错或被取消时关闭句柄。 */
function pieceStream(handle: FileHandle, pieces: readonly BodyPiece[]): ReadableStream<Uint8Array> {
  let index = 0;
  let offset: number | null = null;
  let closed = false;
  const release = async () => {
    if (closed) return;
    closed = true;
    await handle.close();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (index < pieces.length) {
          const piece = pieces[index] as BodyPiece;
          if (piece.kind === 'bytes') {
            index += 1;
            controller.enqueue(piece.data);
            return;
          }
          const position = offset ?? piece.start;
          if (position >= piece.end) {
            index += 1;
            offset = null;
            continue;
          }
          const want = Math.min(ASSET_STREAM_CHUNK, piece.end - position);
          const buf = Buffer.alloc(want);
          const { bytesRead } = await handle.read(buf, 0, want, position);
          if (bytesRead === 0) {
            // 文件在响应期间被截断：与 Tauri `take(n).read_to_end` 一样只输出实际读到的字节。
            index += 1;
            offset = null;
            continue;
          }
          offset = position + bytesRead;
          controller.enqueue(buf.subarray(0, bytesRead));
          return;
        }
        await release();
        controller.close();
      } catch (error) {
        await release().catch(() => undefined);
        controller.error(error);
      }
    },
    async cancel() {
      await release();
    },
  });
}

export async function assetResponse(
  request: { url: string; method: string; headers: Record<string, string> },
  scope: FsScope,
  windowOrigin: string,
  platform: ShellPlatform,
): Promise<AssetResponse> {
  const base = { 'Access-Control-Allow-Origin': windowOrigin };
  const pathname = new URL(request.url).pathname;
  let path: string;
  try {
    path = decodeURIComponent(pathname.slice(1));
  } catch (error) {
    if (!(error instanceof URIError)) throw error;
    path = pathname.slice(1);
  }
  if (components(path, platform).some((c) => c.kind === 'parent')) return { status: 403, headers: base, body: new Uint8Array() };
  if (!scope.isAllowed(path)) return { status: 403, headers: base, body: new Uint8Array() };

  let handle: FileHandle;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { status: 404, headers: base, body: new Uint8Array() };
    if (code === 'EACCES' || code === 'EPERM') return { status: 403, headers: base, body: new Uint8Array() };
    return {
      status: 500,
      headers: { 'Content-Type': 'text/plain', ...base },
      body: new TextEncoder().encode(error instanceof Error ? error.message : String(error)),
    };
  }
  /** 交给流式响应体后由流负责关闭句柄。 */
  let handedOff = false;
  try {
    const len = (await handle.stat()).size;
    const head = await readAt(handle, 0, Math.min(len, MIME_READ_LIMIT));
    const mime = sniffMime(head, path);
    const headers: Record<string, string> = { ...base, 'Content-Type': mime };
    const isHead = request.method === 'HEAD';
    const rangeHeader = Object.entries(request.headers).find(([k]) => k.toLowerCase() === 'range')?.[1];
    if (rangeHeader !== undefined) {
      headers['Accept-Ranges'] = 'bytes';
      headers['Access-Control-Expose-Headers'] = 'content-range';
      const notSatisfiable = (): AssetResponse => ({
        status: 416,
        // 416 也是视频/音频/PDF 的 range 探测会遇到的响应：缺少 CORS 头会被浏览器当成
        // 不透明失败（`TypeError: Failed to fetch`），所以和 200/206 一样带上 base。
        headers: { ...base, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes */${len}` },
        body: new Uint8Array(),
      });
      const parsed = parseRange(rangeHeader, len);
      if (parsed === null || parsed.length > MAX_RANGES) return notSatisfiable();
      const ranges = parsed.map(([start, length]) => [start, start + length - 1] as [number, number]);
      if (ranges.length === 1) {
        const [start, rawEnd] = ranges[0] as [number, number];
        if (start >= len || rawEnd >= len || rawEnd < start) return notSatisfiable();
        const end = start + Math.min(rawEnd - start, len - start, MAX_LEN - 1);
        headers['Content-Range'] = `bytes ${start}-${end}/${len}`;
        headers['Content-Length'] = String(end + 1 - start);
        return { status: 206, headers, body: isHead ? null : await readAt(handle, start, end + 1 - start) };
      }
      const boundary = Array.from(randomBytes(30), (b) => b.toString(16)).join('');
      const sep = Buffer.from(`\r\n--${boundary}\r\n`);
      headers['Content-Type'] = `multipart/byteranges; boundary=${boundary}`;
      if (isHead) return { status: 200, headers, body: null };
      const pieces: BodyPiece[] = [];
      for (const [start, rawEnd] of ranges) {
        if (start >= len || rawEnd >= len || rawEnd < start) continue;
        const end = start + Math.min(rawEnd - start, len - start, MAX_LEN - 1);
        pieces.push({ kind: 'bytes', data: sep });
        pieces.push({ kind: 'bytes', data: Buffer.from(`content-type: ${mime}\r\ncontent-range: bytes ${start}-${end}/${len}\r\n\r\n`) });
        pieces.push({ kind: 'file', start, end: end + 1 });
      }
      pieces.push({ kind: 'bytes', data: sep });
      handedOff = true;
      return { status: 200, headers, body: pieceStream(handle, pieces) };
    }
    headers['Content-Length'] = String(len);
    if (isHead) return { status: 200, headers, body: null };
    if (len < MIME_READ_LIMIT) return { status: 200, headers, body: head };
    handedOff = true;
    return { status: 200, headers, body: pieceStream(handle, [{ kind: 'file', start: 0, end: len }]) };
  } finally {
    if (!handedOff) await handle.close();
  }
}
