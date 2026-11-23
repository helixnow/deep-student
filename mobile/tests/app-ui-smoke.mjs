#!/usr/bin/env node
/**
 * End-to-end UI smoke test for built `mobile/dist` (`--mode app`) simulating Android Capacitor WebView:
 * 1. Android zh-CN fast boot: Chat, Learning Hub drawer, Settings & About — 0 raw i18n keys, 0 console/page errors.
 * 2. Returning-user cold start with 2000ms delayed `zh-CN-*.js`: 0 raw-key flash across every sampled frame.
 * 3. Android en-US boot: 0 raw i18n keys, 0 dock label truncation (e.g. "Flashcards" must fit without ellipsis).
 * 4. Non-native mobile shell (`os: linux`): mounts Mobile Shell cleanly (never empty desktop workbench).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const mobileDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(mobileDir, 'dist');
if (!fs.existsSync(path.join(distDir, 'index.html'))) {
  console.error('[app-ui-smoke] Missing mobile/dist/index.html — run "npm --prefix mobile run build" first.');
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

const RAW_KEY_RE = /\b(?:messageList|input_bar|finder|categories|tabs|apps|resourceType|sidebar|common|settings|chatV2|learningHub|flashcards|todo|skills|mediaStudio|data|sync|pomodoro)\.[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*/g;

let delayZhCnMs = 0;
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '') || 'index.html';
  const full = path.join(distDir, rel);
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  const send = () => {
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    });
    fs.createReadStream(full).pipe(res);
  };
  if (delayZhCnMs > 0 && /zh-CN-.*\.js$/.test(rel)) {
    setTimeout(send, delayZhCnMs);
  } else {
    send();
  }
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ headless: true });

function assertNoRawKeys(label, text) {
  const hits = [...new Set(text.match(RAW_KEY_RE) || [])];
  if (hits.length > 0) {
    throw new Error(`[app-ui-smoke] Raw i18n keys leaked in ${label}: ${JSON.stringify(hits)}`);
  }
}

async function createContext(locale, { nativeAndroid = true } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    locale,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/127.0.6533.103 Mobile Safari/537.36',
  });
  if (nativeAndroid) {
    await ctx.addInitScript(() => {
      window.CapacitorCustomPlatform = { name: 'android' };
      window.Capacitor = {
        PluginHeaders: [
          { name: 'LegacyData', methods: [{ name: 'inspect', rtype: 'promise' }] },
          {
            name: 'DeepStudentNative',
            methods: [
              { name: 'setImmersiveMode', rtype: 'promise' },
              { name: 'getNotificationPermission', rtype: 'promise' },
              { name: 'requestNotificationPermission', rtype: 'promise' },
              { name: 'setNotificationPolicy', rtype: 'promise' },
              { name: 'addListener', rtype: 'promise' },
              { name: 'startShareListener', rtype: 'promise' },
            ],
          },
        ],
        nativePromise: async (p, m) =>
          p === 'LegacyData'
            ? { available: false }
            : m === 'getNotificationPermission'
              ? { state: 'prompt' }
              : m === 'startShareListener'
                ? { shares: [] }
                : {},
        nativeCallback: () => '1',
      };
      window.__DEEP_STUDENT_PENDING_SAFE_AREA__ = [44, 34, 0, 0];
    });
  }
  return ctx;
}

async function dismissOnboarding(page) {
  await page.locator('button:has-text("×")').first().click().catch(() => {});
  await page.locator('button:has-text("我已阅读并同意"), button:has-text("I have read and agree")').first().click().catch(() => {});
  await page.waitForTimeout(700);
  await page.locator('button:has-text("先随便看看"), button:has-text("Just look around"), button:has-text("Explore first"), button:has-text("Skip")').first().click().catch(() => {});
  await page.waitForTimeout(700);
}

try {
  // 1) Android zh-CN fast boot + 0 console errors
  const ctx1 = await createContext('zh-CN');
  const p1 = await ctx1.newPage();
  const errs1 = [];
  p1.on('pageerror', (e) => errs1.push(`pageerror: ${e.message}`));
  p1.on('console', (m) => { if (m.type() === 'error') errs1.push(`console.error: ${m.text()}`); });

  await p1.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await p1.waitForFunction(() => document.body.dataset.ready === 'true', { timeout: 25000 });
  await p1.waitForTimeout(700);
  await dismissOnboarding(p1);

  const chatZh = await p1.evaluate(() => ({
    text: document.body.innerText,
    placeholder: document.querySelector('textarea')?.getAttribute('placeholder') || '',
  }));
  assertNoRawKeys('zh-CN chat', `${chatZh.text}\n${chatZh.placeholder}`);
  if (chatZh.placeholder !== '请输入问题...') {
    throw new Error(`Expected zh-CN placeholder "请输入问题...", got "${chatZh.placeholder}"`);
  }
  if (errs1.length > 0) {
    throw new Error(`Unexpected mobile console/page errors (${errs1.length}): ${errs1.slice(0, 3).join(' | ')}`);
  }
  console.log('[app-ui-smoke] PASS 1/4: Android zh-CN boot (0 raw keys, 0 console errors)');

  // 2) Returning-user cold start with 2000ms delayed zh-CN bundle
  delayZhCnMs = 2000;
  await p1.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  let settledPlaceholder = '';
  for (let i = 0; i < 16; i++) {
    await p1.waitForTimeout(250);
    const snap = await p1.evaluate(() => ({
      text: document.body.innerText,
      placeholder: document.querySelector('textarea')?.getAttribute('placeholder') || '',
    }));
    assertNoRawKeys(`delayed-cold-start-frame-${i}`, `${snap.text}\n${snap.placeholder}`);
    if (snap.placeholder) settledPlaceholder = snap.placeholder;
  }
  if (settledPlaceholder !== '请输入问题...') {
    throw new Error(`Delayed cold start did not settle to zh-CN placeholder: "${settledPlaceholder}"`);
  }
  console.log('[app-ui-smoke] PASS 2/4: Delayed 2000ms zh-CN cold start (0 raw-key flashes)');
  await ctx1.close();

  // 3) Android en-US + dock label truncation check
  delayZhCnMs = 0;
  const ctx2 = await createContext('en-US');
  const p2 = await ctx2.newPage();
  await p2.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await p2.waitForFunction(() => document.body.dataset.ready === 'true', { timeout: 25000 });
  await p2.waitForTimeout(700);
  await dismissOnboarding(p2);

  await p2.locator('button[aria-label="Open sidebar"]').first().click();
  await p2.waitForTimeout(500);
  const enCheck = await p2.evaluate(() => {
    const truncated = [];
    for (const span of document.querySelectorAll('[data-mobile-app-launcher] span')) {
      const r = span.getBoundingClientRect();
      if (r.width > 0 && r.left >= 0 && r.right <= window.innerWidth && span.scrollWidth > span.clientWidth + 2) {
        truncated.push({ text: span.innerText, scrollW: Math.round(span.scrollWidth), clientW: Math.round(span.clientWidth) });
      }
    }
    return { text: document.body.innerText, truncated };
  });
  assertNoRawKeys('en-US drawer', enCheck.text);
  if (enCheck.truncated.length > 0) {
    throw new Error(`English mobile dock labels truncated: ${JSON.stringify(enCheck.truncated)}`);
  }
  console.log('[app-ui-smoke] PASS 3/4: Android en-US drawer (0 raw keys, 0 dock label truncation)');
  await ctx2.close();

  // 4) Non-native mobile shell (os: linux) never renders desktop workbench
  const ctx3 = await createContext('zh-CN', { nativeAndroid: false });
  const p3 = await ctx3.newPage();
  await p3.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await p3.waitForFunction(() => document.body.dataset.ready === 'true', { timeout: 25000 });
  await p3.waitForTimeout(700);
  await dismissOnboarding(p3);
  const linuxCheck = await p3.evaluate(() => ({
    hasWorkbench: Boolean(document.querySelector('.content-body--workbench')),
    placeholder: document.querySelector('textarea')?.getAttribute('placeholder') || '',
  }));
  if (linuxCheck.hasWorkbench || linuxCheck.placeholder !== '请输入问题...') {
    throw new Error(`Non-native mobile shell check failed: ${JSON.stringify(linuxCheck)}`);
  }
  console.log('[app-ui-smoke] PASS 4/4: Non-native mobile shell renders Mobile Shell cleanly');
  await ctx3.close();
} finally {
  await browser.close();
  server.close();
}
