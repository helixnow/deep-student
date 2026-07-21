/**
 * 拖拽性能取证：通过 CDP 抓取拖拽期间的 Chromium 内部 trace。
 *
 * 与 HUD/interactionTrace 只报"症状"（每帧 style/layout 毫秒数）不同，
 * 这里开启 invalidationTracking 等追踪类别，能记录每次样式/布局失效的
 * 肇事 DOM 节点、原因、命中的 CSS 选择器和 JS 调用栈——直接定位源头。
 *
 * 前置条件：应用须带 --remote-debugging-port=9223 启动
 *（npm run dev:tauri:diag 已自动注入，见 dev-tauri-diag.mjs）。
 *
 * 用法：node scripts/cdp-drag-trace.mjs [最长等待分钟=10]
 *   脚本注入拖拽探针后待命，检测到按住拖动（pointerdown + >5 次 move）自动开始
 *   录制，松手 2 秒无新拖拽（或录满 60 秒）自动停止，trace 落盘
 *   .tmp/cdp-drag-trace.json，随后用 scripts/cdp-trace-analyze.mjs 分析。
 *   该文件也可直接拖进 Chrome DevTools Performance 面板查看。
 */
import WebSocket from 'ws';
import { writeFileSync, mkdirSync } from 'node:fs';

const WAIT_MIN = Number(process.argv[2] ?? 10);
const CDP_HTTP = 'http://127.0.0.1:9223';

const list = await (await fetch(`${CDP_HTTP}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
if (!page) {
  console.error('未找到可调试页面，确认应用已启动且带 --remote-debugging-port=9223');
  process.exit(1);
}
console.log(`已连接页面: ${page.title} (${page.url})`);

const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 1024 * 1024 * 1024 });
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });

let msgId = 0;
const pending = new Map();
const traceChunks = [];
let collectDone;
const collected = new Promise((res) => { collectDone = res; });

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  } else if (msg.method === 'Tracing.dataCollected') {
    traceChunks.push(...msg.params.value);
  } else if (msg.method === 'Tracing.tracingComplete') {
    collectDone();
  }
});

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalJs(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true });
  return r.result?.value;
}

const PROBE_SRC = `(() => {
  if (window.__cdpDragProbe) return 'already';
  window.__cdpDragProbe = { downTs: 0, upTs: 0, moves: 0 };
  window.addEventListener('pointerdown', () => { window.__cdpDragProbe.downTs = Date.now(); window.__cdpDragProbe.moves = 0; }, true);
  window.addEventListener('pointermove', (e) => { if (e.buttons) window.__cdpDragProbe.moves++; }, true);
  window.addEventListener('pointerup', () => { window.__cdpDragProbe.upTs = Date.now(); }, true);
  return 'installed';
})()`;

// 页面刷新（如 Vite full reload）会清掉探针，getProbe 兜底重装
async function getProbe() {
  const p = await evalJs('window.__cdpDragProbe');
  if (p) return p;
  await evalJs(PROBE_SRC);
  return { downTs: 0, upTs: 0, moves: 0 };
}

await send('Runtime.enable');
await send('Page.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE_SRC });
await evalJs(PROBE_SRC);
console.log('拖拽探针已注入。等待你在应用里按住并拖动窗口...');

const categories = [
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'disabled-by-default-devtools.timeline.invalidationTracking',
  'blink',
  'blink.style',
  'blink.user_timing',
  'cc',
  'disabled-by-default-blink.debug.layout',
  'toplevel',
  'v8.execute',
  'benchmark',
  'latencyInfo',
].join(',');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deadline = Date.now() + WAIT_MIN * 60_000;

// 等待拖拽开始（按住且移动超过 5 次）
let probe;
for (;;) {
  if (Date.now() > deadline) {
    console.error('等待超时，未检测到拖拽。');
    process.exit(2);
  }
  probe = await getProbe();
  if (probe.downTs > probe.upTs && probe.moves > 5) break;
  await sleep(300);
}

console.log('>>> 检测到拖拽，开始录制！请继续拖拽复现卡顿...');
await send('Tracing.start', {
  traceConfig: { includedCategories: categories.split(','), recordMode: 'recordContinuously' },
  transferMode: 'ReportEvents',
});

// 等待拖拽结束后 2 秒无新拖拽，或最长录 60 秒
const recStart = Date.now();
for (;;) {
  await sleep(500);
  probe = await getProbe();
  const dragging = probe.downTs > probe.upTs;
  const idleMs = Date.now() - Math.max(probe.upTs, probe.downTs);
  if ((!dragging && idleMs > 2000) || Date.now() - recStart > 60_000) break;
}

console.log('拖拽结束，停止录制，正在回收 trace 数据...');
await send('Tracing.end');
await collected;

mkdirSync('.tmp', { recursive: true });
const out = '.tmp/cdp-drag-trace.json';
writeFileSync(out, JSON.stringify({ traceEvents: traceChunks }));
console.log(`已保存 ${traceChunks.length} 条事件到 ${out}`);
ws.close();
process.exit(0);
