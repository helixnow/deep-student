import { afterEach, beforeEach, expect, it } from 'vitest';
import type { ProtocolRequestInfo } from '../../../kernel/api.ts';
import {
  createBiliStreamProtocolHandler, resetBiliStreamProtocolState,
  type BiliStreamProtocolOperations,
} from '../src/bilibili-protocol.ts';
import type { BiliAttemptLike, PlayInfo } from '../src/bilibili-stream.ts';
import { startServer, type TestServer } from './helpers/http-fixture.ts';

const TOTAL = 200_000;
let server: TestServer | null = null;

beforeEach(() => {
  resetBiliStreamProtocolState();
});
afterEach(async () => {
  await server?.close();
  server = null;
});

function body(reply: { body: Uint8Array | AsyncIterable<Uint8Array> }): Uint8Array {
  if (!(reply.body instanceof Uint8Array)) throw new Error('test expected a one-shot protocol body');
  return reply.body;
}

function request(
  url = 'bilistream://localhost/file_abc?qn=80&e=0&a=0',
  method = 'GET',
  headers: Record<string, string> = {},
): ProtocolRequestInfo {
  return { url, method, headers };
}

function session(): BiliAttemptLike {
  return {
    async execute(input) {
      const response = await fetch(input.url, { headers: input.headers });
      return {
        status: response.status,
        header: name => response.headers.get(name),
        body: new Uint8Array(await response.arrayBuffer()),
      };
    },
  };
}

function info(url: string, size = TOTAL): PlayInfo {
  return { url, backup_urls: [], size, quality: 80, options: [] };
}

async function rangeServer(total = TOTAL): Promise<TestServer> {
  return await startServer((incoming, response) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(String(incoming.headers.range));
    if (match === null) {
      response.writeHead(400);
      response.end();
      return;
    }
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), total - 1);
    response.writeHead(206, {
      'content-type': 'video/mp4',
      'content-range': `bytes ${start}-${end}/${total}`,
      'content-length': String(end - start + 1),
      etag: '"v1"',
    });
    response.end(Buffer.alloc(end - start + 1, 7));
  });
}

function operations(
  overrides: Partial<BiliStreamProtocolOperations> = {},
): BiliStreamProtocolOperations {
  const stream = server!;
  return {
    session: async () => session(),
    playInfo: async () => info(`${stream.url}/video.mp4`),
    remember: () => {},
    emitError: () => {},
    timeoutMs: 2_000,
    ...overrides,
  };
}

it('OPTIONS returns 204 with the Rust CORS header set', async () => {
  const handler = createBiliStreamProtocolHandler(operations());
  const reply = await handler(request(undefined, 'OPTIONS', { origin: 'http://localhost:1422' }));
  expect(reply.status).toBe(204);
  expect(body(reply).length).toBe(0);
  expect(reply.headers).toMatchObject({
    'Access-Control-Allow-Origin': 'http://localhost:1422',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range',
    'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
    Vary: 'Origin',
    'Cache-Control': 'no-store',
  });
});

it('rejects non-GET/HEAD methods and invalid stream paths', async () => {
  const handler = createBiliStreamProtocolHandler(operations());
  const method = await handler(request(undefined, 'POST'));
  expect(method.status).toBe(405);
  expect(new TextDecoder().decode(body(method))).toBe('Method Not Allowed');

  const path = await handler(request('bilistream://localhost/res_abc'));
  expect(path.status).toBe(400);
  expect(new TextDecoder().decode(body(path))).toBe('无效的 B 站播放地址');
});

it('forwards the first range chunk and exposes the Rust response headers', async () => {
  server = await rangeServer();
  const handler = createBiliStreamProtocolHandler(operations());
  const reply = await handler(request(undefined, 'GET', {
    origin: 'http://localhost:1422', range: 'bytes=0-',
  }));
  expect(reply.status).toBe(206);
  expect(body(reply).length).toBe(65_536);
  expect(reply.headers).toMatchObject({
    'Accept-Ranges': 'bytes',
    'Content-Type': 'video/mp4',
    'Content-Range': `bytes 0-65535/${TOTAL}`,
    'Content-Length': '65536',
    'Access-Control-Allow-Origin': 'http://localhost:1422',
  });
});

it('resolves suffix ranges from the known total size', async () => {
  server = await rangeServer();
  const handler = createBiliStreamProtocolHandler(operations());
  const reply = await handler(request(undefined, 'GET', { range: 'bytes=-1024' }));
  expect(reply.status).toBe(206);
  expect(body(reply).length).toBe(1024);
  expect(reply.headers['Content-Range']).toBe(`bytes ${TOTAL - 1024}-${TOTAL - 1}/${TOTAL}`);
});

it('clamps a suffix larger than a short video to the file size', async () => {
  const size = 1024;
  server = await rangeServer(size);
  const handler = createBiliStreamProtocolHandler(operations({
    playInfo: async () => info(`${server!.url}/video.mp4`, size),
  }));
  const reply = await handler(request(undefined, 'GET', { range: 'bytes=-65536' }));
  expect(reply.status).toBe(206);
  expect(body(reply).length).toBe(size);
  expect(reply.headers['Content-Range']).toBe(`bytes 0-${size - 1}/${size}`);
});

it('refreshes a stale CDN URL once and then serves the range', async () => {
  let calls = 0;
  server = await startServer((incoming, response) => {
    calls += 1;
    if (calls === 1) {
      response.writeHead(403);
      response.end();
      return;
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(String(incoming.headers.range))!;
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), TOTAL - 1);
    response.writeHead(206, {
      'content-type': 'video/mp4',
      'content-range': `bytes ${start}-${end}/${TOTAL}`,
      'content-length': String(end - start + 1),
    });
    response.end(Buffer.alloc(end - start + 1, 1));
  });
  const fresh: boolean[] = [];
  const handler = createBiliStreamProtocolHandler(operations({
    playInfo: async (_fileId, _qn, _epoch, _attempt, isFresh) => {
      fresh.push(isFresh);
      return info(`${server!.url}/video.mp4`);
    },
  }));
  const reply = await handler(request(undefined, 'GET', { range: 'bytes=0-9' }));
  expect(reply.status).toBe(206);
  expect(fresh).toEqual([false, true]);
  expect(calls).toBe(2);
});

it('returns 502 with the Rust message when the refreshed URL is stale again', async () => {
  server = await startServer((_incoming, response) => {
    response.writeHead(410);
    response.end();
  });
  const errors: unknown[] = [];
  const handler = createBiliStreamProtocolHandler(operations({
    emitError: payload => { errors.push(payload); },
  }));
  const reply = await handler(request(undefined, 'GET', { range: 'bytes=0-9' }));
  expect(reply.status).toBe(502);
  expect(new TextDecoder().decode(body(reply))).toBe('B 站视频服务器拒绝了请求（HTTP 410）');
  expect(errors).toEqual([{
    fileId: 'file_abc', qn: 80, epoch: 0, attempt: 0,
    message: 'B 站视频服务器拒绝了请求（HTTP 410）',
  }]);
});

it('HEAD returns the total content length without a body', async () => {
  server = await rangeServer();
  const handler = createBiliStreamProtocolHandler(operations());
  const reply = await handler(request(undefined, 'HEAD'));
  expect(reply.status).toBe(200);
  expect(body(reply).length).toBe(0);
  expect(reply.headers['Content-Length']).toBe(String(TOTAL));
  expect(reply.headers['Content-Range']).toBeUndefined();
});

it('returns 504 when resolving the play URL exceeds the protocol deadline', async () => {
  const handler = createBiliStreamProtocolHandler(operations({
    playInfo: async () => await new Promise<PlayInfo>(() => {}),
    timeoutMs: 20,
  }));
  const reply = await handler(request());
  expect(reply.status).toBe(504);
  expect(new TextDecoder().decode(body(reply))).toBe('视频加载超时，请重试或在 B 站打开');
});
