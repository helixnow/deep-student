/**
 * ui-drive-core — Deep Student UI 驱动共享客户端
 * 供 ui-drive CLI 与 mcp-servers/dstu-ui-drive MCP server 复用。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const BRIDGE = process.env.DS_UI_BRIDGE_URL || 'http://127.0.0.1:17423';
export const SHOT_DIR = process.env.DS_SHOT_DIR || '/tmp/ds-mobile-audit/shots';

export const DEVICES = {
  'android-compact': { w: 360, h: 800, note: 'Galaxy S23 等窄屏' },
  'android-default': { w: 400, h: 880, note: 'Pixel 8 类主流机' },
  'android-large': { w: 432, h: 960, note: 'Pixel 8 Pro / 大屏' },
  'iphone-se': { w: 375, h: 667, note: '最矮小屏兜底' },
  'iphone-15-pro': { w: 393, h: 852, note: '' },
  'tablet-portrait': { w: 768, h: 1024, note: '竖屏平板（断点边界 768）' },
  'breakpoint-edge': { w: 767, h: 1024, note: '移动断点上边缘' },
};

export async function bridgeStatus() {
  const res = await fetch(`${BRIDGE}/status`);
  return res.json();
}

export async function rpc(code) {
  const res = await fetch(`${BRIDGE}/eval`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  return res.json();
}

export function q(s) {
  return JSON.stringify(s);
}

export function findWindowId() {
  const swiftSrc = `
import CoreGraphics
import Foundation
let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else { print(""); exit(0) }
for w in list {
  let owner = (w[kCGWindowOwnerName as String] as? String) ?? ""
  if owner == "deep-student" || owner == "Deep Student" {
    print(w[kCGWindowNumber as String] ?? 0); exit(0)
  }
}
print("")
`;
  const tmp = path.join('/tmp', 'ds-find-win.swift');
  if (!fs.existsSync(tmp) || fs.readFileSync(tmp, 'utf8') !== swiftSrc) {
    fs.writeFileSync(tmp, swiftSrc);
  }
  return execFileSync('swift', [tmp], { encoding: 'utf8' }).trim();
}

export async function status() {
  const res = await bridgeStatus();
  const winId = findWindowId();
  return { ...res, windowId: winId || null };
}

export async function snapshot(opts = {}) {
  return rpc(`return window.__DS_BRIDGE__.snapshot(${JSON.stringify(opts)});`);
}

export function formatSnapshot(result) {
  if (!result?.ok || !result.value) {
    return `snapshot failed: ${result?.error || 'unknown'}`;
  }
  const snap = result.value;
  const lines = [];
  lines.push(`url: ${snap.url}`);
  lines.push(`viewport: ${snap.viewport.w}x${snap.viewport.h} @${snap.viewport.dpr}x`);
  if (snap.headings?.length) lines.push(`headings: ${snap.headings.join(' | ')}`);
  if (snap.openDialogs) lines.push(`openDialogs: ${snap.openDialogs}`);
  lines.push(`elements (${snap.count}):`);
  for (const el of snap.elements || []) {
    const flags = [
      el.disabled ? 'disabled' : null,
      el.checked != null ? (el.checked ? 'checked' : 'unchecked') : null,
      el.region ? `@${el.region}` : null,
    ]
      .filter(Boolean)
      .join(', ');
    const extra = flags ? ` [${flags}]` : '';
    const val = el.value != null ? ` value="${el.value}"` : '';
    lines.push(
      `  - ${el.ref} ${el.role} "${el.name}"${val}${extra} @(${el.rect.x},${el.rect.y} ${el.rect.w}x${el.rect.h})`,
    );
  }
  return lines.join('\n');
}

export async function click(target, opts = {}) {
  return rpc(
    `return window.__DS_BRIDGE__.click(${q(target)}, { tap: ${!!opts.tap}, scroll: ${opts.scroll !== false} });`,
  );
}

export async function typeText(target, text, opts = {}) {
  return rpc(
    `return window.__DS_BRIDGE__.type(${q(target)}, ${q(text)}, { clear: ${opts.clear !== false}, enter: ${!!opts.enter} });`,
  );
}

export async function pressKey(key, mods = {}) {
  return rpc(
    `return window.__DS_BRIDGE__.key(${q(key)}, { meta: ${!!mods.meta}, ctrl: ${!!mods.ctrl}, alt: ${!!mods.alt}, shift: ${!!mods.shift} });`,
  );
}

export async function scroll(dy, target = null) {
  const t = target ? q(target) : 'null';
  return rpc(`return window.__DS_BRIDGE__.scroll(${t}, ${Number(dy)});`);
}

export async function swipe(from, to, ms = 250) {
  const [x1, y1] = from;
  const [x2, y2] = to;
  return rpc(
    `return await window.__DS_BRIDGE__.swipe([${x1},${y1}], [${x2},${y2}], ${ms});`,
  );
}

export async function back() {
  return rpc(`return window.__DS_BRIDGE__.back();`);
}

export async function reload() {
  return rpc(`window.location.reload(); return { ok: true };`);
}

export async function resetMobileView() {
  return rpc(`return window.__DS_BRIDGE__.resetMobileView();`);
}

export async function errors(clear = false) {
  return rpc(`return window.__DS_BRIDGE__.errors(${clear});`);
}

export async function evalJs(code) {
  return rpc(code);
}

export async function resize(w, h) {
  return rpc(
    `await window.__DS_BRIDGE__.win.setSize(new window.__DS_BRIDGE__.LogicalSize(${w}, ${h})); return { ok: true, w: ${w}, h: ${h} };`,
  );
}

export async function wait(ms = 500) {
  await new Promise((r) => setTimeout(r, Number(ms)));
  return { ok: true, ms: Number(ms) };
}

export function captureWindow(name, opts = {}) {
  const winId = findWindowId();
  if (!winId) return { ok: false, error: 'window not found' };
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const full = path.join(SHOT_DIR, `${name}.png`);
  execFileSync('screencapture', ['-x', '-o', '-l', winId, full]);
  let display = full;
  if (!opts.full) {
    display = path.join(SHOT_DIR, `${name}-s.png`);
    execFileSync('sips', ['-Z', '900', full, '--out', display], { stdio: 'ignore' });
  }
  return { ok: true, path: display, fullPath: full };
}

export function readImageBase64(filePath) {
  return fs.readFileSync(filePath).toString('base64');
}
