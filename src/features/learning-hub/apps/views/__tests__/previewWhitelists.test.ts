/**
 * 文件预览白名单回归：导入/上传入口与预览推断必须认同同一批
 * 常见代码/配置文本与音视频容器，避免"能导入但显示无法预览"。
 */
import { describe, expect, it } from 'vitest';
import { inferFilePreviewTypeFromName } from '../../../types';
import { resolveFilePreviewMode } from '../filePreviewResolver';
import {
  AUDIO_PREVIEW_EXTENSIONS,
  VIDEO_PREVIEW_EXTENSIONS,
} from '../mediaPreviewUtils';

const TEXT_EXTENSIONS = [
  'log', 'conf', 'ini', 'env', 'toml', 'yaml', 'yml', 'jsonc', 'sql',
  'sh', 'bat', 'ps1', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h',
  'ts', 'tsx', 'js', 'jsx', 'css', 'scss', 'html', 'xml', 'csv', 'tsv',
];

const MEDIA_EXTENSIONS = {
  audio: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'opus', 'ogg'],
  video: ['mp4', 'webm', 'mkv', 'mov', 'ogv'],
};

describe('preview whitelists', () => {
  it('infers text for common code/config/log extensions', () => {
    for (const ext of TEXT_EXTENSIONS) {
      expect(inferFilePreviewTypeFromName(`sample.${ext}`), ext).toBe('text');
    }
  });

  it('recognizes the common audio containers', () => {
    for (const ext of MEDIA_EXTENSIONS.audio) {
      expect(AUDIO_PREVIEW_EXTENSIONS.has(ext), ext).toBe(true);
      expect(inferFilePreviewTypeFromName(`sample.${ext}`), ext).toBe('audio');
    }
  });

  it('recognizes the common video containers', () => {
    for (const ext of MEDIA_EXTENSIONS.video) {
      expect(VIDEO_PREVIEW_EXTENSIONS.has(ext), ext).toBe(true);
      expect(inferFilePreviewTypeFromName(`sample.${ext}`), ext).toBe('video');
    }
  });

  it('keeps text ahead of the MPEG-TS `ts` extension collision', () => {
    expect(inferFilePreviewTypeFromName('module.ts')).toBe('text');
    expect(inferFilePreviewTypeFromName('stream.m2ts')).toBe('video');
  });

  it('routes octet-stream uploads by extension for text and media', () => {
    expect(resolveFilePreviewMode('application/octet-stream', 'notes.log')).toBe('text');
    expect(resolveFilePreviewMode('application/octet-stream', 'script.ps1')).toBe('text');
    expect(resolveFilePreviewMode('application/octet-stream', 'clip.ogv')).toBe('video');
    expect(resolveFilePreviewMode('application/octet-stream', 'voice.opus')).toBe('audio');
  });
});
