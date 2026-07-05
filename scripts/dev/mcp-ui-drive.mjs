#!/usr/bin/env node
/**
 * dstu-ui-drive MCP Server
 *
 * Playwright-MCP / browser MCP 风格的 Deep Student UI 驱动。
 * 通过 ui-bridge（WebSocket + HTTP eval）控制 dev 构建里的 __DS_BRIDGE__。
 *
 * Cursor 配置示例（.cursor/mcp.json 或 Settings → MCP）：
 * {
 *   "mcpServers": {
 *     "dstu-ui-drive": {
 *       "command": "node",
 *       "args": ["scripts/dev/mcp-ui-drive.mjs"],
 *       "cwd": "/Volumes/cipan/deep-student"
 *     }
 *   }
 * }
 *
 * 前置：npm run ui:lab  （或 ui:bridge + VITE_DS_UI_BRIDGE=1 dev:tauri）
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  status,
  snapshot,
  formatSnapshot,
  click,
  typeText,
  pressKey,
  scroll,
  swipe,
  back,
  errors,
  evalJs,
  resize,
  wait,
  captureWindow,
  readImageBase64,
  DEVICES,
} from './ui-drive-core.mjs';

const server = new McpServer({
  name: 'dstu-ui-drive',
  version: '1.0.0',
});

function text(content) {
  return { content: [{ type: 'text', text: content }] };
}

function jsonBlock(label, obj) {
  return text(`${label}\n\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\``);
}

function fail(message) {
  return text(`❌ ${message}`);
}

function unwrap(result) {
  if (result?.ok === false) return { ok: false, error: result.error };
  if (result?.value !== undefined) return { ok: true, data: result.value };
  return { ok: true, data: result };
}

server.tool(
  'ui_status',
  'Check ui-bridge connection and Deep Student window id. Call first if actions fail.',
  {},
  async () => {
    const s = await status();
    const emoji = s.connected ? '🟢' : '🔴';
    return text(
      `${emoji} bridge connected=${s.connected}, windowId=${s.windowId || 'none'}\n` +
        (s.connected ? '' : '\nRun: npm run ui:lab'),
    );
  },
);

server.tool(
  'ui_snapshot',
  'Accessibility-style snapshot with stable refs (e1, e2…). Use refs for click/type. Like Playwright page snapshot.',
  {
    all: z.boolean().optional().describe('Include off-screen elements'),
  },
  async ({ all }) => {
    const raw = await snapshot({ all: !!all });
    const unwrapped = unwrap(raw);
    if (!unwrapped.ok) return fail(unwrapped.error || 'snapshot failed');
    return text(formatSnapshot({ ok: true, value: unwrapped.data }));
  },
);

server.tool(
  'ui_click',
  'Click element by ref (e12), visible text, or css=selector. Use --tap semantics via touch pointer.',
  {
    target: z.string().describe('eN ref, button text, or css=.class'),
    tap: z.boolean().optional().describe('Dispatch touch pointer events (mobile)'),
  },
  async ({ target, tap }) => {
    const r = unwrap(await click(target, { tap: !!tap }));
    if (!r.ok || r.data?.ok === false) return fail(r.data?.error || r.error || 'click failed');
    return text(`✅ clicked ${r.data.role || 'element'} "${r.data.name || target}"`);
  },
);

server.tool(
  'ui_type',
  'Type into input/textarea/contenteditable. Target = ref, placeholder text, or css=selector.',
  {
    target: z.string(),
    text: z.string(),
    clear: z.boolean().optional().describe('Clear before typing (default true)'),
    enter: z.boolean().optional().describe('Press Enter after typing'),
  },
  async ({ target, text: value, clear, enter }) => {
    const r = unwrap(await typeText(target, value, { clear: clear !== false, enter: !!enter }));
    if (!r.ok || r.data?.ok === false) return fail(r.data?.error || r.error || 'type failed');
    return text(`✅ typed into ${target}`);
  },
);

server.tool(
  'ui_press_key',
  'Press keyboard key on focused element (Enter, Escape, Tab, ArrowDown, etc.)',
  {
    key: z.string(),
    meta: z.boolean().optional(),
    ctrl: z.boolean().optional(),
    alt: z.boolean().optional(),
    shift: z.boolean().optional(),
  },
  async ({ key, meta, ctrl, alt, shift }) => {
    const r = unwrap(await pressKey(key, { meta, ctrl, alt, shift }));
    return text(`✅ key ${key}`);
  },
);

server.tool(
  'ui_scroll',
  'Scroll page or element. Positive dy scrolls down.',
  {
    dy: z.number().describe('Pixels to scroll (positive = down)'),
    target: z.string().optional().describe('ref or css=selector; omit to scroll viewport center container'),
  },
  async ({ dy, target }) => {
    const r = unwrap(await scroll(dy, target || null));
    if (!r.ok || r.data?.ok === false) return fail(r.data?.error || 'scroll failed');
    return text(`✅ scrolled dy=${dy}${r.data.atBottom ? ' (at bottom)' : ''}`);
  },
);

server.tool(
  'ui_swipe',
  'Touch swipe gesture between two viewport coordinates.',
  {
    x1: z.number(),
    y1: z.number(),
    x2: z.number(),
    y2: z.number(),
    ms: z.number().optional().describe('Duration ms (default 250)'),
  },
  async ({ x1, y1, x2, y2, ms }) => {
    const r = unwrap(await swipe([x1, y1], [x2, y2], ms || 250));
    return text(`✅ swipe (${x1},${y1}) → (${x2},${y2})`);
  },
);

server.tool(
  'ui_back',
  'Android back: uses __DEEP_STUDENT_HANDLE_BACK__ if available, else history.back().',
  {},
  async () => {
    const r = unwrap(await back());
    return jsonBlock('back', r.data);
  },
);

server.tool(
  'ui_errors',
  'Get console errors/warnings and uncaught exceptions captured since load.',
  {
    clear: z.boolean().optional().describe('Clear buffer after read'),
  },
  async ({ clear }) => {
    const r = unwrap(await errors(!!clear));
    const list = r.data || [];
    if (!list.length) return text('No errors captured.');
    const body = list
      .slice(-30)
      .map((e) => `[${e.kind}] ${new Date(e.ts).toISOString()} ${e.text}`)
      .join('\n');
    return text(`Errors (${list.length} total, showing last ${Math.min(30, list.length)}):\n${body}`);
  },
);

server.tool(
  'ui_screenshot',
  'Capture Deep Student window only (ignores occluding windows). Returns image + path.',
  {
    name: z.string().optional().describe('Filename stem under DS_SHOT_DIR'),
    full: z.boolean().optional().describe('Keep full resolution (default scales to 900px height)'),
  },
  async ({ name, full }) => {
    const shot = captureWindow(name || `mcp-${Date.now()}`, { full: !!full });
    if (!shot.ok) return fail(shot.error);
    const b64 = readImageBase64(shot.path);
    return {
      content: [
        { type: 'text', text: `Screenshot saved: ${shot.path}` },
        { type: 'image', data: b64, mimeType: 'image/png' },
      ],
    };
  },
);

server.tool(
  'ui_resize',
  'Resize Tauri window logical size (triggers mobile/desktop breakpoint).',
  {
    width: z.number(),
    height: z.number(),
  },
  async ({ width, height }) => {
    const r = unwrap(await resize(width, height));
    if (!r.ok || r.data?.ok === false) return fail(r.error || 'resize failed');
    return text(`✅ resized to ${width}x${height}`);
  },
);

server.tool(
  'ui_devices',
  'List preset device sizes (android-default, iphone-15-pro, breakpoint-edge, …).',
  {},
  async () => jsonBlock('devices', DEVICES),
);

server.tool(
  'ui_wait',
  'Wait milliseconds (animation, navigation, lazy load).',
  {
    ms: z.number().optional().describe('Default 500'),
  },
  async ({ ms }) => {
    await wait(ms || 500);
    return text(`✅ waited ${ms || 500}ms`);
  },
);

server.tool(
  'ui_eval',
  'Run arbitrary async JS in the WebView (advanced). Must use return to send data back.',
  {
    code: z.string(),
  },
  async ({ code }) => jsonBlock('eval result', unwrap(await evalJs(code))),
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[dstu-ui-drive] MCP server running on stdio');
}

main().catch((e) => {
  console.error('[dstu-ui-drive] fatal', e);
  process.exit(1);
});
