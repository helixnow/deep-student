#!/usr/bin/env node
/**
 * 移动 UI 深度审查 — 在 tree audit 基础上补：手势/右屏/设置 Tab/待办/技能/返回键。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  status,
  snapshot,
  click,
  errors,
  wait,
  captureWindow,
  scroll,
  evalJs,
  swipe,
  back,
} from './ui-drive-core.mjs';

const OUT = process.env.DS_AUDIT_DIR || '/tmp/ds-mobile-audit';
const SHOTS = path.join(OUT, 'deep-shots');
const REPORT = path.join(process.cwd(), 'docs/reviews/mobile-uiux-deep-audit-2026-07-05.md');

const findings = [];
let step = 0;

function add(severity, page, id, detail, evidence = '') {
  findings.push({ severity, page, id, detail, evidence });
}

async function snap(label) {
  step++;
  const name = `${String(step).padStart(3, '0')}-${label}`;
  captureWindow(name);
  return { name, snap: (await snapshot()).value || (await snapshot()) };
}

async function tryClick(text) {
  const r = await click(text, { tap: true });
  if ((r.value || r)?.ok !== false) {
    await wait(600);
    return true;
  }
  const js = await evalJs(`
    const wanted = ${JSON.stringify(text)};
    const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
    const btn = Array.from(document.querySelectorAll('button,a,[role="button"]')).find((b) => norm(b.textContent).includes(norm(wanted)) || norm(b.getAttribute('aria-label')).includes(norm(wanted)));
    if (btn) { btn.click(); return { ok: true }; }
    return { ok: false };
  `);
  if ((js.value || js)?.ok) {
    await wait(600);
    return true;
  }
  return false;
}

async function resetDrawers() {
  await evalJs(`
    document.querySelectorAll('[data-mobile-sidebar-mask]').forEach((m) => {
      if (getComputedStyle(m).pointerEvents !== 'none') m.click();
    });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  `);
  await wait(350);
}

async function openDrawer() {
  await resetDrawers();
  await evalJs(`document.querySelector('[aria-label*="展开侧边栏"]')?.click();`);
  await wait(450);
}

async function navTo(label) {
  await openDrawer();
  const ok = await tryClick(label);
  await resetDrawers();
  await wait(500);
  return ok;
}

async function scrollDrawerNav(dy = 400) {
  await evalJs(`
    const activeLayer = Array.from(document.querySelectorAll('[data-view-layer-shell]')).find((el) => {
      const s = getComputedStyle(el);
      return s.visibility !== 'hidden' && s.pointerEvents !== 'none' && Number(s.opacity) > 0.01;
    });
    const scroller = activeLayer?.querySelector('[data-mobile-unified-drawer] [data-overlayscrollbars-viewport], [data-mobile-unified-drawer] .os-viewport');
    if (scroller) scroller.scrollTop += ${dy};
    else {
      const nav = activeLayer?.querySelector('[data-mobile-shell="sidebar-nav"]');
      nav?.scrollIntoView({ block: 'end' });
    }
    return { ok: true };
  `);
  await wait(300);
}

async function auditChatDeep() {
  await navTo('新会话');
  await openDrawer();
  await snap('chat-drawer');
  await resetDrawers();

  // 打开右侧资源库（命令事件，比边缘手势更稳定）
  await evalJs(`
    window.dispatchEvent(new CustomEvent('CHAT_TOGGLE_PANEL'));
    return { ok: true };
  `);
  await wait(700);
  const panelProbe = await evalJs(`
    const activeLayer = Array.from(document.querySelectorAll('[data-view-layer-shell]')).find((el) => {
      const s = getComputedStyle(el);
      return s.visibility !== 'hidden' && s.pointerEvents !== 'none' && Number(s.opacity) > 0.01;
    });
    const flex = activeLayer?.querySelector('.relative.h-full.overflow-hidden.select-none.flex-1 > .flex.h-full');
    const tx = flex?.style?.transform || '';
    const match = tx.match(/translate3d\\(([-\\d.]+)px/);
    const x = match ? parseFloat(match[1]) : null;
    const containerW = flex?.parentElement?.clientWidth || 400;
    const sidebarW = 304;
    const isRightScreen = x !== null && x <= -(sidebarW + containerW - 80);
    const hasLearningHub = !!activeLayer?.querySelector('.study-shell-panel, [data-learning-hub-sidebar]');
    return { transform: tx, x, isRightScreen, hasLearningHub };
  `);
  const panelData = panelProbe.value || panelProbe;
  if (!panelData?.isRightScreen && !panelData?.hasLearningHub) {
    add('P2', '新会话', 'CHAT-RIGHT-PANEL', '未能打开右侧资源库', panelData?.transform || 'no transform');
  }
  await snap('chat-right-panel');
  await evalJs(`window.dispatchEvent(new CustomEvent('CHAT_TOGGLE_PANEL'));`);
  await wait(400);

  // 输入栏：尝试打开附件/加号菜单（无 session 时可能 disabled）
  await evalJs(`
    const activeLayer = Array.from(document.querySelectorAll('[data-view-layer-shell]')).find((el) => {
      const s = getComputedStyle(el);
      return s.visibility !== 'hidden' && s.pointerEvents !== 'none' && Number(s.opacity) > 0.01;
    });
    const attach = activeLayer?.querySelector('[aria-label*="附件"], [aria-label*="Attach"], button[data-input-bar-attach]');
    attach?.click();
    return { clicked: !!attach };
  `);
  await wait(500);
  await snap('chat-input-attach-menu');
  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`);
}

async function auditLearningHubDeep() {
  await navTo('学习资源');
  await openDrawer();
  await scrollDrawerNav(500);
  const found = await evalJs(`
    const activeLayer = Array.from(document.querySelectorAll('[data-view-layer-shell]')).find((el) => {
      const s = getComputedStyle(el);
      return s.visibility !== 'hidden' && s.pointerEvents !== 'none' && Number(s.opacity) > 0.01;
    });
    const btn = Array.from((activeLayer || document).querySelectorAll('button')).find((b) => (b.textContent || '').includes('设置'));
    return { ok: !!btn, rect: btn?.getBoundingClientRect() };
  `);
  if (!(found.value || found)?.ok) {
    add('P1', '学习资源', 'LH-NAV-SCROLL', '抽屉滚到底仍找不到「设置」');
  }
  await snap('learning-hub-drawer-scrolled');
  await resetDrawers();

  // 新建笔记/文件入口
  if (await tryClick('新建')) {
    await snap('learning-hub-create-menu');
    await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`);
  }

  // 点击首个文件/文件夹项，验证三屏预览（无数据则跳过）
  const fileProbe = await evalJs(`
    const activeLayer = Array.from(document.querySelectorAll('[data-view-layer-shell]')).find((el) => {
      const s = getComputedStyle(el);
      return s.visibility !== 'hidden' && s.pointerEvents !== 'none' && Number(s.opacity) > 0.01;
    });
    const item = activeLayer?.querySelector('[data-finder-item]:not([data-finder-item=""])');
    if (!item) return { ok: false, reason: 'no-items' };
    item.click();
    return { ok: true, label: item.getAttribute('aria-label') || item.textContent?.slice(0, 40) };
  `);
  const fileData = fileProbe.value || fileProbe;
  if (fileData?.ok) {
    await wait(900);
    const screenProbe = await evalJs(`
      const activeLayer = Array.from(document.querySelectorAll('[data-view-layer-shell]')).find((el) => {
        const s = getComputedStyle(el);
        return s.visibility !== 'hidden' && s.pointerEvents !== 'none' && Number(s.opacity) > 0.01;
      });
      const flex = activeLayer?.querySelector('.relative.h-full.overflow-hidden.select-none.flex-1 > .flex.h-full');
      const tx = flex?.style?.transform || '';
      const match = tx.match(/translate3d\\(([-\\d.]+)px/);
      const x = match ? parseFloat(match[1]) : null;
      const containerW = flex?.parentElement?.clientWidth || 400;
      const sidebarW = 304;
      const isRight = x !== null && x <= -(sidebarW + containerW - 80);
      const hasPreview = !!activeLayer?.querySelector('[data-learning-hub-preview], .pdf-reader, [data-pdf-reader]');
      return { transform: tx, isRight, hasPreview };
    `);
    const sp = screenProbe.value || screenProbe;
    if (!sp?.isRight && !sp?.hasPreview) {
      add('P2', '学习资源', 'LH-FILE-PREVIEW', '点击文件后未进入预览/右屏', sp?.transform || '');
    }
    await snap('learning-hub-file-preview');
    await back();
    await wait(500);
  }
}

async function auditTodoDeep() {
  await navTo('待办');
  await openDrawer();
  if (await tryClick('今天')) await snap('todo-today-view');
  await resetDrawers();
}

async function auditSkillsDeep() {
  await navTo('技能管理');
  const createOk = await tryClick('新建') || await tryClick('create');
  if (createOk) {
    await wait(800);
    await snap('skills-editor-panel');
    await back();
    await wait(500);
  } else {
    add('P1', '技能管理', 'SKILLS-CREATE', '无法打开新建/编辑器');
  }
}

async function auditSettingsDeep() {
  await navTo('模板管理');
  await openDrawer();
  await tryClick('设置');
  await wait(900);
  await snap('settings-open');

  for (const tab of ['常规', '外观', '模型服务']) {
    if (await tryClick(tab)) {
      await snap(`settings-tab-${tab}`);
    }
  }

  // 关闭设置
  if (await tryClick('关闭')) {
    await wait(500);
    const s = await snapshot();
    if ((s.openDialogs || 0) > 0) add('P1', '设置', 'SETTINGS-CLOSE', '点关闭后 Sheet 仍打开');
  }
}

async function auditTaskDashboardDeep() {
  await navTo('制卡任务');
  await openDrawer();
  const drawerProbe = await evalJs(`
    const activeLayer = Array.from(document.querySelectorAll('[data-view-layer-shell]')).find((el) => {
      const s = getComputedStyle(el);
      return s.visibility !== 'hidden' && s.pointerEvents !== 'none' && Number(s.opacity) > 0.01;
    });
    const flex = activeLayer?.querySelector('.relative.h-full.overflow-hidden.select-none.flex-1 > .flex.h-full');
    const tx = flex?.style?.transform || '';
    const match = tx.match(/translate3d\\(([-\\d.]+)px/);
    const x = match ? parseFloat(match[1]) : null;
    const drawerOpen = x !== null && x >= -20;
    return { transform: tx, x, drawerOpen };
  `);
  const data = drawerProbe.value || drawerProbe;
  if (!data?.drawerOpen) {
    add('P1', '制卡任务', 'DRAWER-OPEN-FAIL', '汉堡菜单未能打开抽屉', data?.transform || '');
  }
  await snap('task-dashboard-drawer');
  await resetDrawers();
}

async function auditAndroidBack() {
  await navTo('待办');
  await openDrawer();
  await back();
  await wait(500);
  const probe = await evalJs(`
    const flex = document.querySelector('.relative.h-full.overflow-hidden.select-none.flex-1 > .flex.h-full');
    const tx = flex?.style?.transform || '';
    const open = tx.includes('translate3d(0px') || tx.includes('translateX(0px');
    return { transform: tx, drawerStillOpen: open };
  `);
  const data = probe.value || probe;
  if (data?.drawerStillOpen) add('P1', '待办', 'ANDROID-BACK', '系统返回未关闭抽屉', data.transform);
  await snap('todo-after-back');
}

async function collectErrors(page) {
  const errs = await errors();
  for (const e of (errs.value || errs.data || []).filter((x) => x.kind === 'error' || x.kind === 'uncaught' || x.kind === 'warn')) {
    if (e.text?.includes('validateDOMNesting') && e.text?.includes('button')) {
      add('P2', page, 'BTN-NEST', 'button 嵌套警告');
    }
    if (e.text?.includes('GLOBAL_ERROR') || e.text?.includes('Uncaught')) {
      if (e.text.includes('Migration failed') || e.text.includes('Schema fingerprint')) continue;
      add('P2', page, 'CONSOLE-ERROR', e.text.slice(0, 120));
    }
  }
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const st = await status();
  if (!st.connected) {
    console.error('Bridge not connected. Run: npm run ui:lab');
    process.exit(1);
  }

  await errors(true);
  await evalJs(`
    for (const label of ['我已阅读并同意', '先随便看看', '关闭']) {
      const btn = Array.from(document.querySelectorAll('button')).find(b => (b.textContent||'').includes(label));
      btn?.click();
    }
  `);
  await wait(500);

  await auditChatDeep();
  await collectErrors('新会话');
  await auditLearningHubDeep();
  await collectErrors('学习资源');
  await auditTodoDeep();
  await collectErrors('待办');
  await auditSkillsDeep();
  await collectErrors('技能管理');
  await auditTaskDashboardDeep();
  await collectErrors('制卡任务');
  await auditSettingsDeep();
  await collectErrors('设置');
  await auditAndroidBack();

  const seen = new Set();
  const unique = findings.filter((f) => {
    const k = `${f.id}:${f.page}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const lines = [
    '# Deep Student 移动 UI 深度审查（2026-07-05）',
    '',
    '> 方法：`ui-audit-mobile-deep.mjs` — 手势、右屏、设置 Tab、技能编辑器、Android 返回键。',
    `> 截图：\`${SHOTS}/\``,
    '',
    `环境：window ${st.windowId || '?'} · bridge connected`,
    '',
    '## 覆盖范围',
    '',
    '| 场景 | 动作 |',
    '|------|------|',
    '| 新会话 | 抽屉、右屏资源库、输入栏附件菜单 |',
    '| 学习资源 | 抽屉滚到底、新建菜单、点击文件预览 |',
    '| 待办 | 抽屉切「今天」、返回键收抽屉 |',
    '| 技能管理 | 新建 → 右屏编辑器 |',
    '| 制卡任务 | 汉堡菜单打开抽屉 |',
    '| 设置 | 全屏 Sheet、常规/外观/模型 Tab、关闭 |',
    '',
  ];

  if (!unique.length) {
    lines.push('## 结论', '', '**深度路径未发现 P0/P1。**');
  } else {
    for (const sev of ['P0', 'P1', 'P2']) {
      const items = unique.filter((f) => f.severity === sev);
      if (!items.length) continue;
      lines.push(`## ${sev}`, '');
      for (const f of items) {
        lines.push(`- **${f.id}** · ${f.page}：${f.detail}${f.evidence ? ` _(${f.evidence})_` : ''}`);
      }
      lines.push('');
    }
  }

  fs.writeFileSync(REPORT, lines.join('\n'));
  console.log(`Report: ${REPORT}`);
  console.log(`Findings: ${unique.length} (P0=${unique.filter((f) => f.severity === 'P0').length})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
