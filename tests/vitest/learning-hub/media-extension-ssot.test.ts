/**
 * 音视频扩展名单一真源契约
 *
 * inferFilePreviewTypeFromName（learning-hub/types.ts）与播放器 MIME
 * 映射表（mediaPreviewUtils.ts）必须使用同一套扩展名集合：任何一侧
 * 单独增删都会造成"推断说不可预览、播放器其实认识"（或反之）的漂移。
 */
import { describe, expect, it } from 'vitest';

import {
  AUDIO_PREVIEW_EXTENSIONS,
  VIDEO_PREVIEW_EXTENSIONS,
  resolveAudioMimeType,
  resolveVideoMimeType,
} from '@/features/learning-hub/apps/views/mediaPreviewUtils';
import { inferFilePreviewTypeFromName } from '@/features/learning-hub/types';

describe('media extension single source of truth', () => {
  it('exposes non-empty extension sets derived from the MIME tables', () => {
    expect(AUDIO_PREVIEW_EXTENSIONS.size).toBeGreaterThan(0);
    expect(VIDEO_PREVIEW_EXTENSIONS.size).toBeGreaterThan(0);
    expect(AUDIO_PREVIEW_EXTENSIONS.has('mp3')).toBe(true);
    expect(VIDEO_PREVIEW_EXTENSIONS.has('mp4')).toBe(true);
  });

  it('every audio extension resolves an audio/* MIME and infers previewType audio', () => {
    for (const ext of AUDIO_PREVIEW_EXTENSIONS) {
      expect(resolveAudioMimeType('', `sample.${ext}`), ext).toMatch(/^audio\//);
      expect(inferFilePreviewTypeFromName(`sample.${ext}`), ext).toBe('audio');
    }
  });

  it('every video extension resolves a video/* MIME; inference matches except text collisions', () => {
    for (const ext of VIDEO_PREVIEW_EXTENSIONS) {
      expect(resolveVideoMimeType('', `sample.${ext}`), ext).toMatch(/^video\//);
      // 约定（types.ts）：文本判定先于音视频，'ts' 按 TypeScript 而非 MPEG-TS
      const expected = ext === 'ts' ? 'text' : 'video';
      expect(inferFilePreviewTypeFromName(`sample.${ext}`), ext).toBe(expected);
    }
  });

  it('inference is case-insensitive and unknown extensions stay none', () => {
    expect(inferFilePreviewTypeFromName('SONG.FLAC')).toBe('audio');
    expect(inferFilePreviewTypeFromName('movie.MKV')).toBe('video');
    expect(inferFilePreviewTypeFromName('unknown.bin')).toBe('none');
  });

  it('untrusted fallback MIME defers to the extension table', () => {
    // audio/mpeg / video/mp4 是历史默认兜底，可能是错误标注：扩展名优先
    expect(resolveAudioMimeType('audio/mpeg', 'voice.wav')).toBe('audio/wav');
    expect(resolveVideoMimeType('video/mp4', 'clip.webm')).toBe('video/webm');
    // 非兜底值直接信任
    expect(resolveAudioMimeType('audio/flac', 'whatever.bin')).toBe('audio/flac');
  });
});
