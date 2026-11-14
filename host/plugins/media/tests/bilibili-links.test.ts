import { expect, it } from 'vitest';
import type { BiliLinkDescriptor, BiliSubtitleTrack } from '../api.ts';
import {
  DESCRIPTOR_KIND, DESCRIPTOR_VERSION, ERR_INVALID_LINK, ERR_UNSUPPORTED_LINK, MAX_FILE_STEM_CHARS,
  av, bv, descriptorFileName, descriptorToBytes, followShortLink, pageUrl, parseDescriptor,
  parseLink, pickTrack, resolveSubtitleUrl, type BiliTarget,
} from '../src/bilibili-links.ts';
import { BiliStreamClient } from '../src/bilibili-stream.ts';
import type { MediaError } from '../src/errors.ts';
import { startServer } from './helpers/http-fixture.ts';

function codeOf(error: unknown): string {
  return (error as MediaError).code;
}

it('parses_links_share_text_and_bare_ids', () => {
  const video = (input: string): BiliTarget => {
    const parsed = parseLink(input);
    if (parsed.kind !== 'video') throw new Error(`expected video for ${input}`);
    return parsed.target;
  };

  expect(video('https://www.bilibili.com/video/BV1GJ411x7h7/?p=3&share_source=copy_web'))
    .toEqual({ id: bv('BV1GJ411x7h7'), page: 3 });
  expect(video('【官方 MV】Never Gonna Give You Up https://m.bilibili.com/video/BV1GJ411x7h7').id)
    .toEqual(bv('BV1GJ411x7h7'));
  expect(video('bv1GJ411x7h7').id).toEqual(bv('BV1GJ411x7h7'));
  expect(video('https://www.bilibili.com/list/watchlater?bvid=BV1GJ411x7h7&oid=1').id)
    .toEqual(bv('BV1GJ411x7h7'));
  expect(video('https://www.bilibili.com/video/av170001?p=2'))
    .toEqual({ id: av(170001), page: 2 });
  expect(video('AV170001').id).toEqual(av(170001));
  expect(video('BV1GJ411x7h7?p=0').page).toBeNull();

  expect(parseLink('看这个 https://b23.tv/AbC123 ！')).toEqual({ kind: 'short', url: 'https://b23.tv/AbC123' });
  expect(parseLink('bili2233.cn/xyz9')).toEqual({ kind: 'short', url: 'https://bili2233.cn/xyz9' });

  for (const unsupported of [
    'https://www.bilibili.com/bangumi/play/ep12345',
    'https://www.bilibili.com/cheese/play/ss100',
    'https://live.bilibili.com/123',
  ]) {
    expect(codeOf(catchError(() => parseLink(unsupported))), unsupported).toBe(ERR_UNSUPPORTED_LINK);
  }
  for (const invalid of ['', '   ', 'https://www.example.com/video/123', 'java1234567890']) {
    expect(codeOf(catchError(() => parseLink(invalid))), invalid).toBe(ERR_INVALID_LINK);
  }
  // 比 BV 号长的字母数字串不算
  expect(codeOf(catchError(() => parseLink('xBV1GJ411x7h7')))).toBe(ERR_INVALID_LINK);
});

function catchError(run: () => unknown): unknown {
  try { run(); }
  catch (error) { return error; }
  throw new Error('expected an error');
}

function track(lan: string, ai: boolean): BiliSubtitleTrack {
  return { lan, lanDoc: lan, ai };
}

it('default_track_prefers_creator_chinese_then_ai_chinese', () => {
  const tracks = [track('en-US', false), track('ai-zh', true), track('zh-Hant', false), track('zh-CN', false)];
  expect(pickTrack(tracks)!.lan).toBe('zh-CN');
  expect(pickTrack(tracks.slice(0, 3))!.lan).toBe('zh-Hant');
  expect(pickTrack(tracks.slice(0, 2))!.lan).toBe('ai-zh');
  expect(pickTrack(tracks.slice(0, 1))!.lan).toBe('en-US');
  expect(pickTrack(tracks, 'en-US')!.lan).toBe('en-US');
  // 指定的轨不存在：退回默认
  expect(pickTrack(tracks, 'ja')!.lan).toBe('zh-CN');
  expect(pickTrack([])).toBeNull();
  const aiOnly = [track('ai-en', true), track('ai-zh', true)];
  expect(pickTrack(aiOnly)!.lan).toBe('ai-zh');
});

function descriptor(title: string, page: number, pageCount: number, part: string): BiliLinkDescriptor {
  return {
    kind: DESCRIPTOR_KIND,
    version: DESCRIPTOR_VERSION,
    bvid: 'BV1GJ411x7h7',
    aid: 80_433_022,
    cid: 137_649_199,
    page,
    pageCount,
    title,
    part,
    owner: 'UP',
    cover: 'http://i0.hdslb.com/bfs/archive/a.jpg',
    durationMs: 213_000,
    url: pageUrl('BV1GJ411x7h7', page),
  };
}

it('descriptor_file_name_and_validation', () => {
  expect(descriptorFileName(descriptor('线性代数 / 第1讲: 向量?', 1, 1, '')))
    .toBe('线性代数 第1讲 向量.bilibili');
  expect(descriptorFileName(descriptor('合集', 2, 16, '02 矩阵乘法')))
    .toBe('合集 P2 02 矩阵乘法.bilibili');
  expect(descriptorFileName(descriptor('合集', 3, 16, '合集'))).toBe('合集 P3.bilibili');
  expect(descriptorFileName(descriptor('  ...', 1, 1, ''))).toBe('BV1GJ411x7h7.bilibili');
  expect([...descriptorFileName(descriptor('长'.repeat(300), 1, 1, ''))].length)
    .toBe(MAX_FILE_STEM_CHARS + '.bilibili'.length);

  const original = descriptor('课', 1, 1, '');
  const parsed = parseDescriptor(descriptorToBytes(original));
  expect(parsed.cover).toBe('https://i0.hdslb.com/bfs/archive/a.jpg');
  expect(parsed.url).toBe('https://www.bilibili.com/video/BV1GJ411x7h7?p=1');

  const evil = { ...descriptor('课', 1, 1, ''), cover: 'https://evil.example.com/a.jpg' };
  expect(parseDescriptor(descriptorToBytes(evil)).cover).toBeNull();
  const bad = { ...descriptor('课', 1, 1, ''), bvid: 'BV1"><script>' };
  expect(() => parseDescriptor(descriptorToBytes(bad))).toThrow();
  expect(() => parseDescriptor(Buffer.from('{"kind":"other"}', 'utf8'))).toThrow();
});

it('subtitle_urls_must_stay_on_bilibili_hosts', () => {
  expect(resolveSubtitleUrl('//aisubtitle.hdslb.com/bfs/subtitle/a.json?auth_key=1', true).toString())
    .toBe('https://aisubtitle.hdslb.com/bfs/subtitle/a.json?auth_key=1');
  expect(resolveSubtitleUrl('http://i0.hdslb.com/bfs/subtitle/b.json', true).protocol).toBe('https:');
  for (const bad of [
    'https://evil.example.com/a.json',
    'https://hdslb.com.evil.example/a.json',
    'file:///etc/passwd',
    '',
  ]) {
    expect(() => resolveSubtitleUrl(bad, true), bad).toThrow();
  }
});

it('short_links_follow_one_redirect', async () => {
  const server = await startServer((request, response) => {
    if (request.url === '/AbC123') {
      response.writeHead(302, {
        location: 'https://www.bilibili.com/video/BV1GJ411x7h7?p=2&share_medium=android',
      });
      response.end();
      return;
    }
    response.writeHead(404);
    response.end();
  });
  try {
    const client = new BiliStreamClient(server.url);
    const location = await followShortLink(client, `${server.url}/AbC123`);
    expect(location).toContain('BV1GJ411x7h7');
    const parsed = parseLink(location);
    expect(parsed.kind).toBe('video');
    if (parsed.kind !== 'video') return;
    expect(parsed.target.page).toBe(2);

    let failure: unknown = null;
    try { await followShortLink(client, `${server.url}/dead`); }
    catch (error) { failure = error; }
    expect(codeOf(failure)).toBe(ERR_INVALID_LINK);
  } finally { await server.close(); }
});

it('relative_multihop_short_links_and_loops_are_bounded', async () => {
  const server = await startServer((request, response) => {
    if (request.url === '/one') {
      response.writeHead(302, { location: '/two' });
      response.end();
      return;
    }
    if (request.url === '/two') {
      response.writeHead(302, {
        location: 'https://www.bilibili.com/video/BV1GJ411x7h7?p=3',
      });
      response.end();
      return;
    }
    response.writeHead(302, { location: '/loop' });
    response.end();
  });
  try {
    const client = new BiliStreamClient(server.url);
    const location = await followShortLink(client, `${server.url}/one`);
    expect(location.endsWith('?p=3')).toBe(true);
    let failure: unknown = null;
    try { await followShortLink(client, `${server.url}/loop`); }
    catch (error) { failure = error; }
    expect(codeOf(failure)).toBe(ERR_INVALID_LINK);
  } finally { await server.close(); }
});
