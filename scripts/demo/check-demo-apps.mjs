#!/usr/bin/env node
/**
 * 单应用演示（demo-app.html?app=<id>）烟测 + 海报截图。
 *
 * 逐个打开 src/demo/app/registry.ts 里的演示，等它发出就绪信号，检查：
 *   - 没有落到错误页（ErrorBoundary / 启动失败提示）
 *   - 没有未处理的页面异常、console.error
 *   - 没有 mock 漏掉的 IPC 命令（window.__DEMO_UNMOCKED__）
 *   - 没有缺失的文案键（window.__DEMO_MISSING_I18N__，多半是包没声明命名空间）
 * 加 --shots <目录> 时按浅色 / 深色各拍一张海报（webp），官网嵌入前先显示它。
 *
 * 用法：
 *   node scripts/demo/check-demo-apps.mjs --base http://127.0.0.1:1423 [--apps a,b] [--shots dir] [--lang en]
 *   （--base 指向 dev:demo 或 dist-demo 的静态服务）
 * 退出码：有任何一项不过就是 1。--lenient 时只有错误页 / 页面异常才算失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

const base = opt('base', 'http://127.0.0.1:1423').replace(/\/$/, '');
const shotsDir = opt('shots');
const lang = opt('lang');
const lenient = flag('lenient');
const width = Number(opt('width', 1120));
const height = Number(opt('height', 700));

function registryIds() {
  const src = fs.readFileSync(new URL('../../src/demo/app/registry.ts', import.meta.url), 'utf8');
  return [...src.matchAll(/\{\s*id:\s*'([^']+)'/g)].map((m) => m[1]);
}

const ids = opt('apps') ? opt('apps').split(',') : registryIds();
const themes = shotsDir ? ['light', 'dark'] : ['light'];

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const results = [];
let sharp = null;
if (shotsDir) {
  fs.mkdirSync(shotsDir, { recursive: true });
  sharp = (await import('sharp')).default;
}

for (const id of ids) {
  for (const theme of themes) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: shotsDir ? 2 : 1 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 300)}`);
    });
    const q = new URLSearchParams({ app: id });
    if (theme === 'dark') q.set('theme', 'dark');
    if (lang) q.set('lang', lang);
    const url = `${base}/demo-app.html?${q}`;
    const started = Date.now();
    let ready = false;
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
      await page.waitForFunction(() => window.__DEMO_READY__ === true, null, { timeout: 30_000 });
      ready = true;
    } catch (e) {
      errors.push(`not ready: ${e.message.split('\n')[0]}`);
    }
    const state = await page.evaluate(() => ({
      unmocked: window.__DEMO_UNMOCKED__ ?? [],
      missingI18n: window.__DEMO_MISSING_I18N__ ?? [],
      errorPage: Boolean(document.querySelector('[data-demo-error], .demo-app-message')),
      text: (document.querySelector('[data-demo-app-frame]')?.textContent ?? '').trim().length,
    })).catch(() => ({ unmocked: [], missingI18n: [], errorPage: true, text: 0 }));
    const r = { id, theme, ms: Date.now() - started, ready, ...state, errors };
    if (shotsDir && ready) {
      // 就绪后再给动画半秒
      await page.waitForTimeout(500);
      const png = await page.screenshot({ type: 'png' });
      const out = path.join(shotsDir, `${id}-${theme}.webp`);
      await sharp(png).webp({ quality: 82 }).toFile(out);
      r.shot = out;
    }
    results.push(r);
    await page.close();
  }
}
await browser.close();

let failed = 0;
for (const r of results) {
  const hard = !r.ready || r.errorPage || r.text === 0 || r.errors.some((e) => e.startsWith('pageerror'));
  const soft = r.errors.length > 0 || r.unmocked.length > 0 || r.missingI18n.length > 0;
  const bad = hard || (!lenient && soft);
  if (bad) failed++;
  console.log(`${bad ? '✗' : '✓'} ${r.id} [${r.theme}] ${r.ms}ms${r.shot ? ` → ${r.shot}` : ''}`);
  if (r.errorPage) console.log('    error page shown');
  if (r.text === 0) console.log('    nothing rendered');
  for (const e of r.errors.slice(0, 8)) console.log(`    ${e}`);
  if (r.unmocked.length) console.log(`    unmocked: ${r.unmocked.join(', ')}`);
  if (r.missingI18n.length) console.log(`    missing i18n (${r.missingI18n.length}): ${r.missingI18n.slice(0, 12).join(', ')}`);
}
if (opt('json')) fs.writeFileSync(opt('json'), JSON.stringify(results, null, 2));
process.exit(failed ? 1 : 0);
