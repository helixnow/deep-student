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

function readRegistry() {
  const src = fs.readFileSync(new URL('../../src/demo/app/registry.ts', import.meta.url), 'utf8');
  const shellStart = src.indexOf('SHELL_DEMOS');
  const apps = [...src.slice(0, shellStart).matchAll(/\{\s*id:\s*'([^']+)'/g)].map((m) => ({ id: m[1], kind: 'app' }));
  const shells = [...src.slice(shellStart).matchAll(/\{\s*id:\s*'([^']+)'[^}]*?(?:width:\s*(\d+)[^}]*?)?entry:\s*'([^']+)'/g)].map(
    (m) => ({ id: m[1], kind: 'shell', width: m[2] ? Number(m[2]) : undefined, entry: m[3] }),
  );
  return [...apps, ...shells];
}

const registry = readRegistry();
const wanted = opt('apps') ? new Set(opt('apps').split(',')) : null;
const demos = registry.filter((d) => !wanted || wanted.has(d.id));
const themes = shotsDir ? ['light', 'dark'] : ['light'];

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const results = [];
let sharp = null;
if (shotsDir) {
  fs.mkdirSync(shotsDir, { recursive: true });
  sharp = (await import('sharp')).default;
}

for (const demo of demos) {
  const { id } = demo;
  for (const theme of themes) {
    const viewport = demo.width ? { width: demo.width, height: Math.round(demo.width * 2) } : { width, height };
    const page = await browser.newPage({ viewport, deviceScaleFactor: shotsDir ? 2 : 1 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 300)}`);
    });
    const q = demo.kind === 'app' ? new URLSearchParams({ app: id }) : new URLSearchParams(demo.entry.split('?')[1] ?? '');
    if (theme === 'dark') q.set('theme', 'dark');
    if (lang) q.set('lang', lang);
    const url = demo.kind === 'app' ? `${base}/demo-app.html?${q}` : `${base}/${demo.entry.split('?')[0]}?${q}`;
    const started = Date.now();
    let ready = false;
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
      if (demo.kind === 'app') {
        await page.waitForFunction(() => window.__DEMO_READY__ === true, null, { timeout: 30_000 });
      } else {
        // 整壳演示没有就绪标记：等自动播放的首答落定（界面文字连续 2.5s 不变），最多 60s
        await page.waitForFunction(
          () => {
            const w = window;
            const len = document.body.innerText.length;
            const now = Date.now();
            if (w.__shotLen !== len) { w.__shotLen = len; w.__shotSince = now; }
            return len > 200 && now - w.__shotSince > 2500;
          },
          null,
          { timeout: 60_000, polling: 250 },
        );
      }
      ready = true;
    } catch (e) {
      errors.push(`not ready: ${e.message.split('\n')[0]}`);
    }
    const state = await page.evaluate(() => ({
      unmocked: window.__DEMO_UNMOCKED__ ?? [],
      missingI18n: window.__DEMO_MISSING_I18N__ ?? [],
      errorPage: Boolean(document.querySelector('[data-demo-error], .demo-app-message')),
      text: (document.querySelector('[data-demo-app-frame]') ?? document.getElementById('root'))?.textContent?.trim().length ?? 0,
    })).catch(() => ({ unmocked: [], missingI18n: [], errorPage: true, text: 0 }));
    const r = { id, kind: demo.kind, theme, ms: Date.now() - started, ready, ...state, errors };
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
  const soft = r.kind === 'app' && (r.errors.length > 0 || r.unmocked.length > 0 || r.missingI18n.length > 0);
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
