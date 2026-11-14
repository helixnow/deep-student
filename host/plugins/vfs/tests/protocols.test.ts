import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import './local-runtime-fixture.ts';
import {
  FILE_STREAM_MAX_RESPONSE_BYTES,
  FILE_STREAM_MEDIA_CHUNK_BYTES,
  PDF_PROTOCOL_MAX_RESPONSE_BYTES,
  checkedResponseLen,
  extensionPermitted,
  fileStreamMimeType,
  filestreamCheckAccess,
  handleFileStream,
  handlePdfStream,
  hasHiddenSegmentWithin,
  isAllowedMediaExtension,
  isAllowedOrigin,
  mimeOverrideFromQuery,
  makeBudget,
  openedFileMatchesAuthorizedPath,
  parseRangeHeader,
  pathIsWithin,
  pdfMimeType,
  sanitizeMimeOverride,
  windowsComparablePathText,
  windowsPathStartsWith,
} from '../src/protocols.ts';

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-protocol-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function canonical(value: string): string {
  return fs.realpathSync(value);
}

function uriFor(filePath: string): string {
  return encodeURIComponent(filePath);
}

function request(url: string, method = 'GET', headers: Record<string, string> = {}) {
  return { url, method, headers };
}

function header(reply: { headers: Record<string, string> }, name: string): string | undefined {
  const lowered = name.toLowerCase();
  for (const [key, value] of Object.entries(reply.headers)) {
    if (key.toLowerCase() === lowered) return value;
  }
  return undefined;
}

function bodyText(body: Uint8Array): string {
  return Buffer.from(body).toString('utf8');
}

function bytesOf(reply: { body: Uint8Array | AsyncIterable<Uint8Array> }): Uint8Array {
  if (!(reply.body instanceof Uint8Array)) throw new TypeError('test protocol reply must be a byte array');
  return reply.body;
}

function sparseFile(dir: string, name: string, length: number): string {
  const filePath = path.join(dir, name);
  const fd = fs.openSync(filePath, 'w');
  try { fs.ftruncateSync(fd, length); }
  finally { fs.closeSync(fd); }
  return filePath;
}

describe('dstu-vfs/file_stream_protocol.rs', { timeout: 120_000 }, () => {
  it('returns failed-read reservations to the response budget exactly once', () => {
    const budget = makeBudget(8);
    const first = budget.reserve(8)!;
    expect(budget.reserve(1)).toBeUndefined();
    first.release();
    first.release();
    const next = budget.reserve(8)!;
    expect(next).toBeDefined();
    expect(budget.reserve(1)).toBeUndefined();
    next.attach(new Uint8Array(8));
    next.release();
    expect(budget.reserve(8)).toBeDefined();
  });
  it('allowed_origins_match_pdf_protocol_rule', () => {
    expect(isAllowedOrigin('tauri://localhost')).toBe(true);
    expect(isAllowedOrigin('http://tauri.localhost')).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:1422')).toBe(true);
    expect(isAllowedOrigin('http://localhost:1422')).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1.evil.com')).toBe(false);
    expect(isAllowedOrigin('http://localhost.evil.com')).toBe(false);
    expect(isAllowedOrigin('null')).toBe(false);
  });

  it('test_parse_range_header', () => {
    expect(parseRangeHeader('bytes=0-1023', 10000)).toEqual([0, 1023]);
    expect(parseRangeHeader('bytes=1024-', 10000)).toEqual([1024, 9999]);
    expect(parseRangeHeader('bytes=-1024', 10000)).toEqual([8976, 9999]);
    expect(parseRangeHeader('bytes=-0', 10000)).toBeUndefined();
    expect(parseRangeHeader('bytes=0-20000', 10000)).toEqual([0, 9999]);
    expect(parseRangeHeader('bytes=20000-30000', 10000)).toBeUndefined();
    expect(parseRangeHeader('bytes=abc-def', 10000)).toBeUndefined();
    expect(parseRangeHeader('bytes=0-1023', 0)).toBeUndefined();
    expect(parseRangeHeader('bytes=0-', 0)).toBeUndefined();
    expect(parseRangeHeader('bytes=-1024', 0)).toBeUndefined();
  });

  it('test_is_allowed_media_extension', () => {
    for (const ext of ['mp3', 'flac', 'opus', 'aif', 'caf', 'mp4', 'mkv', '3gp', 'png', 'heic', 'pdf', 'bin', 'MP4', 'Png']) {
      expect(isAllowedMediaExtension(ext), ext).toBe(true);
    }
    for (const ext of ['exe', 'html', '']) expect(isAllowedMediaExtension(ext), ext).toBe(false);
  });

  it('test_extension_permitted_relaxed_inside_blob_dirs', () => {
    const blobDirs = ['/data/blobs'];
    expect(extensionPermitted('/data/blobs/abcdef0123456789', blobDirs)).toBe(true);
    expect(extensionPermitted('/data/blobs/file.weird', blobDirs)).toBe(true);
    expect(extensionPermitted('/data/other/noext', blobDirs)).toBe(false);
    expect(extensionPermitted('/data/other/file.exe', blobDirs)).toBe(false);
    expect(extensionPermitted('/data/other/video.mp4', blobDirs)).toBe(true);
  });

  it('test_get_mime_type', () => {
    expect(fileStreamMimeType('a.mp3')).toBe('audio/mpeg');
    expect(fileStreamMimeType('a.m4a')).toBe('audio/mp4');
    expect(fileStreamMimeType('a.opus')).toBe('audio/ogg');
    expect(fileStreamMimeType('a.caf')).toBe('audio/x-caf');
    expect(fileStreamMimeType('a.mp4')).toBe('video/mp4');
    expect(fileStreamMimeType('a.mov')).toBe('video/quicktime');
    expect(fileStreamMimeType('a.mkv')).toBe('video/x-matroska');
    expect(fileStreamMimeType('a.png')).toBe('image/png');
    expect(fileStreamMimeType('a.avif')).toBe('image/avif');
    expect(fileStreamMimeType('a.pdf')).toBe('application/pdf');
    expect(fileStreamMimeType('a.MP4')).toBe('video/mp4');
    expect(fileStreamMimeType('noext')).toBe('application/octet-stream');
    expect(fileStreamMimeType('a.bin')).toBe('application/octet-stream');
    expect(fileStreamMimeType('a.unknown')).toBe('application/octet-stream');
  });

  it('test_sanitize_mime_override', () => {
    expect(sanitizeMimeOverride('video/mp4')).toBe('video/mp4');
    expect(sanitizeMimeOverride('audio/mpeg')).toBe('audio/mpeg');
    expect(sanitizeMimeOverride('image/svg+xml')).toBe('image/svg+xml');
    expect(sanitizeMimeOverride('video%2Fmp4')).toBe('video/mp4');
    expect(sanitizeMimeOverride('Video/MP4')).toBe('video/mp4');
    expect(sanitizeMimeOverride('text/html')).toBeUndefined();
    expect(sanitizeMimeOverride('application/octet-stream')).toBeUndefined();
    // Previewer overrides for blobs stored without a usable extension.
    expect(sanitizeMimeOverride('application/pdf')).toBe('application/pdf');
    expect(sanitizeMimeOverride('application/epub+zip')).toBe('application/epub+zip');
    expect(sanitizeMimeOverride('text/plain')).toBe('text/plain');
    expect(sanitizeMimeOverride('text/markdown')).toBe('text/markdown');
    expect(sanitizeMimeOverride('application/vnd.openxmlformats-officedocument.wordprocessingml.document'))
      .toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(sanitizeMimeOverride('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'))
      .toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(sanitizeMimeOverride('application/vnd.openxmlformats-officedocument.evil/../../x')).toBeUndefined();
    expect(sanitizeMimeOverride('application/javascript')).toBeUndefined();
    expect(sanitizeMimeOverride('video/mp4\r\nSet-Cookie: x')).toBeUndefined();
    expect(sanitizeMimeOverride('video/mp4; charset=utf-8')).toBeUndefined();
    expect(sanitizeMimeOverride('video/')).toBeUndefined();
    expect(sanitizeMimeOverride('')).toBeUndefined();
  });

  it('test_mime_override_from_query', () => {
    expect(mimeOverrideFromQuery('mime=video%2Fmp4')).toBe('video/mp4');
    expect(mimeOverrideFromQuery('foo=bar&mime=audio/ogg&baz=1')).toBe('audio/ogg');
    expect(mimeOverrideFromQuery('mime=text%2Fhtml')).toBeUndefined();
    expect(mimeOverrideFromQuery('foo=bar')).toBeUndefined();
    expect(mimeOverrideFromQuery(null)).toBeUndefined();
  });

  it('test_has_hidden_segment_within', () => {
    const allowed = ['/home/u/.local/share/app'];
    expect(hasHiddenSegmentWithin('/home/u/.local/share/app/media/a.mp4', allowed)).toBe(false);
    expect(hasHiddenSegmentWithin('/home/u/.local/share/app/.secret/a.mp4', allowed)).toBe(true);
    expect(hasHiddenSegmentWithin('/home/u/.local/share/app/media/.hidden.mp4', allowed)).toBe(true);
    expect(hasHiddenSegmentWithin('/etc/passwd', allowed)).toBe(true);
  });

  it('test_protocol_rejects_disallowed_paths', () => {
    const root = tempDir();
    const allowed = [canonical(root)];
    const blobDirs: string[] = [];

    const exePath = path.join(root, 'evil.exe');
    fs.writeFileSync(exePath, 'MZ');
    expect(handleFileStream(request(`filestream://localhost/${uriFor(exePath)}`), allowed, blobDirs).status).toBe(403);

    const hiddenDir = path.join(root, '.secret');
    fs.mkdirSync(hiddenDir, { recursive: true });
    const hiddenPath = path.join(hiddenDir, 'a.mp4');
    fs.writeFileSync(hiddenPath, 'data');
    expect(handleFileStream(request(`filestream://localhost/${uriFor(hiddenPath)}`), allowed, blobDirs).status).toBe(403);

    const outside = tempDir();
    const outsidePath = path.join(outside, 'a.mp4');
    fs.writeFileSync(outsidePath, 'data');
    expect(handleFileStream(request(`filestream://localhost/${uriFor(canonical(outsidePath))}`), allowed, blobDirs).status).toBe(403);

    const missing = path.join(root, 'missing.mp4');
    expect(handleFileStream(request(`filestream://localhost/${uriFor(missing)}`), allowed, blobDirs).status).toBe(404);
  });

  it('test_protocol_serves_chinese_path_and_rejects_outside_whitelist', () => {
    const root = tempDir();
    const allowed = [canonical(root)];
    const nested = path.join(root, '学习软件', '学习');
    fs.mkdirSync(nested, { recursive: true });
    const mediaPath = path.join(nested, '网课录音.mp3');
    fs.writeFileSync(mediaPath, 'ID3-test-body');
    const response = handleFileStream(request(`filestream://localhost/${uriFor(mediaPath)}`), allowed, []);
    expect(response.status).toBe(200);
    expect(header(response, 'Content-Type')).toBe('audio/mpeg');
    expect(bodyText(bytesOf(response))).toBe('ID3-test-body');

    const outside = tempDir();
    const outsidePath = path.join(outside, '明朝那些事儿.pdf');
    fs.writeFileSync(outsidePath, '%PDF-secret');
    expect(handleFileStream(request(`filestream://localhost/${uriFor(outsidePath)}`), allowed, []).status).toBe(403);
  });

  it.skipIf(process.platform !== 'win32')('test_hidden_segment_check_with_mixed_verbatim_forms_on_windows', () => {
    const root = tempDir();
    const mediaDir = path.join(root, '媒体');
    fs.mkdirSync(mediaDir, { recursive: true });
    const mediaPath = path.join(mediaDir, 'a.mp4');
    fs.writeFileSync(mediaPath, 'data');
    const allowed = [root];
    expect(hasHiddenSegmentWithin(canonical(mediaPath), allowed)).toBe(false);
    const hiddenDir = path.join(root, '.secret');
    fs.mkdirSync(hiddenDir, { recursive: true });
    const hiddenPath = path.join(hiddenDir, 'a.mp4');
    fs.writeFileSync(hiddenPath, 'data');
    expect(hasHiddenSegmentWithin(canonical(hiddenPath), allowed)).toBe(true);
  });

  it('test_protocol_serves_media_with_range_and_mime_override', () => {
    const root = tempDir();
    const allowed = [canonical(root)];
    const mediaPath = path.join(root, 'clip.mp4');
    fs.writeFileSync(mediaPath, Buffer.alloc(4096));

    const full = handleFileStream(request(`filestream://localhost/${uriFor(mediaPath)}`), allowed, []);
    expect(full.status).toBe(200);
    expect(header(full, 'Content-Type')).toBe('video/mp4');
    expect(bytesOf(full).length).toBe(4096);

    const ranged = handleFileStream(request(`filestream://localhost/${uriFor(mediaPath)}`, 'GET', { Range: 'bytes=0-1023' }), allowed, []);
    expect(ranged.status).toBe(206);
    expect(header(ranged, 'Content-Range')).toBe('bytes 0-1023/4096');
    expect(bytesOf(ranged).length).toBe(1024);

    const head = handleFileStream(request(`filestream://localhost/${uriFor(mediaPath)}`, 'HEAD'), allowed, []);
    expect(head.status).toBe(200);
    expect(bytesOf(head).length).toBe(0);
    expect(header(head, 'Content-Length')).toBe('4096');
  });

  it('test_protocol_allows_extensionless_blob_with_mime_override', () => {
    const root = tempDir();
    const allowed = [canonical(root)];
    const blobDirs = [canonical(root)];
    const blobPath = path.join(root, '0123456789abcdef');
    fs.writeFileSync(blobPath, Buffer.alloc(128, 7));

    const plain = handleFileStream(request(`filestream://localhost/${uriFor(blobPath)}`), allowed, blobDirs);
    expect(plain.status).toBe(200);
    expect(header(plain, 'Content-Type')).toBe('application/octet-stream');

    const overridden = handleFileStream(request(`filestream://localhost/${uriFor(blobPath)}?mime=video%2Fmp4`), allowed, blobDirs);
    expect(overridden.status).toBe(200);
    expect(header(overridden, 'Content-Type')).toBe('video/mp4');

    const invalid = handleFileStream(request(`filestream://localhost/${uriFor(blobPath)}?mime=text%2Fhtml`), allowed, blobDirs);
    expect(invalid.status).toBe(200);
    expect(header(invalid, 'Content-Type')).toBe('application/octet-stream');
  });

  it('test_oversized_get_is_rejected_and_media_ranges_are_served_in_chunks', () => {
    const root = tempDir();
    const size = 2 * 1024 * 1024 * 1024;
    const mediaPath = sparseFile(root, 'lecture-2g.mp4', size);
    const allowed = [canonical(root)];
    const blobDirs: string[] = [];

    const full = handleFileStream(request(`filestream://localhost/${uriFor(mediaPath)}`), allowed, blobDirs);
    expect(full.status).toBe(413);
    expect(bytesOf(full).length).toBe(0);

    const range = handleFileStream(request(
      `filestream://localhost/${uriFor(mediaPath)}`, 'GET', { Range: 'bytes=0-' },
    ), allowed, blobDirs);
    expect(range.status).toBe(206);
    expect(header(range, 'Content-Range')).toBe(`bytes 0-${FILE_STREAM_MEDIA_CHUNK_BYTES - 1}/${size}`);
    expect(bytesOf(range).length).toBe(FILE_STREAM_MEDIA_CHUNK_BYTES);

    const tailStart = size - 1024;
    const tail = handleFileStream(request(
      `filestream://localhost/${uriFor(mediaPath)}`, 'GET', { Range: `bytes=${tailStart}-` },
    ), allowed, blobDirs);
    expect(tail.status).toBe(206);
    expect(header(tail, 'Content-Range')).toBe(`bytes ${tailStart}-${size - 1}/${size}`);
    expect(bytesOf(tail).length).toBe(1024);
  });

  it('test_oversized_non_media_range_is_still_rejected_without_truncation', () => {
    const root = tempDir();
    const mediaPath = sparseFile(root, 'oversized.pdf', FILE_STREAM_MAX_RESPONSE_BYTES + 1);
    const response = handleFileStream(request(
      `filestream://localhost/${uriFor(mediaPath)}`, 'GET', { Range: 'bytes=0-' },
    ), [canonical(root)], []);
    expect(response.status).toBe(416);
    expect(bytesOf(response).length).toBe(0);
  });

  it.skipIf(process.platform === 'win32')('test_opened_handle_rejects_path_replaced_after_open', () => {
    const allowed = tempDir();
    const external = tempDir();
    const requested = path.join(allowed, 'requested.mp4');
    const moved = path.join(allowed, 'moved.mp4');
    const secret = path.join(external, 'secret.mp4');
    fs.writeFileSync(requested, 'allowed');
    fs.writeFileSync(secret, 'secret');

    const expected = canonical(requested);
    const fd = fs.openSync(requested, 'r');
    try {
      fs.renameSync(requested, moved);
      fs.symlinkSync(secret, requested);
      expect(openedFileMatchesAuthorizedPath(fd, expected, [canonical(allowed)])).toBe(false);
    } finally {
      fs.closeSync(fd);
    }
  });
});

describe('dstu-vfs/pdf_protocol.rs', { timeout: 120_000 }, () => {
  it('test_parse_range_header', () => {
    expect(parseRangeHeader('bytes=0-1023', 10000)).toEqual([0, 1023]);
    expect(parseRangeHeader('bytes=1024-', 10000)).toEqual([1024, 9999]);
    expect(parseRangeHeader('bytes=-1024', 10000)).toEqual([8976, 9999]);
    expect(parseRangeHeader('bytes=-0', 10000)).toBeUndefined();
    expect(parseRangeHeader('bytes=0-20000', 10000)).toEqual([0, 9999]);
    expect(parseRangeHeader('bytes=20000-30000', 10000)).toBeUndefined();
    expect(parseRangeHeader('bytes=abc-def', 10000)).toBeUndefined();
    expect(parseRangeHeader('bytes=0-1023', 0)).toBeUndefined();
    expect(parseRangeHeader('bytes=0-', 0)).toBeUndefined();
    expect(parseRangeHeader('bytes=-1024', 0)).toBeUndefined();
  });

  it('test_is_allowed_origin', () => {
    for (const origin of [
      'tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost',
      'http://localhost', 'http://localhost:1420', 'https://localhost:8080',
      'http://127.0.0.1', 'http://127.0.0.1:1422', 'https://127.0.0.1:8080',
    ]) expect(isAllowedOrigin(origin), origin).toBe(true);
    for (const origin of [
      'http://localhost.evil.com', 'https://localhost.evil.com:443',
      'http://evil.com', 'http://127.0.0.1.evil.com',
    ]) expect(isAllowedOrigin(origin), origin).toBe(false);
  });

  it('test_checked_response_len_enforces_platform_and_protocol_limits', () => {
    expect(checkedResponseLen(PDF_PROTOCOL_MAX_RESPONSE_BYTES, PDF_PROTOCOL_MAX_RESPONSE_BYTES))
      .toBe(PDF_PROTOCOL_MAX_RESPONSE_BYTES);
    expect(checkedResponseLen(PDF_PROTOCOL_MAX_RESPONSE_BYTES + 1, PDF_PROTOCOL_MAX_RESPONSE_BYTES))
      .toBeUndefined();
    expect(checkedResponseLen(Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER))
      .toBeUndefined();
  });

  it('test_oversized_get_and_open_range_are_rejected_without_reading_body', () => {
    const root = tempDir();
    const pdfPath = sparseFile(root, 'oversized.pdf', PDF_PROTOCOL_MAX_RESPONSE_BYTES + 1);
    const allowed = [canonical(root)];

    const get = handlePdfStream(request(`pdfstream://localhost/${uriFor(pdfPath)}`), allowed);
    expect(get.status).toBe(413);
    expect(bytesOf(get).length).toBe(0);

    const range = handlePdfStream(request(
      `pdfstream://localhost/${uriFor(pdfPath)}`, 'GET', { Range: 'bytes=0-' },
    ), allowed);
    expect(range.status).toBe(416);
    expect(bytesOf(range).length).toBe(0);

    const head = handlePdfStream(request(`pdfstream://localhost/${uriFor(pdfPath)}`, 'HEAD'), allowed);
    expect(head.status).toBe(200);
    expect(header(head, 'Content-Length')).toBe(String(PDF_PROTOCOL_MAX_RESPONSE_BYTES + 1));
    expect(header(head, 'Access-Control-Expose-Headers')).toBeTruthy();
  });

  it.skipIf(process.platform === 'win32')('test_opened_handle_rejects_path_replaced_after_open', () => {
    const allowed = tempDir();
    const external = tempDir();
    const requested = path.join(allowed, 'requested.pdf');
    const moved = path.join(allowed, 'moved.pdf');
    const secret = path.join(external, 'secret.pdf');
    fs.writeFileSync(requested, '%PDF-allowed');
    fs.writeFileSync(secret, '%PDF-secret');

    const expected = canonical(requested);
    const fd = fs.openSync(requested, 'r');
    try {
      fs.renameSync(requested, moved);
      fs.symlinkSync(secret, requested);
      expect(openedFileMatchesAuthorizedPath(fd, expected, [canonical(allowed)])).toBe(false);
    } finally {
      fs.closeSync(fd);
    }
  });

  it('test_get_mime_type', () => {
    expect(pdfMimeType('test.pdf')).toBe('application/pdf');
    expect(pdfMimeType('test.png')).toBe('image/png');
    expect(pdfMimeType('test.unknown')).toBe('application/octet-stream');
  });

  it('test_windows_comparable_path_text_aligns_verbatim_and_plain_forms', () => {
    expect(windowsComparablePathText('\\\\?\\D:\\学习软件\\学习'))
      .toBe(windowsComparablePathText('D:\\学习软件\\学习'));
    expect(windowsComparablePathText('\\\\?\\UNC\\srv\\share\\教材'))
      .toBe(windowsComparablePathText('\\\\srv\\share\\教材'));
    expect(windowsComparablePathText('D:\\Docs\\A.PDF'))
      .toBe(windowsComparablePathText('d:\\docs\\a.pdf'));
    expect(windowsComparablePathText('D:\\Docs\\'))
      .toBe(windowsComparablePathText('D:/Docs'));
  });

  it('test_windows_path_starts_with_aligns_whitelist_forms', () => {
    expect(windowsPathStartsWith('\\\\?\\D:\\学习软件\\学习\\明朝那些事儿.pdf', 'D:\\学习软件')).toBe(true);
    expect(windowsPathStartsWith('D:\\学习软件\\学习\\明朝那些事儿.pdf', '\\\\?\\D:\\学习软件\\学习')).toBe(true);
    expect(windowsPathStartsWith('\\\\?\\D:\\x.pdf', 'D:\\')).toBe(true);
    expect(windowsPathStartsWith('\\\\?\\D:\\Docs', 'D:\\Docs')).toBe(true);
    expect(windowsPathStartsWith('\\\\?\\UNC\\srv\\share\\教材\\a.pdf', '\\\\srv\\share\\教材')).toBe(true);
    expect(windowsPathStartsWith('D:\\Docs2\\x.pdf', 'D:\\Docs')).toBe(false);
    expect(windowsPathStartsWith('\\\\?\\D:\\学习软件2\\x.pdf', 'D:\\学习软件')).toBe(false);
    expect(windowsPathStartsWith('\\\\?\\C:\\Windows\\x.pdf', 'D:\\')).toBe(false);
    expect(windowsPathStartsWith('\\\\?\\D:\\学习软件\\x.pdf', 'D:\\其他目录')).toBe(false);
    expect(windowsPathStartsWith('D:\\x.pdf', '')).toBe(false);
  });

  it('test_path_is_within_preserves_unix_semantics', () => {
    expect(pathIsWithin('/a/b/c.pdf', '/a/b')).toBe(true);
    expect(pathIsWithin('/a/b', '/a/b')).toBe(true);
    expect(pathIsWithin('/a/bc/x.pdf', '/a/b')).toBe(false);
    expect(pathIsWithin('/etc/passwd', '/a')).toBe(false);
    expect(pathIsWithin('/A/B/c.pdf', '/a/b')).toBe(false);
    // Path::starts_with is per component: a child named `..x` is inside, `..` climbs out.
    expect(pathIsWithin('/a/b/..x.pdf', '/a/b')).toBe(true);
    expect(pathIsWithin('/a/b/..x/c.pdf', '/a/b')).toBe(true);
    expect(pathIsWithin('/a/c.pdf', '/a/b')).toBe(false);
  });

  it('test_pdfstream_serves_chinese_path_via_encoded_url', () => {
    const root = tempDir();
    const nested = path.join(root, '学习软件', '学习');
    fs.mkdirSync(nested, { recursive: true });
    const pdfPath = path.join(nested, '明朝那些事儿.pdf');
    fs.writeFileSync(pdfPath, '%PDF-1.4 test-body');
    const allowed = [canonical(root)];

    const get = handlePdfStream(request(`pdfstream://localhost/${uriFor(pdfPath)}`), allowed);
    expect(get.status).toBe(200);
    expect(bodyText(bytesOf(get))).toBe('%PDF-1.4 test-body');

    const range = handlePdfStream(request(
      `pdfstream://localhost/${uriFor(pdfPath)}`, 'GET', { Range: 'bytes=0-7' },
    ), allowed);
    expect(range.status).toBe(206);
    expect(bodyText(bytesOf(range))).toBe('%PDF-1.4');
  });

  it('test_pdfstream_serves_content_addressed_bin_blob_with_pdf_magic', () => {
    const root = tempDir();
    const allowed = [canonical(root)];
    const blobDirs = [canonical(root)];
    const pdfBlob = path.join(root, '0123456789abcdef.bin');
    fs.writeFileSync(pdfBlob, '%PDF-1.7 blob body');
    const response = handlePdfStream(request(`pdfstream://localhost/${uriFor(pdfBlob)}`), allowed, blobDirs);
    expect(response.status).toBe(200);
    expect(header(response, 'Content-Type')).toBe('application/pdf');
    expect(bodyText(bytesOf(response))).toBe('%PDF-1.7 blob body');

    // A blob without the magic header is not a PDF and stays rejected.
    const notPdf = path.join(root, 'fedcba9876543210.bin');
    fs.writeFileSync(notPdf, 'PK\u0003\u0004zip-data');
    expect(handlePdfStream(request(`pdfstream://localhost/${uriFor(notPdf)}`), allowed, blobDirs).status).toBe(403);

    // An explicit application/pdf override is honored for uploaded PDFs whose
    // stored extension was not preserved.
    const overridden = handlePdfStream(
      request(`pdfstream://localhost/${uriFor(notPdf)}?mime=application%2Fpdf`),
      allowed,
      blobDirs,
    );
    expect(overridden.status).toBe(200);
    expect(header(overridden, 'Content-Type')).toBe('application/pdf');
  });

  it('test_pdfstream_rejects_unrelated_extension_even_with_pdf_magic', () => {
    const root = tempDir();
    const filePath = path.join(root, '0123456789abcdef.dat');
    fs.writeFileSync(filePath, '%PDF-1.7 body');
    const response = handlePdfStream(
      request(`pdfstream://localhost/${uriFor(filePath)}`),
      [canonical(root)],
      [],
    );
    expect(response.status).toBe(403);
  });

  it('test_pdfstream_still_rejects_chinese_path_outside_whitelist', () => {
    const allowedRoot = tempDir();
    const outside = tempDir();
    const pdfPath = path.join(outside, '明朝那些事儿.pdf');
    fs.writeFileSync(pdfPath, '%PDF-secret');
    const response = handlePdfStream(
      request(`pdfstream://localhost/${uriFor(pdfPath)}`),
      [canonical(allowedRoot)],
    );
    expect(response.status).toBe(403);
    expect(bytesOf(response).length).toBe(0);
  });

  it.skipIf(process.platform !== 'win32')('test_path_is_within_mixed_verbatim_forms_on_windows', () => {
    const root = tempDir();
    const nested = path.join(root, '学习软件');
    fs.mkdirSync(nested, { recursive: true });
    const pdfPath = path.join(nested, '明朝那些事儿.pdf');
    fs.writeFileSync(pdfPath, '%PDF');
    const canonicalFile = canonical(pdfPath);
    expect(pathIsWithin(canonicalFile, root)).toBe(true);
    expect(pathIsWithin(pdfPath, canonical(root))).toBe(true);
    const other = tempDir();
    expect(pathIsWithin(canonicalFile, other)).toBe(false);
  });
});

describe('filestream_check_access', () => {
  it('matches the handler decision chain', () => {
    const root = tempDir();
    const allowed = [canonical(root)];
    const mediaPath = path.join(root, 'a.mp4');
    fs.writeFileSync(mediaPath, 'data');
    expect(filestreamCheckAccess(mediaPath, allowed, [])).toBe(true);

    const exePath = path.join(root, 'a.exe');
    fs.writeFileSync(exePath, 'MZ');
    expect(filestreamCheckAccess(exePath, allowed, [])).toBe(false);

    const outside = tempDir();
    const outsidePath = path.join(outside, 'a.mp4');
    fs.writeFileSync(outsidePath, 'data');
    expect(filestreamCheckAccess(outsidePath, allowed, [])).toBe(false);
    expect(filestreamCheckAccess(path.join(root, 'missing.mp4'), allowed, [])).toBe(false);
  });
});
