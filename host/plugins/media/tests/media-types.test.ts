import { expect, it } from 'vitest';
import { MediaError } from '../src/errors.ts';
import { deriveStatus, isLinkItem, mediaKind } from '../src/media-types.ts';

it('media_kind_by_mime_and_extension', () => {
  expect(mediaKind('audio/mpeg', 'x')).toBe('Audio');
  expect(mediaKind('video/mp4', 'x')).toBe('Video');
  expect(mediaKind('application/octet-stream', 'lecture.MKV')).toBe('Video');
  expect(mediaKind('', 'talk.m4a')).toBe('Audio');
  expect(mediaKind('application/pdf', 'a.pdf')).toBeNull();
});

it('bilibili_link_items_are_video_without_local_media', () => {
  expect(isLinkItem('video/x-bilibili', '课.bilibili')).toBe(true);
  expect(isLinkItem('application/octet-stream', '课.BILIBILI')).toBe(true);
  expect(isLinkItem('video/mp4', '课.mp4')).toBe(false);
  expect(mediaKind('application/octet-stream', '课.bilibili')).toBe('Video');
  expect(new MediaError('LinkOnly', 'x').code).toBe('media-link-only');
});

it('error_payload_has_stable_code', () => {
  const e = new MediaError('Unsupported', 'x');
  expect(JSON.parse(e.toPayloadString())).toEqual({ code: 'media-unsupported', message: 'x' });
  const fatal = new MediaError('AsrFatal', 'bad key', 'auth-failed');
  expect(fatal.code).toBe('auth-failed');
});

it('status_derivation', () => {
  const counts = (total: number, done: number, failed: number) => ({
    total, done, failed, pending: total - done - failed,
  });
  expect(deriveStatus(true, 'queued', counts(0, 0, 0))).toBe('queued');
  expect(deriveStatus(true, 'asr', counts(5, 2, 0))).toBe('running');
  expect(deriveStatus(false, null, counts(0, 0, 0))).toBe('none');
  expect(deriveStatus(false, 'error', counts(0, 0, 0))).toBe('error');
  expect(deriveStatus(false, 'completed', counts(5, 5, 0))).toBe('completed');
  expect(deriveStatus(false, 'cancelled', counts(5, 2, 0))).toBe('cancelled');
  expect(deriveStatus(false, 'completed_with_issues', counts(5, 4, 1))).toBe('partial');
  // 崩溃遗留的中间态（尚未被启动恢复接管）按已有段判断
  expect(deriveStatus(false, 'asr', counts(5, 2, 0))).toBe('partial');
});
