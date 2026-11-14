import { expect, it } from 'vitest';
import {
  DEFAULT_QN, PLAY_SOURCE_TTL_SECONDS, STREAM_CHUNK_BYTES, attemptCacheKey, cacheKey, cachedSource,
  forgetSource, isCdnUrl, mp4QualityOptions, normalizeQn, parsePlayInfo, parsePlayUrlData,
  parseStreamPath, parseStreamQuery, pickPlayUrl, queryU32, rememberSource, sourceTtlSeconds,
  localRequest, rangeBounds, upstreamRange, biliStreamUrl,
  BiliStreamClient, PROTOCOL_TIMEOUT_MS, fetchCandidates, fetchRange, parseContentRange,
  resolvePlayInfo,
} from '../src/bilibili-stream.ts';
import { startServer } from './helpers/http-fixture.ts';

it('retains_backups_and_expires_signed_sources', () => {
  const data = parsePlayUrlData(JSON.parse(
    '{"durl":[{"url":"https://a.bilivideo.com/v","backup_url":["http://b.bilivideo.com/v","https://a.bilivideo.com/v"]}]}'));
  const info = parsePlayInfo(data, 64);
  expect(info.backup_urls).toEqual(['https://b.bilivideo.com/v']);
  expect(sourceTtlSeconds('https://a.bilivideo.com/v?deadline=1')).toBe(0);
});

it('stream_url_uses_the_platform_specific_custom_protocol_form', () => {
  expect(biliStreamUrl('linux', 'file_a', 80, 0, 0))
    .toBe('bilistream://localhost/file_a?qn=80&e=0&a=0');
  expect(biliStreamUrl('darwin', 'file_a', 64, 2, 3))
    .toBe('bilistream://localhost/file_a?qn=64&e=2&a=3');
  expect(biliStreamUrl('win32', 'file_a', 80, 0, 1))
    .toBe('http://bilistream.localhost/file_a?qn=80&e=0&a=1');
});

it('stream_path_accepts_vfs_file_ids_only', () => {  expect(parseStreamPath('/file_AbC-12_x')).toBe('file_AbC-12_x');
  expect(parseStreamPath('/file_a%5Fb')).toBe('file_a_b');
  expect(parseStreamPath('/att_x/anything')).toBe('att_x');
  expect(parseStreamPath('/../etc/passwd')).toBeNull();
  expect(parseStreamPath('/https%3A%2F%2Fevil.com')).toBeNull();
  expect(parseStreamPath('/res_abc')).toBeNull();
  expect(parseStreamPath('/')).toBeNull();
});

it('upstream_range_is_clamped_to_one_chunk', () => {
  const chunk = STREAM_CHUNK_BYTES;
  expect(upstreamRange(null)).toEqual([0, chunk - 1]);
  expect(upstreamRange('bytes=0-')).toEqual([0, chunk - 1]);
  expect(upstreamRange('bytes=100-199')).toEqual([100, 199]);
  expect(upstreamRange('bytes=10-999999999')).toEqual([10, 10 + chunk - 1]);
  expect(upstreamRange('bytes=-500')).toBeNull();
  expect(upstreamRange('bytes=0-1,5-6')).toBeNull();
  expect(upstreamRange('bytes=9-3')).toBeNull();
  expect(upstreamRange('items=0-1')).toBeNull();
});

it('only_https_bilibili_cdn_urls_are_proxied', () => {
  expect(isCdnUrl('https://cn-bj-cc-03-01.bilivideo.com/upgcxcode/1.mp4?e=1')).toBe(true);
  expect(isCdnUrl('https://xy1x2x3x4xy.mcdn.bilivideo.cn:4483/v.mp4')).toBe(true);
  expect(isCdnUrl('https://upos-hz-mirrorakam.akamaized.net/a.mp4')).toBe(true);
  expect(isCdnUrl('http://cn-bj-cc-03-01.bilivideo.com/a.mp4')).toBe(false);
  expect(isCdnUrl('https://evil.com/bilivideo.com.mp4')).toBe(false);
  expect(isCdnUrl('https://bilivideo.com.evil.com/a.mp4')).toBe(false);
  expect(isCdnUrl('not a url')).toBe(false);
});

it('picks_single_mp4_and_falls_back_to_backup_url', () => {
  const data = parsePlayUrlData(JSON.parse(
    '{"durl":[{"url":"https://evil.example.com/a.mp4","backup_url":["http://cn-x.bilivideo.com/b.mp4"]}]}'));
  expect(pickPlayUrl(data)).toBe('https://cn-x.bilivideo.com/b.mp4');

  const multi = parsePlayUrlData(JSON.parse(
    '{"durl":[{"url":"https://a.bilivideo.com/1"},{"url":"https://a.bilivideo.com/2"}]}'));
  expect(() => pickPlayUrl(multi)).toThrow();
  const none = parsePlayUrlData(JSON.parse('{"durl":[]}'));
  expect(() => pickPlayUrl(none)).toThrow();
});

it('stream_qn_comes_from_query_and_falls_back_to_default', () => {
  expect(parseStreamQuery(null)).toEqual([DEFAULT_QN, 0]);
  expect(parseStreamQuery('')).toEqual([DEFAULT_QN, 0]);
  expect(parseStreamQuery('qn=64')).toEqual([64, 0]);
  expect(parseStreamQuery('t=1&qn=16&e=3')).toEqual([16, 3]);
  expect(parseStreamQuery('qn=112')[0]).toBe(DEFAULT_QN);
  expect(parseStreamQuery('qn=120')[0]).toBe(DEFAULT_QN);
  expect(parseStreamQuery('qn=abc&e=x')).toEqual([DEFAULT_QN, 0]);
  expect(parseStreamQuery('xqn=64')[0]).toBe(DEFAULT_QN);
  expect(normalizeQn(32)).toBe(32);
  expect(normalizeQn(116)).toBe(DEFAULT_QN);
  expect(normalizeQn(null)).toBe(DEFAULT_QN);
});

it('cache_key_separates_qualities', () => {
  expect(cacheKey('file_a', 80, 0)).not.toBe(cacheKey('file_a', 64, 0));
  expect(cacheKey('file_a', 64, 0)).not.toBe(cacheKey('file_b', 64, 0));
  expect(cacheKey('file_a', 80, 0)).not.toBe(cacheKey('file_a', 80, 1));
  expect(attemptCacheKey('file_a', 80, 0, 1)).not.toBe(cacheKey('file_a', 80, 0));
  const info = {
    url: 'https://a.bilivideo.com/720.mp4',
    backup_urls: [],
    size: null,
    quality: 64,
    options: [],
  };
  rememberSource(cacheKey('file_cache_test', 64, 0), info);
  expect(cachedSource(cacheKey('file_cache_test', 64, 0))).toEqual(info);
  expect(cachedSource(cacheKey('file_cache_test', 80, 0))).toBeNull();
  forgetSource(cacheKey('file_cache_test', 64, 0));
  expect(cachedSource(cacheKey('file_cache_test', 64, 0))).toBeNull();
});

it('quality_options_keep_only_mp4_levels_from_accept_quality', () => {
  const data = parsePlayUrlData(JSON.parse(
    '{"quality":80,"accept_quality":[120,116,112,80,74,64,32,16],'
    + '"accept_description":["超清 4K","高清 1080P60","高清 1080P+","高清 1080P","高清 720P60","高清 720P","清晰 480P","流畅 360P"],'
    + '"durl":[{"url":"https://a.bilivideo.com/1080.mp4"}]}'));
  const info = parsePlayInfo(data, 80);
  expect(info.quality).toBe(80);
  expect(info.options).toEqual([
    { qn: 80, label: '高清 1080P' },
    { qn: 64, label: '高清 720P' },
    { qn: 32, label: '清晰 480P' },
    { qn: 16, label: '流畅 360P' },
  ]);

  const guest = parsePlayUrlData(JSON.parse(
    '{"quality":64,"format":"mp4720","accept_quality":[64,16],"accept_description":["高清 720P","流畅 360P"],'
    + '"durl":[{"url":"https://a.bilivideo.com/720.mp4"}]}'));
  expect(mp4QualityOptions(guest).map(option => option.qn)).toEqual([64, 16]);

  const sparse = parsePlayUrlData(JSON.parse(
    '{"quality":32,"accept_quality":[64,16],"accept_description":["高清 720P"],"durl":[]}'));
  expect(mp4QualityOptions(sparse)).toEqual([
    { qn: 64, label: '高清 720P' },
    { qn: 32, label: '480P' },
    { qn: 16, label: '360P' },
  ]);
});

it('query_and_ttl_helpers_follow_rust_semantics', () => {
  expect(queryU32('qn=64&qn=32', 'qn')).toBe(64);
  expect(queryU32('e=3', 'qn')).toBeNull();
  expect(sourceTtlSeconds('https://a.bilivideo.com/v', 1000)).toBe(PLAY_SOURCE_TTL_SECONDS);
  expect(sourceTtlSeconds('https://a.bilivideo.com/v?deadline=2000', 1000)).toBe(970);
  expect(sourceTtlSeconds('https://a.bilivideo.com/v?deadline=5000', 1000)).toBe(PLAY_SOURCE_TTL_SECONDS);
});

it('http_ranges_cover_the_requested_extent_instead_of_one_cdn_chunk', () => {
  expect(rangeBounds(null, 10_000_000)).toEqual([0, 9_999_999]);
  expect(rangeBounds('bytes=0-', 10_000_000)).toEqual([0, 9_999_999]);
  expect(rangeBounds('bytes=100-8000000', 10_000_000)).toEqual([100, 8_000_000]);
  expect(rangeBounds('bytes=-100', 10_000_000)).toEqual([9_999_900, 9_999_999]);
  expect(rangeBounds('bytes=0-1445', 10_000_000)).toEqual([0, 1445]);
  for (const value of ['bytes=10-1', 'bytes=-0', 'bytes=10000000-', 'bytes=0-1,4-5']) {
    expect(rangeBounds(value, 10_000_000), value).toBeNull();
  }
});

it('loopback_rejects_foreign_hosts_and_web_origins', () => {
  const request = (host: string, origin: string) => ({ host, origin });
  expect(localRequest(request('127.0.0.1:42', 'tauri://localhost'), 42)).toBe(true);
  expect(localRequest(request('localhost:42', 'tauri://localhost'), 42)).toBe(false);
  expect(localRequest(request('127.0.0.1:43', 'tauri://localhost'), 42)).toBe(false);
  expect(localRequest(request('127.0.0.1:42', 'https://evil.test'), 42)).toBe(false);
});

function descriptor(): { bvid: string; cid: number } {
  return { bvid: 'BV1Ss4y1W7KB', cid: 995381097 };
}

it('failed_primary_uses_backup_and_validates_the_range', async () => {
  const server = await startServer((request, response) => {
    if (request.url === '/primary') {
      response.writeHead(503);
      response.end();
      return;
    }
    response.writeHead(206, {
      'content-range': 'bytes 4-7/16', 'content-type': 'video/mp4',
    });
    response.end('abcd');
  });
  try {
    const info = {
      url: `${server.url}/primary`,
      backup_urls: [`${server.url}/backup`],
      size: 16,
      quality: 64,
      options: [],
    };
    const [upstream, selected] = await fetchCandidates(
      new BiliStreamClient(server.url), info, 4, 7);
    expect(selected).toBe(info.backup_urls[0]);
    expect(upstream.kind).toBe('ok');
    if (upstream.kind !== 'ok') return;
    expect(Buffer.from(upstream.body).toString('utf8')).toBe('abcd');
    expect(server.requests.map(request => request.url)).toEqual(['/primary', '/backup']);
    expect(server.requests[1]!.headers.range).toBe('bytes=4-7');
  } finally { await server.close(); }
});

it('rejects_ignored_range_invalid_range_and_short_reads', async () => {
  const server = await startServer((request, response) => {
    if (request.url === '/whole') {
      // 200 + 超长 Content-Length：绝不为模拟 Range 而整体缓冲
      response.writeHead(200, { 'content-length': '100000000' });
      response.write('large video');
      response.destroy();
      return;
    }
    if (request.url === '/wrong') {
      response.writeHead(206, { 'content-range': 'bytes 1-4/16' });
      response.end('abcd');
      return;
    }
    response.writeHead(206, { 'content-range': 'bytes 0-3/16' });
    response.end('ab');
  });
  try {
    const client = new BiliStreamClient(server.url);
    for (const path of ['whole', 'wrong', 'short']) {
      const result = await fetchRange(client, `${server.url}/${path}`, 0, 3, null,
        Date.now() + PROTOCOL_TIMEOUT_MS);
      expect(result.kind, path).toBe('failed');
    }
    expect(parseContentRange('bytes 5-3/8')).toBeNull();
    expect(parseContentRange('bytes 0-8/8')).toBeNull();
  } finally { await server.close(); }
});

it('cdn_timeout_is_bounded_and_eof_is_preserved', async () => {
  const server = await startServer((request, response) => {
    if (request.url === '/slow') {
      setTimeout(() => {
        response.writeHead(206, { 'content-range': 'bytes 0-3/16' });
        response.end('abcd');
      }, 100);
      return;
    }
    response.writeHead(416, { 'content-range': 'bytes */16' });
    response.end();
  });
  try {
    const client = new BiliStreamClient(server.url);
    const slow = await fetchRange(client, `${server.url}/slow`, 0, 3, null, Date.now() + 20);
    expect(slow.kind).toBe('failed');
    const eof = await fetchRange(client, `${server.url}/eof`, 16, 19, null,
      Date.now() + PROTOCOL_TIMEOUT_MS);
    expect(eof).toEqual({ kind: 'unsatisfiable', range: 'bytes */16' });
    expect(PROTOCOL_TIMEOUT_MS).toBeLessThan(30_000);
  } finally { await server.close(); }
});

it('resolves_play_url_through_the_api_with_cookie', async () => {
  const server = await startServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      code: 0,
      message: '0',
      data: {
        format: 'mp4',
        durl: [{ url: 'https://cn-bj.bilivideo.com/v.mp4?e=1', size: 10 }],
      },
    }));
  });
  try {
    const client = new BiliStreamClient(server.url, { cookie: 'SESSDATA=s' });
    const info = await resolvePlayInfo(client, descriptor(), DEFAULT_QN);
    expect(info.url).toBe('https://cn-bj.bilivideo.com/v.mp4?e=1');
    // 老响应没有清晰度字段：按请求的 qn 记
    expect(info.quality).toBe(DEFAULT_QN);
    const request = server.requests[0]!;
    expect(request.headers.cookie).toBe('SESSDATA=s');
    const query = new URL(request.url, server.url).searchParams;
    expect(query.get('bvid')).toBe('BV1Ss4y1W7KB');
    expect(query.get('cid')).toBe('995381097');
    expect(query.get('platform')).toBe('html5');
  } finally { await server.close(); }
});

it('requests_selected_qn_and_reports_downgraded_quality', async () => {
  const server = await startServer((request, response) => {
    const qn = new URL(request.url, 'http://127.0.0.1').searchParams.get('qn');
    response.writeHead(200, { 'content-type': 'application/json' });
    if (qn === '16') {
      response.end(JSON.stringify({
        code: 0, message: '0',
        data: {
          quality: 16, format: 'mp4', accept_quality: [64, 16],
          accept_description: ['高清 720P', '流畅 360P'],
          durl: [{ url: 'https://cn-bj.bilivideo.com/360.mp4?e=1' }],
        },
      }));
      return;
    }
    response.end(JSON.stringify({
      code: 0, message: '0',
      data: {
        quality: 64, format: 'mp4720', accept_quality: [64, 16],
        accept_description: ['高清 720P', '流畅 360P'],
        durl: [{ url: 'https://cn-bj.bilivideo.com/720.mp4?e=1' }],
      },
    }));
  });
  try {
    const client = new BiliStreamClient(server.url);
    const high = await resolvePlayInfo(client, descriptor(), 80);
    expect(high.quality).toBe(64);
    expect(high.url).toBe('https://cn-bj.bilivideo.com/720.mp4?e=1');
    expect(high.options.map(option => option.qn)).toEqual([64, 16]);
    const low = await resolvePlayInfo(client, descriptor(), 16);
    expect(low.quality).toBe(16);
    expect(low.url).toBe('https://cn-bj.bilivideo.com/360.mp4?e=1');
  } finally { await server.close(); }
});

it('downgraded_advertised_quality_checks_standard_mp4_on_the_same_account', async () => {
  const server = await startServer((request, response) => {
    const query = new URL(request.url, 'http://127.0.0.1').searchParams;
    response.writeHead(200, { 'content-type': 'application/json' });
    if (query.get('platform') === 'html5') {
      response.end(JSON.stringify({
        code: 0,
        data: {
          quality: 64, format: 'mp4720', accept_quality: [80, 64, 16],
          durl: [{ url: 'https://a.bilivideo.com/720.mp4' }],
        },
      }));
      return;
    }
    response.end(JSON.stringify({
      code: 0,
      data: {
        quality: 80, format: 'mp4', accept_quality: [80, 64, 16],
        durl: [{ url: 'https://a.bilivideo.com/1080.mp4' }],
      },
    }));
  });
  try {
    const client = new BiliStreamClient(server.url, { cookie: 'SESSDATA=s' });
    const info = await resolvePlayInfo(client, descriptor(), 80);
    expect(info.quality).toBe(80);
    expect(info.url).toBe('https://a.bilivideo.com/1080.mp4');
    expect(server.requests).toHaveLength(2);
    expect(server.requests[0]!.headers.cookie).toBe('SESSDATA=s');
    expect(server.requests[1]!.headers.cookie).toBe('SESSDATA=s');
    expect(server.requests[1]!.url).toBe(
      '/x/player/playurl?bvid=BV1Ss4y1W7KB&cid=995381097&qn=80&fnval=1&fnver=0&fourk=0&high_quality=1');
  } finally { await server.close(); }
});

it('standard_mp4_does_not_replace_a_playable_source_with_flv_or_a_lower_quality', async () => {
  for (const [format, current] of [['flv720', 80], ['mp4', 16]] as const) {
    const server = await startServer((request, response) => {
      const query = new URL(request.url, 'http://127.0.0.1').searchParams;
      response.writeHead(200, { 'content-type': 'application/json' });
      if (query.get('platform') === 'html5') {
        response.end(JSON.stringify({
          code: 0,
          data: {
            quality: 64, format: 'mp4720', accept_quality: [80, 64, 16],
            durl: [{ url: 'https://a.bilivideo.com/720.mp4' }],
          },
        }));
        return;
      }
      response.end(JSON.stringify({
        code: 0,
        data: {
          quality: current, format, accept_quality: [80, 64, 16],
          durl: [{ url: 'https://a.bilivideo.com/other' }],
        },
      }));
    });
    try {
      const client = new BiliStreamClient(server.url);
      const info = await resolvePlayInfo(client, descriptor(), 80);
      expect(info.quality, format).toBe(64);
      expect(info.url, format).toBe('https://a.bilivideo.com/720.mp4');
      expect(server.requests, format).toHaveLength(2);
    } finally { await server.close(); }
  }
});

function streamedResponse(body: ReadableStream<Uint8Array> | null, headerList: Record<string, string> = {}): Response {
  return {
    status: 200,
    headers: new Headers(headerList),
    body,
    arrayBuffer: async () => { throw new Error('the response body must not be buffered'); },
  } as unknown as Response;
}

it('refuses an oversized declared body without touching the stream', async () => {
  let pulls = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { pulls += 1; controller.enqueue(new Uint8Array(8)); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const client = new BiliStreamClient('https://api.bilibili.com', {
    fetchImpl: async () => streamedResponse(stream, { 'content-length': '4096' }),
  });
  await expect(client.execute({
    url: 'https://a.bilivideo.com/v.mp4', headers: {}, deadlineMs: Date.now() + 5_000, maxBytes: 1024,
  })).rejects.toMatchObject({ code: 'bilibili-response-too-large' });
  expect(pulls).toBe(0);
  expect(cancelled).toBe(true);
});

it('cancels a chunked oversized body as soon as the limit is crossed', async () => {
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (pulls > 3) { controller.close(); return; }
      controller.enqueue(new Uint8Array(16).fill(pulls));
    },
  }, { highWaterMark: 0 });
  const client = new BiliStreamClient('https://api.bilibili.com', {
    fetchImpl: async () => streamedResponse(stream),
  });
  await expect(client.execute({
    url: 'https://a.bilivideo.com/v.mp4', headers: {}, deadlineMs: Date.now() + 5_000, maxBytes: 24,
  })).rejects.toMatchObject({ code: 'bilibili-response-too-large' });
  // 16B + 16B > 24B：第二块后立即取消，第三块不会被读取。
  expect(pulls).toBe(2);
});

it('falls back to arrayBuffer only when the response exposes no stream', async () => {
  const client = new BiliStreamClient('https://api.bilibili.com', {
    fetchImpl: async () => new Response(new Uint8Array(8).fill(3), { status: 200 }),
  });
  // `new Response(bytes)` 有 body 流，这里直接构造没有 body 的响应验证回退分支。
  const noStream = new BiliStreamClient('https://api.bilibili.com', {
    fetchImpl: async () => ({ status: 200, headers: new Headers(), body: null, arrayBuffer: async () => new Uint8Array(8).fill(3) } as unknown as Response),
  });
  await expect(noStream.execute({
    url: 'https://a.bilivideo.com/s.json', headers: {}, deadlineMs: Date.now() + 5_000, maxBytes: 4,
  })).rejects.toMatchObject({ code: 'bilibili-response-too-large' });
  const ok = await client.execute({
    url: 'https://a.bilivideo.com/s.json', headers: {}, deadlineMs: Date.now() + 5_000, maxBytes: 8,
  });
  expect(ok.body.byteLength).toBe(8);
});

it('still returns a body that fits the limit exactly', async () => {
  const client = new BiliStreamClient('https://api.bilibili.com', {
    fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(16).fill(7)); controller.enqueue(new Uint8Array(8).fill(9)); controller.close(); },
    }), { status: 200 }),
  });
  const response = await client.execute({
    url: 'https://a.bilivideo.com/v.mp4', headers: {}, deadlineMs: Date.now() + 5_000, maxBytes: 24,
  });
  expect(response.body.byteLength).toBe(24);
  expect(response.body[0]).toBe(7);
  expect(response.body[23]).toBe(9);
});
