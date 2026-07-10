import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
import {
  decodeTextPreviewBytes,
  loadTextPreviewContent,
  needsBackendTextExtraction,
} from '@/features/learning-hub/apps/views/textPreviewLoader';
import { classifyPdfLoadError } from '@/features/learning-hub/apps/views/pdfLoadErrors';
import {
  isLikelyUnsupportedMedia,
  resolveAudioMimeType,
  resolveVideoMimeType,
} from '@/features/learning-hub/apps/views/mediaPreviewUtils';

const invokeMock = vi.mocked(invoke);

const utf8ToBase64 = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
};

describe('textPreviewLoader', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('detects formats that need backend text extraction', () => {
    expect(needsBackendTextExtraction('book.epub')).toBe(true);
    expect(needsBackendTextExtraction('sheet.xls')).toBe(true);
    expect(needsBackendTextExtraction('sheet.xlsx')).toBe(false);
    expect(needsBackendTextExtraction('readme.md')).toBe(false);
    expect(needsBackendTextExtraction('page.html')).toBe(true);
  });

  it('decodes UTF-8 bytes and strips a UTF-8 BOM', () => {
    const plain = new TextEncoder().encode('hello 世界');
    expect(decodeTextPreviewBytes(plain)).toBe('hello 世界');

    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('abc')]);
    expect(decodeTextPreviewBytes(withBom)).toBe('abc');
  });

  it('falls back to GBK for legacy Chinese encodings that are invalid UTF-8', () => {
    // "中文" encoded as GBK: D6D0 CEC4 (invalid as UTF-8)
    const gbkBytes = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]);
    expect(decodeTextPreviewBytes(gbkBytes)).toBe('中文');
  });

  it('never throws on undecodable bytes (lossy last-resort decoding)', () => {
    const junk = new Uint8Array([0xff, 0x00, 0xfe, 0x81]);
    expect(() => decodeTextPreviewBytes(junk)).not.toThrow();
    expect(typeof decodeTextPreviewBytes(junk)).toBe('string');
  });

  it('decodes UTF-16 LE/BE content via BOM detection', () => {
    // "Hi" in UTF-16LE with BOM
    const utf16le = new Uint8Array([0xff, 0xfe, 0x48, 0x00, 0x69, 0x00]);
    expect(decodeTextPreviewBytes(utf16le)).toBe('Hi');

    // "Hi" in UTF-16BE with BOM
    const utf16be = new Uint8Array([0xfe, 0xff, 0x00, 0x48, 0x00, 0x69]);
    expect(decodeTextPreviewBytes(utf16be)).toBe('Hi');
  });

  it('decodes rawBase64 for plain-text formats without calling the backend', async () => {
    const content = await loadTextPreviewContent({
      nodeId: 'n1',
      fileName: 'notes.txt',
      rawBase64: utf8ToBase64('local text 内容'),
    });
    expect(content).toBe('local text 内容');
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('resolves backend-extracted formats via vfs_resolve_resource_refs', async () => {
    invokeMock.mockResolvedValueOnce([{ found: true, content: 'extracted text' }]);
    const content = await loadTextPreviewContent({
      nodeId: 'n2',
      fileName: 'page.html',
      contentHash: 'hash',
    });
    expect(content).toBe('extracted text');
    expect(invokeMock).toHaveBeenCalledWith('vfs_resolve_resource_refs', {
      refs: [{ sourceId: 'n2', resourceHash: 'hash', type: 'file', name: 'page.html' }],
    });
  });

  it('returns empty string (not null) for a found-but-empty file', async () => {
    invokeMock.mockResolvedValueOnce([{ found: true, content: '' }]);
    const content = await loadTextPreviewContent({ nodeId: 'n3', fileName: 'empty.txt' });
    expect(content).toBe('');
  });

  it('returns null when the resource is not found', async () => {
    invokeMock.mockResolvedValueOnce([{ found: false, content: null }]);
    const content = await loadTextPreviewContent({ nodeId: 'n4', fileName: 'missing.txt' });
    expect(content).toBeNull();
  });
});

describe('pdfLoadErrors', () => {
  it('classifies password-protected PDF errors', () => {
    expect(classifyPdfLoadError(new Error('PasswordException: Need password')).kind).toBe('password');
  });

  it('classifies invalid PDF errors', () => {
    expect(classifyPdfLoadError(new Error('Invalid PDF structure')).kind).toBe('invalid');
  });

  it('classifies network/stream errors', () => {
    expect(classifyPdfLoadError(new Error('Failed to fetch pdfstream resource 403')).kind).toBe('network');
  });
});

describe('mediaPreviewUtils', () => {
  it('resolves MIME from extension when generic octet-stream', () => {
    expect(resolveAudioMimeType('application/octet-stream', 'track.flac')).toBe('audio/flac');
    expect(resolveVideoMimeType('application/octet-stream', 'clip.webm')).toBe('video/webm');
  });

  it('flags likely unsupported media containers', () => {
    expect(isLikelyUnsupportedMedia('movie.mkv', 'video')).toBe(true);
    expect(isLikelyUnsupportedMedia('song.mp3', 'audio')).toBe(false);
  });
});
