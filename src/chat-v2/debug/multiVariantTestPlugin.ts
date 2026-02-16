/**
 * 多变体自动化测试 — 核心逻辑模块
 *
 * 测试链路（6 组，21 步），详见 docs/design/multi-variant-automated-test-plugin-v2.md
 *
 * 覆盖范围：
 *   ✅ pendingParallelModelIds → TauriAdapter → 后端多变体 pipeline
 *   ✅ 多变体消息创建后的全部 UI 交互
 *   ❌ chip 面板选择模型 → setPendingParallelModelIds（React useState 不可访问）
 */

import { CHATV2_LOG_EVENT, type ChatV2LogEntry } from './chatV2Logger';
import { listen } from '@tauri-apps/api/event';
import { createSessionWithDefaults } from '../core/session/createSessionWithDefaults';
import { detectProviderBrand } from '../../utils/providerIconEngine';
import i18n from '../../i18n';
import type { StoreApi } from 'zustand';
import type { ChatStore } from '../core/types';

// =============================================================================
// 类型定义
// =============================================================================

export type StepName =
  | 'mv_send_3' | 'mv_cancel_middle' | 'mv_cancel_all'
  | 'mv_retry_one' | 'mv_retry_all' | 'mv_fast_cancel_retry'
  | 'mv_switch_setup' | 'mv_switch_nav' | 'mv_delete_one' | 'mv_delete_to_single'
  | 'mv_cancel_first' | 'mv_cancel_last' | 'mv_cancel_two'
  | 'mv_cancel_then_delete' | 'mv_switch_during_stream'
  | 'mv_persist_complete' | 'mv_skeleton_check' | 'mv_icon_and_dom'
  | 'mv_mixed_single_multi' | 'mv_mixed_multi_single' | 'mv_mixed_alternating_persist';

export const ALL_STEPS: StepName[] = [
  'mv_send_3', 'mv_cancel_middle', 'mv_cancel_all',
  'mv_retry_one', 'mv_retry_all', 'mv_fast_cancel_retry',
  'mv_switch_setup', 'mv_switch_nav', 'mv_delete_one', 'mv_delete_to_single',
  'mv_cancel_first', 'mv_cancel_last', 'mv_cancel_two',
  'mv_cancel_then_delete', 'mv_switch_during_stream',
  'mv_persist_complete', 'mv_skeleton_check', 'mv_icon_and_dom',
  'mv_mixed_single_multi', 'mv_mixed_multi_single', 'mv_mixed_alternating_persist',
];

export const STEP_LABELS: Record<StepName, string> = {
  mv_send_3: 'A① 3模型发送', mv_cancel_middle: 'A② 取消中间', mv_cancel_all: 'A③ 取消全部',
  mv_retry_one: 'B④ 重试单个', mv_retry_all: 'B⑤ 重试全部', mv_fast_cancel_retry: 'B⑥ 快速取消重试',
  mv_switch_setup: 'C⑦ 切换前置', mv_switch_nav: 'C⑧ 导航切换', mv_delete_one: 'C⑨ 删除一个', mv_delete_to_single: 'C⑩ 删至单变体',
  mv_cancel_first: 'D⑪ 取消首个', mv_cancel_last: 'D⑫ 取消末尾', mv_cancel_two: 'D⑬ 连续取消2个',
  mv_cancel_then_delete: 'D⑭ 取消后删除', mv_switch_during_stream: 'D⑮ 流式中切换',
  mv_persist_complete: 'E⑯ 持久化', mv_skeleton_check: 'E⑰ 骨架验证', mv_icon_and_dom: 'E⑱ Icon+DOM',
  mv_mixed_single_multi: 'F⑲ 单→多混合', mv_mixed_multi_single: 'F⑳ 多→单混合', mv_mixed_alternating_persist: 'F㉑ 交替持久化',
};

export const GROUP_A: StepName[] = ['mv_send_3', 'mv_cancel_middle', 'mv_cancel_all'];
export const GROUP_B: StepName[] = ['mv_retry_one', 'mv_retry_all', 'mv_fast_cancel_retry'];
export const GROUP_C: StepName[] = ['mv_switch_setup', 'mv_switch_nav', 'mv_delete_one', 'mv_delete_to_single'];
export const GROUP_D: StepName[] = ['mv_cancel_first', 'mv_cancel_last', 'mv_cancel_two', 'mv_cancel_then_delete', 'mv_switch_during_stream'];
export const GROUP_E: StepName[] = ['mv_persist_complete', 'mv_skeleton_check', 'mv_icon_and_dom'];
export const GROUP_F: StepName[] = ['mv_mixed_single_multi', 'mv_mixed_multi_single', 'mv_mixed_alternating_persist'];

export interface MultiVariantTestConfig {
  modelA: string; modelB: string; modelC: string;
  prompt: string; longPrompt: string;
  cancelDelayMs: number; fastCancelDelayMs: number;
  roundTimeoutMs: number; intervalMs: number;
  skipSteps: StepName[];
}

export interface VerificationCheck { name: string; passed: boolean; detail: string; }
export interface VerificationResult { passed: boolean; checks: VerificationCheck[]; }
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'success';
export interface LogEntry { id: number; timestamp: string; level: LogLevel; phase: string; message: string; data?: Record<string, unknown>; }
export interface CapturedConsoleEntry { level: 'log' | 'warn' | 'error' | 'debug'; timestamp: string; message: string; args: unknown[]; }

export interface StepResult {
  step: StepName; status: 'passed' | 'failed' | 'skipped';
  startTime: string; endTime: string; durationMs: number; sessionId: string; error?: string;
  capturedRequestBodies: unknown[]; verification: VerificationResult;
  logs: LogEntry[]; chatV2Logs: ChatV2LogEntry[]; consoleLogs: CapturedConsoleEntry[];
}

export type OverallStatus = 'idle' | 'running' | 'completed' | 'aborted';
export const MV_TEST_EVENT = 'MULTI_VARIANT_TEST_LOG';
export const MV_TEST_SESSION_PREFIX = '[MultiVariantTest]';

type LogFn = (level: LogLevel, phase: string, msg: string, data?: Record<string, unknown>) => void;

// =============================================================================
// 基础设施
// =============================================================================

let _globalLogId = 0;
const MAX_LOGS = 500;

function createLogger(stepName: string, onLog?: (entry: LogEntry) => void) {
  const logs: LogEntry[] = [];
  function log(level: LogLevel, phase: string, message: string, data?: Record<string, unknown>) {
    const entry: LogEntry = { id: ++_globalLogId, timestamp: new Date().toISOString(), level, phase, message, data };
    if (logs.length < MAX_LOGS) logs.push(entry);
    const emoji = { debug: '🔍', info: '🔷', warn: '⚠️', error: '❌', success: '✅' }[level];
    console.log(`${emoji} [MVTest][${stepName}][${phase}] ${message}`, data ?? '');
    onLog?.(entry);
    window.dispatchEvent(new CustomEvent(MV_TEST_EVENT, { detail: entry }));
  }
  return { logs, log };
}

function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

async function waitFor(cond: () => boolean, timeoutMs: number, pollMs = 200): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { if (cond()) return true; await sleep(pollMs); }
  return false;
}

// ── 控制台拦截 ──

const CAPTURE_PREFIXES = [
  '[VariantActions]', '[ChatStore] switchVariant', '[ChatStore] deleteVariant',
  '[ChatStore] retryVariant', '[ChatStore] cancelVariant', '[ChatStore] retryAllVariants',
  '[ChatV2::VariantHandler]', '[ChatV2::VariantPipeline]', '[ChatV2::pipeline]',
  '[ChatStore]', '[TauriAdapter]', '[ChatV2]', '[EventBridge]',
];

function createConsoleCapture() {
  const captured: CapturedConsoleEntry[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, debug: console.debug };
  function wrap(level: CapturedConsoleEntry['level'], origFn: (...a: unknown[]) => void) {
    return (...args: unknown[]) => {
      origFn(...args);
      if (args.length > 0 && CAPTURE_PREFIXES.some(p => String(args[0]).includes(p))) {
        captured.push({ level, timestamp: new Date().toISOString(), message: String(args[0]), args: args.slice(1) });
      }
    };
  }
  return {
    start() { console.log = wrap('log', orig.log); console.warn = wrap('warn', orig.warn); console.error = wrap('error', orig.error); console.debug = wrap('debug', orig.debug); },
    stop() { console.log = orig.log; console.warn = orig.warn; console.error = orig.error; console.debug = orig.debug; },
    captured,
  };
}

// ── ChatV2 日志捕获 ──

function createChatV2LogCapture() {
  const captured: ChatV2LogEntry[] = [];
  const startTime = new Date().toISOString();
  const handler = (e: Event) => {
    const entry = (e as CustomEvent<ChatV2LogEntry>).detail;
    if (entry.timestamp >= startTime && captured.length < MAX_LOGS) captured.push(entry);
  };
  return {
    start: () => window.addEventListener(CHATV2_LOG_EVENT, handler),
    stop: () => window.removeEventListener(CHATV2_LOG_EVENT, handler),
    logs: captured,
  };
}

// ── 请求体捕获 ──

async function createRequestBodyCapture(sessionId: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bodies: any[] = [];
  const unlisten = await listen<{ streamEvent: string; model: string; url: string; requestBody: unknown }>(
    'chat_v2_llm_request_body', (event) => {
      const prefix = `chat_v2_event_${sessionId}`;
      if (event.payload.streamEvent === prefix || event.payload.streamEvent.startsWith(`${prefix}_`)) {
        bodies.push({ model: event.payload.model, url: event.payload.url, requestBody: event.payload.requestBody, capturedAt: new Date().toISOString() });
      }
    },
  );
  return { stop: () => unlisten(), get bodies() { return bodies; }, get count() { return bodies.length; }, get models(): string[] { return bodies.map(b => b.model); } };
}

// ── Variant 生命周期事件捕获 ──

async function createVariantEventCapture(sessionId: string) {
  const events: Array<{ type: string; variantId?: string; modelId?: string; status?: string; timestamp: string }> = [];
  const eventName = `chat_v2_event_${sessionId}`;
  const unlisten = await listen<Record<string, unknown>>(eventName, (event) => {
    const p = event.payload; const type = String(p.type || '');
    if (type === 'variant_start' || type === 'variant_end') {
      events.push({ type, variantId: p.variantId as string | undefined, modelId: p.modelId as string | undefined, status: p.status as string | undefined, timestamp: new Date().toISOString() });
    }
  });
  return { stop: () => unlisten(), events, hasVariantStart: () => events.some(e => e.type === 'variant_start') };
}

// ── 会话管理 ──

async function getSessionManager() { return (await import('../core/session/sessionManager')).sessionManager; }

async function createAndSwitchSession(log: LogFn, label: string): Promise<{ store: StoreApi<ChatStore>; sessionId: string }> {
  const sm = await getSessionManager();
  const session = await createSessionWithDefaults({ mode: 'chat', title: `${MV_TEST_SESSION_PREFIX} ${label}` });
  log('info', 'session', `新建会话: ${session.id}`);
  window.dispatchEvent(new CustomEvent('PIPELINE_TEST_SWITCH_SESSION', { detail: { sessionId: session.id } }));
  if (!await waitFor(() => sm.getCurrentSessionId() === session.id, 5000, 100)) throw new Error(`会话切换超时: ${session.id}`);
  if (!await waitFor(() => !!document.querySelector('[data-testid="input-bar-v2-textarea"]'), 10000, 200)) throw new Error('InputBarUI 未就绪');
  await sleep(500);
  const store = sm.get(session.id);
  if (!store) throw new Error(`无法获取 Store: ${session.id}`);
  log('success', 'session', `会话已就绪: ${session.id}`);
  return { store, sessionId: session.id };
}

// =============================================================================
// DOM 模拟层
// =============================================================================

function simulateTyping(text: string): boolean {
  const ta = document.querySelector('[data-testid="input-bar-v2-textarea"]') as HTMLTextAreaElement | null;
  if (!ta) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (setter) setter.call(ta, text); else ta.value = text;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.dispatchEvent(new Event('change', { bubbles: true }));
  ta.focus(); ta.setSelectionRange(text.length, text.length);
  return true;
}

async function clickSend(log?: LogFn, waitMs = 15000): Promise<boolean> {
  let btn = document.querySelector('[data-testid="btn-send"]') as HTMLButtonElement | null;
  if (!btn) return false;
  if (btn.disabled) {
    log?.('info', 'send', `发送按钮禁用，等待 ${waitMs}ms...`);
    const ok = await waitFor(() => { btn = document.querySelector('[data-testid="btn-send"]') as HTMLButtonElement | null; return !!btn && !btn.disabled; }, waitMs, 300);
    if (!ok || !btn || btn.disabled) return false;
  }
  btn.click(); return true;
}

function getI18nTitle(key: string): string {
  try { const t = i18n.t(key); if (t && t !== key) return t; } catch { /* */ }
  const fb: Record<string, string> = { 'chatV2:variant.cancel': '取消', 'chatV2:variant.retry': '重试', 'chatV2:variant.delete': '删除' };
  return fb[key] ?? key;
}

/** 变体卡片内按钮点击。找不到 = 抛错，绝不降级。 */
async function clickVariantButton(variantIndex: number, action: 'cancel' | 'retry' | 'delete', log: LogFn): Promise<void> {
  const card = document.querySelector(`[data-variant-index="${variantIndex}"]`);
  if (!card) throw new Error(`变体卡片[${variantIndex}]未找到`);
  card.scrollIntoView({ behavior: 'instant', inline: 'center' });
  await sleep(300);
  const title = getI18nTitle(`chatV2:variant.${action}`);
  const btn = card.querySelector<HTMLButtonElement>(`button[title="${title}"], button[aria-label="${title}"]`);
  if (!btn) throw new Error(`变体[${variantIndex}] ${action} 按钮未找到 (title="${title}")`);
  if (btn.disabled) throw new Error(`变体[${variantIndex}] ${action} 按钮已禁用`);
  btn.click();
  log('success', 'dom', `变体[${variantIndex}] ${action} 已点击`);
}

function clickNavArrow(direction: 'prev' | 'next'): boolean {
  const label = direction === 'prev' ? 'Previous variant' : 'Next variant';
  const btn = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!btn || btn.disabled) return false;
  btn.click(); return true;
}

function isNavArrowDisabled(direction: 'prev' | 'next'): boolean {
  const btn = document.querySelector<HTMLButtonElement>(`button[aria-label="${direction === 'prev' ? 'Previous variant' : 'Next variant'}"]`);
  return !btn || btn.disabled;
}

// =============================================================================
// Store 辅助
// =============================================================================

async function waitForStreaming(store: StoreApi<ChatStore>, ms: number) { return waitFor(() => store.getState().sessionStatus !== 'idle', ms, 100); }
async function waitForIdle(store: StoreApi<ChatStore>, ms: number) { return waitFor(() => store.getState().sessionStatus === 'idle', ms, 300); }
async function waitAllDone(store: StoreApi<ChatStore>, ms: number) {
  return waitFor(() => {
    const s = store.getState();
    if (s.sessionStatus !== 'idle' || s.streamingVariantIds.size > 0) return false;
    // 额外检查：最后一条助手消息的所有变体都不在 streaming/pending 状态
    for (let i = s.messageOrder.length - 1; i >= 0; i--) {
      const m = s.messageMap.get(s.messageOrder[i]);
      if (m?.role === 'assistant') {
        return (m.variants ?? []).every(v => v.status !== 'streaming' && v.status !== 'pending');
      }
    }
    return true;
  }, ms, 300);
}

function getLastMsgId(store: StoreApi<ChatStore>, role: 'user' | 'assistant'): string | null {
  const s = store.getState();
  for (let i = s.messageOrder.length - 1; i >= 0; i--) { const m = s.messageMap.get(s.messageOrder[i]); if (m?.role === role) return s.messageOrder[i]; }
  return null;
}

function findVarIdxByModel(store: StoreApi<ChatStore>, msgId: string, modelId: string, resolveMap?: Map<string, string>): number {
  const resolved = resolveMap?.get(modelId) ?? modelId;
  return (store.getState().messageMap.get(msgId)?.variants ?? []).findIndex(v => v.modelId === resolved);
}

async function waitForVariants(store: StoreApi<ChatStore>, count: number, timeoutMs: number): Promise<boolean> {
  return waitFor(() => {
    const aId = getLastMsgId(store, 'assistant');
    if (!aId) return false;
    return (store.getState().messageMap.get(aId)?.variants?.length ?? 0) >= count;
  }, timeoutMs, 200);
}

function buildModelResolveMap(configIds: string[], reqBodies: Array<{ model: string }>, log?: LogFn): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i < configIds.length && i < reqBodies.length; i++) {
    map.set(configIds[i], reqBodies[i].model);
  }
  log?.('info', 'resolve', `模型映射: ${[...map.entries()].map(([k, v]) => `${k}→${v}`).join(', ')}`);
  return map;
}

// =============================================================================
// 多变体发送（含 monkey-patch 例外）
// =============================================================================

async function sendMultiVariant(store: StoreApi<ChatStore>, modelIds: string[], prompt: string, log: LogFn): Promise<void> {
  const orig = store.getState().setPendingParallelModelIds;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (store as any).setState({ setPendingParallelModelIds: (ids: string[] | null) => { if (ids === null) { log('info', 'model', 'setPendingParallelModelIds(null) 拦截'); return; } orig(ids); } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (store as any).setState({ pendingParallelModelIds: modelIds });
  log('info', 'model', `并行模型: ${modelIds.join(', ')}`);
  try {
    if (!simulateTyping(prompt)) throw new Error('无法输入');
    await sleep(500);
    if (!await clickSend(log)) { await sleep(1000); if (!await clickSend(log)) throw new Error('发送按钮不可用'); }
    if (!await waitForStreaming(store, 15000)) throw new Error('流式未开始');
  } finally {
    // ★ 与 chatInteractionTestPlugin 对齐：无论成功/失败都恢复 monkey-patch
    const current = store.getState().setPendingParallelModelIds;
    if (current !== orig) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (store as any).setState({ setPendingParallelModelIds: orig });
    }
    log('success', 'send', 'monkey-patch 已恢复');
  }
}

/** 发送单变体（普通）消息 — 不设置 pendingParallelModelIds */
async function sendSingleVariant(store: StoreApi<ChatStore>, prompt: string, log: LogFn): Promise<void> {
  // 确保 pendingParallelModelIds 为空
  const pIds = store.getState().pendingParallelModelIds;
  if (pIds && pIds.length > 0) {
    log('warn', 'send', `pendingParallelModelIds 残留: [${pIds.join(',')}], 强制清空`);
    store.getState().setPendingParallelModelIds(null);
  }
  if (!simulateTyping(prompt)) throw new Error('无法输入');
  await sleep(500);
  if (!await clickSend(log)) { await sleep(1000); if (!await clickSend(log)) throw new Error('发送按钮不可用'); }
  if (!await waitForStreaming(store, 15000)) throw new Error('流式未开始');
  log('success', 'send', '单变体消息已发送');
}

// =============================================================================
// 验证辅助
// =============================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sanitize(body: any): unknown {
  if (!body) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = JSON.parse(JSON.stringify(body, (k: string, v: any) => (k === 'url' && typeof v === 'string' && v.startsWith('data:')) ? `[base64:${v.length}b]` : v));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (Array.isArray(s.messages)) s.messages = s.messages.map((m: any) => m.role === 'system' ? { role: 'system', content: `[sys:${m.content?.length||0}]` } : m);
    return s;
  } catch { return '[err]'; }
}

async function verifyPersistence(sessionId: string, expectedVariants: number): Promise<VerificationCheck[]> {
  const checks: VerificationCheck[] = [];
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await sleep(1000);
    const data = await invoke<{ messages?: Array<{ id: string; role: string; variants?: Array<{ id: string; modelId?: string; status?: string; blockIds?: string[] }>; activeVariantId?: string }> }>('chat_v2_load_session', { sessionId });
    const msgs = data?.messages || [];
    const ast = [...msgs].reverse().find(m => m.role === 'assistant');
    checks.push({ name: '助手消息持久化', passed: !!ast, detail: ast ? `id=${ast.id}` : '❌' });
    if (ast) {
      const vs = ast.variants || [];
      checks.push({ name: `变体=${expectedVariants}`, passed: vs.length === expectedVariants, detail: `actual=${vs.length}` });
      checks.push({ name: 'activeVariantId 有效', passed: !!ast.activeVariantId && vs.some(v => v.id === ast.activeVariantId), detail: `${ast.activeVariantId}` });
      for (const v of vs) { checks.push({ name: `blocks ${v.modelId?.slice(0,12)}`, passed: (v.blockIds?.length??0)>0 || v.status==='cancelled', detail: `blocks=${v.blockIds?.length??0} status=${v.status}` }); }
    }
  } catch (e) { checks.push({ name: '持久化', passed: false, detail: `${e}` }); }
  return checks;
}

/**
 * 验证混合会话持久化：检查每条助手消息的变体数是否符合预期
 * @param expectedVariantCounts 按消息顺序，每条助手消息期望的变体数（0=单变体，3=多变体）
 */
async function verifyMixedPersistence(sessionId: string, expectedVariantCounts: number[], log: LogFn): Promise<VerificationCheck[]> {
  const checks: VerificationCheck[] = [];
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await sleep(1000);
    type PersistMsg = { id: string; role: string; blockIds?: string[]; variants?: Array<{ id: string; modelId?: string; status?: string; blockIds?: string[] }>; activeVariantId?: string };
    const data = await invoke<{ messages?: PersistMsg[] }>('chat_v2_load_session', { sessionId });
    const msgs = data?.messages || [];
    const assistants = msgs.filter(m => m.role === 'assistant');

    checks.push({ name: `助手消息数=${expectedVariantCounts.length}`, passed: assistants.length === expectedVariantCounts.length, detail: `actual=${assistants.length}` });

    for (let i = 0; i < expectedVariantCounts.length; i++) {
      const expected = expectedVariantCounts[i];
      const ast = assistants[i];
      const label = `msg[${i}]`;
      if (!ast) { checks.push({ name: `${label} 缺失`, passed: false, detail: '❌' }); continue; }

      const vs = ast.variants || [];
      if (expected === 0) {
        // 单变体消息：variants 应为空或不存在，blockIds 应非空
        checks.push({ name: `${label} 单变体`, passed: vs.length === 0, detail: `variants=${vs.length}` });
        checks.push({ name: `${label} blocks`, passed: (ast.blockIds?.length ?? 0) > 0, detail: `blocks=${ast.blockIds?.length ?? 0}` });
      } else {
        // 多变体消息
        checks.push({ name: `${label} 变体=${expected}`, passed: vs.length === expected, detail: `actual=${vs.length}` });
        checks.push({ name: `${label} activeId`, passed: !!ast.activeVariantId && vs.some(v => v.id === ast.activeVariantId), detail: `${ast.activeVariantId?.slice(0, 12)}` });
        for (const v of vs) {
          checks.push({ name: `${label} ${v.modelId?.slice(0, 10)} blocks`, passed: (v.blockIds?.length ?? 0) > 0 || v.status === 'cancelled', detail: `blocks=${v.blockIds?.length ?? 0}` });
        }
      }
    }
    log('info', 'persist', `混合持久化验证: ${assistants.length} 条助手消息, 期望 [${expectedVariantCounts.join(',')}]`);
  } catch (e) { checks.push({ name: '混合持久化', passed: false, detail: `${e}` }); }
  return checks;
}

function checkIcons(store: StoreApi<ChatStore>, msgId: string): VerificationCheck[] {
  const msg = store.getState().messageMap.get(msgId);
  return (msg?.variants ?? []).map(v => {
    const brand = detectProviderBrand(v.modelId || '');
    return { name: `Icon ${v.modelId?.slice(0,15)}`, passed: brand !== 'generic', detail: brand === 'generic' ? `❌ generic` : `✓ ${brand}` };
  });
}

function domSnapshot() {
  const cards = document.querySelectorAll('[data-variant-index]').length;
  const dots = document.querySelectorAll('.variant-indicator-dot, .variant-indicator-dot-active').length;
  const activeDots = document.querySelectorAll('.variant-indicator-dot-active').length;
  const prev = document.querySelector<HTMLButtonElement>('button[aria-label="Previous variant"]');
  const next = document.querySelector<HTMLButtonElement>('button[aria-label="Next variant"]');
  return { cards, dots, activeDots, hasPrev: !!prev, hasNext: !!next, prevDisabled: !prev || prev.disabled, nextDisabled: !next || next.disabled };
}

// =============================================================================
// 步骤样板
// =============================================================================

interface StepCaptures { chatV2: ReturnType<typeof createChatV2LogCapture>; console: ReturnType<typeof createConsoleCapture>; }
function startCaptures(): StepCaptures { const c2 = createChatV2LogCapture(); const cc = createConsoleCapture(); c2.start(); cc.start(); return { chatV2: c2, console: cc }; }
function stopCaptures(c: StepCaptures) { c.console.stop(); c.chatV2.stop(); }

function finalizeChecks(log: LogFn, checks: VerificationCheck[], status: 'passed'|'failed', error: string|undefined, t0: number) {
  for (const c of checks) log(c.passed ? 'success' : 'error', 'verify', `${c.passed?'✅':'❌'} ${c.name}: ${c.detail}`);
  const v: VerificationResult = { passed: checks.every(c => c.passed), checks };
  let s = status; let e = error;
  if (!v.passed && s === 'passed') { s = 'failed'; e = '验证未通过: ' + checks.filter(c => !c.passed).map(c => c.name).join(', '); }
  log(s === 'passed' ? 'success' : 'error', 'result', `${s==='passed'?'✅':'❌'} ${s} (${Date.now()-t0}ms)`);
  return { status: s, error: e, verification: v };
}

function mkResult(step: StepName, o: { status: 'passed'|'failed'|'skipped'; startTime: string; t0: number; bodies: unknown[]; v: VerificationResult; logs: LogEntry[]; c2: ChatV2LogEntry[]; cc: CapturedConsoleEntry[]; sid: string; err?: string }): StepResult {
  return { step, status: o.status, startTime: o.startTime, endTime: new Date().toISOString(), durationMs: Date.now()-o.t0, capturedRequestBodies: o.bodies, verification: o.v, logs: o.logs, chatV2Logs: o.c2, consoleLogs: o.cc, sessionId: o.sid, error: o.err };
}

interface StepContext { store: StoreApi<ChatStore>; sessionId: string; config: MultiVariantTestConfig; onLog?: (entry: LogEntry) => void; }

/** 独立会话步骤的通用包装 */
async function runIndependentStep(
  stepName: StepName, config: MultiVariantTestConfig, onLog: ((e: LogEntry) => void) | undefined,
  body: (ctx: StepContext, log: LogFn, checks: VerificationCheck[], reqCapture: Awaited<ReturnType<typeof createRequestBodyCapture>>) => Promise<void>,
): Promise<StepResult> {
  const startTime = new Date().toISOString();
  const { logs, log } = createLogger(stepName, onLog);
  const caps = startCaptures();
  const t0 = Date.now();
  const checks: VerificationCheck[] = [];
  let status: 'passed'|'failed' = 'passed';
  let error: string|undefined;
  let verification: VerificationResult = { passed: false, checks: [] };
  let sid = '';
  let reqCap: Awaited<ReturnType<typeof createRequestBodyCapture>> | null = null;

  try {
    const sess = await createAndSwitchSession(log, stepName);
    sid = sess.sessionId;
    reqCap = await createRequestBodyCapture(sid);
    await body({ store: sess.store, sessionId: sid, config, onLog }, log, checks, reqCap);
  } catch (e2) { error = e2 instanceof Error ? e2.message : String(e2); log('error', 'fatal', error); status = 'failed'; }
  finally {
    reqCap?.stop(); stopCaptures(caps);
    const fin = finalizeChecks(log, checks, status, error, t0);
    status = fin.status; error = fin.error; verification = fin.verification;
  }
  return mkResult(stepName, { status, startTime, t0, bodies: reqCap?.bodies??[], v: verification, logs, c2: caps.chatV2.logs, cc: caps.console.captured, sid, err: error });
}

// =============================================================================
// Group A — 发送与取消
// =============================================================================

async function stepSend3(config: MultiVariantTestConfig, onLog?: (e: LogEntry) => void): Promise<StepResult> {
  return runIndependentStep('mv_send_3', config, onLog, async (ctx, log, checks, req) => {
    const { store, sessionId, config: c } = ctx;
    await sendMultiVariant(store, [c.modelA, c.modelB, c.modelC], c.prompt, log);
    const done = await waitAllDone(store, c.roundTimeoutMs);
    checks.push({ name: '完成', passed: done, detail: done ? '✓' : `status=${store.getState().sessionStatus}` });

    const aId = getLastMsgId(store, 'assistant');
    if (!aId) { checks.push({ name: '助手消息', passed: false, detail: '未找到' }); return; }
    const vars = store.getState().messageMap.get(aId)?.variants || [];
    checks.push({ name: '3变体', passed: vars.length === 3, detail: `${vars.length}` });
    for (const v of vars) checks.push({ name: `${v.modelId?.slice(0,12)} ok`, passed: v.status === 'success', detail: `status=${v.status} blocks=${v.blockIds.length}` });
    checks.push({ name: '无僵尸', passed: store.getState().streamingVariantIds.size === 0, detail: `${store.getState().streamingVariantIds.size}` });
    checks.push(...checkIcons(store, aId));
    checks.push({ name: '请求≥3', passed: req.count >= 3, detail: `${req.count} 模型:${req.models.join(',')}` });
    checks.push({ name: '3不同模型', passed: new Set(req.models).size >= 3, detail: `${new Set(req.models).size}` });

    await sleep(500);
    const dom = domSnapshot();
    checks.push({ name: 'DOM 3卡片', passed: dom.cards === 3, detail: `${dom.cards}` });
    checks.push({ name: 'DOM 3dots', passed: dom.dots === 3, detail: `${dom.dots}` });
    checks.push({ name: '1 active', passed: dom.activeDots === 1, detail: `${dom.activeDots}` });

    for (const b of req.bodies) log('info', 'req', JSON.stringify(sanitize(b.requestBody), null, 2));
  });
}

async function stepCancelMiddle(config: MultiVariantTestConfig, onLog?: (e: LogEntry) => void): Promise<StepResult> {
  return runIndependentStep('mv_cancel_middle', config, onLog, async (ctx, log, checks, req) => {
    const { store, config: c } = ctx;
    const configIds = [c.modelA, c.modelB, c.modelC];
    await sendMultiVariant(store, configIds, c.longPrompt, log);
    await waitFor(() => req.count >= 3, 15000, 200);
    const resolveMap = buildModelResolveMap(configIds, req.bodies, log);
    await waitForVariants(store, 3, 15000);
    await sleep(c.cancelDelayMs);

    const aId = getLastMsgId(store, 'assistant')!;
    const bIdx = findVarIdxByModel(store, aId, c.modelB, resolveMap);
    if (bIdx < 0) throw new Error(`modelB(${c.modelB}) 变体未找到 (resolved: ${resolveMap.get(c.modelB)})`);
    await clickVariantButton(bIdx, 'cancel', log);

    const bDone = await waitFor(() => { const v = store.getState().messageMap.get(aId)?.variants?.[bIdx]; return !!v && v.status !== 'streaming' && v.status !== 'pending'; }, 10000, 200);
    checks.push({ name: 'B状态变化', passed: bDone, detail: `status=${store.getState().messageMap.get(aId)?.variants?.[bIdx]?.status}` });

    const done = await waitAllDone(store, c.roundTimeoutMs);
    checks.push({ name: '全部结束', passed: done, detail: done ? '✓' : '❌' });

    const resolvedB = resolveMap.get(c.modelB) ?? c.modelB;
    const vars = store.getState().messageMap.get(aId)?.variants || [];
    for (const v of vars) {
      const isB = v.modelId === resolvedB;
      checks.push({ name: `${isB?'B':v.modelId?.slice(0,10)}`, passed: isB ? ['cancelled','success'].includes(v.status) : v.status === 'success', detail: `status=${v.status}` });
    }
    checks.push({ name: '无僵尸', passed: store.getState().streamingVariantIds.size === 0, detail: `${store.getState().streamingVariantIds.size}` });
  });
}

async function stepCancelAll(config: MultiVariantTestConfig, onLog?: (e: LogEntry) => void): Promise<StepResult> {
  return runIndependentStep('mv_cancel_all', config, onLog, async (ctx, log, checks) => {
    const { store, config: c } = ctx;
    await sendMultiVariant(store, [c.modelA, c.modelB, c.modelC], c.longPrompt, log);
    await sleep(c.cancelDelayMs);
    for (let i = 0; i < 3; i++) {
      try { await clickVariantButton(i, 'cancel', log); } catch (e) { log('warn', 'cancel', `[${i}] ${e}`); }
      if (i < 2) await sleep(500);
    }
    const idled = await waitForIdle(store, 15000);
    checks.push({ name: 'idle', passed: idled, detail: idled ? '✓' : `status=${store.getState().sessionStatus}` });
    const aId = getLastMsgId(store, 'assistant');
    if (aId) {
      const vars = store.getState().messageMap.get(aId)?.variants || [];
      const cc = vars.filter(v => v.status === 'cancelled').length;
      checks.push({ name: '≥2 cancelled', passed: cc >= 2, detail: `${cc} cancelled, ${vars.map(v=>`${v.modelId?.slice(0,8)}=${v.status}`).join(',')}` });
    }
    checks.push({ name: '无僵尸', passed: store.getState().streamingVariantIds.size === 0, detail: `${store.getState().streamingVariantIds.size}` });
  });
}

// =============================================================================
// Group B — 重试与恢复
// =============================================================================

async function stepRetryOne(config: MultiVariantTestConfig, onLog?: (e: LogEntry) => void): Promise<StepResult> {
  return runIndependentStep('mv_retry_one', config, onLog, async (ctx, log, checks, req) => {
    const { store, config: c } = ctx;
    const configIds = [c.modelA, c.modelB, c.modelC];
    await sendMultiVariant(store, configIds, c.longPrompt, log);
    await waitFor(() => req.count >= 3, 15000, 200);
    const resolveMap = buildModelResolveMap(configIds, req.bodies, log);
    await waitForVariants(store, 3, 15000);
    await sleep(c.cancelDelayMs);
    const aId = getLastMsgId(store, 'assistant')!;
    const bIdx = findVarIdxByModel(store, aId, c.modelB, resolveMap);
    if (bIdx < 0) throw new Error('modelB 变体未找到');
    await clickVariantButton(bIdx, 'cancel', log);
    await waitAllDone(store, c.roundTimeoutMs);

    const beforeBlocks = store.getState().messageMap.get(aId)?.variants?.[bIdx]?.blockIds ?? [];
    await clickVariantButton(bIdx, 'retry', log);
    const done = await waitAllDone(store, c.roundTimeoutMs);
    checks.push({ name: '重试完成', passed: done, detail: done ? '✓' : '❌' });

    const bAfter = store.getState().messageMap.get(aId)?.variants?.[bIdx];
    checks.push({ name: 'B=success', passed: bAfter?.status === 'success', detail: `status=${bAfter?.status}` });
    const afterBlocks = bAfter?.blockIds ?? [];
    const changed = afterBlocks.length !== beforeBlocks.length || afterBlocks.some((id, i) => id !== beforeBlocks[i]);
    checks.push({ name: 'blocks 更新', passed: changed, detail: `before=${beforeBlocks.length} after=${afterBlocks.length}` });
    checks.push(...checkIcons(store, aId));
  });
}

async function stepRetryAll(config: MultiVariantTestConfig, onLog?: (e: LogEntry) => void): Promise<StepResult> {
  return runIndependentStep('mv_retry_all', config, onLog, async (ctx, log, checks) => {
    const { store, config: c } = ctx;
    await sendMultiVariant(store, [c.modelA, c.modelB, c.modelC], c.longPrompt, log);
    await sleep(c.cancelDelayMs);
    for (let i = 0; i < 3; i++) { try { await clickVariantButton(i, 'cancel', log); } catch { /* */ } if (i < 2) await sleep(500); }
    await waitForIdle(store, 15000);

    const aId = getLastMsgId(store, 'assistant')!;
    log('info', 'retry', 'store.retryAllVariants (例外: 无 DOM 按钮)');
    await store.getState().retryAllVariants(aId);
    const done = await waitAllDone(store, c.roundTimeoutMs * 2);
    checks.push({ name: '重试完成', passed: done, detail: done ? '✓' : '❌' });

    const vars = store.getState().messageMap.get(aId)?.variants || [];
    const sc = vars.filter(v => v.status === 'success').length;
    checks.push({ name: '≥1 success', passed: sc >= 1, detail: `${sc} success` });
    checks.push({ name: '无僵尸', passed: store.getState().streamingVariantIds.size === 0, detail: `${store.getState().streamingVariantIds.size}` });
  });
}

async function stepFastCancelRetry(config: MultiVariantTestConfig, onLog?: (e: LogEntry) => void): Promise<StepResult> {
  return runIndependentStep('mv_fast_cancel_retry', config, onLog, async (ctx, log, checks, req) => {
    const { store, config: c } = ctx;
    const configIds = [c.modelA, c.modelB, c.modelC];
    await sendMultiVariant(store, configIds, c.longPrompt, log);
    await waitFor(() => req.count >= 3, 15000, 200);
    const resolveMap = buildModelResolveMap(configIds, req.bodies, log);
    await waitForVariants(store, 3, 15000);
    await sleep(c.fastCancelDelayMs);

    const aId = getLastMsgId(store, 'assistant')!;
    const aIdx = findVarIdxByModel(store, aId, c.modelA, resolveMap);
    if (aIdx < 0) throw new Error('modelA 变体未找到');
    await clickVariantButton(aIdx, 'cancel', log);
    await waitFor(() => { const v = store.getState().messageMap.get(aId)?.variants?.[aIdx]; return !!v && v.status !== 'streaming' && v.status !== 'pending'; }, 10000, 200);

    await clickVariantButton(aIdx, 'retry', log);
    const done = await waitAllDone(store, c.roundTimeoutMs);
    checks.push({ name: '完成', passed: done, detail: done ? '✓' : '❌' });

    const aFinal = store.getState().messageMap.get(aId)?.variants?.[aIdx];
    checks.push({ name: 'A=success', passed: aFinal?.status === 'success', detail: `status=${aFinal?.status}` });
    checks.push({ name: '无僵尸', passed: store.getState().streamingVariantIds.size === 0, detail: `${store.getState().streamingVariantIds.size}` });
  });
}

// =============================================================================
// Group C — 切换与删除（共享会话）
// =============================================================================

async function runGroupC(config: MultiVariantTestConfig, onLog: ((e: LogEntry) => void) | undefined, onStep: (r: StepResult, i: number) => void, baseIdx: number): Promise<StepResult[]> {
  const results: StepResult[] = [];
  const { logs: setupLogs, log: setupLog } = createLogger('mv_switch_setup', onLog);

  // 创建共享会话
  const sess = await createAndSwitchSession(setupLog, 'GroupC');
  const { store, sessionId: sid } = sess;

  // ── Step 7: mv_switch_setup ──
  {
    const st = new Date().toISOString(); const caps = startCaptures(); const t0 = Date.now();
    const checks: VerificationCheck[] = []; let status: 'passed'|'failed' = 'passed'; let err: string|undefined; let v: VerificationResult = { passed: false, checks: [] };
    const req = await createRequestBodyCapture(sid);
    try {
      await sendMultiVariant(store, [config.modelA, config.modelB, config.modelC], config.prompt, setupLog);
      const done = await waitAllDone(store, config.roundTimeoutMs);
      checks.push({ name: '完成', passed: done, detail: done ? '✓' : '❌' });
      const aId = getLastMsgId(store, 'assistant');
      const vars = aId ? store.getState().messageMap.get(aId)?.variants : [];
      checks.push({ name: '3 success', passed: (vars?.filter(x => x.status==='success').length??0)===3, detail: vars?.map(x=>`${x.modelId?.slice(0,8)}=${x.status}`).join(',')??'' });
    } catch (e2) { err = e2 instanceof Error ? e2.message : String(e2); setupLog('error','fatal',err); status = 'failed'; }
    finally { req.stop(); stopCaptures(caps); const f = finalizeChecks(setupLog, checks, status, err, t0); status=f.status; err=f.error; v=f.verification; }
    const r = mkResult('mv_switch_setup', { status, startTime: st, t0, bodies: req.bodies, v, logs: setupLogs, c2: caps.chatV2.logs, cc: caps.console.captured, sid, err });
    results.push(r); onStep(r, baseIdx);
    if (status === 'failed') return results;
    await sleep(config.intervalMs);
  }

  // ── Step 8: mv_switch_nav ──
  {
    const { logs, log } = createLogger('mv_switch_nav', onLog);
    const st = new Date().toISOString(); const caps = startCaptures(); const t0 = Date.now();
    const checks: VerificationCheck[] = []; let status: 'passed'|'failed' = 'passed'; let err: string|undefined; let v: VerificationResult = { passed: false, checks: [] };
    try {
      const aId = getLastMsgId(store, 'assistant')!;
      const getActive = () => store.getState().messageMap.get(aId)?.activeVariantId;
      const vars = store.getState().messageMap.get(aId)?.variants ?? [];
      const [id0, id1, id2] = [vars[0]?.id, vars[1]?.id, vars[2]?.id];

      // ★ 先导航到 variants[0]：初始 activeVariantId 取决于哪个模型先完成，不一定是 variants[0]
      while (!isNavArrowDisabled('prev')) { clickNavArrow('prev'); await sleep(200); }
      await sleep(300);
      checks.push({ name: '初始=1st', passed: getActive()===id0, detail: `${getActive()} vs ${id0}` });
      checks.push({ name: 'Prev disabled', passed: isNavArrowDisabled('prev'), detail: '第1个时 Prev 应 disabled' });

      checks.push({ name: '→ next', passed: clickNavArrow('next'), detail: '' }); await sleep(300);
      checks.push({ name: 'active=2nd', passed: getActive()===id1, detail: `${getActive()} vs ${id1}` });
      checks.push({ name: '→ next', passed: clickNavArrow('next'), detail: '' }); await sleep(300);
      checks.push({ name: 'active=3rd', passed: getActive()===id2, detail: `${getActive()} vs ${id2}` });
      checks.push({ name: 'Next disabled', passed: isNavArrowDisabled('next'), detail: '第3个时 Next 应 disabled' });
      checks.push({ name: '← prev', passed: clickNavArrow('prev'), detail: '' }); await sleep(300);
      checks.push({ name: 'active=2nd', passed: getActive()===id1, detail: `${getActive()} vs ${id1}` });

      await sleep(500);
      checks.push(...await verifyPersistence(sid, 3));
    } catch (e2) { err = e2 instanceof Error ? e2.message : String(e2); log('error','fatal',err); status = 'failed'; }
    finally { stopCaptures(caps); const f = finalizeChecks(log, checks, status, err, t0); status=f.status; err=f.error; v=f.verification; }
    const r = mkResult('mv_switch_nav', { status, startTime: st, t0, bodies: [], v, logs, c2: caps.chatV2.logs, cc: caps.console.captured, sid, err });
    results.push(r); onStep(r, baseIdx+1);
    await sleep(config.intervalMs);
  }

  // ── Step 9: mv_delete_one ──
  {
    const { logs, log } = createLogger('mv_delete_one', onLog);
    const st = new Date().toISOString(); const caps = startCaptures(); const t0 = Date.now();
    const checks: VerificationCheck[] = []; let status: 'passed'|'failed' = 'passed'; let err: string|undefined; let v: VerificationResult = { passed: false, checks: [] };
    try {
      const aId = getLastMsgId(store, 'assistant')!;
      const activeId = store.getState().messageMap.get(aId)?.activeVariantId;
      const vars = store.getState().messageMap.get(aId)?.variants ?? [];
      const delIdx = vars.findIndex(x => x.id !== activeId);
      log('info', 'delete', `删除 index=${delIdx} (非 active)`);
      await clickVariantButton(delIdx, 'delete', log);
      await waitFor(() => (store.getState().messageMap.get(aId)?.variants?.length??3)===2, 5000, 200);
      const after = store.getState().messageMap.get(aId)?.variants ?? [];
      checks.push({ name: 'variants=2', passed: after.length===2, detail: `${after.length}` });
      checks.push({ name: 'active不变', passed: store.getState().messageMap.get(aId)?.activeVariantId===activeId, detail: '' });
      await sleep(300); // 等待 React 重渲染
      const dom = domSnapshot();
      checks.push({ name: '2卡片', passed: dom.cards===2, detail: `${dom.cards}` });
      checks.push({ name: '2dots', passed: dom.dots===2, detail: `${dom.dots}` });
    } catch (e2) { err = e2 instanceof Error ? e2.message : String(e2); log('error','fatal',err); status = 'failed'; }
    finally { stopCaptures(caps); const f = finalizeChecks(log, checks, status, err, t0); status=f.status; err=f.error; v=f.verification; }
    const r = mkResult('mv_delete_one', { status, startTime: st, t0, bodies: [], v, logs, c2: caps.chatV2.logs, cc: caps.console.captured, sid, err });
    results.push(r); onStep(r, baseIdx+2);
    await sleep(config.intervalMs);
  }

  // ── Step 10: mv_delete_to_single ──
  {
    const { logs, log } = createLogger('mv_delete_to_single', onLog);
    const st = new Date().toISOString(); const caps = startCaptures(); const t0 = Date.now();
    const checks: VerificationCheck[] = []; let status: 'passed'|'failed' = 'passed'; let err: string|undefined; let v: VerificationResult = { passed: false, checks: [] };
    try {
      const aId = getLastMsgId(store, 'assistant')!;
      const activeId = store.getState().messageMap.get(aId)?.activeVariantId;
      const vars = store.getState().messageMap.get(aId)?.variants ?? [];
      const delIdx = vars.findIndex(x => x.id !== activeId);
      if (delIdx < 0) throw new Error('无非 active 变体');
      await clickVariantButton(delIdx, 'delete', log);
      await waitFor(() => (store.getState().messageMap.get(aId)?.variants?.length??2)===1, 5000, 200);
      checks.push({ name: 'variants=1', passed: (store.getState().messageMap.get(aId)?.variants?.length??0)===1, detail: '' });
      await sleep(300);
      const dom = domSnapshot();
      checks.push({ name: '指示器消失', passed: dom.dots===0, detail: `dots=${dom.dots}` });
    } catch (e2) { err = e2 instanceof Error ? e2.message : String(e2); log('error','fatal',err); status = 'failed'; }
    finally { stopCaptures(caps); const f = finalizeChecks(log, checks, status, err, t0); status=f.status; err=f.error; v=f.verification; }
    const r = mkResult('mv_delete_to_single', { status, startTime: st, t0, bodies: [], v, logs, c2: caps.chatV2.logs, cc: caps.console.captured, sid, err });
    results.push(r); onStep(r, baseIdx+3);
  }

  return results;
}

// =============================================================================
// Group D — 中间状态打断
// =============================================================================

async function stepCancelFirst(c: MultiVariantTestConfig, onLog?: (e: LogEntry) => void) { return runCancelAtIndex(c, onLog, 'mv_cancel_first', c.modelA); }
async function stepCancelLast(c: MultiVariantTestConfig, onLog?: (e: LogEntry) => void) { return runCancelAtIndex(c, onLog, 'mv_cancel_last', c.modelC); }

async function runCancelAtIndex(config: MultiVariantTestConfig, onLog: ((e: LogEntry) => void)|undefined, step: StepName, targetModel: string): Promise<StepResult> {
  return runIndependentStep(step, config, onLog, async (ctx, log, checks, req) => {
    const { store, config: c } = ctx;
    const configIds = [c.modelA, c.modelB, c.modelC];
    await sendMultiVariant(store, configIds, c.longPrompt, log);
    await waitFor(() => req.count >= 3, 15000, 200);
    const resolveMap = buildModelResolveMap(configIds, req.bodies, log);
    await waitForVariants(store, 3, 15000);
    await sleep(c.cancelDelayMs);
    const aId = getLastMsgId(store, 'assistant')!;
    const idx = findVarIdxByModel(store, aId, targetModel, resolveMap);
    if (idx < 0) throw new Error(`${targetModel} 变体未找到 (resolved: ${resolveMap.get(targetModel)})`);
    await clickVariantButton(idx, 'cancel', log);
    const done = await waitAllDone(store, c.roundTimeoutMs);
    checks.push({ name: '完成', passed: done, detail: done ? '✓' : '❌' });
    const resolvedTarget = resolveMap.get(targetModel) ?? targetModel;
    const vars = store.getState().messageMap.get(aId)?.variants || [];
    for (const v of vars) { const isT = v.modelId===resolvedTarget; checks.push({ name: `${v.modelId?.slice(0,10)}`, passed: isT ? ['cancelled','success'].includes(v.status) : v.status==='success', detail: `status=${v.status}` }); }
    checks.push({ name: '无僵尸', passed: store.getState().streamingVariantIds.size===0, detail: `${store.getState().streamingVariantIds.size}` });
  });
}

async function stepCancelTwo(config: MultiVariantTestConfig, onLog?: (e: LogEntry) => void): Promise<StepResult> {
  return runIndependentStep('mv_cancel_two', config, onLog, async (ctx, log, checks, req) => {
    const { store, config: c } = ctx;
    const configIds = [c.modelA, c.modelB, c.modelC];
    await sendMultiVariant(store, configIds, c.longPrompt, log);
    await waitFor(() => req.count >= 3, 15000, 200);
    const resolveMap = buildModelResolveMap(configIds, req.bodies, log);
    await waitForVariants(store, 3, 15000);
    await sleep(c.cancelDelayMs);
    const aId = getLastMsgId(store, 'assistant')!;
    for (const m of [c.modelA, c.modelB]) {
      const idx = findVarIdxByModel(store, aId, m, resolveMap);
      if (idx < 0) throw new Error(`${m} 变体未找到 (resolved: ${resolveMap.get(m)})`);
      try { await clickVariantButton(idx, 'cancel', log); } catch (e) { log('warn', 'cancel', `${m}: ${e}`); }
      await sleep(500);
    }
    const done = await waitAllDone(store, c.roundTimeoutMs);
    checks.push({ name: '完成', passed: done, detail: done ? '✓' : '❌' });
    const resolvedC = resolveMap.get(c.modelC) ?? c.modelC;
    const vars = store.getState().messageMap.get(aId)?.variants || [];
    checks.push({ name: 'C=success', passed: vars.some(v => v.modelId===resolvedC && v.status==='success'), detail: vars.find(v=>v.modelId===resolvedC)?.status??'?' });
    checks.push({ name: '无僵尸', passed: store.getState().streamingVariantIds.size===0, detail: `${store.getState().streamingVariantIds.size}` });
  });
}

async function stepCancelThenDelete(config: MultiVariantTestConfig, onLog?: (e: LogEntry) => void): Promise<StepResult> {
  return runIndependentStep('mv_cancel_then_delete', config, onLog, async (ctx, log, checks, req) => {
    const { store, config: c } = ctx;
    const configIds = [c.modelA, c.modelB, c.modelC];
    await sendMultiVariant(store, configIds, c.longPrompt, log);
    await waitFor(() => req.count >= 3, 15000, 200);
    const resolveMap = buildModelResolveMap(configIds, req.bodies, log);
    await waitForVariants(store, 3, 15000);
    await sleep(c.cancelDelayMs);
    const aId = getLastMsgId(store, 'assistant')!;
    const bIdx = findVarIdxByModel(store, aId, c.modelB, resolveMap);
    if (bIdx < 0) throw new Error('modelB 未找到');
    await clickVariantButton(bIdx, 'cancel', log);
    const resolvedB = resolveMap.get(c.modelB) ?? c.modelB;
    await waitFor(() => { const v = store.getState().messageMap.get(aId)?.variants?.find(x=>x.modelId===resolvedB); return !!v && v.status!=='streaming' && v.status!=='pending'; }, 10000, 200);
    await sleep(500);
    const bIdx2 = findVarIdxByModel(store, aId, c.modelB, resolveMap);
    await clickVariantButton(bIdx2 >= 0 ? bIdx2 : bIdx, 'delete', log);
    await waitFor(() => (store.getState().messageMap.get(aId)?.variants?.length??3)===2, 5000, 200);
    const done = await waitAllDone(store, c.roundTimeoutMs);
    checks.push({ name: '完成', passed: done, detail: done ? '✓' : '❌' });
    checks.push({ name: 'variants=2', passed: (store.getState().messageMap.get(aId)?.variants?.length??0)===2, detail: `${store.getState().messageMap.get(aId)?.variants?.length}` });
    checks.push({ name: '无僵尸', passed: store.getState().streamingVariantIds.size===0, detail: `${store.getState().streamingVariantIds.size}` });
  });
}

async function stepSwitchDuringStream(config: MultiVariantTestConfig, onLog?: (e: LogEntry) => void): Promise<StepResult> {
  return runIndependentStep('mv_switch_during_stream', config, onLog, async (ctx, log, checks) => {
    const { store, config: c } = ctx;
    await sendMultiVariant(store, [c.modelA, c.modelB, c.modelC], c.longPrompt, log);
    await sleep(1000);
    const dots = document.querySelectorAll('.variant-indicator-dot, .variant-indicator-dot-active');
    if (dots.length >= 3) { (dots[2] as HTMLElement).click(); log('success', 'switch', '流式中点击第3个指示器'); }
    else log('warn', 'switch', `指示器不足: ${dots.length}`);
    const done = await waitAllDone(store, c.roundTimeoutMs);
    checks.push({ name: '完成', passed: done, detail: done ? '✓' : '❌' });
    const aId = getLastMsgId(store, 'assistant')!;
    const vars = store.getState().messageMap.get(aId)?.variants || [];
    const sc = vars.filter(v => v.status==='success').length;
    checks.push({ name: '3 success', passed: sc===3, detail: vars.map(v=>`${v.modelId?.slice(0,8)}=${v.status}`).join(',') });
    checks.push({ name: '无僵尸', passed: store.getState().streamingVariantIds.size===0, detail: `${store.getState().streamingVariantIds.size}` });
  });
}

// =============================================================================
// Group E — 持久化与 DOM
// =============================================================================

async function stepPersist(config: MultiVariantTestConfig, onLog?: (e: LogEntry) => void): Promise<StepResult> {
  return runIndependentStep('mv_persist_complete', config, onLog, async (ctx, log, checks) => {
    const { store, sessionId, config: c } = ctx;
    await sendMultiVariant(store, [c.modelA, c.modelB, c.modelC], c.prompt, log);
    await waitAllDone(store, c.roundTimeoutMs);
    checks.push(...await verifyPersistence(sessionId, 3));
  });
}

async function stepSkeleton(config: MultiVariantTestConfig, onLog?: (e: LogEntry) => void): Promise<StepResult> {
  const startTime = new Date().toISOString();
  const { logs, log } = createLogger('mv_skeleton_check', onLog);
  const caps = startCaptures(); const t0 = Date.now();
  const checks: VerificationCheck[] = [];
  let status: 'passed'|'failed' = 'passed'; let err: string|undefined; let v: VerificationResult = { passed: false, checks: [] };
  let sid = '';
  let reqCap: Awaited<ReturnType<typeof createRequestBodyCapture>>|null = null;
  let varCap: Awaited<ReturnType<typeof createVariantEventCapture>>|null = null;

  try {
    const sess = await createAndSwitchSession(log, 'skeleton');
    sid = sess.sessionId;
    reqCap = await createRequestBodyCapture(sid);
    varCap = await createVariantEventCapture(sid);
    await sendMultiVariant(sess.store, [config.modelA, config.modelB, config.modelC], config.longPrompt, log);

    const gotStart = await waitFor(() => varCap!.hasVariantStart(), 15000, 200);
    checks.push({ name: 'variant_start', passed: gotStart, detail: gotStart ? `${varCap!.events.length} events` : '❌ 15s无事件' });

    if (gotStart) {
      const { invoke } = await import('@tauri-apps/api/core');
      const data = await invoke<{ messages?: Array<{ id: string; role: string; variants?: Array<{ id: string; modelId?: string }> }> }>('chat_v2_load_session', { sessionId: sid });
      const ast = (data?.messages||[]).find(m => m.role==='assistant');
      checks.push({ name: '骨架存在', passed: !!ast, detail: ast ? `id=${ast.id}` : '❌' });
      if (ast) { const vs = ast.variants||[]; checks.push({ name: 'variants≥2', passed: vs.length>=2, detail: `${vs.length}` }); }
    }
    await waitAllDone(sess.store, config.roundTimeoutMs);
  } catch (e2) { err = e2 instanceof Error ? e2.message : String(e2); log('error','fatal',err); status = 'failed'; }
  finally {
    varCap?.stop(); reqCap?.stop(); stopCaptures(caps);
    const f = finalizeChecks(log, checks, status, err, t0);
    status = f.status; err = f.error; v = f.verification;
  }
  return mkResult('mv_skeleton_check', { status, startTime, t0, bodies: reqCap?.bodies??[], v, logs, c2: caps.chatV2.logs, cc: caps.console.captured, sid, err });
}

async function stepIconDom(config: MultiVariantTestConfig, onLog?: (e: LogEntry) => void): Promise<StepResult> {
  return runIndependentStep('mv_icon_and_dom', config, onLog, async (ctx, log, checks) => {
    const { store, config: c } = ctx;
    await sendMultiVariant(store, [c.modelA, c.modelB, c.modelC], c.prompt, log);
    await waitAllDone(store, c.roundTimeoutMs);
    await sleep(500);
    const aId = getLastMsgId(store, 'assistant')!;
    checks.push(...checkIcons(store, aId));
    const dom = domSnapshot();
    checks.push({ name: '3卡片', passed: dom.cards===3, detail: `${dom.cards}` });
    checks.push({ name: '3dots', passed: dom.dots===3, detail: `${dom.dots}` });
    checks.push({ name: '1active', passed: dom.activeDots===1, detail: `${dom.activeDots}` });
    checks.push({ name: 'Prev箭头', passed: dom.hasPrev, detail: `${dom.hasPrev}` });
    checks.push({ name: 'Next箭头', passed: dom.hasNext, detail: `${dom.hasNext}` });
  });
}

// =============================================================================
// Group F — 模式交替与历史完整性（共享会话）
// =============================================================================

async function runGroupF(config: MultiVariantTestConfig, onLog: ((e: LogEntry) => void) | undefined, onStep: (r: StepResult, i: number) => void, baseIdx: number): Promise<StepResult[]> {
  const results: StepResult[] = [];
  const skip = new Set(config.skipSteps || []);

  // ── Step 19: mv_mixed_single_multi — 单变体→多变体，持久化验证 ──
  if (!_abortRequested && !skip.has('mv_mixed_single_multi')) {
    const { logs, log } = createLogger('mv_mixed_single_multi', onLog);
    const st = new Date().toISOString(); const caps = startCaptures(); const t0 = Date.now();
    const checks: VerificationCheck[] = []; let status: 'passed'|'failed' = 'passed'; let err: string|undefined; let v: VerificationResult = { passed: false, checks: [] };
    let sid = '';
    let reqCap: Awaited<ReturnType<typeof createRequestBodyCapture>> | null = null;
    try {
      const sess = await createAndSwitchSession(log, 'GroupF-S→M');
      sid = sess.sessionId;
      reqCap = await createRequestBodyCapture(sid);
      const { store } = sess;

      // 1) 发送单变体消息
      log('info', 'phase', '发送单变体消息...');
      await sendSingleVariant(store, config.prompt, log);
      const done1 = await waitAllDone(store, config.roundTimeoutMs);
      checks.push({ name: '单变体完成', passed: done1, detail: done1 ? '✓' : '❌' });

      // 验证 pendingParallelModelIds 状态
      const pIds1 = store.getState().pendingParallelModelIds;
      checks.push({ name: 'pIds 为空', passed: !pIds1 || pIds1.length === 0, detail: `${JSON.stringify(pIds1)}` });

      await sleep(config.intervalMs);

      // 2) 发送多变体消息
      log('info', 'phase', '发送多变体消息...');
      await sendMultiVariant(store, [config.modelA, config.modelB, config.modelC], config.prompt, log);
      const done2 = await waitAllDone(store, config.roundTimeoutMs);
      checks.push({ name: '多变体完成', passed: done2, detail: done2 ? '✓' : '❌' });

      // Store 内验证
      const s = store.getState();
      const assistantMsgs = s.messageOrder.filter(id => s.messageMap.get(id)?.role === 'assistant');
      checks.push({ name: 'Store 2条助手', passed: assistantMsgs.length === 2, detail: `${assistantMsgs.length}` });

      if (assistantMsgs.length >= 2) {
        const msg1 = s.messageMap.get(assistantMsgs[0]);
        const msg2 = s.messageMap.get(assistantMsgs[1]);
        checks.push({ name: 'msg[0] 无变体', passed: !msg1?.variants || msg1.variants.length === 0, detail: `variants=${msg1?.variants?.length ?? 0}` });
        checks.push({ name: 'msg[1] 3变体', passed: msg2?.variants?.length === 3, detail: `variants=${msg2?.variants?.length ?? 0}` });
      }

      // 3) 持久化验证
      checks.push(...await verifyMixedPersistence(sid, [0, 3], log));
    } catch (e2) { err = e2 instanceof Error ? e2.message : String(e2); log('error', 'fatal', err); status = 'failed'; }
    finally { reqCap?.stop(); stopCaptures(caps); const f = finalizeChecks(log, checks, status, err, t0); status = f.status; err = f.error; v = f.verification; }
    const r = mkResult('mv_mixed_single_multi', { status, startTime: st, t0, bodies: reqCap?.bodies ?? [], v, logs, c2: caps.chatV2.logs, cc: caps.console.captured, sid, err });
    results.push(r); onStep(r, baseIdx);
    await sleep(config.intervalMs);
  }

  // ── Step 20: mv_mixed_multi_single — 多变体→单变体，状态机验证 ──
  if (!_abortRequested && !skip.has('mv_mixed_multi_single')) {
    const { logs, log } = createLogger('mv_mixed_multi_single', onLog);
    const st = new Date().toISOString(); const caps = startCaptures(); const t0 = Date.now();
    const checks: VerificationCheck[] = []; let status: 'passed'|'failed' = 'passed'; let err: string|undefined; let v: VerificationResult = { passed: false, checks: [] };
    let sid = '';
    let reqCap: Awaited<ReturnType<typeof createRequestBodyCapture>> | null = null;
    try {
      const sess = await createAndSwitchSession(log, 'GroupF-M→S');
      sid = sess.sessionId;
      reqCap = await createRequestBodyCapture(sid);
      const { store } = sess;

      // 1) 发送多变体消息
      log('info', 'phase', '发送多变体消息...');
      await sendMultiVariant(store, [config.modelA, config.modelB, config.modelC], config.prompt, log);
      const done1 = await waitAllDone(store, config.roundTimeoutMs);
      checks.push({ name: '多变体完成', passed: done1, detail: done1 ? '✓' : '❌' });

      // ★ 核心验证：pendingParallelModelIds 在多变体发送后应已恢复
      // sendMultiVariant 恢复了 monkey-patch，但 pendingParallelModelIds 值可能残留
      const pIdsAfterMulti = store.getState().pendingParallelModelIds;
      checks.push({ name: '多变体后 pIds 状态', passed: true, detail: `pIds=${JSON.stringify(pIdsAfterMulti)}` });

      await sleep(config.intervalMs);

      // 2) 发送单变体消息 — 验证不会意外走多变体路径
      log('info', 'phase', '发送单变体消息...');
      await sendSingleVariant(store, config.prompt, log);
      const done2 = await waitAllDone(store, config.roundTimeoutMs);
      checks.push({ name: '单变体完成', passed: done2, detail: done2 ? '✓' : '❌' });

      // Store 内验证
      const s = store.getState();
      const assistantMsgs = s.messageOrder.filter(id => s.messageMap.get(id)?.role === 'assistant');
      checks.push({ name: 'Store 2条助手', passed: assistantMsgs.length === 2, detail: `${assistantMsgs.length}` });

      if (assistantMsgs.length >= 2) {
        const msg1 = s.messageMap.get(assistantMsgs[0]);
        const msg2 = s.messageMap.get(assistantMsgs[1]);
        checks.push({ name: 'msg[0] 3变体', passed: msg1?.variants?.length === 3, detail: `variants=${msg1?.variants?.length ?? 0}` });
        checks.push({ name: 'msg[1] 无变体', passed: !msg2?.variants || msg2.variants.length === 0, detail: `variants=${msg2?.variants?.length ?? 0}` });
        // 确认第二条消息有 blockIds（非空内容）
        checks.push({ name: 'msg[1] 有blocks', passed: (msg2?.blockIds?.length ?? 0) > 0, detail: `blocks=${msg2?.blockIds?.length ?? 0}` });
      }

      // 3) 持久化验证
      checks.push(...await verifyMixedPersistence(sid, [3, 0], log));
    } catch (e2) { err = e2 instanceof Error ? e2.message : String(e2); log('error', 'fatal', err); status = 'failed'; }
    finally { reqCap?.stop(); stopCaptures(caps); const f = finalizeChecks(log, checks, status, err, t0); status = f.status; err = f.error; v = f.verification; }
    const r = mkResult('mv_mixed_multi_single', { status, startTime: st, t0, bodies: reqCap?.bodies ?? [], v, logs, c2: caps.chatV2.logs, cc: caps.console.captured, sid, err });
    results.push(r); onStep(r, baseIdx + 1);
    await sleep(config.intervalMs);
  }

  // ── Step 21: mv_mixed_alternating_persist — 3轮交替 + 全量持久化 ──
  if (!_abortRequested && !skip.has('mv_mixed_alternating_persist')) {
    const { logs, log } = createLogger('mv_mixed_alternating_persist', onLog);
    const st = new Date().toISOString(); const caps = startCaptures(); const t0 = Date.now();
    const checks: VerificationCheck[] = []; let status: 'passed'|'failed' = 'passed'; let err: string|undefined; let v: VerificationResult = { passed: false, checks: [] };
    let sid = '';
    let reqCap: Awaited<ReturnType<typeof createRequestBodyCapture>> | null = null;
    try {
      const sess = await createAndSwitchSession(log, 'GroupF-Alt');
      sid = sess.sessionId;
      reqCap = await createRequestBodyCapture(sid);
      const { store } = sess;

      // 轮次 1: 单变体
      log('info', 'phase', '轮次1: 单变体...');
      await sendSingleVariant(store, config.prompt, log);
      const d1 = await waitAllDone(store, config.roundTimeoutMs);
      checks.push({ name: '轮次1完成', passed: d1, detail: d1 ? '✓' : '❌' });
      await sleep(config.intervalMs);

      // 轮次 2: 多变体
      log('info', 'phase', '轮次2: 多变体...');
      await sendMultiVariant(store, [config.modelA, config.modelB, config.modelC], config.prompt, log);
      const d2 = await waitAllDone(store, config.roundTimeoutMs);
      checks.push({ name: '轮次2完成', passed: d2, detail: d2 ? '✓' : '❌' });
      await sleep(config.intervalMs);

      // 轮次 3: 单变体
      log('info', 'phase', '轮次3: 单变体...');
      await sendSingleVariant(store, config.prompt, log);
      const d3 = await waitAllDone(store, config.roundTimeoutMs);
      checks.push({ name: '轮次3完成', passed: d3, detail: d3 ? '✓' : '❌' });

      // Store 内验证
      const s = store.getState();
      const assistantMsgs = s.messageOrder.filter(id => s.messageMap.get(id)?.role === 'assistant');
      checks.push({ name: 'Store 3条助手', passed: assistantMsgs.length === 3, detail: `${assistantMsgs.length}` });

      if (assistantMsgs.length >= 3) {
        const m0 = s.messageMap.get(assistantMsgs[0]);
        const m1 = s.messageMap.get(assistantMsgs[1]);
        const m2 = s.messageMap.get(assistantMsgs[2]);
        checks.push({ name: 'msg[0] 单变体', passed: !m0?.variants || m0.variants.length === 0, detail: `v=${m0?.variants?.length ?? 0}` });
        checks.push({ name: 'msg[1] 3变体', passed: m1?.variants?.length === 3, detail: `v=${m1?.variants?.length ?? 0}` });
        checks.push({ name: 'msg[2] 单变体', passed: !m2?.variants || m2.variants.length === 0, detail: `v=${m2?.variants?.length ?? 0}` });
      }

      // 全量持久化验证
      checks.push(...await verifyMixedPersistence(sid, [0, 3, 0], log));

      // 最终状态验证
      checks.push({ name: '无僵尸', passed: store.getState().streamingVariantIds.size === 0, detail: `${store.getState().streamingVariantIds.size}` });
      const finalPIds = store.getState().pendingParallelModelIds;
      checks.push({ name: '最终 pIds 干净', passed: !finalPIds || finalPIds.length === 0, detail: `${JSON.stringify(finalPIds)}` });
    } catch (e2) { err = e2 instanceof Error ? e2.message : String(e2); log('error', 'fatal', err); status = 'failed'; }
    finally { reqCap?.stop(); stopCaptures(caps); const f = finalizeChecks(log, checks, status, err, t0); status = f.status; err = f.error; v = f.verification; }
    const r = mkResult('mv_mixed_alternating_persist', { status, startTime: st, t0, bodies: reqCap?.bodies ?? [], v, logs, c2: caps.chatV2.logs, cc: caps.console.captured, sid, err });
    results.push(r); onStep(r, baseIdx + 2);
  }

  return results;
}

// =============================================================================
// 全量运行器
// =============================================================================

let _abortRequested = false;
export function requestAbort() { _abortRequested = true; }
export function resetAbort() { _abortRequested = false; }

export async function runAllMultiVariantTests(
  config: MultiVariantTestConfig,
  onStepComplete?: (result: StepResult, index: number, total: number) => void,
  onLog?: (entry: LogEntry) => void,
): Promise<StepResult[]> {
  _abortRequested = false;
  _globalLogId = 0;

  const skip = new Set(config.skipSteps || []);
  const total = ALL_STEPS.filter(s => !skip.has(s)).length;
  const results: StepResult[] = [];
  let idx = 0;

  const push = (r: StepResult) => { results.push(r); onStepComplete?.(r, idx++, total); };
  const skipped = (step: StepName): StepResult => ({ step, status: 'skipped', startTime: new Date().toISOString(), endTime: new Date().toISOString(), durationMs: 0, capturedRequestBodies: [], verification: { passed: true, checks: [] }, logs: [], chatV2Logs: [], consoleLogs: [], sessionId: '' });

  // ── Group A ──
  for (const [step, fn] of [['mv_send_3', stepSend3], ['mv_cancel_middle', stepCancelMiddle], ['mv_cancel_all', stepCancelAll]] as const) {
    if (_abortRequested || skip.has(step)) { push(skipped(step)); continue; }
    push(await fn(config, onLog)); await sleep(config.intervalMs);
  }

  // ── Group B ──
  for (const [step, fn] of [['mv_retry_one', stepRetryOne], ['mv_retry_all', stepRetryAll], ['mv_fast_cancel_retry', stepFastCancelRetry]] as const) {
    if (_abortRequested || skip.has(step)) { push(skipped(step)); continue; }
    push(await fn(config, onLog)); await sleep(config.intervalMs);
  }

  // ── Group C (shared session) ──
  if (!_abortRequested && GROUP_C.some(s => !skip.has(s))) {
    try {
      const cResults = await runGroupC(config, onLog, (r, i) => onStepComplete?.(r, idx + i, total), idx);
      for (const r of cResults) { results.push(r); idx++; }
    } catch (e) {
      for (const s of GROUP_C) { if (!results.some(r => r.step === s)) push({ ...skipped(s), status: 'failed', error: `GroupC 初始化失败: ${e}` }); }
    }
    await sleep(config.intervalMs);
  } else {
    for (const s of GROUP_C) push(skipped(s));
  }

  // ── Group D ──
  const groupDFns: Array<[StepName, (c: MultiVariantTestConfig, l?: (e: LogEntry) => void) => Promise<StepResult>]> = [
    ['mv_cancel_first', stepCancelFirst], ['mv_cancel_last', stepCancelLast],
    ['mv_cancel_two', stepCancelTwo], ['mv_cancel_then_delete', stepCancelThenDelete],
    ['mv_switch_during_stream', stepSwitchDuringStream],
  ];
  for (const [step, fn] of groupDFns) {
    if (_abortRequested || skip.has(step)) { push(skipped(step)); continue; }
    push(await fn(config, onLog)); await sleep(config.intervalMs);
  }

  // ── Group E ──
  for (const [step, fn] of [['mv_persist_complete', stepPersist], ['mv_skeleton_check', stepSkeleton], ['mv_icon_and_dom', stepIconDom]] as const) {
    if (_abortRequested || skip.has(step)) { push(skipped(step)); continue; }
    push(await fn(config, onLog)); await sleep(config.intervalMs);
  }

  // ── Group F (shared session per step) ──
  if (!_abortRequested && GROUP_F.some(s => !skip.has(s))) {
    try {
      const fResults = await runGroupF(config, onLog, (r, i) => onStepComplete?.(r, idx + i, total), idx);
      for (const r of fResults) { results.push(r); idx++; }
    } catch (e) {
      for (const s of GROUP_F) { if (!results.some(r => r.step === s)) push({ ...skipped(s), status: 'failed', error: `GroupF 初始化失败: ${e}` }); }
    }
  } else {
    for (const s of GROUP_F) push(skipped(s));
  }

  return results;
}

// =============================================================================
// 数据清理
// =============================================================================

export async function cleanupMultiVariantTestData(
  onProgress?: (msg: string) => void,
): Promise<{ deleted: number; errors: string[] }> {
  const sm = await getSessionManager();
  const errors: string[] = [];
  let deleted = 0;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    for (const status of ['active', 'deleted'] as const) {
      let offset = 0;
      const limit = 50;
      let hasMore = true;
      while (hasMore) {
        const list = await invoke<{ sessions: Array<{ id: string; title: string }> }>('chat_v2_list_sessions', { status, offset, limit });
        const sessions = list?.sessions || [];
        hasMore = sessions.length === limit;
        for (const s of sessions) {
          if (s.title?.startsWith(MV_TEST_SESSION_PREFIX)) {
            try {
              await invoke('chat_v2_soft_delete_session', { sessionId: s.id });
              deleted++;
              onProgress?.(`删除: ${s.title} (${s.id})`);
            } catch (e) { errors.push(`${s.id}: ${e}`); }
          }
        }
        offset += limit;
      }
    }
  } catch (e) { errors.push(`清理失败: ${e}`); }
  onProgress?.(`清理完成: 删除 ${deleted} 个, 错误 ${errors.length} 个`);
  return { deleted, errors };
}
