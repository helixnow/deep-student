import { EventEmitter } from 'node:events';
import net from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ANKI_CONNECT_URL,
  checkAnkiConnectAvailability,
  createDeckIfNotExists,
  getDeckNames,
  getModelNames,
  importApkg,
  statusText,
} from '../src/anki-connect.ts';
import type { AnkiLogger } from '../src/logger.ts';
import { setAnkiLocalRuntime } from '../src/local-runtime.ts';
import { nodeAnkiLocalRuntime } from '../src/local-runtime.node.ts';

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeAll(() => { setAnkiLocalRuntime(nodeAnkiLocalRuntime); });
afterAll(() => { setAnkiLocalRuntime(null); });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function loggerDouble(warnings: string[]): AnkiLogger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: (message) => { warnings.push(message); },
    error: () => undefined,
  };
}

/** 让 `checkAnkiConnectAvailability` 的端口探测直接成功，并只桩住本机 POST。 */
function stubAvailability(body: string): void {
  vi.spyOn(net, 'connect').mockImplementation((() => {
    const socket = new EventEmitter() as unknown as net.Socket;
    (socket as unknown as { destroy: () => void }).destroy = () => undefined;
    setImmediate(() => socket.emit('connect'));
    return socket;
  }) as unknown as typeof net.connect);
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return new Response(body, { status: 200 });
    return new Response('', { status: 200 });
  });
}

describe('anki_connect_service 牌组与笔记类型请求', () => {
  it('getDeckNames posts the version 6 deckNames action', async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return reply({ result: ['Default', 'Deck A'], error: null });
    });
    await expect(getDeckNames()).resolves.toEqual(['Default', 'Deck A']);
    expect(calls).toEqual([{ url: ANKI_CONNECT_URL, body: { action: 'deckNames', version: 6 } }]);
  });

  it('getDeckNames surfaces HTTP, AnkiConnect and parse errors with Rust prefixes', async () => {
    vi.stubGlobal('fetch', async () => new Response('boom', { status: 500 }));
    await expect(getDeckNames()).rejects.toThrow('AnkiConnect HTTP错误: 500 Internal Server Error');

    vi.stubGlobal('fetch', async () => reply({ result: null, error: 'collection is closed' }));
    await expect(getDeckNames()).rejects.toThrow('AnkiConnect错误: collection is closed');

    vi.stubGlobal('fetch', async () => reply({ result: 'nope', error: null }));
    await expect(getDeckNames()).rejects.toThrow('解析牌组列表失败: invalid type: string "nope", expected a sequence');

    vi.stubGlobal('fetch', async () => new Response('not json', { status: 200 }));
    await expect(getDeckNames()).rejects.toThrow(
      '解析AnkiConnect响应失败: error decoding response body: expected ident at line 1 column 2',
    );
  });

  it('matches reqwest decode Display and serde_json positions instead of V8 JSON.parse text', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"result": [1}, "error": null}', { status: 200 }));
    const error = await getDeckNames().then(
      () => { throw new Error('expected getDeckNames to reject'); },
      (caught: unknown) => caught as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(
      '解析AnkiConnect响应失败: error decoding response body: '
      + 'expected `,` or `]` at line 1 column 14',
    );
    expect(error.message).not.toMatch(/Unexpected token|not valid JSON/);
  });

  it('version decodes text/from_str errors without the reqwest decode prefix', async () => {
    stubAvailability('{');
    const error = await checkAnkiConnectAvailability().then(
      () => { throw new Error('expected version check to reject'); },
      (caught: unknown) => caught as Error,
    );
    expect(error.message).toBe(
      '解析AnkiConnect响应失败: EOF while parsing an object at line 1 column 1 - 响应内容: {',
    );
    expect(error.message).not.toContain('error decoding response body');
  });

  it('version treats 5.0 as a non-u64 result and skips negotiation', async () => {
    const warnings: string[] = [];
    stubAvailability('{"result":5.0,"error":null}');
    await expect(checkAnkiConnectAvailability(loggerDouble(warnings))).resolves.toBe(true);
    expect(warnings).toEqual([
      '⚠️ AnkiConnect version 返回非数字结果，跳过版本协商: Some(Number(5.0))',
    ]);
  });

  it('deck errors follow serde field order before later syntax errors', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"error":1,"result":[}', { status: 200 }));
    await expect(getDeckNames()).rejects.toThrow(
      '解析AnkiConnect响应失败: error decoding response body: '
      + 'invalid type: integer `1`, expected a string at line 1 column 10',
    );
  });

  it('deck rejects duplicate result fields like the serde derived struct', async () => {
    vi.stubGlobal(
      'fetch',
      async () => new Response('{"result":["A"],"result":["B"],"error":null}', { status: 200 }),
    );
    await expect(getDeckNames()).rejects.toThrow(
      '解析AnkiConnect响应失败: error decoding response body: '
      + 'duplicate field `result` at line 1 column 24',
    );
  });

  it('deck typed decode keeps integers outside the JS safe range exact', async () => {
    vi.stubGlobal(
      'fetch',
      async () => new Response('{"result":[9007199254740993],"error":null}', { status: 200 }),
    );
    await expect(getDeckNames()).rejects.toThrow(
      '解析牌组列表失败: invalid type: integer `9007199254740993`, expected a string',
    );
  });

  it('deck response.json rejects invalid UTF-8 instead of accepting lossy text', async () => {
    const prefix = Buffer.from('{"result":["', 'utf8');
    const suffix = Buffer.from('"],"error":null}', 'utf8');
    const body = Buffer.concat([prefix, Buffer.from([0xff]), suffix]);
    vi.stubGlobal('fetch', async () => new Response(body, { status: 200 }));
    await expect(getDeckNames()).rejects.toThrow(
      '解析AnkiConnect响应失败: error decoding response body: '
      + 'invalid unicode code point at line 1 column 13',
    );
  });

  it('reports the result container and element types without an extra serde context', async () => {
    vi.stubGlobal('fetch', async () => reply({ result: { deck: 'Default' }, error: null }));
    await expect(getDeckNames()).rejects.toThrow(
      '解析牌组列表失败: invalid type: map, expected a sequence',
    );

    vi.stubGlobal('fetch', async () => reply({ result: [1], error: null }));
    await expect(getDeckNames()).rejects.toThrow(
      '解析牌组列表失败: invalid type: integer `1`, expected a string',
    );
    await expect(getDeckNames()).rejects.not.toThrow(/while parsing/);
  });

  it('getModelNames uses the modelNames action and labels its parse errors', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return reply({ result: ['Basic'], error: null });
    });
    await expect(getModelNames()).resolves.toEqual(['Basic']);
    expect(bodies).toEqual([{ action: 'modelNames', version: 6 }]);

    vi.stubGlobal('fetch', async () => reply({ result: [1], error: null }));
    await expect(getModelNames()).rejects.toThrow('解析笔记类型列表失败: invalid type: integer `1`, expected a string');
  });

  it('createDeckIfNotExists sends the deck param and tolerates already exists', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return reply({ result: 1, error: null });
    });
    await expect(createDeckIfNotExists('Deck A')).resolves.toBeUndefined();
    expect(bodies).toEqual([{ action: 'createDeck', version: 6, params: { deck: 'Deck A' } }]);

    vi.stubGlobal('fetch', async () => reply({ result: null, error: 'deck already exists' }));
    await expect(createDeckIfNotExists('Deck A')).resolves.toBeUndefined();

    vi.stubGlobal('fetch', async () => reply({ result: null, error: 'permission denied' }));
    await expect(createDeckIfNotExists('Deck A')).rejects.toThrow('创建牌组时出错: permission denied');
  });

  it('importApkg rejects blank paths before any network access', async () => {
    const fetchStub = vi.fn();
    vi.stubGlobal('fetch', fetchStub);
    await expect(importApkg('   ')).rejects.toThrow('APKG 路径不能为空');
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('statusText matches Rust http::StatusCode display', () => {
    expect(statusText(200)).toBe('200 OK');
    expect(statusText(404)).toBe('404 Not Found');
  });
});
