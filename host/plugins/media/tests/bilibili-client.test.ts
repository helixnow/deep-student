import { expect, it } from 'vitest';
import type { MediaError } from '../src/errors.ts';
import {
  BiliLookupClient, descriptorFromLookup, type BiliLookup,
} from '../src/bilibili-client.ts';
import {
  ERR_NO_SUBTITLE, ERR_REQUEST, ERR_UNAVAILABLE, descriptorFileName,
} from '../src/bilibili-links.ts';
import { parseSubtitle } from '../src/subtitle.ts';
import { startServer, type RecordedRequest } from './helpers/http-fixture.ts';

const BCC = '{"type":"AIsubtitle","body":[{"from":0.5,"to":2.0,"content":"第一句"},'
  + '{"from":2.5,"to":4.0,"content":"第二句"}]}';

const SUBTITLE_FILE_NAME = 'subtitle.json';

function viewBody(): string {
  return JSON.stringify({
    code: 0,
    message: '0',
    data: {
      bvid: 'BV1xx411c7mD',
      aid: 42,
      cid: 1001,
      title: '线性代数',
      pic: 'http://i1.hdslb.com/bfs/archive/cover.jpg',
      duration: 600,
      owner: { name: '老师' },
      pages: [
        { cid: 1001, page: 1, part: '01 向量', duration: 300 },
        { cid: 1002, page: 2, part: '02 矩阵', duration: 300 },
      ],
    },
  });
}

function queryOf(request: RecordedRequest): URLSearchParams {
  return new URL(request.url, 'http://127.0.0.1').searchParams;
}

function clientOf(server: { url: string }): BiliLookupClient {
  return new BiliLookupClient(server.url, { strictHosts: false });
}

it('lookup_picks_page_tracks_and_downloads_bcc', async () => {
  const server = await startServer((request, response) => {
    const query = queryOf(request);
    response.setHeader('content-type', 'application/json');
    if (request.url.startsWith('/x/web-interface/view')) {
      if (query.get('bvid') !== 'BV1xx411c7mD') {
        response.writeHead(400);
        response.end();
        return;
      }
      response.writeHead(200);
      response.end(viewBody());
      return;
    }
    if (request.url.startsWith('/x/v2/dm/view')) {
      response.writeHead(200);
      response.end(JSON.stringify({
        code: 0,
        data: {
          subtitle: {
            subtitles: [
              {
                lan: 'ai-zh', lan_doc: '中文（自动生成）', ai_type: 0,
                subtitle_url: `${server.url}/sub/ai.json`,
              },
              {
                lan: 'zh-CN', lan_doc: '中文（中国）',
                subtitle_url: `${server.url}/sub/zh.json`,
              },
              { lan: 'en-US', lan_doc: 'English', subtitle_url: '' },
            ],
          },
        },
      }));
      return;
    }
    response.writeHead(200);
    response.end(BCC);
  });
  try {
    const client = clientOf(server);
    const lookup = await client.lookup(
      'https://www.bilibili.com/video/BV1xx411c7mD?p=2', null);
    expect(lookup.page.cid).toBe(1002);
    expect(lookup.page.durationMs).toBe(300_000);
    expect(lookup.video.cover).toBe('https://i1.hdslb.com/bfs/archive/cover.jpg');
    expect(lookup.video.owner).toBe('老师');
    expect(lookup.tracks.map(track => [track.lan, track.ai]))
      .toEqual([['ai-zh', true], ['zh-CN', false]]);

    const [track, bytes] = await client.subtitleBytes(lookup, null);
    expect(track.lan).toBe('zh-CN');
    expect(parseSubtitle(SUBTITLE_FILE_NAME, bytes)).toHaveLength(2);

    const descriptor = descriptorFromLookup(lookup);
    expect(descriptorFileName(descriptor)).toBe('线性代数 P2 02 矩阵.bilibili');
    expect(descriptor.durationMs).toBe(300_000);
    expect(descriptor.pageCount).toBe(2);
    const dmRequest = server.requests.find(request =>
      request.url.startsWith('/x/v2/dm/view'));
    const dmQuery = queryOf(dmRequest!);
    expect(dmQuery.get('type')).toBe('1');
    expect(dmQuery.get('oid')).toBe('1002');
    expect(dmQuery.get('pid')).toBe('42');

    // 参数 page 优先于链接里的 ?p=；不存在的分 P 报错
    let failure: unknown = null;
    try { await client.lookup('https://www.bilibili.com/video/BV1xx411c7mD?p=2', 9); }
    catch (error) { failure = error; }
    expect((failure as MediaError).code).toBe(ERR_UNAVAILABLE);

    // 第二次 lookup 命中视频信息缓存，view 只请求一次
    expect(server.requests.filter(request => request.url.startsWith('/x/web-interface/view')))
      .toHaveLength(1);
    expect(server.requests.filter(request => request.url.startsWith('/sub/zh.json')))
      .toHaveLength(1);
    for (const request of server.requests) {
      expect(request.headers.referer).toBe('https://www.bilibili.com/');
    }
  } finally { await server.close(); }
});

it('api_errors_and_missing_subtitles_have_stable_codes', async () => {
  const server = await startServer((request, response) => {
    const query = queryOf(request);
    if (request.url.startsWith('/x/web-interface/view')) {
      if (query.get('aid') === '404') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"code":-404,"message":"啥都木有","data":null}');
        return;
      }
      if (query.get('aid') === '412') {
        response.writeHead(412);
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(viewBody());
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"code":0,"data":{"subtitle":{"subtitles":[]}}}');
  });
  try {
    const client = clientOf(server);

    let failure: unknown = null;
    try { await client.lookup('av404', null); }
    catch (error) { failure = error; }
    expect((failure as MediaError).code).toBe(ERR_UNAVAILABLE);
    expect((failure as Error).message).toContain('-404');

    failure = null;
    try { await client.lookup('av412', null); }
    catch (error) { failure = error; }
    expect((failure as MediaError).code).toBe(ERR_REQUEST);
    expect((failure as Error).message).toContain('风控');

    const lookup = await client.lookup('BV1xx411c7mD', null);
    expect(lookup.tracks).toEqual([]);
    expect(lookup.subtitleState).toBe('none_confirmed');
    failure = null;
    try { await client.subtitleBytes(lookup, null); }
    catch (error) { failure = error; }
    expect((failure as MediaError).code).toBe(ERR_NO_SUBTITLE);
    expect((failure as Error).message.startsWith('第 1 P')).toBe(true);
  } finally { await server.close(); }
});

it('unknown_subtitles_use_same_route_grpc_and_never_claim_empty_on_failure', async () => {
  const server = await startServer((request, response) => {
    if (request.url.startsWith('/x/web-interface/view')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(viewBody());
      return;
    }
    if (request.url.startsWith('/x/v2/dm/view')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"code":0,"data":{"subtitle":null}}');
      return;
    }
    // 截断的 gRPC 帧：声明 9 字节但只有 1 字节
    response.writeHead(200);
    response.end(Buffer.from([0, 0, 0, 0, 9, 0]));
  });
  try {
    const client = clientOf(server);
    const lookup = await client.lookup('BV1xx411c7mD', null);
    expect(lookup.subtitleState).toBe('failed');
    expect(lookup.subtitleError?.code).toBe('bilibili-subtitle-protocol');

    const grpc = server.requests.find(request =>
      request.url === '/bilibili.community.service.dm.v1.DM/DmView');
    expect(grpc).toBeDefined();
    expect(grpc!.method).toBe('POST');
    expect(grpc!.headers['content-type']).toBe('application/grpc');

    let failure: unknown = null;
    try { await client.subtitleBytes(lookup, null); }
    catch (error) { failure = error; }
    expect((failure as MediaError).code).toBe('bilibili-subtitle-protocol');
  } finally { await server.close(); }
});
