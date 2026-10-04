/**
 * Chat V2 - fileDefinition media (audio/video) citation hint
 *
 * 媒体学习 §2：音视频附件注入 `[媒体@id:mm:ss]` 引用格式说明与按时间读转写的提示。
 */

import { describe, it, expect } from 'vitest';
import type { Resource } from '@/features/chat/context';
import { fileDefinition, isTextContentBlock } from '@/features/chat/context';
import { isMediaFile } from '@/features/chat/context/definitions/file';

function attachment(name: string, mimeType: string, content: string): Resource {
  return {
    id: 'res_media',
    hash: 'hash_media',
    type: 'file',
    data: '',
    refCount: 1,
    createdAt: Date.now(),
    _resolvedResources: [
      {
        sourceId: 'file_lecture',
        resourceHash: 'hash_media',
        type: 'file',
        name,
        path: `/tmp/${name}`,
        content,
        found: true,
        metadata: { name, mimeType, size: 1024 },
      },
    ],
  };
}

function texts(resource: Resource): string[] {
  return fileDefinition
    .formatToBlocks(resource)
    .filter(isTextContentBlock)
    .map((block) => (block as { text: string }).text);
}

describe('fileDefinition (media)', () => {
  it('detects audio/video by mime type or extension', () => {
    expect(isMediaFile('a.bin', 'audio/mpeg')).toBe(true);
    expect(isMediaFile('lecture.MP4')).toBe(true);
    expect(isMediaFile('notes.txt', 'text/plain')).toBe(false);
  });

  it('prepends the [媒体@id:mm:ss] citation hint for media attachments', () => {
    const out = texts(attachment('lecture.mp4', 'video/mp4', '[00:05] 今天讲傅里叶级数'));
    expect(out[0]).toContain('<media_meta');
    expect(out[0]).toContain('[媒体@file_lecture:mm:ss]');
    expect(out[0]).toContain('time_start/time_end');
    expect(out.some((text) => text.includes('今天讲傅里叶级数'))).toBe(true);
  });

  it('keeps the hint even when the transcript is not ready yet', () => {
    const out = texts(attachment('talk.m4a', 'audio/mp4', ''));
    expect(out[0]).toContain('[媒体@file_lecture:mm:ss]');
  });

  it('does not add the hint to ordinary files', () => {
    const out = texts(attachment('notes.txt', 'text/plain', 'hello'));
    expect(out.some((text) => text.includes('media_meta'))).toBe(false);
  });
});
