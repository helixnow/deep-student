#!/usr/bin/env node
/**
 * 用户指南全章静态截图生成器（桌面版 + 移动版，浅色 + 深色）。
 *
 * 一次命令自动拉起隔离的演示前端（vite.demo.config.ts）与自托管 WebUI（临时数据目录），
 * 使用预置的丰富学生学习示例数据，为全部 20 个指南章节渲染并截取 2× Retina WebP 静态图，
 * 同时生成 docs/user-guide/images/manifest.json 供官网 ds-web 自动同步渲染。
 *
 * 用法：
 *   npm run docs:screenshots                                 # 全量重截全部章节
 *   npm run docs:screenshots -- --chapters chat,models       # 只重截指定章节（合并进 manifest）
 *   npm run docs:screenshots -- --themes light               # 只截浅色主题
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DEFAULT_OUT = path.join(ROOT, 'docs/user-guide/images');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};

const OUT_DIR = path.resolve(opt('out', DEFAULT_OUT));
const THEMES = opt('themes', 'light,dark').split(',').filter(Boolean);
const ONLY_CHAPTERS = opt('chapters') ? new Set(opt('chapters').split(',').filter(Boolean)) : null;

const DEMO_PORT = Number(opt('demo-port', 1438));
const WEB_PORT = Number(opt('web-port', 1439));
const WEB_TOKEN = 'docs-screenshots-token-local';
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const HIDE_DEV_CSS = `
  button[aria-label="打开调试面板"],
  button[aria-label*="Open Debug" i],
  button[aria-label*="Debug Panel" i],
  button[title*="调试面板"],
  button[title*="Debug Panel" i] {
    display: none !important;
    visibility: hidden !important;
  }
`;

/**
 * 全部 20 个指南章节的截图清单（桌面版 / 移动版覆盖策略与中文图注）。
 * - kind: 'app'   → 单应用剧本包（demo-app.html?app=<id>），内置真实学生示例数据
 * - kind: 'shell' → 整壳演示（demo.html），含多窗口学习桌面与完整移动端对话
 * - kind: 'webui' → 真实隔离 WebUI 宿主（web/server/main.ts），覆盖自托管桌面与移动壳
 */
const CHAPTER_SPECS = [
  {
    id: 'workbench',
    kind: 'shell',
    entry: 'demo.html?desktop=1',
    title: '学习桌面',
    caption: '多窗口并排协作：左侧 AI 对话与制卡产物，中间 FSRS-6 闪卡今日复习，右侧日历与 AI 学习简报同屏联动。',
    desktop: true,
    mobile: false,
    desktopSize: { width: 1280, height: 800 },
  },
  {
    id: 'chat',
    kind: 'app',
    title: 'AI 对话与会话管理',
    caption: '《机器学习系统》第 3 章精读示例：带 PDF 页码引用徽章、资料检索块与学习产物联动。',
    desktop: true,
    mobile: true,
  },
  {
    id: 'research-memory',
    kind: 'app',
    title: '深度调研与智能记忆',
    caption: '联网深度调研与长期学习记忆示例：多步检索来源溯源与学习空间记忆管理。',
    desktop: true,
    mobile: true,
  },
  {
    id: 'learning-hub',
    kind: 'app',
    title: '资源库',
    caption: '学习资料统一管理示例：PDF 教材、讲义笔记、学科文件夹与知识库索引状态。',
    desktop: true,
    mobile: true,
  },
  {
    id: 'reading-translation',
    kind: 'app',
    title: '文档阅读与翻译',
    caption: '论文精读与双语对照翻译示例：原文排版、逐段译文与划词即时提问联动。',
    desktop: true,
    mobile: true,
  },
  {
    id: 'media',
    kind: 'app',
    title: '音视频',
    caption: '网课与讲座陪学示例：带时间戳的字幕轴、重点摘录与图文讲义整理。',
    desktop: true,
    mobile: true,
  },
  {
    id: 'paper-search',
    kind: 'app',
    title: '论文搜索',
    caption: '学术论文检索示例：多库联合搜索、摘要速览与一键入库精读。',
    desktop: true,
    mobile: true,
  },
  {
    id: 'notes',
    kind: 'app',
    title: '笔记',
    caption: '双链 Markdown 笔记示例：数学公式、反向链接、大纲导航与属性面板。',
    desktop: true,
    mobile: true,
  },
  {
    id: 'mindmap',
    kind: 'app',
    title: '思维导图',
    caption: '高等数学微分中值定理导图示例：多色分支结构、大纲双视图与背诵遮挡。',
    desktop: true,
    mobile: true,
  },
  {
    id: 'essay',
    kind: 'app',
    title: '作文批改',
    caption: '雅思 / 考研英语作文批改示例：逐句红蓝批注、分项评分与范文润色对比。',
    desktop: true,
    mobile: true,
  },
  {
    id: 'productivity',
    kind: 'app',
    title: '待办、番茄钟与命令面板',
    caption: '学习计划与专注节奏示例：四象限待办清单、番茄钟计时与学习统计。',
    desktop: true,
    mobile: true,
  },
  {
    id: 'question-bank',
    kind: 'app',
    title: '题目集与练习',
    caption: '高等数学题目集示例：15 道精选题目、掌握度统计、题型筛选与错题复习。',
    desktop: true,
    mobile: true,
  },
  {
    id: 'anki',
    kind: 'app',
    title: 'Anki 制卡与模板',
    caption: '对话式制卡与模板示例：正面/反面实时预览、牌组归档与 .apkg 导出。',
    desktop: true,
    mobile: true,
  },
  {
    id: 'flashcards',
    kind: 'app',
    title: '闪卡复习',
    caption: 'FSRS-6 每日复习示例：今日待复习进度环、新卡与复习队列统计。',
    desktop: true,
    mobile: true,
  },
  {
    id: 'models',
    kind: 'app',
    title: '模型与供应商配置',
    caption: '15 家预置模型服务与本机 Ollama 示例：已配置硅基流动、DeepSeek 与月之暗面并分配全套槽位。',
    desktop: true,
    mobile: true,
  },
  {
    id: 'skills-mcp',
    kind: 'app',
    title: '技能与 MCP 扩展',
    caption: '58 个内置技能与 MCP 服务器管理示例：技能分组启用与外部工具连接状态。',
    desktop: true,
    mobile: true,
  },
  {
    id: 'data-sync',
    kind: 'app',
    title: '数据管理与云同步',
    caption: '数据治理与备份示例：近一周本地备份列表、分层归档与自动备份策略。',
    desktop: true,
    mobile: true,
  },
  {
    id: 'plugin-workshop',
    kind: 'app',
    title: 'AI 插件工坊与插件管理',
    caption: '插件工坊与统一管理示例：自然语言创作栏、3 个自制/社区学习插件卡片、5 组内置能力与渠道插件。',
    desktop: true,
    mobile: false,
  },
  {
    id: 'mobile',
    kind: 'shell',
    entry: 'demo.html',
    title: '移动端指南',
    caption: '手机端单手对话与学习卡片流示例：专为 390px 触屏优化的对话、检索与复习体验。',
    desktop: false,
    mobile: true,
  },
  {
    id: 'webui-pwa',
    kind: 'webui',
    title: 'WebUI 与 PWA 自托管',
    caption: '浏览器自托管工作台示例：电脑浏览器完整学习桌面，手机浏览器自动切换移动端自适应壳。',
    desktop: true,
    mobile: true,
  },
];

async function waitForHttp(url, { timeoutMs = 60_000, server = null } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (server && server.child.exitCode !== null) {
      throw new Error(`Server exited early (${server.child.exitCode}) while waiting for ${url}:\n${server.getLogs()}`);
    }
    try {
      const res = await fetch(url, { redirect: 'manual' });
      if (res.status < 500) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  const extra = server ? `\nServer logs:\n${server.getLogs()}` : '';
  throw new Error(`Timed out waiting for ${url}${extra}`);
}

async function waitForLog(server, needle, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (server.getLogs().includes(needle)) return;
    if (server.child.exitCode !== null) {
      throw new Error(`Server exited early (${server.child.exitCode}) while waiting for "${needle}":\n${server.getLogs()}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timed out waiting for log "${needle}":\n${server.getLogs()}`);
}

function startChild(cmd, args, env = {}) {
  const child = spawn(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout?.on('data', (d) => {
    logs = (logs + d.toString()).slice(-4000);
  });
  child.stderr?.on('data', (d) => {
    logs = (logs + d.toString()).slice(-4000);
  });
  return {
    child,
    getLogs: () => logs,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', resolve);
        child.kill('SIGTERM');
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
          resolve();
        }, 3000);
      }),
  };
}

async function cleanDevOverlays(page) {
  await page.addStyleTag({ content: HIDE_DEV_CSS }).catch(() => {});
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('button, div, span')) {
      const text = (el.textContent || '').trim();
      const s = getComputedStyle(el);
      if (text === 'DEV' && (s.position === 'fixed' || el.tagName === 'BUTTON')) {
        el.style.display = 'none';
        if (el.parentElement && getComputedStyle(el.parentElement).position === 'fixed') {
          el.parentElement.style.display = 'none';
        }
      }
    }
  });
}

async function saveWebp(page, fileName, maxWidth) {
  await cleanDevOverlays(page);
  await page.mouse.move(4, 4).catch(() => {});
  await page.waitForTimeout(450);
  const png = await page.screenshot({ type: 'png', fullPage: false });
  const outPath = path.join(OUT_DIR, fileName);
  await sharp(png)
    .resize({ width: maxWidth, withoutEnlargement: true })
    .webp({ quality: 82 })
    .toFile(outPath);
  const kb = (fs.statSync(outPath).size / 1024).toFixed(1);
  return { fileName, kb };
}

async function waitForDemoReady(page, kind) {
  if (kind === 'app') {
    await page.waitForFunction(() => window.__DEMO_READY__ === true, null, { timeout: 35_000 });
    await page.waitForTimeout(450);
    return;
  }
  await page.waitForFunction(
    () => {
      const w = window;
      const len = document.body.innerText.length;
      const now = Date.now();
      if (w.__shotLen !== len) {
        w.__shotLen = len;
        w.__shotSince = now;
      }
      return len > 180 && now - w.__shotSince > 2200;
    },
    null,
    { timeout: 60_000, polling: 250 },
  );
  await page.waitForTimeout(500);
}

async function captureDemoShot(browser, baseUrl, spec, formFactor, theme) {
  const isMobile = formFactor === 'mobile';
  const viewport = isMobile
    ? { width: 390, height: 844 }
    : spec.desktopSize ?? { width: 1120, height: 700 };
  const ctx = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    locale: 'zh-CN',
    ...(isMobile ? { isMobile: true, hasTouch: true, userAgent: MOBILE_UA } : {}),
  });
  const page = await ctx.newPage();
  const q =
    spec.kind === 'app'
      ? new URLSearchParams({ app: spec.id })
      : new URLSearchParams(spec.entry.split('?')[1] ?? '');
  if (theme === 'dark') q.set('theme', 'dark');
  const url =
    spec.kind === 'app'
      ? `${baseUrl}/demo-app.html?${q}`
      : `${baseUrl}/${spec.entry.split('?')[0]}?${q}`;
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
    await waitForDemoReady(page, spec.kind);
    const hasError = await page.locator('[data-demo-error], .demo-app-message').count();
    if (hasError > 0) {
      const msg = await page.locator('body').innerText();
      throw new Error(`Demo ${spec.id} (${formFactor}/${theme}) rendered error page: ${msg.slice(0, 200)}`);
    }
    const fileName = `${spec.id}-${formFactor}-${theme}.webp`;
    const res = await saveWebp(page, fileName, isMobile ? 780 : 1440);
    return { ...res, ok: true };
  } finally {
    await ctx.close();
  }
}

async function captureWebuiShots(browser, baseUrl, themes) {
  const outputs = { desktop: {}, mobile: {} };
  for (const theme of themes) {
    // Desktop WebUI
    {
      const ctx = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 2,
        locale: 'zh-CN',
        colorScheme: theme,
      });
      const page = await ctx.newPage();
      await page.addInitScript((t) => {
        localStorage.setItem('dstu-theme-mode', t);
      }, theme);
      await page.goto(`${baseUrl}/?token=${WEB_TOKEN}`, { waitUntil: 'networkidle', timeout: 60_000 });
      await page.waitForTimeout(1800);
      const agree = page.getByRole('button', { name: /我已阅读并同意|Agree/i }).first();
      if (await agree.isVisible().catch(() => false)) {
        await agree.click();
        await page.waitForTimeout(1200);
      }
      const skip = page.getByText(/先随便看看|Just look around/i).first();
      if (await skip.isVisible().catch(() => false)) {
        await skip.click();
        await page.waitForTimeout(900);
      }
      await page.evaluate((t) => {
        document.documentElement.classList.toggle('dark', t === 'dark');
        document.documentElement.setAttribute('data-theme', t);
      }, theme);
      const fileName = `webui-pwa-desktop-${theme}.webp`;
      const res = await saveWebp(page, fileName, 1440);
      outputs.desktop[theme] = res.fileName;
      console.log(`✓ webui-pwa [desktop/${theme}] → ${res.fileName} (${res.kb} KB)`);
      await ctx.close();
    }

    // Mobile WebUI (?shell=mobile with drawer open)
    {
      const ctx = await browser.newContext({
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        locale: 'zh-CN',
        isMobile: true,
        hasTouch: true,
        userAgent: MOBILE_UA,
        colorScheme: theme,
      });
      const page = await ctx.newPage();
      await page.addInitScript((t) => {
        localStorage.setItem('dstu-theme-mode', t);
      }, theme);
      await page.goto(`${baseUrl}/?token=${WEB_TOKEN}&shell=mobile`, { waitUntil: 'networkidle', timeout: 60_000 });
      await page.waitForTimeout(1800);
      const skip = page.getByText(/先随便看看|Just look around/i).first();
      if (await skip.isVisible().catch(() => false)) {
        await skip.click();
        await page.waitForTimeout(800);
      }
      await page.evaluate((t) => {
        document.documentElement.classList.toggle('dark', t === 'dark');
        document.documentElement.setAttribute('data-theme', t);
      }, theme);
      await page.mouse.click(34, 28);
      await page.waitForTimeout(800);
      const fileName = `webui-pwa-mobile-${theme}.webp`;
      const res = await saveWebp(page, fileName, 780);
      outputs.mobile[theme] = res.fileName;
      console.log(`✓ webui-pwa [mobile/${theme}] → ${res.fileName} (${res.kb} KB)`);
      await ctx.close();
    }
  }
  return outputs;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const selected = CHAPTER_SPECS.filter((s) => !ONLY_CHAPTERS || ONLY_CHAPTERS.has(s.id));
  if (!selected.length) {
    throw new Error(`No chapters matched --chapters=${opt('chapters')}`);
  }

  const demoSpecs = selected.filter((s) => s.kind === 'app' || s.kind === 'shell');
  const webuiSpecs = selected.filter((s) => s.kind === 'webui');
  const manifestPath = path.join(OUT_DIR, 'manifest.json');
  const existingManifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    : { version: PKG.version, chapters: {} };

  const chapters = { ...(existingManifest.chapters ?? {}) };
  const browser = await chromium.launch(
    process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {},
  );

  try {
    // 阶段 1：运行演示前端（与 WebUI 分开运行，避免双 Vite 实例争抢 node_modules/.vite 预构建锁）
    if (demoSpecs.length > 0) {
      console.log(`[docs:screenshots] 启动演示前端 http://127.0.0.1:${DEMO_PORT} ...`);
      const demoServer = startChild('npx', [
        'vite',
        '--config',
        'vite.demo.config.ts',
        '--host',
        '127.0.0.1',
        '--port',
        String(DEMO_PORT),
        '--strictPort',
      ]);
      try {
        await waitForHttp(`http://127.0.0.1:${DEMO_PORT}/demo-app.html`, { server: demoServer });
        for (const spec of demoSpecs) {
          const entry = { title: spec.title, caption: spec.caption };
          if (spec.desktop) {
            entry.desktop = { ...(chapters[spec.id]?.desktop ?? {}) };
            for (const theme of THEMES) {
              const res = await captureDemoShot(
                browser,
                `http://127.0.0.1:${DEMO_PORT}`,
                spec,
                'desktop',
                theme,
              );
              entry.desktop[theme] = res.fileName;
              console.log(`✓ ${spec.id} [desktop/${theme}] → ${res.fileName} (${res.kb} KB)`);
            }
          }
          if (spec.mobile) {
            entry.mobile = { ...(chapters[spec.id]?.mobile ?? {}) };
            for (const theme of THEMES) {
              const res = await captureDemoShot(
                browser,
                `http://127.0.0.1:${DEMO_PORT}`,
                spec,
                'mobile',
                theme,
              );
              entry.mobile[theme] = res.fileName;
              console.log(`✓ ${spec.id} [mobile/${theme}] → ${res.fileName} (${res.kb} KB)`);
            }
          }
          chapters[spec.id] = entry;
        }
      } finally {
        await demoServer.stop();
      }
    }

    // 阶段 2：运行隔离自托管 WebUI 宿主（仅当需要截取 webui-pwa 时启动）
    if (webuiSpecs.length > 0) {
      const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-docs-webui-'));
      console.log(`[docs:screenshots] 启动隔离 WebUI http://127.0.0.1:${WEB_PORT} ...`);
      const webServer = startChild('node', ['web/server/main.ts'], {
        DS_APP_DATA_DIR: tempDataDir,
        DS_WEB_HOST: '127.0.0.1',
        DS_WEB_PORT: String(WEB_PORT),
        DS_WEB_TOKEN: WEB_TOKEN,
      });
      try {
        await waitForLog(webServer, 'WebUI + PWA ready');
        for (const spec of webuiSpecs) {
          const shots = await captureWebuiShots(browser, `http://127.0.0.1:${WEB_PORT}`, THEMES);
          chapters[spec.id] = {
            title: spec.title,
            caption: spec.caption,
            desktop: { ...(chapters[spec.id]?.desktop ?? {}), ...shots.desktop },
            mobile: { ...(chapters[spec.id]?.mobile ?? {}), ...shots.mobile },
          };
        }
      } finally {
        await webServer.stop();
        fs.rmSync(tempDataDir, { recursive: true, force: true });
      }
    }
  } finally {
    await browser.close();
  }

  // Keep manifest chapters ordered by CHAPTER_SPECS
  const orderedChapters = {};
  for (const spec of CHAPTER_SPECS) {
    if (chapters[spec.id]) orderedChapters[spec.id] = chapters[spec.id];
  }
  const manifest = {
    version: PKG.version,
    generatedAt: new Date().toISOString(),
    chapters: orderedChapters,
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`\n[docs:screenshots] 完成！已写入 ${manifestPath}（共 ${Object.keys(orderedChapters).length} 章）`);
}

main().catch((err) => {
  console.error('[docs:screenshots] 失败:', err);
  process.exit(1);
});
