import { describe, expect, it } from 'vitest';
import {
  computePermilleCropRegionsForQuestions, formatSourceImageMarkdown, formatSourceImageUri,
  parseSourceImageUri, type PageTextItem, type PermilleCropRegion,
} from '../src/source-image-ref.ts';
import {
  classifyBilibiliResolveError, extractBilibiliTargetFromShareText, parseLink,
} from '../src/bilibili-links.ts';
import { BiliRequestError, selectProgressiveCompatibleVideoTrack } from '../src/bilibili-policy.ts';
import { MediaError } from '../src/errors.ts';

describe('stable source-image protocol', () => {
  it('round-trips encoded identifiers and optional version digests without image bytes', () => {
    const ref = { resourceId: '高等数学 (上)', imageId: '插图 1.png', versionDigest: 'a1b2' };
    const uri = formatSourceImageUri(ref);
    expect(uri).toBe('#source-image/%E9%AB%98%E7%AD%89%E6%95%B0%E5%AD%A6%20%28%E4%B8%8A%29/%E6%8F%92%E5%9B%BE%201.png?v=a1b2');
    expect(parseSourceImageUri(uri)).toEqual(ref);
    expect(parseSourceImageUri('#source-image/course/image-1')).toEqual({ resourceId: 'course', imageId: 'image-1' });
    expect(formatSourceImageMarkdown('原图[1]\n说明', ref)).toBe(`![原图\\[1\\] 说明](${uri})`);
    expect(formatSourceImageMarkdown('预览', ref, true)).toBe(`[预览](${uri})`);
  });

  it('round-trips PDF crop coordinates including exact page edges', () => {
    const ref = { resourceId: '卷一', page: 2, x: 0, y: 100, width: 1000, height: 900 };
    expect(parseSourceImageUri(formatSourceImageUri(ref))).toEqual(ref);
    expect(formatSourceImageUri(ref)).toContain('/page-2-region-0-100-1000-900');
  });

  it.each([
    '#source-image/id/page-0-region-0-0-1000-1000',
    '#source-image/id/page-1-region-900-0-101-100',
    '#source-image/id/page-1-region-0-999-10-2',
    '#source-image/id/page-1-region-0-0-0-10',
    '#source-image/id/page-1-region-0-0-10-0',
    '#source-image/id/page-1-region--1-0-10-10',
    '#source-image/id/page-1-region-0.5-0-10-10',
    '#source-image/id/page-1-region-0-0-1001-100',
    '#source-image/id/page-9007199254740992-region-0-0-1-1',
    '#source-image/../image-1', '#source-image/id/%2e%2e',
    '#source-image/id/..%2Fsecret', '#source-image/id/%5csecret',
    '#source-image/id/%00', '#source-image/id/%E0%A4%A',
    '#source-image/javascript%3Aalert(1)/image-1',
    '#source-image/id/data%3Aimage%2Fsvg%2Bxml',
    '#source-image/id/blob%3Aimage',
    'javascript:alert(1)', 'data:image/svg+xml,<svg/>', 'blob:https://local/1',
    '#source-image/id/image-1/extra', '#source-image/id/image-1?v=x&file=secret',
    '#source-image/id/image-1?unknown=x',
  ])('rejects invalid or forged reference %s', uri => {
    expect(parseSourceImageUri(uri)).toBeNull();
  });

  it('formatter enforces the same region and identifier boundary', () => {
    expect(() => formatSourceImageUri({ resourceId: '../secret', imageId: 'a' })).toThrow();
    expect(() => formatSourceImageUri({ resourceId: 'id', page: 1, x: 990, y: 0, width: 20, height: 10 })).toThrow(RangeError);
    expect(() => formatSourceImageUri({ resourceId: 'id', imageId: 'page-0-region-0-0-1-1' })).toThrow();
  });
});

function box(text: string, x: number, y: number, page = 1, width = 200): PageTextItem {
  return { text, x, y, page, width, height: 20 };
}
const fullPage = (page: number): PermilleCropRegion => ({ page, x: 0, y: 0, width: 1000, height: 1000 });

describe('question regions in rotated-page permille coordinates', () => {
  it('splits single-column dot, bracket and Chinese question markers', () => {
    const regions = computePermilleCropRegionsForQuestions([
      box('1. 求导', 50, 100, 3), box('（2）证明', 50, 400, 3), box('第3题 计算', 50, 700, 3),
    ], 1000, 1000);
    expect(regions).toEqual([
      { page: 3, x: 25, y: 94, width: 960, height: 300 },
      { page: 3, x: 25, y: 394, width: 960, height: 300 },
      { page: 3, x: 25, y: 694, width: 960, height: 291 },
    ]);
  });

  it('handles fragmented PDF text and reads two columns in column order', () => {
    const regions = computePermilleCropRegionsForQuestions([
      box('1.', 50, 100, 1, 20), box('题干', 75, 100), box('2. 第二题', 50, 500),
      box('3. 第三题', 550, 100), box('(4) 第四题', 550, 500),
    ], 1000, 1000);
    expect(regions).toHaveLength(4);
    expect(regions.map(r => [r.x, r.y, r.width])).toEqual([
      [25, 94, 500], [25, 494, 500], [525, 94, 460], [525, 494, 460],
    ]);
    for (const region of regions) {
      expect(parseSourceImageUri(formatSourceImageUri({ resourceId: 'paper', ...region })))
        .toEqual({ resourceId: 'paper', ...region });
    }
  });

  it('falls back for scans, missing numbers, decimals and ambiguous layouts', () => {
    expect(computePermilleCropRegionsForQuestions([], 1000, 1000)).toEqual([fullPage(1)]);
    expect(computePermilleCropRegionsForQuestions([box('', 0, 0, 4)], 1000, 1000)).toEqual([fullPage(4)]);
    for (const items of [
      [box('无题号的讲义', 50, 100)], [box('1.234 是小数', 50, 100)],
      [box('1. 题目', 50, 100), box('2. 题目', 350, 300), box('3. 题目', 700, 500)],
      [box('1. 跨栏题干', 50, 100, 1, 850), box('2. 右栏', 550, 300)],
    ]) expect(computePermilleCropRegionsForQuestions(items, 1000, 1000)).toEqual([fullPage(1)]);
    expect(() => computePermilleCropRegionsForQuestions([], 0, 1000)).toThrow(RangeError);
  });
});

describe('mobile Bilibili shares', () => {
  it.each([
    '【高等数学】 https://b23.tv/abc123?p=3 快来看',
    '“【高等数学】（https://b23.tv/abc123?p=3）”',
    '(https://b23.tv/abc123?p=3).',
  ])('extracts short links and retains part selection: %s', input => {
    expect(extractBilibiliTargetFromShareText(input)).toEqual({ kind: 'short', url: 'https://b23.tv/abc123?p=3' });
    expect(parseLink(input)).toEqual({ kind: 'short', url: 'https://b23.tv/abc123?p=3' });
  });
  it('prefers the actual shared URL over identifiers and queries in the caption', () => {
    expect(extractBilibiliTargetFromShareText('标题 BV1GJ411x7h7?p=9 “https://m.bilibili.com/video/BV1xx411c7mD?p=2”'))
      .toEqual({ kind: 'video', target: { id: { kind: 'bv', value: 'BV1xx411c7mD' }, page: 2 } });
    expect(extractBilibiliTargetFromShareText('https://b23.tv/ab_c-12')).toEqual({ kind: 'short', url: 'https://b23.tv/ab_c-12' });
    expect(extractBilibiliTargetFromShareText('BV1GJ411x7h7')).toMatchObject({ kind: 'video' });
    expect(extractBilibiliTargetFromShareText('没有视频')).toBeNull();
  });
});

describe('actionable Bilibili failures', () => {
  it.each([
    [{ apiCode: -101 }, 'login-expired', false], [{ apiCode: -111 }, 'login-expired', false],
    [new Error('需要大会员'), 'vip-required', false],
    [new Error('分P不存在或超出范围'), 'page-out-of-range', false],
    [{ apiCode: -352 }, 'rate-limited', true], [{ status: 429 }, 'rate-limited', true],
    [new BiliRequestError('timeout', '请求超时'), 'network-timeout', true],
    [new TypeError('Failed to fetch'), 'network-timeout', true],
    [Object.assign(new Error('request'), { name: 'TimeoutError' }), 'network-timeout', true],
    [new MediaError('Bilibili', '暂不支持', 'bilibili-unsupported-link'), 'unsupported-format', false],
    [null, 'unknown', true],
  ])('classifies %j as %s', (error, kind, retryable) => {
    expect(classifyBilibiliResolveError(error)).toMatchObject({ kind, retryable });
    expect(classifyBilibiliResolveError(error).message.length).toBeGreaterThan(5);
  });
  it('handles transport payload codes without leaking upstream details', () => {
    const result = classifyBilibiliResolveError({ transport: { businessCode: -412, message: 'secret cookie' } });
    expect(result.kind).toBe('rate-limited');
    expect(result.message).not.toContain('secret');
  });
});

describe('progressive playback track selection', () => {
  it('chooses the best AVC/AAC instead of higher-resolution HEVC or AV1', () => {
    const tracks = [
      { codec: 'hev1', quality: 120, width: 3840, height: 2160 },
      { codec: 'av01', quality: 127, width: 7680, height: 4320 },
      { codec: 'avc1.640028', quality: 80, height: 1080, audioCodec: 'mp4a.40.2' },
      { codecId: 7, quality: 64, height: 720, audioCodec: 'AAC' },
    ];
    expect(selectProgressiveCompatibleVideoTrack(tracks)).toBe(tracks[2]);
    expect(tracks[0]!.codec).toBe('hev1');
  });
  it('recognizes raw API codec fields and breaks quality ties using resolution/bandwidth', () => {
    const tracks = [
      { codecid: 7, id: 80, width: 1920, height: 1080, bandwidth: 1000 },
      { codecs: 'avc1.640028', id: 80, width: 1920, height: 1080, bandwidth: 2000 },
    ];
    expect(selectProgressiveCompatibleVideoTrack(tracks)).toBe(tracks[1]);
    expect(selectProgressiveCompatibleVideoTrack([{ codec: 'avc1', height: 720 }, { codec: 'avc1', height: 1080 }]))
      .toMatchObject({ height: 1080 });
  });
  it('prefers muxed AAC and only falls back to other video codecs when AVC is absent', () => {
    const tracks = [
      { codec: 'avc1', quality: 120, audioCodec: 'opus' },
      { codec: 'avc1', quality: 80, audioCodec: 'AAC' },
    ];
    expect(selectProgressiveCompatibleVideoTrack(tracks)).toBe(tracks[1]);
    expect(selectProgressiveCompatibleVideoTrack([{ codec: 'hev1', quality: 80 }, { codec: 'av01', quality: 120 }]))
      .toMatchObject({ codec: 'av01' });
    expect(selectProgressiveCompatibleVideoTrack([])).toBeNull();
  });
});
