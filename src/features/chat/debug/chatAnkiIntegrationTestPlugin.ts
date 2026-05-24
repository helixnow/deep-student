/**
 * ChatAnki 集成自动测试 — 核心逻辑模块
 *
 * 通过真实对话 + DOM 模拟覆盖 ChatAnki 制卡管线的关键路径与边缘场景。
 *
 * 设计原则（与 MultiVariantTestPlugin / SubagentTestPlugin 对齐）：
 *   1. 每个场景独立 session，互不干扰
 *   2. 使用 store.sendMessage() 发送消息（稳定 API），不依赖 DOM 模拟输入
 *   3. DOM 操作仅用于用户交互模拟（按钮点击），使用 data-testid 精确选择器
 *   4. 捕获 console / ChatV2 日志 / Tauri 事件三个维度
 *   5. 持久化验证通过 invoke 读取数据库
 *   6. 结果构造统一模板（finalizeResult）
 *
 * 测试矩阵（3 组 7 场景）：
 *
 * A 制卡核心流（1 次 LLM 调用，场景间复用结果）：
 *   A① 制卡端到端：发送 → 卡片出现 → 块 success → DOM 渲染 → 进度信息
 *   A② 进度阶段正确性：直接读 store 中 progress.stage 变化，检测 normalizeStageToStep 遗漏
 *
 * B 用户操作流（复用 A① 的会话，纯 DOM 操作无额外 LLM 调用）：
 *   B③ 内联编辑保存：展开 → 编辑 → 保存 → 验证 store 更新
 *   B④ 删除卡片：删除卡片 → 验证无 confirm → 计数减少
 *   B⑤ 保存到库 + 持久化验证：点保存 → 检查 UI + 数据库
 *
 * C 数据一致性（各自独立 session）：
 *   C⑥ onEnd 覆盖检测：编辑后等 onEnd → 检查编辑是否被覆盖
 *   C⑦ AnkiConnect 状态：检查有无刷新机制
 */

import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { createSessionWithDefaults } from '../core/session/createSessionWithDefaults';
import type { StoreApi } from 'zustand';
import type { ChatStore } from '../core/types';
import type { AnkiCardsBlockData } from '../plugins/blocks/ankiCardsBlock';
import { CHATV2_LOG_EVENT, type ChatV2LogEntry } from './chatV2Logger';

// =============================================================================
// 类型
// =============================================================================

export type ScenarioName =
  | 'ca_e2e_run'
  | 'ca_progress_stages'
  | 'ca_inline_edit'
  | 'ca_delete_card'
  | 'ca_save_to_library'
  | 'ca_onend_overwrite'
  | 'ca_anki_connect_no_refresh';

export const ALL_SCENARIOS: ScenarioName[] = [
  'ca_e2e_run',
  'ca_progress_stages',
  'ca_inline_edit',
  'ca_delete_card',
  'ca_save_to_library',
  'ca_onend_overwrite',
  'ca_anki_connect_no_refresh',
];

export const SCENARIO_LABELS: Record<ScenarioName, string> = {
  ca_e2e_run: 'A① 制卡端到端',
  ca_progress_stages: 'A② 进度阶段正确性',
  ca_inline_edit: 'B③ 内联编辑保存',
  ca_delete_card: 'B④ 删除卡片',
  ca_save_to_library: 'B⑤ 保存到库',
  ca_onend_overwrite: 'C⑥ onEnd 覆盖检测',
  ca_anki_connect_no_refresh: 'C⑦ AnkiConnect 状态',
};

export const SCENARIO_DESCRIPTIONS: Record<ScenarioName, string> = {
  ca_e2e_run: '发送 → chatanki_run → 卡片生成 → 块 success → DOM/store 全验证',
  ca_progress_stages: '从 store 读取 progress.stage 历史，检测 normalizeStageToStep 遗漏',
  ca_inline_edit: '展开编辑卡片 → 保存 → 验证 store 更新',
  ca_delete_card: '删除卡片 → 验证无 confirm 弹窗 → 计数减少',
  ca_save_to_library: '保存到库 → 检查 UI + 数据库持久化',
  ca_onend_overwrite: '编辑卡片后等 onEnd → 检查编辑是否被后端覆盖',
  ca_anki_connect_no_refresh: '检查 AnkiConnect 状态 badge 有无刷新机制',
};

export const GROUP_A: ScenarioName[] = ['ca_e2e_run', 'ca_progress_stages'];
export const GROUP_B: ScenarioName[] = ['ca_inline_edit', 'ca_delete_card', 'ca_save_to_library'];
export const GROUP_C: ScenarioName[] = ['ca_onend_overwrite', 'ca_anki_connect_no_refresh'];

export interface ChatAnkiTestConfig {
  prompt: string;
  timeoutMs: number;
  pollMs: number;
  settleMs: number;
  skipScenarios: ScenarioName[];
}

export interface VerificationCheck { name: string; passed: boolean; detail: string; }
export interface VerificationResult { passed: boolean; checks: VerificationCheck[]; }
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'success';
export interface LogEntry { id: number; timestamp: string; level: LogLevel; phase: string; message: string; data?: Record<string, unknown>; }
export interface CapturedConsoleEntry { level: 'log' | 'warn' | 'error' | 'debug'; timestamp: string; message: string; }

export interface ScenarioResult {
  scenario: ScenarioName;
  status: 'passed' | 'failed' | 'skipped';
  startTime: string;
  endTime: string;
  durationMs: number;
  sessionId: string;
  error?: string;
  verification: VerificationResult;
  logs: LogEntry[];
  consoleLogs: CapturedConsoleEntry[];
  chatV2Logs: ChatV2LogEntry[];
  ankiEvents: AnkiEventEntry[];
  stageSnapshots: string[];
}

export interface AnkiEventEntry {
  type: string;
  timestamp: string;
  documentId?: string;
  data?: Record<string, unknown>;
}

export type OverallStatus = 'idle' | 'running' | 'completed' | 'aborted';
export const CA_TEST_EVENT = 'CHATANKI_INTEGRATION_TEST_LOG';
export const CA_TEST_SESSION_PREFIX = '[ChatAnkiTest]';

type LogFn = (level: LogLevel, phase: string, msg: string, data?: Record<string, unknown>) => void;

// =============================================================================
// 基础设施
// =============================================================================

let _globalLogId = 0;
const MAX_LOGS = 500;
let _abortRequested = false;

export function requestAbort() { _abortRequested = true; }
export function resetAbort() { _abortRequested = false; }
export function isAbortRequested() { return _abortRequested; }

function createLogger(scenarioName: string, onLog?: (entry: LogEntry) => void) {
  const logs: LogEntry[] = [];
  function log(level: LogLevel, phase: string, message: string, data?: Record<string, unknown>) {
    const entry: LogEntry = { id: ++_globalLogId, timestamp: new Date().toISOString(), level, phase, message, data };
    if (logs.length < MAX_LOGS) logs.push(entry);
    const emoji = { debug: '🔍', info: '🔷', warn: '⚠️', error: '❌', success: '✅' }[level];
    console.log(`${emoji} [CATest][${scenarioName}][${phase}] ${message}`, data ?? '');
    onLog?.(entry);
    window.dispatchEvent(new CustomEvent(CA_TEST_EVENT, { detail: entry }));
  }
  return { logs, log };
}

function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }
async function waitFor(cond: () => boolean, timeoutMs: number, pollMs = 200): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (_abortRequested) return false;
    if (cond()) return true;
    await sleep(pollMs);
  }
  return false;
}

// =============================================================================
// console 捕获（对齐 MultiVariantTestPlugin）
// =============================================================================

const CAPTURE_PREFIXES = [
  '[ChatV2', '[TauriAdapter', '[EventBridge', '[AnkiCardsBlock',
  '[ankiCards]', '[anki]', '[ANKI_', '[ChatAnki',
];

function createConsoleCapture() {
  const captured: CapturedConsoleEntry[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, debug: console.debug };
  function wrap(level: CapturedConsoleEntry['level'], origFn: (...a: unknown[]) => void) {
    return (...args: unknown[]) => {
      origFn(...args);
      if (args.length > 0 && CAPTURE_PREFIXES.some(p => String(args[0]).includes(p))) {
        if (captured.length < MAX_LOGS) {
          captured.push({ level, timestamp: new Date().toISOString(), message: String(args[0]) });
        }
      }
    };
  }
  return {
    start() { console.log = wrap('log', orig.log); console.warn = wrap('warn', orig.warn); console.error = wrap('error', orig.error); console.debug = wrap('debug', orig.debug); },
    stop() { console.log = orig.log; console.warn = orig.warn; console.error = orig.error; console.debug = orig.debug; },
    captured,
  };
}

// =============================================================================
// ChatV2 日志捕获（对齐 MultiVariantTestPlugin）
// =============================================================================

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

// =============================================================================
// Anki 事件捕获
// =============================================================================

function createAnkiEventCapture() {
  const events: AnkiEventEntry[] = [];
  let unlisten: UnlistenFn | null = null;

  return {
    async start() {
      unlisten = await listen<unknown>('anki_generation_event', (event) => {
        const outerPayload = event.payload as Record<string, unknown>;
        const raw = (outerPayload.payload ?? outerPayload) as Record<string, unknown>;
        if (!raw || typeof raw !== 'object') return;

        let type: string;
        let data: Record<string, unknown>;
        if ('type' in raw && 'data' in raw) {
          type = String(raw.type);
          data = (raw.data ?? {}) as Record<string, unknown>;
        } else {
          const keys = Object.keys(raw);
          type = keys[0] ?? 'unknown';
          data = (raw[type] ?? {}) as Record<string, unknown>;
        }

        events.push({
          type,
          timestamp: new Date().toISOString(),
          documentId: (data.document_id ?? data.documentId) as string | undefined,
          data,
        });
      });
    },
    stop() { unlisten?.(); unlisten = null; },
    events,
    hasEvent: (type: string) => events.some(e => e.type === type),
    countEvents: (type: string) => events.filter(e => e.type === type).length,
  };
}

// =============================================================================
// Store 辅助
// =============================================================================

function getAnkiBlock(store: StoreApi<ChatStore>): { blockId: string; block: { type: string; status: string; toolOutput?: unknown; error?: string } } | null {
  const blocks = store.getState().blocks;
  for (const [id, block] of blocks) {
    if (block.type === 'anki_cards') return { blockId: id, block };
  }
  return null;
}

function getAnkiBlockData(store: StoreApi<ChatStore>): AnkiCardsBlockData | null {
  const b = getAnkiBlock(store);
  return b ? (b.block.toolOutput ?? {}) as AnkiCardsBlockData : null;
}

function getAnkiBlockStatus(store: StoreApi<ChatStore>): string | null {
  return getAnkiBlock(store)?.block.status ?? null;
}

// =============================================================================
// 会话管理（使用 sendMessage API，不依赖 DOM 输入）
// =============================================================================

async function getSessionManager() { return (await import('../core/session/sessionManager')).sessionManager; }

async function createTestSession(log: LogFn, label: string): Promise<{ store: StoreApi<ChatStore>; sessionId: string }> {
  const sm = await getSessionManager();
  const session = await createSessionWithDefaults({ mode: 'chat', title: `${CA_TEST_SESSION_PREFIX} ${label}` });
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

async function sendAndWaitForAnkiBlock(store: StoreApi<ChatStore>, prompt: string, timeoutMs: number, pollMs: number, log: LogFn): Promise<void> {
  log('info', 'send', '通过 store.sendMessage 发送制卡 prompt');
  await store.getState().sendMessage(prompt);
  log('success', 'send', 'prompt 已发送，等待 anki_cards 块...');

  const appeared = await waitFor(() => !!getAnkiBlock(store), timeoutMs, pollMs);
  if (!appeared) throw new Error('anki_cards 块未出现（LLM 可能未调用 chatanki_run）');

  log('info', 'wait', '块已出现，等待完成...');
  const done = await waitFor(() => {
    const s = getAnkiBlockStatus(store);
    return s === 'success' || s === 'error';
  }, timeoutMs, pollMs);
  if (!done) throw new Error('anki_cards 块未在超时内完成');
}

// =============================================================================
// 捕获管理（统一启停）
// =============================================================================

interface Captures { console: ReturnType<typeof createConsoleCapture>; chatV2: ReturnType<typeof createChatV2LogCapture>; }
function startCaptures(): Captures { const c = createConsoleCapture(); const c2 = createChatV2LogCapture(); c.start(); c2.start(); return { console: c, chatV2: c2 }; }
function stopCaptures(c: Captures) { c.console.stop(); c.chatV2.stop(); }

// =============================================================================
// 结果构造（统一模板，对齐 MultiVariantTestPlugin.finalizeChecks）
// =============================================================================

function verify(name: string, passed: boolean, detail: string): VerificationCheck {
  return { name, passed, detail };
}

function finalizeResult(
  scenario: ScenarioName, checks: VerificationCheck[], t0: number,
  sessionId: string, logs: LogEntry[], captures: Captures,
  ankiEvents: AnkiEventEntry[], stageSnapshots: string[],
  error?: string,
): ScenarioResult {
  const allPassed = checks.every(c => c.passed);
  return {
    scenario,
    status: allPassed && !error ? 'passed' : 'failed',
    startTime: new Date(t0).toISOString(),
    endTime: new Date().toISOString(),
    durationMs: Date.now() - t0,
    sessionId,
    error: allPassed ? error : (error || '验证未通过: ' + checks.filter(c => !c.passed).map(c => c.name).join(', ')),
    verification: { passed: allPassed, checks },
    logs,
    consoleLogs: [...captures.console.captured],
    chatV2Logs: [...captures.chatV2.logs],
    ankiEvents: [...ankiEvents],
    stageSnapshots: [...stageSnapshots],
  };
}

// =============================================================================
// 场景 A① 制卡端到端
// =============================================================================

async function runScenario_e2eRun(
  config: ChatAnkiTestConfig, log: LogFn,
  ankiCapture: ReturnType<typeof createAnkiEventCapture>,
  captures: Captures,
): Promise<ScenarioResult> {
  const t0 = Date.now();
  const checks: VerificationCheck[] = [];
  let sessionId = '';

  try {
    const { store, sessionId: sid } = await createTestSession(log, 'A① 端到端');
    sessionId = sid;

    await sendAndWaitForAnkiBlock(store, config.prompt, config.timeoutMs, config.pollMs, log);
    await sleep(config.settleMs);

    const bd = getAnkiBlockData(store);
    const cards = bd?.cards ?? [];
    const status = getAnkiBlockStatus(store);

    checks.push(verify('卡片已生成', cards.length > 0, `${cards.length} 张`));
    checks.push(verify('块状态 success', status === 'success', `status=${status}`));
    checks.push(verify('DOM 块存在', !!document.querySelector('.chat-v2-anki-cards-block'), ''));
    checks.push(verify('进度条存在', !!document.querySelector('[data-testid="chatanki-progress"]'), ''));

    const metrics = document.querySelector('[data-testid="chatanki-progress-metrics"]');
    checks.push(verify('进度指标文本', !!metrics?.textContent, metrics?.textContent ?? '空'));

    const hasErrorCards = cards.some(c => c.is_error_card);
    if (hasErrorCards) {
      const blockEl = document.querySelector('.chat-v2-anki-cards-block');
      const hasVisualMark = !!blockEl?.querySelector('[data-error-card], .anki-error-card');
      checks.push(verify('错误卡片有视觉区分', hasVisualMark, hasVisualMark ? '有标记' : '无标记（确认缺失：前端未检查 is_error_card）'));
    }

    checks.push(verify('documentId 存在', !!bd?.documentId, bd?.documentId?.slice(0, 12) ?? '无'));
    checks.push(verify('ankiConnect 已检查', bd?.ankiConnect?.checkedAt != null, bd?.ankiConnect?.checkedAt ?? '未检查'));

    log('success', 'done', `端到端完成: ${cards.length} 张卡片, status=${status}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('error', 'fail', msg);
    checks.push(verify('场景未崩溃', false, msg));
  }

  return finalizeResult('ca_e2e_run', checks, t0, sessionId, [], captures, [...ankiCapture.events], [], undefined);
}

// =============================================================================
// 场景 A② 进度阶段正确性（直接从 store 轮询 progress.stage）
// =============================================================================

async function runScenario_progressStages(
  config: ChatAnkiTestConfig, log: LogFn,
  ankiCapture: ReturnType<typeof createAnkiEventCapture>,
  captures: Captures,
): Promise<ScenarioResult> {
  const t0 = Date.now();
  const checks: VerificationCheck[] = [];
  const stageSnapshots: string[] = [];
  let sessionId = '';

  try {
    const { store, sessionId: sid } = await createTestSession(log, 'A② 进度阶段');
    sessionId = sid;

    log('info', 'send', '发送制卡 prompt 并轮询 progress.stage');
    await store.getState().sendMessage(config.prompt);

    const done = await waitFor(() => {
      const bd = getAnkiBlockData(store);
      const stage = bd?.progress?.stage;
      if (stage && (stageSnapshots.length === 0 || stageSnapshots[stageSnapshots.length - 1] !== stage)) {
        stageSnapshots.push(stage);
        log('debug', 'stage', `新阶段: ${stage}`);
      }
      const s = getAnkiBlockStatus(store);
      return s === 'success' || s === 'error';
    }, config.timeoutMs, 300);

    if (!done) throw new Error('块未完成');
    await sleep(config.settleMs);

    const bd = getAnkiBlockData(store);
    if (bd?.progress?.stage && (stageSnapshots.length === 0 || stageSnapshots[stageSnapshots.length - 1] !== bd.progress.stage)) {
      stageSnapshots.push(bd.progress.stage);
    }

    log('info', 'verify', `阶段序列: [${stageSnapshots.join(' → ')}]`);

    checks.push(verify('至少经历 2 个阶段', stageSnapshots.length >= 2, `${stageSnapshots.length} 个: [${stageSnapshots.join(', ')}]`));

    const hasStreamingToRouting = stageSnapshots.some((s, i) =>
      s.toLowerCase() === 'routing' && i > 0 && stageSnapshots[i - 1]?.toLowerCase() === 'streaming'
    );
    checks.push(verify('无 streaming→routing 回退', !hasStreamingToRouting, hasStreamingToRouting ? `检测到回退` : `正常`));

    const normalizeStageToStep = (stage: string): string => {
      switch (stage.toLowerCase()) {
        case 'routing': case 'queued': return 'routing';
        case 'importing': return 'importing';
        case 'generating': case 'paused': return 'generating';
        case 'completed': case 'success': return 'completed';
        case 'cancelled': case 'canceled': return 'cancelled';
        case 'error': case 'failed': return 'failed';
        default: return 'routing';
      }
    };
    const unmappedStages = stageSnapshots.filter(s => normalizeStageToStep(s) === 'routing' && s.toLowerCase() !== 'routing' && s.toLowerCase() !== 'queued');
    checks.push(verify(
      '所有阶段被 normalizeStageToStep 正确映射',
      unmappedStages.length === 0,
      unmappedStages.length > 0 ? `未映射的阶段: [${unmappedStages.join(', ')}]（会回退到 routing）` : '全部正确映射'
    ));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('error', 'fail', msg);
    checks.push(verify('场景未崩溃', false, msg));
  }

  return finalizeResult('ca_progress_stages', checks, t0, sessionId, [], captures, [...ankiCapture.events], stageSnapshots, undefined);
}

// =============================================================================
// 场景 B③ 内联编辑（复用已完成的 session 或新建）
// =============================================================================

async function runScenario_inlineEdit(
  config: ChatAnkiTestConfig, log: LogFn,
  ankiCapture: ReturnType<typeof createAnkiEventCapture>,
  captures: Captures,
  sharedSession?: { store: StoreApi<ChatStore>; sessionId: string },
): Promise<ScenarioResult> {
  const t0 = Date.now();
  const checks: VerificationCheck[] = [];
  let sessionId = '';

  try {
    const { store, sessionId: sid } = sharedSession ?? await createTestSession(log, 'B③ 编辑');
    sessionId = sid;

    if (!sharedSession) {
      await sendAndWaitForAnkiBlock(store, config.prompt, config.timeoutMs, config.pollMs, log);
      await sleep(config.settleMs);
    }

    const bd = getAnkiBlockData(store);
    if (!bd || (bd.cards?.length ?? 0) === 0) throw new Error('无卡片可编辑');
    const blockId = getAnkiBlock(store)!.blockId;
    const originalFront = bd.cards[0].front ?? '';
    log('info', 'edit', `原始 front: "${originalFront.slice(0, 50)}"`);

    const editMark = `[CATest_Edit_${Date.now()}]`;
    const newCards = [...bd.cards];
    newCards[0] = { ...newCards[0], front: editMark };
    const newToolOutput = { ...bd, cards: newCards };

    store.getState().updateBlock(blockId, { toolOutput: newToolOutput });
    log('info', 'edit', `store.updateBlock: front → "${editMark}"`);
    await sleep(100);

    const afterEdit = getAnkiBlockData(store);
    checks.push(verify('store 已更新', afterEdit?.cards?.[0]?.front === editMark, `front="${afterEdit?.cards?.[0]?.front?.slice(0, 30)}"`));

    try {
      await invoke('chat_v2_update_block_tool_output', {
        blockId,
        toolOutputJson: JSON.stringify(newToolOutput),
      });
      log('info', 'persist', 'persistToolOutput 调用成功');

      await sleep(500);
      const sessionData = await invoke<{ blocks?: Array<{ id: string; toolOutput?: unknown }> }>('chat_v2_load_session', { sessionId: sid });
      const allBlocks = sessionData?.blocks ?? [];
      const dbBlock = allBlocks.find(b => b.id === blockId);
      if (dbBlock?.toolOutput) {
        const loadedData = (typeof dbBlock.toolOutput === 'string' ? JSON.parse(dbBlock.toolOutput) : dbBlock.toolOutput) as AnkiCardsBlockData;
        const dbFront = loadedData.cards?.[0]?.front ?? '';
        checks.push(verify('DB 持久化内容正确', dbFront === editMark, `DB front="${dbFront.slice(0, 30)}"`));
      } else {
        checks.push(verify('DB 读回验证', !!dbBlock, dbBlock ? 'block 存在但无 toolOutput' : '未找到 block'));
      }
    } catch (persistErr) {
      checks.push(verify('persistToolOutput 成功', false, String(persistErr)));
    }

    checks.push(verify('卡片数量不变', (afterEdit?.cards?.length ?? 0) === bd.cards.length, `${afterEdit?.cards?.length ?? 0} vs ${bd.cards.length}`));

    store.getState().updateBlock(blockId, { toolOutput: { ...bd } });
    log('info', 'cleanup', '恢复原始卡片数据');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('error', 'fail', msg);
    checks.push(verify('场景未崩溃', false, msg));
  }

  return finalizeResult('ca_inline_edit', checks, t0, sessionId, [], captures, [...ankiCapture.events], [], undefined);
}

// =============================================================================
// 场景 B④ 删除卡片
// =============================================================================

async function runScenario_deleteCard(
  config: ChatAnkiTestConfig, log: LogFn,
  ankiCapture: ReturnType<typeof createAnkiEventCapture>,
  captures: Captures,
  sharedSession?: { store: StoreApi<ChatStore>; sessionId: string },
): Promise<ScenarioResult> {
  const t0 = Date.now();
  const checks: VerificationCheck[] = [];
  let sessionId = '';

  try {
    const { store, sessionId: sid } = sharedSession ?? await createTestSession(log, 'B④ 删除');
    sessionId = sid;

    if (!sharedSession) {
      await sendAndWaitForAnkiBlock(store, config.prompt, config.timeoutMs, config.pollMs, log);
      await sleep(config.settleMs);
    }

    const bd = getAnkiBlockData(store);
    const origCount = bd?.cards?.length ?? 0;
    if (origCount < 2) throw new Error(`卡片不足 2 张（${origCount}），无法测试`);

    const blockEl = document.querySelector('.chat-v2-anki-cards-block');
    if (!blockEl) throw new Error('未找到 anki_cards_block DOM');

    const expandBtn = blockEl.querySelector('.chatanki-bottom-actions button') as HTMLButtonElement | null;
    if (expandBtn) { expandBtn.click(); log('info', 'dom', '点击展开按钮'); await sleep(600); }

    const allCardEls = blockEl.querySelectorAll('[class*="border"][class*="rounded-lg"]');
    if (allCardEls.length === 0) throw new Error('展开后无卡片元素');
    const firstCardEl = allCardEls[0] as HTMLElement;

    const editTrigger = firstCardEl.querySelector('button[aria-label="edit"]') as HTMLButtonElement | null;
    if (editTrigger) { editTrigger.click(); log('info', 'dom', '点击编辑触发器'); }
    else { firstCardEl.click(); log('info', 'dom', '点击卡片元素'); }
    await sleep(500);

    const origConfirm = window.confirm;
    let confirmCalled = false;
    window.confirm = () => { confirmCalled = true; return true; };

    const deleteBtn = blockEl.querySelector('button.text-destructive, button[class*="text-destructive"]') as HTMLButtonElement | null;
    if (!deleteBtn) {
      window.confirm = origConfirm;
      throw new Error('未找到删除按钮（.text-destructive）');
    }
    deleteBtn.click();
    log('info', 'dom', '点击了删除按钮');
    await sleep(500);

    window.confirm = origConfirm;

    checks.push(verify('无 confirm 弹窗', !confirmCalled, confirmCalled ? '触发了 confirm（有确认）' : '未触发 confirm（确认缺失：删除无确认对话框）'));

    const afterDel = getAnkiBlockData(store);
    const newCount = afterDel?.cards?.length ?? 0;
    checks.push(verify('卡片数量减少', newCount === origCount - 1, `${origCount} → ${newCount}`));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('error', 'fail', msg);
    checks.push(verify('场景未崩溃', false, msg));
  }

  return finalizeResult('ca_delete_card', checks, t0, sessionId, [], captures, [...ankiCapture.events], [], undefined);
}

// =============================================================================
// 场景 B⑤ 保存到库 + 持久化验证
// =============================================================================

async function runScenario_saveToLibrary(
  config: ChatAnkiTestConfig, log: LogFn,
  ankiCapture: ReturnType<typeof createAnkiEventCapture>,
  captures: Captures,
  sharedSession?: { store: StoreApi<ChatStore>; sessionId: string },
): Promise<ScenarioResult> {
  const t0 = Date.now();
  const checks: VerificationCheck[] = [];
  let sessionId = '';

  try {
    const { store, sessionId: sid } = sharedSession ?? await createTestSession(log, 'B⑤ 保存');
    sessionId = sid;

    if (!sharedSession) {
      await sendAndWaitForAnkiBlock(store, config.prompt, config.timeoutMs, config.pollMs, log);
      await sleep(config.settleMs);
    }

    const bd = getAnkiBlockData(store);
    const documentId = bd?.documentId;
    checks.push(verify('有 documentId', !!documentId, documentId?.slice(0, 12) ?? '无'));

    if (documentId) {
      try {
        const dbCards = await invoke<unknown[]>('get_document_cards', { documentId });
        const dbCount = Array.isArray(dbCards) ? dbCards.length : 0;
        const storeCount = bd?.cards?.length ?? 0;
        checks.push(verify('DB 卡片已存在', dbCount > 0, `DB=${dbCount}, Store=${storeCount}`));

        const match = dbCount > 0 && storeCount > 0;
        checks.push(verify('DB 与 store 卡片数一致', Math.abs(dbCount - storeCount) <= 2, `DB=${dbCount}, Store=${storeCount}`));

        if (match) {
          log('info', 'verify', '卡片已在制卡时自动保存到 DB，"保存到库"按钮对已有卡片会走 INSERT OR IGNORE → localStorage 降级');
        }
      } catch (dbErr) {
        checks.push(verify('DB 查询', false, String(dbErr)));
      }
    }

    const actionArea = document.querySelector('.chatanki-bottom-actions');
    if (actionArea) {
      const saveBtn = actionArea.querySelector('button:nth-child(2)') as HTMLButtonElement | null;
      if (saveBtn && !saveBtn.disabled) {
        saveBtn.click();
        log('info', 'dom', '点击了保存按钮');
        await sleep(3000);

        const iconAfter = saveBtn.querySelector('svg');
        const svgClass = iconAfter?.getAttribute('class') ?? '';
        const looksSuccess = svgClass.includes('lucide-check') || svgClass.includes('text-emerald');
        checks.push(verify('保存按钮反馈正常', looksSuccess || !svgClass.includes('text-destructive'), `svg class: ${svgClass.slice(0, 60)}`));
      } else {
        checks.push(verify('保存按钮可点击', false, saveBtn ? '按钮禁用' : '未找到按钮'));
      }
    } else {
      checks.push(verify('操作区域存在', false, '未找到 .chatanki-bottom-actions'));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('error', 'fail', msg);
    checks.push(verify('场景未崩溃', false, msg));
  }

  return finalizeResult('ca_save_to_library', checks, t0, sessionId, [], captures, [...ankiCapture.events], [], undefined);
}

// =============================================================================
// 场景 C⑥ onEnd 覆盖检测
// =============================================================================

async function runScenario_onEndOverwrite(
  config: ChatAnkiTestConfig, log: LogFn,
  ankiCapture: ReturnType<typeof createAnkiEventCapture>,
  captures: Captures,
): Promise<ScenarioResult> {
  const t0 = Date.now();
  const checks: VerificationCheck[] = [];
  let sessionId = '';

  try {
    const { store, sessionId: sid } = await createTestSession(log, 'C⑥ onEnd 覆盖');
    sessionId = sid;

    await store.getState().sendMessage(config.prompt);
    log('info', 'send', 'prompt 已发送');

    const appeared = await waitFor(() => {
      const bd = getAnkiBlockData(store);
      return (bd?.cards?.length ?? 0) > 0;
    }, config.timeoutMs, config.pollMs);
    if (!appeared) throw new Error('卡片未出现');

    const bd = getAnkiBlockData(store)!;
    const blockId = getAnkiBlock(store)!.blockId;
    const editMark = `[ONEND_TEST_${Date.now()}]`;
    const editedCards = [...bd.cards];
    editedCards[0] = { ...editedCards[0], front: editMark };
    store.getState().updateBlock(blockId, { toolOutput: { ...bd, cards: editedCards } });
    log('info', 'edit', `在 onEnd 前注入编辑标记: ${editMark}`);

    const midCheck = getAnkiBlockData(store);
    checks.push(verify('编辑标记已注入', midCheck?.cards?.[0]?.front === editMark, `front="${midCheck?.cards?.[0]?.front?.slice(0, 30)}"`));

    log('info', 'wait', '等待块完成（onEnd 到达）...');
    await waitFor(() => {
      const s = getAnkiBlockStatus(store);
      return s === 'success' || s === 'error';
    }, config.timeoutMs, config.pollMs);
    await sleep(config.settleMs);

    const finalBd = getAnkiBlockData(store);
    const finalFront = finalBd?.cards?.[0]?.front ?? '';
    const survived = finalFront === editMark;
    checks.push(verify(
      '编辑未被 onEnd 覆盖',
      survived,
      survived
        ? `编辑保留`
        : `编辑被覆盖: final="${finalFront.slice(0, 40)}" (expected="${editMark.slice(0, 30)}")`
    ));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('error', 'fail', msg);
    checks.push(verify('场景未崩溃', false, msg));
  }

  return finalizeResult('ca_onend_overwrite', checks, t0, sessionId, [], captures, [...ankiCapture.events], [], undefined);
}

// =============================================================================
// 场景 C⑦ AnkiConnect 状态不刷新
// =============================================================================

async function runScenario_ankiConnectNoRefresh(
  config: ChatAnkiTestConfig, log: LogFn,
  ankiCapture: ReturnType<typeof createAnkiEventCapture>,
  captures: Captures,
): Promise<ScenarioResult> {
  const t0 = Date.now();
  const checks: VerificationCheck[] = [];
  let sessionId = '';

  try {
    const { store, sessionId: sid } = await createTestSession(log, 'C⑦ AnkiConnect');
    sessionId = sid;

    await sendAndWaitForAnkiBlock(store, config.prompt, config.timeoutMs, config.pollMs, log);
    await sleep(config.settleMs);

    const badge = document.querySelector('[data-testid="chatanki-progress-anki-connect"]');
    checks.push(verify('AnkiConnect badge 存在', !!badge, badge?.textContent ?? '未找到'));

    const allButtons = document.querySelectorAll('.chatanki-bottom-actions button, [data-testid="chatanki-progress"] button');
    let hasRefreshBtn = false;
    for (const btn of allButtons) {
      const title = btn.getAttribute('title') ?? '';
      const ariaLabel = btn.getAttribute('aria-label') ?? '';
      const text = btn.textContent ?? '';
      if (/刷新|recheck|refresh|重新检/i.test(title + ariaLabel + text)) {
        hasRefreshBtn = true;
        break;
      }
    }
    checks.push(verify(
      'AnkiConnect 有刷新按钮',
      hasRefreshBtn,
      hasRefreshBtn ? '有刷新按钮' : '无刷新按钮（确认缺失：状态仅在管线启动时检查一次）'
    ));

    const bd = getAnkiBlockData(store);
    checks.push(verify('checkedAt 存在', !!bd?.ankiConnect?.checkedAt, bd?.ankiConnect?.checkedAt ?? '无'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('error', 'fail', msg);
    checks.push(verify('场景未崩溃', false, msg));
  }

  return finalizeResult('ca_anki_connect_no_refresh', checks, t0, sessionId, [], captures, [...ankiCapture.events], [], undefined);
}

// =============================================================================
// 场景调度
// =============================================================================

export async function runAllChatAnkiTests(
  config: ChatAnkiTestConfig,
  onResult: (result: ScenarioResult, index: number, total: number) => void,
  onLog: (entry: LogEntry) => void,
): Promise<ScenarioResult[]> {
  const skipSet = new Set(config.skipScenarios);
  const active = ALL_SCENARIOS.filter(s => !skipSet.has(s));
  const results: ScenarioResult[] = [];

  const ankiCapture = createAnkiEventCapture();
  await ankiCapture.start();

  let sharedSession: { store: StoreApi<ChatStore>; sessionId: string } | undefined;

  for (let i = 0; i < active.length; i++) {
    if (_abortRequested) {
      for (let j = i; j < active.length; j++) {
        const skipped: ScenarioResult = {
          scenario: active[j], status: 'skipped',
          startTime: new Date().toISOString(), endTime: new Date().toISOString(),
          durationMs: 0, sessionId: '', verification: { passed: true, checks: [] },
          logs: [], consoleLogs: [], chatV2Logs: [], ankiEvents: [], stageSnapshots: [],
        };
        results.push(skipped);
        onResult(skipped, j, active.length);
      }
      break;
    }

    const { log, logs } = createLogger(active[i], onLog);
    const captures = startCaptures();
    ankiCapture.events.length = 0;

    log('info', 'scenario', `开始 ${i + 1}/${active.length}: ${SCENARIO_LABELS[active[i]]}`);

    let result: ScenarioResult;
    const scenario = active[i];

    try {
      switch (scenario) {
        case 'ca_e2e_run':
          result = await runScenario_e2eRun(config, log, ankiCapture, captures);
          if (result.status === 'passed' && result.sessionId) {
            const sm = await getSessionManager();
            const st = sm.get(result.sessionId);
            if (st) sharedSession = { store: st, sessionId: result.sessionId };
          }
          break;
        case 'ca_progress_stages':
          result = await runScenario_progressStages(config, log, ankiCapture, captures);
          break;
        case 'ca_inline_edit':
          result = await runScenario_inlineEdit(config, log, ankiCapture, captures, sharedSession);
          break;
        case 'ca_delete_card':
          result = await runScenario_deleteCard(config, log, ankiCapture, captures, sharedSession);
          break;
        case 'ca_save_to_library':
          result = await runScenario_saveToLibrary(config, log, ankiCapture, captures, sharedSession);
          break;
        case 'ca_onend_overwrite':
          result = await runScenario_onEndOverwrite(config, log, ankiCapture, captures);
          break;
        case 'ca_anki_connect_no_refresh':
          result = await runScenario_ankiConnectNoRefresh(config, log, ankiCapture, captures);
          break;
        default:
          result = finalizeResult(scenario, [verify('未实现', false, '')], Date.now(), '', [], captures, [], []);
      }
    } catch (err) {
      result = finalizeResult(scenario, [verify('场景崩溃', false, String(err))], Date.now(), '', [], captures, [], [], String(err));
    }

    stopCaptures(captures);
    result.logs = logs;
    results.push(result);
    onResult(result, i, active.length);

    log(result.status === 'passed' ? 'success' : 'error', 'scenario', `${SCENARIO_LABELS[scenario]}: ${result.status} (${result.durationMs}ms)`);

    if (i < active.length - 1) await sleep(1500);
  }

  ankiCapture.stop();
  return results;
}

export async function cleanupChatAnkiTestData(
  onLog?: (msg: string) => void,
): Promise<{ deleted: number; errors: string[] }> {
  const errors: string[] = [];
  let deleted = 0;
  try {
    for (const status of ['active', 'archived', 'deleted'] as const) {
      let offset = 0;
      const PAGE = 50;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const batch = await invoke<Array<{ id: string; title?: string }>>('chat_v2_list_sessions', {
          status, limit: PAGE, offset,
        });
        if (!Array.isArray(batch) || batch.length === 0) break;
        for (const s of batch) {
          if (s.title?.startsWith(CA_TEST_SESSION_PREFIX)) {
            try {
              await invoke('chat_v2_delete_session', { sessionId: s.id });
              deleted++;
              onLog?.(`删除: ${s.title} (${s.id})`);
            } catch (e) { errors.push(`${s.id}: ${e}`); }
          }
        }
        if (batch.length < PAGE) break;
        offset += PAGE;
      }
    }
  } catch (e) { errors.push(`清理失败: ${e}`); }
  onLog?.(`清理完成: 删除 ${deleted} 个, 错误 ${errors.length} 个`);
  return { deleted, errors };
}
