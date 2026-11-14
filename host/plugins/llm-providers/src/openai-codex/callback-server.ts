/**
 * Codex OAuth 浏览器登录的桌面回环回调服务（`node:http`）。
 *
 * 移动端没有监听套接字，因此这份实现只由桌面入口（`host/plugins/llm-providers/index.ts`）
 * 注入；插件本体与移动端入口不导入它。绑定 127.0.0.1 的 1455/1457（manager.rs 的同两个端口），
 * 两个都被占用时按 `CallbackBind` 失败。
 */
import { createServer } from 'node:http';
import type { OAuthCallbackReply, OAuthCallbackRequest, OAuthCallbackServerFactory } from './manager.ts';

/** 浏览器回调页面的响应头：与 Rust 实现一致的内联样式与无缓存。 */
const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
  'cache-control': 'no-store',
} as const;

export const nodeOAuthCallbackServer: OAuthCallbackServerFactory = (ports, handler) => new Promise((resolve, reject) => {
  const attempt = (index: number): void => {
    if (index >= ports.length) { reject(new Error('CallbackBind')); return; }
    const server = createServer((request, response) => {
      const payload: OAuthCallbackRequest = { method: request.method ?? 'GET', url: request.url ?? '/' };
      void handler(payload).then((reply: OAuthCallbackReply) => {
        if (response.writableEnded) return;
        response.writeHead(reply.status, HTML_HEADERS);
        response.end(reply.body);
      }, () => {
        if (!response.writableEnded) { response.writeHead(400, HTML_HEADERS); response.end(); }
      });
    });
    server.once('error', () => { server.close(); attempt(index + 1); });
    server.listen(ports[index]!, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') { server.close(); reject(new Error('CallbackBind')); return; }
      resolve({ port: address.port, close: () => server.close() });
    });
  };
  attempt(0);
});
