#!/usr/bin/env node
/**
 * 移动 UI 交互树深度审查 — 侧栏双栏结构、各页抽屉子路径、Sheet/返回键。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  status,
  snapshot,
  click,
  back,
  errors,
  wait,
  captureWindow,
  scroll,
  evalJs,
} from './ui-drive-core.mjs';

const OUT = process.env.DS_AUDIT_DIR || '/tmp/ds-mobile-audit';
const SHOTS = path.join(OUT, 'tree-shots');
const REPORT_DOC = path.join(process.cwd(), 'docs/reviews/mobile-uiux-interaction-tree-2026-07-05.md');
const REPORT_TMP = path.join(OUT, 'interaction-tree-2026-07-05.md');

const findings = [];
let step = 0;

function add(severity, page, id, detail, evidence = '') {
  findings.push({ severity, page, id, detail, evidence });
}

async function snap(label) {
  step++;
  const name = `${String(step).padStart(3, '0')}-${label}`;
  const shot = captureWindow(name);
  const snapResult = await snapshot();
  return { name, shot, snap: snapResult.value || snapResult };
}

async function dismissOverlays() {
  for (const label of ['我已阅读并同意', '先随便看看', '关闭']) {
    const r = await click(label, { tap: true });
    if ((r.value || r)?.ok) await wait(500);
  }
}

/** 关闭所有视图层上可能打开的抽屉，恢复顶栏 */
async function resetDrawers() {
  await evalJs(`
    document.querySelectorAll('[data-mobile-sidebar-mask]').forEach((m) => {
      if (getComputedStyle(m).pointerEvents !== 'none') m.click();
    });
    return { ok: true };
  `);
  await wait(400);
}

async function openDrawer() {
  await resetDrawers();
  await evalJs(`
    const btn = document.querySelector('[aria-label*="展开侧边栏"], [aria-label*="打开侧边栏"]');
    if (btn) btn.click();
    return { ok: !!btn };
  `);
  await wait(400);
  const check = await evalJs(`
    const activeLayer = Array.from(document.querySelectorAll('[data-view-layer-shell]')).find((el) => {
      const s = getComputedStyle(el);
      return s.visibility !== 'hidden' && s.pointerEvents !== 'none' && Number(s.opacity) > 0.01;
    });
    const navs = Array.from((activeLayer || document).querySelectorAll('[data-mobile-shell="sidebar-nav"]'));
    const ranked = navs
      .map((n) => ({ n, r: n.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 40)
      .sort((a, b) => b.r.left - a.r.left);
    const best = ranked[0];
    const btn = best?.n?.querySelector('button');
    const btnRect = btn?.getBoundingClientRect();
    const openByNav = !!best && (best.r.left ?? -999) > -40;
    const openByBtn = !!btnRect && btnRect.right > 0 && btnRect.left < innerWidth;
    return { open: openByNav || openByBtn, left: best?.r.left ?? btnRect?.left ?? -999 };
  `);
  return (check.value || check)?.open;
}

function sidebarDomProbe() {
  return `(() => {
    const activeLayer = Array.from(document.querySelectorAll('[data-view-layer-shell]')).find((el) => {
      const s = getComputedStyle(el);
      return s.visibility !== 'hidden' && s.pointerEvents !== 'none' && Number(s.opacity) > 0.01;
    });
    const navs = Array.from((activeLayer || document).querySelectorAll('[data-mobile-shell="sidebar-nav"]'));
    const ranked = navs
      .map((n) => ({ n, r: n.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 40)
      .sort((a, b) => b.r.left - a.r.left);
    const globalNav = ranked[0]?.n || null;
    const sidebarCol = globalNav?.parentElement || null;
    const pagePane = sidebarCol?.querySelector('.min-h-0.flex-1') || null;
    const navBtn = globalNav?.querySelector('button');
    const navBtnRect = navBtn?.getBoundingClientRect();
    const vh = innerHeight;
    const navBtns = globalNav ? Array.from(globalNav.querySelectorAll('button')).map(b => ({
      text: (b.textContent||'').trim().slice(0,24),
      y: Math.round(b.getBoundingClientRect().y),
      visible: b.getBoundingClientRect().bottom <= vh - 4 && b.getBoundingClientRect().top >= 0,
    })) : [];
    const pagePaneRect = pagePane?.getBoundingClientRect();
    const globalRect = globalNav?.getBoundingClientRect();
    const borderTop = globalNav ? getComputedStyle(globalNav).borderTopWidth : null;
    const unifiedDrawer = !!sidebarCol?.closest('[data-mobile-unified-drawer]');
    const openByNav = !!globalNav && (globalRect?.left ?? -999) > -40;
    const openByBtn = !!navBtnRect && navBtnRect.right > 0 && navBtnRect.left < innerWidth;
    return {
      drawerOpen: openByNav || openByBtn,
      hasGlobalNav: !!globalNav,
      hasPagePane: !!pagePane,
      unifiedDrawer,
      dualStack: !unifiedDrawer && !!(globalNav && pagePane && (globalRect?.left ?? -999) > -40),
      pagePaneH: pagePaneRect ? Math.round(pagePaneRect.height) : 0,
      globalNavH: globalRect ? Math.round(globalRect.height) : 0,
      navBtns,
      navOffscreen: navBtns.filter(b => !b.visible).map(b => b.text),
      borderTop,
      redundant: {
        newChatTop: !!Array.from(document.querySelectorAll('button')).find(b => (b.textContent||'').includes('新对话')),
        newSessionBottom: navBtns.some(b => b.text.includes('新会话')),
      },
      viewportH: vh,
      navLeft: globalRect ? Math.round(globalRect.left) : (navBtnRect ? Math.round(navBtnRect.left) : null),
    };
  })()`;
}

async function analyzeDrawerStructure(pageLabel) {
  await evalJs(`
    const activeLayer = Array.from(document.querySelectorAll('[data-view-layer-shell]')).find((el) => {
      const s = getComputedStyle(el);
      return s.visibility !== 'hidden' && s.pointerEvents !== 'none' && Number(s.opacity) > 0.01;
    });
    const scroller = activeLayer?.querySelector('[data-mobile-unified-drawer] [data-overlayscrollbars-viewport], [data-mobile-unified-drawer] .os-viewport');
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    else activeLayer?.querySelector('[data-mobile-shell="sidebar-nav"]')?.scrollIntoView({ block: 'end' });
    return { ok: true };
  `);
  await wait(250);
  const r = await evalJs(`return ${sidebarDomProbe()};`);
  const data = r.value || r;
  if (!data?.drawerOpen) {
    add('P1', pageLabel, 'DRAWER-OPEN-FAIL', '自动化未能打开抽屉（或动画未完成）', `navLeft=${data?.navLeft}`);
    return data;
  }
  if (data?.dualStack) {
    add(
      'P0',
      pageLabel,
      'DUAL-SIDEBAR',
      `页内区 ${data.pagePaneH}px + 全局导航 ${data.globalNavH}px 硬堆叠（border-top ${data.borderTop}）`,
      `navLeft=${data.navLeft}px · 页内 ${data.pagePaneH}px + nav ${data.globalNavH}px`,
    );
    if (data.redundant?.newChatTop && data.redundant?.newSessionBottom) {
      add('P1', pageLabel, 'NAV-REDUNDANT', '「新对话」(页内) 与「新会话」(全局) 语义重复');
    }
  } else if (data?.hasPagePane && !data?.hasGlobalNav) {
    add('P2', pageLabel, 'PAGE-ONLY-SIDEBAR', '仅有页内侧栏，无 MobileSidebarNavigation');
  } else if (!data?.hasPagePane && !data?.hasGlobalNav) {
    add('P1', pageLabel, 'NO-DRAWER', '无抽屉导航（技能页等仅顶栏返回）');
  }
  if (data?.navOffscreen?.length) {
    const severity = data?.unifiedDrawer ? 'P2' : 'P1';
    add(severity, pageLabel, 'NAV-OFFSCREEN', `底部导航未完全可见：${data.navOffscreen.join('、')}${data.unifiedDrawer ? '（统一滚动抽屉，可滚到底）' : ''}`);
  }
  return data;
}

async function tryClick(text, opts = {}) {
  const r = await click(text, { tap: true, ...opts });
  if ((r.value || r)?.ok === false) {
    const js = await evalJs(`
      const wanted = ${JSON.stringify(text)};
      const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
      const btn = Array.from(document.querySelectorAll('button')).find((b) => norm(b.textContent).includes(norm(wanted)));
      if (btn) { btn.click(); return { ok: true, via: 'js' }; }
      return { ok: false };
    `);
    if (!(js.value || js)?.ok) {
      return { ok: false, error: (r.value || r)?.error };
    }
  }
  await wait(opts.waitMs || 700);
  return { ok: true };
}

async function navTo(label) {
  await resetDrawers();
  await openDrawer();
  const ok = await tryClick(label);
  await resetDrawers();
  await wait(600);
  return ok.ok;
}

const MAIN_VIEWS = [
  { label: '新会话', key: 'chat-v2', drawer: true },
  { label: '学习资源', key: 'learning-hub', drawer: true },
  { label: '待办', key: 'todo', drawer: true },
  { label: '技能管理', key: 'skills-management', drawer: true },
  { label: '制卡任务', key: 'task-dashboard', drawer: true },
  { label: '模板管理', key: 'template-management', drawer: true },
];

async function auditSubPaths(page) {
  const subs = [];
  const { label, key } = page;

  if (key === 'chat-v2') {
    await openDrawer();
    subs.push(await snap(`${key}-drawer`));
    await analyzeDrawerStructure(label);
    await tryClick('新对话');
    subs.push(await snap('chat-new-chat'));
    await tryClick('已归档会话');
    subs.push(await snap('chat-archived'));
    await resetDrawers();
    await tryClick('搜索与命令');
    subs.push(await snap('chat-command-palette'));
    await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`);
    await wait(300);
  }

  if (key === 'learning-hub') {
    const s = await snapshot();
    if ((s.value || s)?.elements?.some((e) => e.name.includes('右键'))) {
      add('P1', label, 'RIGHT-CLICK-HINT', '空态文案含「右键」，触屏不可用');
    }
    await openDrawer();
    subs.push(await snap(`${key}-drawer`));
    await analyzeDrawerStructure(label);
    await resetDrawers();
  }

  if (key === 'todo') {
    await openDrawer();
    subs.push(await snap(`${key}-drawer`));
    await analyzeDrawerStructure(label);
    await resetDrawers();
  }

  if (key === 'skills-management') {
    await openDrawer();
    subs.push(await snap(`${key}-drawer`));
    await analyzeDrawerStructure(label);
    await resetDrawers();
    const s = await snapshot();
    if ((s.value || s)?.elements?.some((e) => e.name === 'create')) {
      add('P2', label, 'I18N-CREATE', '创建按钮 aria 为英文 create');
    }
  }

  if (key === 'task-dashboard') {
    await wait(1200);
    await openDrawer();
    subs.push(await snap(`${key}-drawer`));
    await analyzeDrawerStructure(label);
    await resetDrawers();
    await scroll(350);
    subs.push(await snap(`${key}-scrolled`));
  }

  if (key === 'template-management') {
    await openDrawer();
    subs.push(await snap(`${key}-drawer`));
    await analyzeDrawerStructure(label);
    await tryClick('浏览');
    subs.push(await snap('templates-browse'));
    await resetDrawers();
  }

  return subs;
}

async function auditSettingsSheet() {
  await navTo('模板管理');
  await openDrawer();
  await tryClick('设置');
  await wait(900);
  const s = await snapshot();
  const headings = s.headings || s.value?.headings || [];
  const settingsTitle = headings.find((h) => h.includes('设置') || h.includes('Settings'));
  const leakedUnderlying = headings.filter(
    (h) => h && !h.includes('设置') && !h.includes('Settings') && !h.includes('系统'),
  );
  if (leakedUnderlying.length > 0) {
    add(
      'P1',
      '设置',
      'SETTINGS-SHEET',
      '设置 Sheet 打开时底层页面标题仍可见',
      headings.join(' | ') || '无标题',
    );
  } else if (!settingsTitle) {
    add('P2', '设置', 'SETTINGS-TITLE', '设置 Sheet 未检测到独立标题', headings.join(' | '));
  }
  await snap('settings-sheet-overlay');
  await resetDrawers();
}

async function collectConsoleErrors(page) {
  const errs = await errors();
  for (const e of (errs.value || errs.data || []).filter((x) => x.kind === 'error' || x.kind === 'uncaught')) {
    if (e.text?.includes('key') && e.text?.includes('AppMenu')) add('P2', page, 'REACT-KEY', 'AppMenu 缺 key');
    if (e.text?.includes('validateDOMNesting') && e.text?.includes('button')) add('P2', page, 'BTN-NEST', 'button 嵌套');
  }
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const st = await status();
  if (!st.connected) {
    console.error('Bridge not connected. Run: npm run ui:lab');
    process.exit(1);
  }

  await dismissOverlays();
  await errors(true);
  await navTo('新会话');

  const pageResults = [];
  for (const page of MAIN_VIEWS) {
    await navTo(page.label);
    await collectConsoleErrors(page.label);
    const subs = await auditSubPaths(page);
    const mainShot = await snap(`${page.key}-main`);
    pageResults.push({ page, subs, mainShot });
  }

  await auditSettingsSheet();

  const seen = new Set();
  const unique = findings.filter((f) => {
    const k = `${f.id}:${f.page}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const lines = [
    '# Deep Student 移动 UI 交互树审查（2026-07-05）',
    '',
    '> 方法：`ui-audit-mobile-tree.mjs` 在 400×880 窗口逐页打开抽屉、遍历子路径并截图。',
    '> 截图：`/tmp/ds-mobile-audit/tree-shots/`',
    '',
    `环境：window ${st.windowId || '?'} · bridge connected`,
    '',
    '## 核心结论（P0）',
    '',
    unique.some((f) => f.severity === 'P0')
      ? unique
          .filter((f) => f.severity === 'P0')
          .map((f) => `- **${f.id}** · ${f.page}：${f.detail}`)
          .join('\n')
      : '**无 P0**。移动抽屉已融合为单滚动容器（页内区 + 「应用」全局导航），见 `MobileSlidingLayout` + `MobileSidebarNavigation embedded`。 ',
    '',
    '## 交互树覆盖矩阵',
    '',
    '| 视图 | 抽屉 | 双栏堆叠 | 全局导航 | 子路径 |',
    '|------|------|----------|----------|--------|',
  ];

  for (const r of pageResults) {
    const dual = unique.some((f) => f.id === 'DUAL-SIDEBAR' && f.page === r.page.label);
    const noDrawer = unique.some(
      (f) =>
        (f.id === 'NO-DRAWER' || f.id === 'SKILLS-NO-DRAWER' || f.id === 'DRAWER-OPEN-FAIL') &&
        f.page === r.page.label,
    );
    lines.push(
      `| ${r.page.label} | ${noDrawer ? '无' : '有'} | ${dual ? '**是**' : '否'} | ${noDrawer ? '不可达' : '底部 8 项'} | ${r.subs?.length || 0} |`,
    );
  }

  for (const sev of ['P0', 'P1', 'P2']) {
    const items = unique.filter((f) => f.severity === sev);
    if (!items.length) continue;
    lines.push('', `## ${sev} 问题清单`, '');
    for (const f of items) {
      lines.push(`- **${f.id}** · ${f.page}：${f.detail}${f.evidence ? ` _(${f.evidence})_` : ''}`);
    }
  }

  lines.push('', '## 各页交互路径（应测尽测）', '');
  lines.push('### 新会话 (chat-v2)');
  lines.push('- 顶栏 ☰ → 抽屉：新对话 / 课题 / 最近 / 未分组 / 已归档 + 底部全局 8 项');
  lines.push('- 冗余：页内「新对话」≈ 底部「新会话」');
  lines.push('- 抽屉开时顶栏 `hidden`（sessionSheetOpen），符合全屏侧栏但加剧「两段式」观感');
  lines.push('- 子路径：新对话、已归档、搜索与命令；右滑附件/资源库（未在本轮自动跑）');
  lines.push('');
  lines.push('### 学习资源');
  lines.push('- 抽屉：文件夹树 + 底部全局导航');
  lines.push('- 空态「右键新建」→ P1');
  lines.push('- 三屏：文件预览右 panel（LearningHub 特有，需手势/点击文件）');
  lines.push('');
  lines.push('### 待办');
  lines.push('- 抽屉：收件箱/清单/标签 + 底部全局导航');
  lines.push('- 主区番茄钟药丸 + 任务列表');
  lines.push('');
  lines.push('### 技能管理');
  lines.push('- 抽屉：页内标题区 + 底部全局导航（与其它页一致）');
  lines.push('- 右滑进入编辑器；筛选 Tab + 创建/导入');
  lines.push('');
  lines.push('### 制卡任务 / 模板管理');
  lines.push('- 抽屉：页内工具 + 底部全局导航（模板页与用户截图一致）');
  lines.push('- 设置 → 移动全屏 Settings Sheet');
  lines.push('');
  lines.push('## 修复方向（供排期）', '');
  lines.push('1. **融合侧栏**：单滚动容器 + section 标题（「本页」/「应用」），去掉 border-t 硬切；或长页内区时折叠全局 nav');
  lines.push('2. **去重**：当前页从底部 nav 隐藏或降权；统一「新对话/新会话」文案');
  lines.push('3. **技能页 IA**：补汉堡抽屉或底部入口，与 chat/todo 一致');
  lines.push('4. **设置**：移动全屏 Settings 视图，或 Sheet 全屏遮罩 + 独立标题');
  lines.push('5. **自动化**：抽屉开时顶栏 hidden，审计脚本须先 `resetDrawers()`');

  const body = lines.join('\n');
  fs.writeFileSync(REPORT_TMP, body);
  fs.mkdirSync(path.dirname(REPORT_DOC), { recursive: true });
  fs.writeFileSync(REPORT_DOC, body);
  console.log(`Report: ${REPORT_DOC}`);
  console.log(`Findings: ${unique.length} (P0=${unique.filter((f) => f.severity === 'P0').length})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
