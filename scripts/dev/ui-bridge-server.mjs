#!/usr/bin/env node
/**
 * Dev-only UI 自动化桥服务端。
 *
 * - WebSocket ws://127.0.0.1:17423/app ：WebView 内的 uiAutomationBridge.ts 连进来
 * - HTTP POST http://127.0.0.1:17423/eval  body={code} ：在 WebView 里执行异步 JS 并返回 JSON
 * - HTTP GET  http://127.0.0.1:17423/status ：查看桥连接状态
 *
 * 用法：node scripts/dev/ui-bridge-server.mjs
 */
import http from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = 17423;

let appSocket = null;
let nextId = 1;
const pending = new Map();

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ connected: !!appSocket }));
    return;
  }
  if (req.method === 'POST' && req.url === '/eval') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (!appSocket) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'app not connected' }));
        return;
      }
      let code;
      try {
        code = JSON.parse(body).code;
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'bad json' }));
        return;
      }
      const id = nextId++;
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          res.writeHead(504, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'eval timeout (15s)' }));
        }
      }, 15000);
      pending.set(id, { res, timer });
      appSocket.send(JSON.stringify({ id, code }));
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server, path: '/app' });
wss.on('connection', (ws) => {
  appSocket = ws;
  console.log('[bridge] app connected');
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    entry.res.writeHead(200, { 'content-type': 'application/json' });
    entry.res.end(JSON.stringify(msg));
  });
  ws.on('close', () => {
    if (appSocket === ws) appSocket = null;
    console.log('[bridge] app disconnected');
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[bridge] listening on http://127.0.0.1:${PORT}`);
});
