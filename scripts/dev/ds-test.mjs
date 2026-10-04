#!/usr/bin/env node
/**
 * ds-test — 真机 UI 测试的通用驱动（基于 ui-bridge，开发版 + VITE_DS_UI_BRIDGE=1）。
 *
 * 设计原则（避免「脚本把测试卡住」）：
 * - 每条命令都有超时（--timeout 秒，默认 20），超时 / 失败以非零码退出并输出一行 JSON 原因；
 * - 点击默认精确匹配可访问名，歧义时报出候选，不猜；
 * - 只用「等到条件成立」的等待原语，长等待每 5 秒在 stderr 打进度；
 * - 输入走 React 受控组件可识别的原生 setter，并回读校验值确实写进去了。
 *
 * 用法：node scripts/dev/ds-test.mjs <命令> [参数] [--timeout 秒]
 *   status                              桥 / 窗口 / 页面状态
 *   snap [正则]                          可交互元素快照（可按名称过滤）
 *   click <名称|css=选择器> [--partial] [--within css=…]   （目标未出现 / 禁用时自动等待到超时）
 *   dblclick <名称|css=…>                双击（列表项打开）
 *   menu <行文本> <菜单项>                右键行 → 点菜单项
 *   open <资料名>                         学习资源里双击打开，确认标签激活
 *   fill <名称|css=…> <文本>              受控输入 + 回读校验
 *   send <文本>                           聊天输入框填入并发送，确认用户气泡出现
 *   answer <选项文本>                     回答提问卡片，确认后端收到
 *   select <文本> [--chars N] [--within css=…]  在页面 / 同源 iframe 中选中可选中的一段文本并触发划词
 *   wait-text <文本> [--gone]             等页面（含 iframe）出现 / 消失某文本
 *   wait <css=…> [--enabled]              等元素出现（且可用）
 *   mark                                  记下后端日志当前位置（字节偏移）
 *   wait-log <正则> [--since 偏移]         等后端日志从偏移起出现匹配行
 *   shot <名字> [--crop x,y,w,h]           窗口截图（裁剪坐标为 CSS 像素）
 *   eval <js>                             执行任意 async JS（return 值）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BRIDGE, findWindowId } from './ui-drive-core.mjs';

const SHOT_DIR = process.env.DS_SHOT_DIR || '/tmp/ds-test/shots';
const LOG_FILE =
  process.env.DS_APP_LOG || path.join(os.homedir(), 'Library/Logs/com.deepstudent.app/deep-student.log');

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  } else {
    pos.push(a);
  }
}
const cmd = pos.shift();
const TIMEOUT_S = Number(flags.timeout ?? 20);
const deadline = Date.now() + TIMEOUT_S * 1000;

function done(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.ok === false ? 1 : 0);
}
function fail(error, extra = {}) {
  done({ ok: false, cmd, error, ...extra });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastProgress = Date.now();
function progress(msg) {
  if (Date.now() - lastProgress >= 5000) {
    process.stderr.write(`… ${msg}（剩 ${Math.max(0, Math.round((deadline - Date.now()) / 1000))}s）\n`);
    lastProgress = Date.now();
  }
}

// ---------------------------------------------------------------------------
// 浏览器侧助手：注入一次 window.__DS_TEST__，页面重载后自动重注入
// ---------------------------------------------------------------------------
const HELPER = String.raw`
if (window.__DS_TEST_VERSION__ !== __HELPER_VERSION__) {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || el.closest('[aria-hidden="true"],[inert]')) return false;
    // 保活的隐藏页面：祖先 opacity:0 / visibility:hidden，子元素可能被样式设回 visible
    if (typeof el.checkVisibility === 'function'
      && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    return true;
  };
  // 可访问名称：aria-label → 可见文字 → title（title 是悬停说明，不能盖过按钮文字）
  // 可见文字去掉 aria-hidden 后代（如快捷键 <kbd aria-hidden>），与真实无障碍名一致
  const visibleText = (el) => {
    let text = el.innerText || '';
    for (const hidden of el.querySelectorAll('[aria-hidden="true"]')) {
      const part = hidden.innerText;
      if (part) text = text.replace(part, '');
    }
    return text;
  };
  // 输入框：aria-label → placeholder（无障碍名兜底同样用它）→ 当前值
  const nameOf = (el) => norm(el.getAttribute('aria-label') || visibleText(el) || el.getAttribute('title') || el.getAttribute('placeholder') || el.value || '');
  const SEL = 'button,a[href],input,textarea,select,[role=button],[role=menuitem],[role=option],[role=tab],[role=radio],[role=switch],[role=checkbox],[role=treeitem],[contenteditable=true]';
  const docs = () => {
    const out = [document];
    for (const f of document.querySelectorAll('iframe')) {
      try { if (f.contentDocument) out.push(f.contentDocument); } catch {}
    }
    return out;
  };
  const find = (target, opts = {}) => {
    const scope = opts.within ? document.querySelector(opts.within) : document;
    if (!scope) return { error: 'within 未找到: ' + opts.within };
    if (target.startsWith('css=')) {
      const all = [...scope.querySelectorAll(target.slice(4))].filter(visible);
      if (!all.length) return { error: '未找到: ' + target };
      return { el: all[0] };
    }
    const wanted = norm(target);
    const cands = [...scope.querySelectorAll(SEL)].filter(visible);
    const exact = cands.filter((el) => nameOf(el) === wanted);
    if (exact.length === 1) return { el: exact[0] };
    if (exact.length > 1) {
      const enabled = exact.filter((el) => !el.disabled);
      if (enabled.length === 1) return { el: enabled[0] };
      return { el: exact[0], note: '同名 ' + exact.length + ' 个，取第一个' };
    }
    if (!opts.partial) {
      const near = cands.map(nameOf).filter((n) => n.includes(wanted)).slice(0, 6);
      return { error: '没有精确匹配「' + wanted + '」', candidates: near };
    }
    const part = cands.filter((el) => nameOf(el).includes(wanted));
    if (part.length === 1) return { el: part[0] };
    if (!part.length) return { error: '未找到包含「' + wanted + '」的元素' };
    return { error: '「' + wanted + '」有 ' + part.length + ' 个候选', candidates: part.slice(0, 6).map(nameOf) };
  };
  const describe = (el) => ({ tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || undefined, name: nameOf(el).slice(0, 80), disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true' });
  const setValue = (el, value) => {
    el.focus();
    if (el.isContentEditable) {
      el.textContent = value;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }));
      return el.textContent;
    }
    const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value;
  };
  const allText = () => docs().map((d) => d.body ? d.body.innerText : '').join('\n');
  const selectable = (el) => {
    const cs = el.ownerDocument.defaultView.getComputedStyle(el);
    return (cs.webkitUserSelect || cs.userSelect) !== 'none';
  };
  const selectText = (text, chars, within) => {
    for (const d of docs()) {
      const w = d.defaultView;
      const root = within ? d.querySelector(within) : d.body;
      if (!root) continue;
      const walker = d.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const i = node.data.indexOf(text);
        // 跳过不可见 / 不可选中的文本（列表、标签等 chrome 禁选，选了也是空选区）
        if (i < 0 || !visible(node.parentElement) || !selectable(node.parentElement)) continue;
        const r = d.createRange();
        r.setStart(node, i);
        r.setEnd(node, Math.min(node.data.length, i + (chars || text.length)));
        const s = w.getSelection();
        s.removeAllRanges();
        s.addRange(r);
        const rc = r.getBoundingClientRect();
        for (const t of ['mousedown', 'mouseup']) node.parentElement.dispatchEvent(new w.MouseEvent(t, { bubbles: true, clientX: rc.right, clientY: rc.bottom }));
        d.dispatchEvent(new Event('selectionchange'));
        return { ok: true, selected: s.toString(), inIframe: d !== document };
      }
    }
    return { ok: false, error: '页面里没有可见且可选中的文本「' + text + '」' };
  };
  window.__DS_TEST__ = { find, describe, setValue, allText, selectText, nameOf, visible };
  window.__DS_TEST_VERSION__ = __HELPER_VERSION__;
}
`;

// 助手代码变了就重新注入（页面里可能还留着旧版本）
const HELPER_SRC = HELPER.replaceAll('__HELPER_VERSION__', JSON.stringify(String(HELPER.length) + ':' + [...HELPER].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0)));

async function rpc(code, ms = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.min(ms, Math.max(1000, deadline - Date.now())));
  try {
    const res = await fetch(`${BRIDGE}/eval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: `${HELPER_SRC}\n${code}` }),
      signal: ctrl.signal,
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || 'eval failed');
    return json.value;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('页面无响应（eval 超时）——应用可能卡死或在重载');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
const js = (v) => JSON.stringify(v);

/** 反复求值直到返回真值；超时返回 null */
async function until(code, label, interval = 500) {
  while (Date.now() < deadline) {
    try {
      const v = await rpc(code, 8000);
      if (v) return v;
    } catch (e) {
      progress(`${label}（${e.message}）`);
      await sleep(interval);
      continue;
    }
    progress(label);
    await sleep(interval);
  }
  return null;
}

// ---------------------------------------------------------------------------
// 日志
// ---------------------------------------------------------------------------
function logSize() {
  try {
    return fs.statSync(LOG_FILE).size;
  } catch {
    return 0;
  }
}
function logSince(offset) {
  const size = logSize();
  const start = size < offset ? 0 : offset; // 日志轮转后从头读
  const fd = fs.openSync(LOG_FILE, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------
async function clickTarget(target, { dbl = false } = {}) {
  const opts = { partial: !!flags.partial, within: flags.within?.replace(/^css=/, '') };
  // 自动等待：目标未出现 / 仍禁用时在超时内重试（内容常在异步加载）
  let r;
  while (true) {
    r = await tryClick(target, opts, dbl);
    if (r?.ok || Date.now() >= deadline) break;
    progress(`等可点击的「${target}」（${r?.error}）`);
    await sleep(300);
  }
  if (!r?.ok) fail(r?.error || 'click failed', r);
  return r;
}

async function tryClick(target, opts, dbl) {
  return rpc(`
    const f = window.__DS_TEST__.find(${js(target)}, ${js(opts)});
    if (f.error) return f;
    const el = f.el;
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const info = window.__DS_TEST__.describe(el);
    if (info.disabled) return { error: '目标处于禁用状态', target: info };
    if (${dbl}) {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + Math.min(60, r.width / 2), r.top + r.height / 2) || el;
      hit.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
      hit.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
    } else {
      el.click();
    }
    return { ok: true, clicked: info, note: f.note };
  `);
}

const commands = {
  async status() {
    const s = await (await fetch(`${BRIDGE}/status`)).json();
    let page = null;
    try {
      page = await rpc(`return { url: location.href, ready: document.body.innerText.length > 50, visibility: document.visibilityState, dpr: devicePixelRatio, tabs: [...document.querySelectorAll('[role=tab][aria-selected=true]')].map(t => t.textContent.trim()).slice(0, 4) };`, 5000);
    } catch (e) {
      page = { error: e.message };
    }
    done({ ok: !!s.connected && !page?.error, bridge: s, windowId: findWindowId() || null, page });
  },

  async snap() {
    const filter = pos[0] ? new RegExp(pos[0]) : null;
    const items = await rpc(`
      const T = window.__DS_TEST__;
      return [...document.querySelectorAll('button,a[href],input,textarea,select,[role=button],[role=menuitem],[role=option],[role=tab],[role=radio],[role=switch],[role=checkbox]')]
        .filter(T.visible).map(el => { const d = T.describe(el); const r = el.getBoundingClientRect(); return d.tag + (d.role ? '/' + d.role : '') + ' "' + d.name + '"' + (d.disabled ? ' [disabled]' : '') + ' @' + Math.round(r.x) + ',' + Math.round(r.y); });
    `);
    const lines = filter ? items.filter((l) => filter.test(l)) : items;
    process.stdout.write(`${lines.join('\n')}\n`);
    process.exit(0);
  },

  async click() {
    if (!pos[0]) fail('缺少目标');
    done(await clickTarget(pos[0]));
  },

  async dblclick() {
    if (!pos[0]) fail('缺少目标');
    done(await clickTarget(pos[0], { dbl: true }));
  },

  async menu() {
    const [row, item] = pos;
    if (!row || !item) fail('用法: menu <行文本> <菜单项>');
    const r = await rpc(`
      const o = [...document.querySelectorAll('[role=option],[role=treeitem],[role=row],li')].find(e => window.__DS_TEST__.visible(e) && e.textContent.includes(${js(row)}));
      if (!o) return { error: '没有找到行「' + ${js(row)} + '」' };
      o.scrollIntoView({ block: 'center', behavior: 'instant' });
      const r = o.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + Math.min(60, r.width / 2), r.top + r.height / 2) || o;
      hit.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 60, clientY: r.top + r.height / 2 }));
      return { ok: true };
    `);
    if (!r?.ok) fail(r?.error);
    const item_ = await until(`return [...document.querySelectorAll('[role=menuitem]')].some(e => window.__DS_TEST__.nameOf(e) === ${js(item)});`, `等菜单项「${item}」`, 200);
    if (!item_) fail(`右键菜单里没有「${item}」`);
    done(await clickTarget(item));
  },

  async open() {
    const name = pos[0];
    if (!name) fail('缺少资料名');
    const onHub = await rpc(`return !!document.querySelector('[role=option]') && [...document.querySelectorAll('[role=option]')].some(o => o.textContent.includes(${js(name)}));`);
    if (!onHub) {
      await rpc(`const b = [...document.querySelectorAll('button')].find(b => /^(学习资源|Learning resources|Files)$/i.test(window.__DS_TEST__.nameOf(b)) && window.__DS_TEST__.visible(b)); b && b.click(); return !!b;`);
      const listed = await until(`return [...document.querySelectorAll('[role=option]')].some(o => o.textContent.includes(${js(name)}));`, `等列表出现「${name}」`, 300);
      if (!listed) fail(`学习资源列表里没有「${name}」`);
    }
    await rpc(`
      const o = [...document.querySelectorAll('[role=option]')].find(o => o.textContent.includes(${js(name)}));
      o.scrollIntoView({ block: 'center', behavior: 'instant' });
      const r = o.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + 60, r.top + r.height / 2) || o;
      hit.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
      hit.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
      return true;
    `);
    const active = await until(`return [...document.querySelectorAll('[role=tab][aria-selected=true]')].map(t => t.textContent).find(t => t.includes(${js(name)})) || null;`, `等标签「${name}」激活`, 300);
    if (!active) fail(`双击后没有激活「${name}」的标签`);
    done({ ok: true, activeTab: active.trim() });
  },

  async fill() {
    const [target, text] = pos;
    if (!target || text === undefined) fail('用法: fill <目标> <文本>');
    // 自动等待：输入框常随视图异步挂载
    let r;
    while (true) {
      r = await rpc(`
        const f = window.__DS_TEST__.find(${js(target)}, { partial: ${!!flags.partial} });
        if (f.error) return f;
        const v = window.__DS_TEST__.setValue(f.el, ${js(text)});
        return { ok: v === ${js(text)}, value: v, target: window.__DS_TEST__.describe(f.el) };
      `);
      if (r?.ok || Date.now() >= deadline) break;
      progress(`等输入框「${target}」（${r?.error ?? '回读不一致'}）`);
      await sleep(300);
    }
    if (!r?.ok) fail(r?.error || '写入后回读不一致', r);
    done(r);
  },

  async send() {
    const text = pos[0];
    // 聊天输入框：可见的、在发送按钮所在表单里的 textarea
    const filled = await rpc(`
      const send = [...document.querySelectorAll('button')].find(b => /^(发送|发送消息|Send|Send message)$/i.test(window.__DS_TEST__.nameOf(b)) && window.__DS_TEST__.visible(b));
      if (!send) return { error: '找不到发送按钮（不在聊天页？）' };
      let box = send.closest('form,[class*=input-bar],[class*=composer],[class*=InputBar]') || document;
      const ta = [...box.querySelectorAll('textarea')].find(window.__DS_TEST__.visible);
      if (!ta) return { error: '找不到聊天输入框' };
      ${text === undefined ? '' : `window.__DS_TEST__.setValue(ta, ${js(text)});`}
      return { ok: true, value: ta.value };
    `);
    if (!filled?.ok) fail(filled?.error, filled);
    if (!filled.value?.trim()) fail('输入框是空的，未发送');
    const before = await rpc(`return document.querySelectorAll('.user-message-bubble').length;`);
    const enabled = await until(`const b = [...document.querySelectorAll('button')].find(b => /^(发送|发送消息|Send|Send message)$/i.test(window.__DS_TEST__.nameOf(b)) && window.__DS_TEST__.visible(b)); return b && !b.disabled ? true : false;`, '等发送按钮可用', 200);
    if (!enabled) fail('发送按钮一直不可用（输入未进入组件状态？）');
    await rpc(`[...document.querySelectorAll('button')].find(b => /^(发送|发送消息|Send|Send message)$/i.test(window.__DS_TEST__.nameOf(b)) && window.__DS_TEST__.visible(b)).click(); return true;`);
    const sent = await until(`return document.querySelectorAll('.user-message-bubble').length > ${before};`, '等用户气泡出现', 300);
    if (!sent) fail('点了发送但没有出现新的用户气泡');
    done({ ok: true, sent: filled.value.slice(0, 80) });
  },

  async answer() {
    const option = pos[0];
    if (!option) fail('缺少选项文本');
    const mark = logSize();
    const r = await rpc(`
      const btn = [...document.querySelectorAll('button')].find(b => window.__DS_TEST__.visible(b) && !b.disabled && window.__DS_TEST__.nameOf(b).includes(${js(option)}));
      if (!btn) return { error: '没有可点的选项「' + ${js(option)} + '」', options: [...document.querySelectorAll('button')].filter(b => /^\\d\\./.test(window.__DS_TEST__.nameOf(b))).map(b => window.__DS_TEST__.nameOf(b) + (b.disabled ? ' [disabled]' : '')) };
      btn.click();
      return { ok: true, chose: window.__DS_TEST__.nameOf(btn) };
    `);
    if (!r?.ok) fail(r?.error, r);
    // 多选卡：选中后还要点「提交」
    await sleep(300);
    await rpc(`const s = [...document.querySelectorAll('button')].find(b => /^(提交|Submit)$/i.test(window.__DS_TEST__.nameOf(b)) && window.__DS_TEST__.visible(b) && !b.disabled); if (s) s.click(); return !!s;`);
    while (Date.now() < deadline) {
      if (/ask_user\] Received response/.test(logSince(mark))) done({ ok: true, chose: r.chose });
      progress('等后端收到回答');
      await sleep(400);
    }
    fail('后端没有收到回答（应用可能卡死，见 status）', { chose: r.chose });
  },

  async select() {
    const text = pos[0];
    if (!text) fail('缺少文本');
    const r = await rpc(`return window.__DS_TEST__.selectText(${js(text)}, ${Number(flags.chars) || 0}, ${js(flags.within ? String(flags.within).replace(/^css=/, '') : null)});`);
    if (!r?.ok) fail(r?.error);
    done(r);
  },

  async 'wait-text'() {
    const text = pos[0];
    const gone = !!flags.gone;
    const t0 = Date.now();
    const ok = await until(`return ${gone ? '!' : ''}window.__DS_TEST__.allText().includes(${js(text)});`, `等文本${gone ? '消失' : '出现'}「${text}」`, 400);
    if (!ok) fail(`超时：文本${gone ? '仍在' : '未出现'}「${text}」`);
    done({ ok: true, ms: Date.now() - t0 });
  },

  async wait() {
    const target = pos[0];
    const t0 = Date.now();
    const ok = await until(`const f = window.__DS_TEST__.find(${js(target)}, { partial: ${!!flags.partial} }); if (f.error) return false; return ${flags.enabled ? '!window.__DS_TEST__.describe(f.el).disabled' : 'true'};`, `等元素「${target}」`, 300);
    if (!ok) fail(`超时：元素未${flags.enabled ? '可用' : '出现'}「${target}」`);
    done({ ok: true, ms: Date.now() - t0 });
  },

  async mark() {
    done({ ok: true, offset: logSize() });
  },

  async 'wait-log'() {
    const re = new RegExp(pos[0]);
    const since = Number(flags.since ?? logSize());
    const t0 = Date.now();
    while (Date.now() < deadline) {
      const hit = logSince(since).split('\n').filter((l) => re.test(l));
      if (hit.length) done({ ok: true, ms: Date.now() - t0, lines: hit.slice(-3).map((l) => l.slice(0, 240)) });
      progress(`等日志 /${pos[0]}/`);
      await sleep(500);
    }
    fail(`超时：日志未出现 /${pos[0]}/`);
  },

  async shot() {
    const name = pos[0] || `shot-${Date.now()}`;
    const winId = findWindowId();
    if (!winId) fail('找不到应用窗口');
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const full = path.join(SHOT_DIR, `${name}.png`);
    execFileSync('screencapture', ['-x', '-o', '-l', winId, full]);
    if (flags.crop) {
      const [x, y, w, h] = String(flags.crop).split(',').map(Number);
      const dpr = await rpc('return devicePixelRatio;').catch(() => 2);
      const out = path.join(SHOT_DIR, `${name}-crop.png`);
      execFileSync('sips', ['--cropOffset', String(Math.round(y * dpr)), String(Math.round(x * dpr)), '-c', String(Math.round(h * dpr)), String(Math.round(w * dpr)), full, '--out', out], { stdio: 'ignore' });
      done({ ok: true, path: out });
    }
    done({ ok: true, path: full });
  },

  async eval() {
    done({ ok: true, value: await rpc(pos.join(' ')) });
  },
};

const run = commands[cmd];
if (!run) {
  process.stderr.write(`未知命令: ${cmd || '(空)'}\n命令: ${Object.keys(commands).join(' ')}\n`);
  process.exit(2);
}
const hardStop = setTimeout(() => fail(`命令总超时 ${TIMEOUT_S}s`), TIMEOUT_S * 1000 + 3000);
hardStop.unref();
run().catch((e) => fail(e.message));
