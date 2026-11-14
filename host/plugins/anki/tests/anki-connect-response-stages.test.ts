/**
 * R5 A6 后继反例（`anki_connect_service.rs:113-116,365-418,440-479`），经真实 Host 命令入口：
 * - `{"result":null,"error":null}`：`result: Option<serde_json::Value>` 解成 None，
 *   牌组命令报 `AnkiConnect返回空结果`，不当作 `Some(Null)` 去解 `Vec<String>`。
 * - `send()` 已成功、读响应体失败：version 归 `response.text()` 阶段（`读取响应内容失败`），
 *   deck 归 `response.json()` 阶段（`解析AnkiConnect响应失败`），都不是请求/连接失败。
 */
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { createAnkiTestEnv, type AnkiTestEnv } from './env.ts';

let env: AnkiTestEnv | undefined;

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await env?.dispose();
  env = undefined;
});

function portOpen(): void {
  vi.spyOn(net, 'connect').mockImplementation((() => {
    const socket = new EventEmitter() as net.Socket;
    socket.destroy = () => socket;
    setImmediate(() => socket.emit('connect'));
    return socket;
  }) as typeof net.connect);
}

/** 响应头已到达（status 200），读响应体时连接中断。 */
function brokenBody(status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error('connection reset'));
    },
  });
  return new Response(body, { status });
}

function postOnly(reply: () => Response): void {
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) =>
    init?.method === 'POST' ? reply() : new Response(''));
}

const bodyError = 'request or response body error: connection reset';

it.each(['anki_get_deck_names', 'get_anki_deck_names'])(
  '%s: result null is Option None → AnkiConnect返回空结果',
  async (command) => {
    env = await createAnkiTestEnv({ migrate: false });
    postOnly(() => new Response('{"result":null,"error":null}'));
    await expect(env.host.invoke(command)).rejects.toEqual({
      error_type: 'Validation', message: 'AnkiConnect返回空结果', details: null,
    });
  },
);

it('get_anki_model_names: result null is Option None → AnkiConnect返回空结果', async () => {
  env = await createAnkiTestEnv({ migrate: false });
  postOnly(() => new Response('{"error":null,"result":null}'));
  await expect(env.host.invoke('get_anki_model_names')).rejects.toEqual({
    error_type: 'Validation', message: 'AnkiConnect返回空结果', details: null,
  });
});

it('check_anki_connect_availability: version result null logs None (not Some(Null)) and passes', async () => {
  env = await createAnkiTestEnv({ migrate: false });
  const warn = vi.spyOn(env.host.ctx.logger, 'warn');
  portOpen();
  postOnly(() => new Response('{"result":null,"error":null}'));
  await expect(env.host.invoke('check_anki_connect_availability')).resolves.toBe(true);
  expect(warn).toHaveBeenCalledExactlyOnceWith('⚠️ AnkiConnect version 返回非数字结果，跳过版本协商: None');
});

it('check_anki_connect_availability: body read failure after send is the text() stage', async () => {
  env = await createAnkiTestEnv({ migrate: false });
  const warn = vi.spyOn(env.host.ctx.logger, 'warn');
  portOpen();
  postOnly(() => brokenBody());
  await expect(env.host.invoke('check_anki_connect_availability'))
    .rejects.toBe(`读取响应内容失败: ${bodyError}`);
  // 连接错误日志只属于 send() 失败分支。
  expect(warn).not.toHaveBeenCalled();
});

it('check_anki_connect_availability: non-2xx with unreadable body uses 无法读取错误内容', async () => {
  env = await createAnkiTestEnv({ migrate: false });
  portOpen();
  postOnly(() => brokenBody(500));
  await expect(env.host.invoke('check_anki_connect_availability'))
    .rejects.toBe('AnkiConnect HTTP错误: 500 Internal Server Error - 内容: 无法读取错误内容');
});

it.each(['anki_get_deck_names', 'get_anki_deck_names'])(
  '%s: body read failure after send is the response.json() stage',
  async (command) => {
    env = await createAnkiTestEnv({ migrate: false });
    postOnly(() => brokenBody());
    await expect(env.host.invoke(command)).rejects.toEqual({
      error_type: 'Validation', message: `解析AnkiConnect响应失败: ${bodyError}`, details: null,
    });
  },
);

it('get_anki_deck_names: non-2xx never reads the body (status-only error)', async () => {
  env = await createAnkiTestEnv({ migrate: false });
  postOnly(() => brokenBody(503));
  await expect(env.host.invoke('get_anki_deck_names')).rejects.toEqual({
    error_type: 'Validation', message: 'AnkiConnect HTTP错误: 503 Service Unavailable', details: null,
  });
});
