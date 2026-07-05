#!/usr/bin/env node
/**
 * 移动 UI 自动审查 — 不依赖 Cursor MCP，直接走 ui-drive-core。
 * 用法：node scripts/dev/ui-audit-mobile.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  status,
  snapshot,
  formatSnapshot,
  click,
  back,
  errors,
  wait,
  captureWindow,
  scroll,
  evalJs,
} from './ui-drive-core.mjs';

const OUT = process.env.DS_AUDIT_DIR || '/tmp/ds-mobile-audit';
const SHOTS = path.join(OUT, 'shots');
const REPORT = path.join(OUT, 'report-2026-07-05.md');

const issues = [];
let step = 0;

async function snap(label) {
  step++;
  const name = `${String(step).padStart(2, '0')}-${label}`;
  const shot = captureWindow(name);
  const snapResult = await snapshot();
  const errs = await errors();
  const recentErrs = (errs.value || errs.data || []).filter(
    (e) => e.kind === 'error' || e.kind === 'uncaught',
  );
  if (recentErrs.length) {
    issues.push({
      screen: label,
      type: 'console',
      detail: recentErrs.slice(-3).map((e) => e.text).join('; '),
    });
  }
  return { name, shot, snap: snapResult.value || snapResult, recentErrs };
}

async function tryClick(text, opts = {}) {
  const r = await click(text, { tap: true, ...opts });
  const data = r.value || r;
  if (data?.ok === false) {
    const js = await evalJs(`
      const wanted = ${JSON.stringify(text)};
      const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
      const btn = Array.from(document.querySelectorAll('button')).find((b) => norm(b.textContent).includes(norm(wanted)));
      if (btn) { btn.click(); return { ok: true }; }
      return { ok: false };
    `);
    if (!(js.value || js)?.ok) {
      issues.push({ screen: text, type: 'navigation', detail: data.error || 'click failed' });
      return false;
    }
  }
  await wait(opts.waitMs || 800);
  return true;
}

async function dismissOverlays() {
  for (const label of ['我已阅读并同意', '先随便看看', '关闭']) {
    const r = await click(label, { tap: true });
    if ((r.value || r)?.ok) {
      await wait(600);
    }
  }
}

async function openSidebar() {
  const s = await snapshot();
  const els = (s.value || s)?.elements || [];
  const btn = els.find((e) => e.name.includes('展开侧边栏') || e.name.includes('打开侧边栏'));
  if (btn) {
    await click(btn.ref, { tap: true });
    await wait(500);
    return true;
  }
  return false;
}

async function closeSidebar() {
  const s = await snapshot();
  const els = (s.value || s)?.elements || [];
  const btn = els.find((e) => e.name.includes('关闭侧边栏'));
  if (btn) {
    await click(btn.ref, { tap: true });
    await wait(400);
  }
}

const NAV_ITEMS = [
  { label: '新会话', key: 'chat-home' },
  { label: '学习资源', key: 'learning-hub' },
  { label: '待办', key: 'todo' },
  { label: '技能管理', key: 'skills' },
  { label: '制卡任务', key: 'task-dashboard' },
  { label: '模板管理', key: 'templates' },
  { label: '设置', key: 'settings' },
];

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const st = await status();
  if (!st.connected) {
    console.error('Bridge not connected. Run: npm run ui:lab');
    process.exit(1);
  }

  const pages = [];

  await dismissOverlays();
  pages.push({ ...(await snap('chat-home-initial')), nav: 'chat' });

  for (const item of NAV_ITEMS) {
    await openSidebar();
    const ok = await tryClick(item.label);
    if (!ok) continue;
    await closeSidebar();
    const page = await snap(item.key);
    pages.push({ ...page, nav: item.label });

    // 设置页多滚一屏
    if (item.key === 'settings') {
      await scroll(400);
      await wait(300);
      pages.push({ ...(await snap('settings-scrolled')), nav: '设置(滚动)' });
    }
    if (item.key === 'learning-hub') {
      await scroll(300);
      pages.push({ ...(await snap('learning-hub-scrolled')), nav: '学习资源(滚动)' });
    }
  }

  // 数据管理：从设置找入口
  await openSidebar();
  await tryClick('设置');
  await closeSidebar();
  await wait(500);
  const settingsSnap = await snapshot();
  const dataEntry = (settingsSnap.value || settingsSnap)?.elements?.find(
    (e) => e.name.includes('数据') || e.name.includes('备份') || e.name.includes('导入'),
  );
  if (dataEntry) {
    await tryClick(dataEntry.ref);
    pages.push({ ...(await snap('data-management')), nav: '数据管理' });
  }

  // 写报告
  const lines = [
    '# Deep Student 移动 UI 实测审查（2026-07-05）',
    '',
    `环境：${st.windowId ? `window ${st.windowId}` : 'unknown'} · 400×880 · ui-drive CLI`,
    '',
    '## 截图索引',
    '',
  ];
  for (const p of pages) {
    const rel = p.shot?.path ? path.basename(p.shot.path) : p.name;
    lines.push(`- **${p.nav}** → \`shots/${rel}\``);
    const headings = p.snap?.headings?.join(' | ');
    if (headings) lines.push(`  - 标题：${headings}`);
    lines.push(`  - 可交互元素：${p.snap?.count ?? '?'}`);
  }

  lines.push('', '## 发现的问题', '');
  if (!issues.length) {
    lines.push('_本轮自动探测未捕获控制台 error；详见各截图人工复核。_');
  } else {
    for (const i of issues) {
      lines.push(`- **[${i.type}] ${i.screen}**：${i.detail}`);
    }
  }

  lines.push('', '## 快照样例（最后一屏）', '', '```', formatSnapshot({ ok: true, value: pages.at(-1)?.snap }), '```');

  fs.writeFileSync(REPORT, lines.join('\n'));
  console.log(`Report: ${REPORT}`);
  console.log(`Shots:  ${SHOTS}`);
  console.log(`Issues: ${issues.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
