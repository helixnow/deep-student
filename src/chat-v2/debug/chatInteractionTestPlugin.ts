/**
 * Chat V2 交互行为自动化测试 — 核心逻辑模块
 *
 * 供 debug-panel/plugins 的 UI 组件使用。
 *
 * 测试链路（顺序执行，每步依赖前步结果）：
 *
 *   Session A — 基础交互链：
 *     1. send_basic        : 输入 → 发送 → 等待完整响应
 *     2. stream_abort       : 输入 → 发送 → 中途点击停止
 *     3. retry_same_model   : 点击重试（同一模型）
 *     4. retry_diff_model   : 切换模型 → 点击重试
 *     5. edit_and_resend    : 点击编辑 → 修改文字 → 确认重发
 *     6. resend_unchanged   : 点击重新发送（不编辑）
 *
 *   Session B — 多变体：
 *     7. multi_variant      : 设置并行模型 → 发送 → 等待所有变体完成
 *
 * 每步验证：
 *   - capturedRequestBodies: 后端真实 LLM 请求体（chat_v2_llm_request_body 事件）
 *   - modelIcon:            message._meta.modelId → ProviderIcon 是否 fallback 到 generic
 *   - persistence:          操作完成后 invoke chat_v2_load_session 校验数据完整性
 *
 * 模拟策略（真实路径 + 已记录的例外）：
 *   - 输入文字：操作真实 <textarea data-testid="input-bar-v2-textarea">
 *   - 发送/停止：点击 data-testid 按钮（走完整 useInputBarV2 路径）
 *   - 重试/编辑/重发：通过 i18n title 属性定位并点击按钮
 *   - 模型切换：store.setChatParams（与模型选择面板回调路径一致；
 *              chip 面板设置 React selectedModels 不影响 chatParams.modelId，
 *              而 retry 路径读取 chatParams.modelId，无可用 DOM 路径）
 *   - 多变体：store.setState({ pendingParallelModelIds })（chip 选中状态是
 *            InputBarV2 内部 React useState，外部不可访问；需 monkey-patch
 *            setPendingParallelModelIds 阻止 handleSendMessage 清空）
 */

import { CHATV2_LOG_EVENT, type ChatV2LogEntry } from './chatV2Logger';
import { listen } from '@tauri-apps/api/event';
// invoke 使用 lazy import，减少初始加载开销
import { createSessionWithDefaults } from '../core/session/createSessionWithDefaults';
import { detectProviderBrand } from '../../utils/providerIconEngine';
import i18n from '../../i18n';
import type { StoreApi } from 'zustand';
import type { ChatStore } from '../core/types';

// =============================================================================
// 类型定义
// =============================================================================

export type StepName =
  | 'send_basic'
  | 'stream_abort'
  | 'retry_same_model'
  | 'retry_diff_model'
  | 'edit_and_resend'
  | 'resend_unchanged'
  | 'multi_variant';

export const ALL_STEPS: StepName[] = [
  'send_basic', 'stream_abort', 'retry_same_model', 'retry_diff_model',
  'edit_and_resend', 'resend_unchanged', 'multi_variant',
];

export interface InteractionTestConfig {
  primaryModelId: string;
  primaryModelName: string;
  secondaryModelId: string;
  secondaryModelName: string;
  prompt?: string;
  editedPrompt?: string;
  abortDelayMs?: number;
  roundTimeoutMs?: number;
  skipSteps?: StepName[];
}

export interface CapturedConsoleEntry {
  level: 'log' | 'warn' | 'error' | 'debug';
  timestamp: string;
  message: string;
  args: unknown[];
}

export interface StepResult {
  step: StepName;
  status: 'passed' | 'failed' | 'skipped';
  startTime: string;
  endTime: string;
  durationMs: number;
  capturedRequestBodies: unknown[];
  modelIconChecks: ModelIconCheck[];
  persistenceCheck: PersistenceCheck | null;
  verification: VerificationResult;
  logs: LogEntry[];
  chatV2Logs: ChatV2LogEntry[];
  consoleLogs: CapturedConsoleEntry[];
  error?: string;
  sessionId: string;
}

export interface ModelIconCheck {
  messageId: string;
  expectedModelId: string;
  actualModelId: string | undefined;
  expectedBrand: string;
  actualBrand: string;
  iconLost: boolean;
}

export interface PersistenceCheck {
  verified: boolean;
  messageCount: number;
  lastAssistantModelId?: string;
  detail: string;
}

export interface VerificationResult {
  passed: boolean;
  checks: VerificationCheck[];
}

export interface VerificationCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'success';

export interface LogEntry {
  id: number;
  timestamp: string;
  level: LogLevel;
  phase: string;
  message: string;
  data?: Record<string, unknown>;
}

export type OverallStatus = 'idle' | 'running' | 'completed' | 'aborted';

export const INTERACTION_TEST_EVENT = 'INTERACTION_TEST_LOG';
export const INTERACTION_TEST_SESSION_PREFIX = '[InteractionTest]';

// =============================================================================
// 日志工具
// =============================================================================

let globalLogId = 0;
const MAX_LOGS = 500;

function createLogger(stepName: string, onLog?: (entry: LogEntry) => void) {
  const logs: LogEntry[] = [];
  function log(level: LogLevel, phase: string, message: string, data?: Record<string, unknown>) {
    const entry: LogEntry = {
      id: ++globalLogId,
      timestamp: new Date().toISOString(),
      level, phase, message, data,
    };
    if (logs.length < MAX_LOGS) logs.push(entry);
    const emoji = { debug: '🔍', info: '🔷', warn: '⚠️', error: '❌', success: '✅' }[level];
    console.log(`${emoji} [InteractionTest][${stepName}][${phase}] ${message}`, data ?? '');
    onLog?.(entry);
    window.dispatchEvent(new CustomEvent(INTERACTION_TEST_EVENT, { detail: entry }));
  }
  return { logs, log };
}

// =============================================================================
// 工具
// =============================================================================

function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

async function waitFor(cond: () => boolean, timeoutMs: number, pollMs = 200): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { if (cond()) return true; await sleep(pollMs); }
  return false;
}

function getI18nTitle(key: string): string {
  // 使用应用已初始化的 i18n 实例获取当前语言翻译
  try {
    const translated = i18n.t(key);
    if (translated && translated !== key) return translated;
  } catch { /* ignore */ }
  // fallback: 中/英双语硬编码
  const fallback: Record<string, string[]> = {
    'chatV2:messageItem.actions.retry': ['重试', 'Retry'],
    'chatV2:messageItem.actions.edit': ['编辑', 'Edit'],
    'chatV2:messageItem.actions.resend': ['重新发送', 'Resend'],
  };
  return fallback[key]?.[0] ?? key;
}

// =============================================================================
// 控制台拦截（复用 attachmentPipelineTestPlugin 模式）
// =============================================================================

const CAPTURE_PREFIXES = [
  '[ChatStore]', '[TauriAdapter]', '[ChatV2]',
  '[InputBarUI]', '[MessageItem]', '[editAndResend]',
  '[retryMessage]', '[EventBridge]',
];

function shouldCapture(args: unknown[]): boolean {
  if (args.length === 0) return false;
  const s = String(args[0]);
  return CAPTURE_PREFIXES.some(p => s.includes(p));
}

function createConsoleCapture() {
  const captured: CapturedConsoleEntry[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, debug: console.debug };

  function wrap(level: CapturedConsoleEntry['level'], origFn: (...a: unknown[]) => void) {
    return (...args: unknown[]) => {
      origFn(...args);
      if (shouldCapture(args)) {
        captured.push({ level, timestamp: new Date().toISOString(), message: String(args[0]), args: args.slice(1) });
      }
    };
  }

  return {
    start() {
      console.log = wrap('log', orig.log);
      console.warn = wrap('warn', orig.warn);
      console.error = wrap('error', orig.error);
      console.debug = wrap('debug', orig.debug);
    },
    stop() {
      console.log = orig.log;
      console.warn = orig.warn;
      console.error = orig.error;
      console.debug = orig.debug;
    },
    captured,
  };
}

// =============================================================================
// DOM 模拟层 — 所有用户操作通过 DOM 实现
// =============================================================================

/**
 * 在真实 textarea 中输入文字。
 * 使用 React 原生 value setter 确保 onChange 正确触发。
 */
function simulateTyping(text: string): boolean {
  const textarea = document.querySelector(
    '[data-testid="input-bar-v2-textarea"]'
  ) as HTMLTextAreaElement | null;
  if (!textarea) return false;

  // React 16+ 使用内部 _valueTracker，需要通过原生 setter 绕过
  const nativeSetter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype, 'value'
  )?.set;
  if (nativeSetter) {
    nativeSetter.call(textarea, text);
  } else {
    textarea.value = text;
  }
  // 触发 React 的 onChange
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.dispatchEvent(new Event('change', { bubbles: true }));
  // 聚焦并移动光标到末尾
  textarea.focus();
  textarea.setSelectionRange(text.length, text.length);
  return true;
}

/** 点击发送按钮，若 disabled 则等待最多 waitMs 毫秒 */
async function clickSend(
  log?: (level: LogLevel, phase: string, msg: string, data?: Record<string, unknown>) => void,
  waitMs = 15000,
): Promise<boolean> {
  let btn = document.querySelector('[data-testid="btn-send"]') as HTMLButtonElement | null;
  if (!btn) return false;
  if (btn.disabled) {
    log?.('info', 'send', `发送按钮暂时禁用，等待最多 ${waitMs}ms...`);
    const ready = await waitFor(() => {
      btn = document.querySelector('[data-testid="btn-send"]') as HTMLButtonElement | null;
      return !!btn && !btn.disabled;
    }, waitMs, 300);
    if (!ready || !btn || btn.disabled) {
      log?.('error', 'send', '发送按钮仍然禁用，模拟用户无法发送');
      return false;
    }
    log?.('success', 'send', '发送按钮已就绪');
  }
  btn.click();
  return true;
}

/** 点击停止按钮 */
function clickStop(): boolean {
  const btn = document.querySelector('[data-testid="btn-stop"]') as HTMLButtonElement | null;
  if (!btn || btn.disabled) return false;
  btn.click();
  return true;
}

/** 通过 title 属性找到最后一个匹配的按钮并点击 */
function clickButtonByTitle(i18nKey: string): boolean {
  const title = getI18nTitle(i18nKey);
  // 查找所有匹配的按钮（可能有多个消息都有该操作）
  const buttons = document.querySelectorAll<HTMLButtonElement>(`button[title="${title}"]`);
  if (buttons.length === 0) {
    // fallback: 尝试英文 title
    const fallback: Record<string, string> = {
      'chatV2:messageItem.actions.retry': 'Retry',
      'chatV2:messageItem.actions.edit': 'Edit',
      'chatV2:messageItem.actions.resend': 'Resend',
    };
    const enTitle = fallback[i18nKey];
    if (enTitle) {
      const enButtons = document.querySelectorAll<HTMLButtonElement>(`button[title="${enTitle}"]`);
      if (enButtons.length > 0) {
        const last = enButtons[enButtons.length - 1];
        if (!last.disabled) { last.click(); return true; }
      }
    }
    return false;
  }
  // 点击最后一个（最新消息的按钮）
  const last = buttons[buttons.length - 1];
  if (last.disabled) return false;
  last.click();
  return true;
}

/**
 * 确保消息操作按钮可见：触发 group-hover 状态。
 * MessageItem 使用 md:opacity-0 md:group-hover:opacity-100 隐藏按钮，
 * 虽然 click() 对 opacity-0 元素仍然有效，但某些场景下可能有条件渲染。
 * 通过 mouseenter 触发 group hover 状态确保按钮完全可见。
 *
 * 策略：MessageItem 根 div 无 data-message-role 属性，改为通过 CSS 类识别角色。
 * user 消息: .group.bg-muted\/20  |  assistant 消息: .group.bg-background
 */
async function ensureMessageHover(role: 'user' | 'assistant'): Promise<void> {
  // MessageItem 根 div 同时具有 .group 和角色相关 class
  const groups = Array.from(document.querySelectorAll<HTMLElement>('.group.px-4.py-4'));
  // user → bg-muted/20（Tailwind 编码后为 bg-muted\/20 或实际包含 bg-muted），assistant → bg-background
  for (let i = groups.length - 1; i >= 0; i--) {
    const el = groups[i];
    const isUser = el.classList.contains('bg-muted/20') || el.className.includes('bg-muted');
    const match = role === 'user' ? isUser : !isUser;
    if (match) {
      el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      await sleep(200);
      return;
    }
  }
  // fallback: hover 最后一个 .group
  const last = groups[groups.length - 1];
  if (last) {
    last.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    await sleep(200);
  }
}

/** 点击重试按钮（最后一条助手消息） */
async function clickRetry(): Promise<boolean> {
  await ensureMessageHover('assistant');
  return clickButtonByTitle('chatV2:messageItem.actions.retry');
}

/** 点击编辑按钮（最后一条用户消息） */
async function clickEdit(): Promise<boolean> {
  await ensureMessageHover('user');
  return clickButtonByTitle('chatV2:messageItem.actions.edit');
}

/** 点击重新发送按钮（最后一条用户消息） */
async function clickResend(): Promise<boolean> {
  await ensureMessageHover('user');
  return clickButtonByTitle('chatV2:messageItem.actions.resend');
}

/**
 * 在内联编辑模式下修改文字并确认。
 * MessageInlineEdit 渲染一个 border-2 border-primary 的 <textarea> 和
 * 一个 bg-primary 的确认按钮。
 */
function editAndConfirm(newText: string): boolean {
  // 1. 找到编辑 textarea（border-primary 特征）
  const editTextarea = document.querySelector(
    'textarea.border-primary, textarea[class*="border-primary"]'
  ) as HTMLTextAreaElement | null;

  if (!editTextarea) {
    // fallback: 找任何带 border-2 的 textarea
    const all = Array.from(document.querySelectorAll('textarea'));
    for (const ta of all) {
      if (ta.className.includes('border-primary') || ta.className.includes('border-2')) {
        return editTextareaAndConfirm(ta, newText);
      }
    }
    return false;
  }

  return editTextareaAndConfirm(editTextarea, newText);
}

function editTextareaAndConfirm(textarea: HTMLTextAreaElement, newText: string): boolean {
  // 设置新文本
  const nativeSetter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype, 'value'
  )?.set;
  if (nativeSetter) {
    nativeSetter.call(textarea, newText);
  } else {
    textarea.value = newText;
  }
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.dispatchEvent(new Event('change', { bubbles: true }));

  // 2. 找到确认按钮（bg-primary 的 button，在同一个容器中）
  const container = textarea.closest('div.flex.flex-col') || textarea.parentElement;
  if (!container) return false;
  const buttons = container.querySelectorAll<HTMLButtonElement>('button');
  for (const btn of buttons) {
    if (btn.className.includes('bg-primary') && !btn.disabled) {
      btn.click();
      return true;
    }
  }
  return false;
}

// =============================================================================
// 请求体捕获（监听后端 chat_v2_llm_request_body 事件）
// =============================================================================

async function createRequestBodyCapture(sessionId: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bodies: any[] = [];
  const unlisten = await listen<{
    streamEvent: string; model: string; url: string; requestBody: unknown;
  }>('chat_v2_llm_request_body', (event) => {
    const prefix = `chat_v2_event_${sessionId}`;
    if (
      event.payload.streamEvent === prefix ||
      event.payload.streamEvent.startsWith(`${prefix}_`)
    ) {
      bodies.push({
        model: event.payload.model,
        url: event.payload.url,
        requestBody: event.payload.requestBody,
        capturedAt: new Date().toISOString(),
      });
    }
  });
  return {
    stop: () => unlisten(),
    get bodies() { return bodies; },
    get count() { return bodies.length; },
    /** 第一个请求体（通常含用户消息+附件） */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    get first(): any { return bodies[0]?.requestBody ?? null; },
    /** 第一个请求的模型 ID（来自事件 payload，非 requestBody 内部） */
    get firstModel(): string | undefined { return bodies[0]?.model; },
    /** 最后一个请求体 */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    get last(): any { return bodies[bodies.length - 1]?.requestBody ?? null; },
    /** 所有捕获到的模型 ID */
    get models(): string[] { return bodies.map(b => b.model); },
  };
}

// =============================================================================
// ChatV2 日志捕获（复用 attachment test 的模式）
// =============================================================================

function createChatV2LogCapture() {
  const captured: ChatV2LogEntry[] = [];
  const startTime = new Date().toISOString();
  const handler = (e: Event) => {
    const entry = (e as CustomEvent<ChatV2LogEntry>).detail;
    if (entry.timestamp >= startTime && captured.length < MAX_LOGS) {
      captured.push(entry);
    }
  };
  return {
    start: () => window.addEventListener(CHATV2_LOG_EVENT, handler),
    stop: () => window.removeEventListener(CHATV2_LOG_EVENT, handler),
    logs: captured,
  };
}

// =============================================================================
// Model Icon 验证
// =============================================================================

function checkModelIcon(
  store: StoreApi<ChatStore>,
  messageId: string,
  expectedModelId: string,
): ModelIconCheck {
  const state = store.getState();
  const message = state.messageMap.get(messageId);
  const actualModelId = message?._meta?.modelId || '';
  const expectedBrand = detectProviderBrand(expectedModelId);
  const actualBrand = detectProviderBrand(actualModelId);
  const iconLost = actualBrand === 'generic' && expectedBrand !== 'generic';

  return {
    messageId,
    expectedModelId,
    actualModelId: actualModelId || undefined,
    expectedBrand,
    actualBrand,
    iconLost,
  };
}

/** 检查 DOM 中最后一个助手消息的头像是否为 generic fallback */
function checkDomModelIcon(): { isGeneric: boolean; src: string | null } {
  // ProviderIcon 渲染为 <img src="/icons/providers/xxx.svg"> 或 <img src="/logo.svg">
  // 在 .rounded-full 容器中
  const avatarContainers = Array.from(document.querySelectorAll('.rounded-full'));
  let lastAvatarImg: HTMLImageElement | null = null;
  for (const container of avatarContainers) {
    const img = container.querySelector('img') as HTMLImageElement | null;
    if (img) lastAvatarImg = img;
  }
  if (!lastAvatarImg) return { isGeneric: true, src: null };
  const src = lastAvatarImg.getAttribute('src') || '';
  return {
    isGeneric: src === '/logo.svg' || src.includes('logo.svg'),
    src,
  };
}

// =============================================================================
// 持久化验证
// =============================================================================

async function verifyPersistence(
  sessionId: string,
  expectedMinMessages: number,
  expectedLastAssistantModel?: string,
): Promise<PersistenceCheck> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    // 等待后端保存完成
    await sleep(1000);
    const data = await invoke<{
      messages?: Array<{
        id: string;
        role: string;
        _meta?: { modelId?: string };
      }>;
    }>('chat_v2_load_session', { sessionId });

    const messages = data?.messages || [];
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
    const lastModelId = lastAssistant?._meta?.modelId;

    const countOk = messages.length >= expectedMinMessages;
    const modelOk = !expectedLastAssistantModel || lastModelId === expectedLastAssistantModel;

    return {
      verified: countOk && modelOk,
      messageCount: messages.length,
      lastAssistantModelId: lastModelId,
      detail: countOk && modelOk
        ? `✓ ${messages.length} 条消息已持久化`
        + (lastModelId ? `, 最后助手模型: ${lastModelId}` : '')
        : `消息数 ${messages.length}/${expectedMinMessages}`
        + (modelOk ? '' : `, 模型期望 ${expectedLastAssistantModel} 实际 ${lastModelId}`),
    };
  } catch (err) {
    return {
      verified: false,
      messageCount: 0,
      detail: `持久化验证失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// =============================================================================
// 请求体 Dump（脱敏）
// =============================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sanitizeRequestBody(body: any): unknown {
  if (!body) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sanitized = JSON.parse(JSON.stringify(body, (_key: string, val: any) => {
      if (_key === 'url' && typeof val === 'string' && val.startsWith('data:')) {
        return `[base64:${val.length}bytes]`;
      }
      return val;
    }));
    if (Array.isArray(sanitized.messages)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sanitized.messages = sanitized.messages.map((m: any) => {
        if (m.role === 'system') {
          return { role: 'system', content: `[system:${(m.content?.length || 0)}字符]` };
        }
        return m;
      });
    }
    return sanitized;
  } catch { return '[序列化失败]'; }
}

// =============================================================================
// 会话管理
// =============================================================================

async function getSessionManager() {
  return (await import('../core/session/sessionManager')).sessionManager;
}

async function createAndSwitchSession(
  log: (level: LogLevel, phase: string, msg: string, data?: Record<string, unknown>) => void,
  label: string,
): Promise<{ store: StoreApi<ChatStore>; sessionId: string }> {
  const sm = await getSessionManager();
  const title = `${INTERACTION_TEST_SESSION_PREFIX} ${label}`;
  const session = await createSessionWithDefaults({ mode: 'chat', title });
  log('info', 'session', `新建会话: ${session.id}`);

  window.dispatchEvent(new CustomEvent('PIPELINE_TEST_SWITCH_SESSION', {
    detail: { sessionId: session.id },
  }));

  if (!await waitFor(() => sm.getCurrentSessionId() === session.id, 5000, 100)) {
    throw new Error(`会话切换超时: ${session.id}`);
  }
  if (!await waitFor(
    () => !!document.querySelector('[data-testid="input-bar-v2-textarea"]'),
    10000, 200,
  )) {
    throw new Error('InputBarUI 未就绪');
  }
  await sleep(500);

  const store = sm.get(session.id);
  if (!store) throw new Error(`无法获取 Store: ${session.id}`);
  log('success', 'session', `会话已就绪: ${session.id}`);
  return { store, sessionId: session.id };
}

// =============================================================================
// confirm 对话框拦截（retry 有后续消息时弹出 window.confirm）
// =============================================================================

async function withAutoConfirm<T>(fn: () => T | Promise<T>): Promise<T> {
  const orig = window.confirm;
  window.confirm = () => true;
  try {
    return await fn();
  } finally {
    window.confirm = orig;
  }
}

// =============================================================================
// 单步执行器
// =============================================================================

interface StepContext {
  store: StoreApi<ChatStore>;
  sessionId: string;
  config: InteractionTestConfig;
  onLog?: (entry: LogEntry) => void;
  /** 从首次请求体自动检测的实际模型 ID（可能与 config.primaryModelId 不同） */
  resolvedPrimaryModelId?: string;
}

// =============================================================================
// 步骤结果构建器（减少每个 step 函数的样板代码）
// =============================================================================

interface StepCaptures {
  chatV2Capture: ReturnType<typeof createChatV2LogCapture>;
  consoleCapture: ReturnType<typeof createConsoleCapture>;
}

function startStepCaptures(): StepCaptures {
  const chatV2Capture = createChatV2LogCapture();
  const consoleCapture = createConsoleCapture();
  chatV2Capture.start();
  consoleCapture.start();
  return { chatV2Capture, consoleCapture };
}

function stopStepCaptures(captures: StepCaptures) {
  captures.consoleCapture.stop();
  captures.chatV2Capture.stop();
}

/** 统一的 finally 块验证总结逻辑（复制原插件模式） */
function finalizeChecks(
  log: (level: LogLevel, phase: string, msg: string, data?: Record<string, unknown>) => void,
  checks: VerificationCheck[],
  currentStatus: 'passed' | 'failed',
  currentError: string | undefined,
  t0: number,
): { status: 'passed' | 'failed'; error: string | undefined; verification: VerificationResult } {
  // 通繁体输出每个验证检查结果
  for (const c of checks) {
    log(c.passed ? 'success' : 'error', 'verify', `${c.passed ? '\u2705' : '\u274c'} ${c.name}: ${c.detail}`);
  }
  const verification: VerificationResult = { passed: checks.every(c => c.passed), checks };
  let status = currentStatus;
  let error = currentError;
  // 如果验证未通过但 status=passed，将其改为 failed
  if (!verification.passed && status === 'passed') {
    status = 'failed';
    error = '验证未通过: ' + checks.filter(c => !c.passed).map(c => c.name).join(', ');
  }
  // 最终状态行
  const elapsed = Date.now() - t0;
  log(status === 'passed' ? 'success' : 'error', 'result',
    `${status === 'passed' ? '\u2705' : '\u274c'} ${status} (${elapsed}ms)`);
  return { status, error, verification };
}

function makeStepResult(
  step: StepName,
  opts: {
    status: 'passed' | 'failed' | 'skipped';
    startTime: string;
    t0: number;
    capturedRequestBodies: unknown[];
    modelIconChecks: ModelIconCheck[];
    persistenceCheck: PersistenceCheck | null;
    verification: VerificationResult;
    logs: LogEntry[];
    chatV2Logs: ChatV2LogEntry[];
    consoleLogs: CapturedConsoleEntry[];
    sessionId: string;
    error?: string;
  },
): StepResult {
  return {
    step,
    status: opts.status,
    startTime: opts.startTime,
    endTime: new Date().toISOString(),
    durationMs: Date.now() - opts.t0,
    capturedRequestBodies: opts.capturedRequestBodies,
    modelIconChecks: opts.modelIconChecks,
    persistenceCheck: opts.persistenceCheck,
    verification: opts.verification,
    logs: opts.logs,
    chatV2Logs: opts.chatV2Logs,
    consoleLogs: opts.consoleLogs,
    sessionId: opts.sessionId,
    error: opts.error,
  };
}

/** 等待流式开始 */
async function waitForStreaming(store: StoreApi<ChatStore>, timeoutMs: number): Promise<boolean> {
  return waitFor(() => store.getState().sessionStatus !== 'idle', timeoutMs, 100);
}

/** 等待回到 idle */
async function waitForIdle(store: StoreApi<ChatStore>, timeoutMs: number): Promise<boolean> {
  return waitFor(() => store.getState().sessionStatus === 'idle', timeoutMs, 300);
}

/** 获取最后一条指定角色的消息 ID */
function getLastMessageId(store: StoreApi<ChatStore>, role: 'user' | 'assistant'): string | null {
  const state = store.getState();
  const order = state.messageOrder;
  for (let i = order.length - 1; i >= 0; i--) {
    const msg = state.messageMap.get(order[i]);
    if (msg?.role === role) return order[i];
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1: send_basic — 发送消息，等待完整响应
// ─────────────────────────────────────────────────────────────────────────────

async function stepSendBasic(ctx: StepContext): Promise<StepResult> {
  const startTime = new Date().toISOString();
  const { store, sessionId, config } = ctx;
  const { logs, log } = createLogger('send_basic', ctx.onLog);
  const reqCapture = await createRequestBodyCapture(sessionId);
  const captures = startStepCaptures();
  const t0 = Date.now();
  const checks: VerificationCheck[] = [];
  const iconChecks: ModelIconCheck[] = [];
  let persistCheck: PersistenceCheck | null = null;
  let stepStatus: 'passed' | 'failed' = 'passed';
  let stepError: string | undefined;
  let verification: VerificationResult = { passed: false, checks: [] };

  try {
    const prompt = config.prompt || '你好，请用一句话自我介绍。';
    log('info', 'input', `输入文字: "${prompt}"`);
    if (!simulateTyping(prompt)) throw new Error('无法输入文字');
    await sleep(300);

    log('info', 'send', '点击发送按钮');
    if (!await clickSend(log)) throw new Error('发送按钮不可用');

    if (!await waitForStreaming(store, 10000)) throw new Error('流式未开始 (10s)');
    log('info', 'send', `流式已开始 (status=${store.getState().sessionStatus})`);

    const timeout = config.roundTimeoutMs || 60000;
    if (!await waitForIdle(store, timeout)) throw new Error(`流式超时 (${timeout}ms)`);
    log('success', 'send', '流式完成');

    const assistantId = getLastMessageId(store, 'assistant');
    checks.push({ name: '助手消息存在', passed: !!assistantId,
      detail: assistantId ? `messageId=${assistantId}` : '未找到助手消息' });
    checks.push({ name: '请求体已捕获', passed: reqCapture.count > 0,
      detail: `${reqCapture.count} 个请求体, 模型: ${reqCapture.models.join(',')}` });

    // 使用实际 API 模型 ID（可能与 config.primaryModelId 不同）
    const effectiveModelId = reqCapture.firstModel || ctx.resolvedPrimaryModelId || config.primaryModelId;

    if (assistantId) {
      const ic = checkModelIcon(store, assistantId, effectiveModelId);
      iconChecks.push(ic);
      checks.push({ name: 'Model Icon 完整', passed: !ic.iconLost,
        detail: ic.iconLost
          ? `❌ Icon 丢失: 期望 ${ic.expectedBrand}, 实际 ${ic.actualBrand}`
          : `✓ ${ic.actualBrand} (modelId="${ic.actualModelId}")` });
    }

    if (reqCapture.first) {
      const msgs = reqCapture.first.messages as Array<{ role: string }> | undefined;
      const hasUserMsg = msgs?.some(m => m.role === 'user');
      checks.push({ name: '请求体含用户消息', passed: !!hasUserMsg,
        detail: hasUserMsg ? `✓ ${msgs?.length} 条消息` : '请求体无 user 消息' });
      log('info', 'requestBody', JSON.stringify(sanitizeRequestBody(reqCapture.first), null, 2));
    }

    persistCheck = await verifyPersistence(sessionId, 2, effectiveModelId);
    checks.push({ name: '持久化验证', passed: persistCheck.verified, detail: persistCheck.detail });
  } catch (err) {
    stepError = err instanceof Error ? err.message : String(err);
    log('error', 'fatal', stepError);
    stepStatus = 'failed';
  } finally {
    reqCapture.stop();
    stopStepCaptures(captures);
    const fin = finalizeChecks(log, checks, stepStatus, stepError, t0);
    stepStatus = fin.status; stepError = fin.error; verification = fin.verification;
  }
  return makeStepResult('send_basic', {
    status: stepStatus, startTime, t0, capturedRequestBodies: reqCapture.bodies,
    modelIconChecks: iconChecks, persistenceCheck: persistCheck,
    verification,
    logs, chatV2Logs: captures.chatV2Capture.logs, consoleLogs: captures.consoleCapture.captured,
    sessionId, error: stepError,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2: stream_abort — 发送消息，中途点击停止
// ─────────────────────────────────────────────────────────────────────────────

async function stepStreamAbort(ctx: StepContext): Promise<StepResult> {
  const startTime = new Date().toISOString();
  const { store, sessionId, config } = ctx;
  const { logs, log } = createLogger('stream_abort', ctx.onLog);
  const reqCapture = await createRequestBodyCapture(sessionId);
  const captures = startStepCaptures();
  const t0 = Date.now();
  const checks: VerificationCheck[] = [];
  let stepStatus: 'passed' | 'failed' = 'passed';
  let stepError: string | undefined;
  let verification: VerificationResult = { passed: false, checks: [] };

  try {
    const prompt = '请写一篇 300 字关于人工智能发展历史的短文。';
    log('info', 'input', `输入: "${prompt.slice(0, 40)}..."`);
    if (!simulateTyping(prompt)) throw new Error('无法输入文字');
    await sleep(300);

    log('info', 'send', '点击发送');
    if (!await clickSend(log)) throw new Error('发送按钮不可用');

    if (!await waitForStreaming(store, 10000)) throw new Error('流式未开始');
    log('info', 'send', '流式已开始');

    const abortDelay = config.abortDelayMs || 2000;
    log('info', 'abort', `等待 ${abortDelay}ms 后中断...`);
    await sleep(abortDelay);

    log('info', 'abort', '点击停止按钮');
    const stopClicked = clickStop();
    checks.push({ name: '停止按钮可点击', passed: stopClicked,
      detail: stopClicked ? '✓ 已点击 btn-stop' : '❌ 停止按钮不可用或不存在' });

    const idled = await waitForIdle(store, 10000);
    checks.push({ name: '中断后回到 idle', passed: idled,
      detail: idled ? `✓ status=${store.getState().sessionStatus}`
        : `❌ 10s 后仍为 ${store.getState().sessionStatus}（僵尸状态）` });

    const assistantId = getLastMessageId(store, 'assistant');
    if (assistantId) {
      const msg = store.getState().messageMap.get(assistantId);
      const blocks = msg?.blockIds.map(id => store.getState().blocks.get(id)).filter(Boolean) || [];
      const hasAborted = blocks.some(b =>
        b?.status === 'error' || b?.error === 'aborted');
      const hasContent = blocks.some(b =>
        (b?.type === 'content' && b?.content && (b.content as string).length > 0)
        || (b?.type === 'thinking' && b?.content && (b.content as string).length > 0));
      // 中断后只要有块存在就算通过（快速中断时 thinking 块可能既无 error 也无 content）
      const blockStateOk = blocks.length > 0;
      const stateDetail = blocks.map(b => `${b?.type}(${b?.status})`).join(', ');
      checks.push({ name: '中断后有块创建', passed: blockStateOk,
        detail: blockStateOk
          ? `✓ ${blocks.length} 个块: ${stateDetail}, aborted=${hasAborted}, partialContent=${hasContent}`
          : `❌ 无块创建` });

      const effectiveModelId = ctx.resolvedPrimaryModelId || config.primaryModelId;
      const ic = checkModelIcon(store, assistantId, effectiveModelId);
      checks.push({ name: 'Model Icon 完整（中断后）', passed: !ic.iconLost,
        detail: ic.iconLost ? `❌ 中断后 Icon 丢失: ${ic.actualBrand}` : `✓ ${ic.actualBrand}` });
    }

    checks.push({ name: '请求体已捕获', passed: reqCapture.count > 0,
      detail: `${reqCapture.count} 个请求体` });
    if (reqCapture.first) {
      log('info', 'requestBody', JSON.stringify(sanitizeRequestBody(reqCapture.first), null, 2));
    }
  } catch (err) {
    stepError = err instanceof Error ? err.message : String(err);
    log('error', 'fatal', stepError);
    stepStatus = 'failed';
  } finally {
    reqCapture.stop();
    stopStepCaptures(captures);
    const fin = finalizeChecks(log, checks, stepStatus, stepError, t0);
    stepStatus = fin.status; stepError = fin.error; verification = fin.verification;
  }
  return makeStepResult('stream_abort', {
    status: stepStatus, startTime, t0, capturedRequestBodies: reqCapture.bodies,
    modelIconChecks: [], persistenceCheck: null,
    verification,
    logs, chatV2Logs: captures.chatV2Capture.logs, consoleLogs: captures.consoleCapture.captured,
    sessionId, error: stepError,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 3: retry_same_model — 点击重试（同一模型）
// ─────────────────────────────────────────────────────────────────────────────

async function stepRetrySameModel(ctx: StepContext): Promise<StepResult> {
  const startTime = new Date().toISOString();
  const { store, sessionId, config } = ctx;
  const { logs, log } = createLogger('retry_same_model', ctx.onLog);
  const reqCapture = await createRequestBodyCapture(sessionId);
  const captures = startStepCaptures();
  const t0 = Date.now();
  const checks: VerificationCheck[] = [];
  const iconChecks: ModelIconCheck[] = [];
  let persistCheck: PersistenceCheck | null = null;
  let stepStatus: 'passed' | 'failed' = 'passed';
  let stepError: string | undefined;
  let verification: VerificationResult = { passed: false, checks: [] };

  try {
    const assistantIdBefore = getLastMessageId(store, 'assistant');
    log('info', 'pre', `重试前助手消息: ${assistantIdBefore}`);

    log('info', 'retry', '点击重试按钮');
    const clicked = await withAutoConfirm(async () => await clickRetry());
    checks.push({ name: '重试按钮可点击', passed: clicked,
      detail: clicked ? '✓ 已点击' : '❌ 重试按钮不可用或不存在' });
    if (!clicked) throw new Error('重试按钮不可用');

    if (!await waitForStreaming(store, 10000)) throw new Error('重试后流式未开始');
    log('info', 'retry', '流式已开始');

    const timeout = config.roundTimeoutMs || 60000;
    if (!await waitForIdle(store, timeout)) throw new Error(`重试流式超时 (${timeout}ms)`);
    log('success', 'retry', '重试完成');

    if (reqCapture.firstModel) {
      const effectiveModelId = ctx.resolvedPrimaryModelId || config.primaryModelId;
      checks.push({ name: '请求体模型一致', passed: reqCapture.firstModel === effectiveModelId,
        detail: `期望 ${effectiveModelId}, 实际 ${reqCapture.firstModel}` });
      log('info', 'requestBody', JSON.stringify(sanitizeRequestBody(reqCapture.first), null, 2));
    } else {
      checks.push({ name: '请求体已捕获', passed: false, detail: '未捕获请求体' });
    }

    const assistantId = getLastMessageId(store, 'assistant');
    if (assistantId) {
      const effectiveModelId = ctx.resolvedPrimaryModelId || config.primaryModelId;
      const ic = checkModelIcon(store, assistantId, effectiveModelId);
      iconChecks.push(ic);
      checks.push({ name: 'Model Icon 完整（重试后）', passed: !ic.iconLost,
        detail: ic.iconLost
          ? `❌ 重试后 Icon 丢失: ${ic.actualBrand} (modelId="${ic.actualModelId}")`
          : `✓ ${ic.actualBrand}` });
    }

    persistCheck = await verifyPersistence(sessionId, 4);
    checks.push({ name: '持久化验证', passed: persistCheck.verified, detail: persistCheck.detail });
  } catch (err) {
    stepError = err instanceof Error ? err.message : String(err);
    log('error', 'fatal', stepError);
    stepStatus = 'failed';
  } finally {
    reqCapture.stop();
    stopStepCaptures(captures);
    const fin = finalizeChecks(log, checks, stepStatus, stepError, t0);
    stepStatus = fin.status; stepError = fin.error; verification = fin.verification;
  }
  return makeStepResult('retry_same_model', {
    status: stepStatus, startTime, t0, capturedRequestBodies: reqCapture.bodies,
    modelIconChecks: iconChecks, persistenceCheck: persistCheck,
    verification,
    logs, chatV2Logs: captures.chatV2Capture.logs, consoleLogs: captures.consoleCapture.captured,
    sessionId, error: stepError,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 4: retry_diff_model — UI 切换模型 → 点击重试
// ─────────────────────────────────────────────────────────────────────────────

async function stepRetryDiffModel(ctx: StepContext): Promise<StepResult> {
  const startTime = new Date().toISOString();
  const { store, sessionId, config } = ctx;
  const { logs, log } = createLogger('retry_diff_model', ctx.onLog);
  const reqCapture = await createRequestBodyCapture(sessionId);
  const captures = startStepCaptures();
  const t0 = Date.now();
  const checks: VerificationCheck[] = [];
  const iconChecks: ModelIconCheck[] = [];
  let stepStatus: 'passed' | 'failed' = 'passed';
  let stepError: string | undefined;
  let verification: VerificationResult = { passed: false, checks: [] };

  try {
    // ★ 重试换模型例外：btn-toggle-model 打开的是 chip 面板（设置 React selectedModels），
    //   而 retry 路径读取 chatParams.modelId。chip 不会改变 chatParams。
    //   因此必须通过 store.setChatParams 直接切换模型，与 multi_variant 同属一类例外。
    // 恢复时使用 config.primaryModelId（vendor ID），因为 chatParams.modelId 可能为空。
    const previousModelId = store.getState().chatParams.modelId || config.primaryModelId;
    log('info', 'model', `切换模型: ${previousModelId} → ${config.secondaryModelId} (via setChatParams)`);
    store.getState().setChatParams({ modelId: config.secondaryModelId });
    await sleep(300);

    const currentModel = store.getState().chatParams.modelId;
    const modelSwitched = currentModel === config.secondaryModelId;
    checks.push({ name: '模型切换已生效', passed: modelSwitched,
      detail: modelSwitched
        ? `✓ 当前模型: ${currentModel}`
        : `❌ 期望 ${config.secondaryModelId}, 实际 ${currentModel}` });
    log('info', 'model', `当前模型: ${currentModel}`);

    log('info', 'retry', '点击重试按钮（换模型）');
    const clicked = await withAutoConfirm(async () => await clickRetry());
    checks.push({ name: '重试按钮可点击', passed: clicked,
      detail: clicked ? '✓ 已点击' : '❌ 不可用' });
    if (!clicked) throw new Error('重试按钮不可用');

    if (!await waitForStreaming(store, 10000)) throw new Error('重试后流式未开始');
    log('info', 'retry', '流式已开始');

    const timeout = config.roundTimeoutMs || 60000;
    if (!await waitForIdle(store, timeout)) throw new Error('重试流式超时');
    log('success', 'retry', '换模型重试完成');

    if (reqCapture.firstModel) {
      const effectiveModelId = ctx.resolvedPrimaryModelId || config.primaryModelId;
      const modelChanged = reqCapture.firstModel !== effectiveModelId;
      checks.push({ name: '请求体模型已更换', passed: modelChanged,
        detail: `期望非 ${effectiveModelId}, 实际 ${reqCapture.firstModel}` });
      log('info', 'requestBody:model', `请求模型: ${reqCapture.firstModel}`);
      log('info', 'requestBody', JSON.stringify(sanitizeRequestBody(reqCapture.first), null, 2));
    } else {
      checks.push({ name: '请求体已捕获', passed: false, detail: '未捕获' });
    }

    const assistantId = getLastMessageId(store, 'assistant');
    if (assistantId) {
      // 使用实际请求体中的模型 ID 来验证 icon（vendor ID 如 builtin-sf-vision 无法被 detectProviderBrand 识别）
      const actualRetryModelId = reqCapture.firstModel || config.secondaryModelId;
      const ic = checkModelIcon(store, assistantId, actualRetryModelId);
      iconChecks.push(ic);
      checks.push({ name: 'Model Icon 完整（换模型重试后）', passed: !ic.iconLost,
        detail: ic.iconLost
          ? `❌ Icon 丢失: 期望 ${ic.expectedBrand}, 实际 ${ic.actualBrand}`
          : `✓ ${ic.actualBrand} (modelId="${ic.actualModelId}")` });

      const domIcon = checkDomModelIcon();
      checks.push({ name: 'DOM Icon 非 generic', passed: !domIcon.isGeneric,
        detail: domIcon.isGeneric ? `❌ DOM 头像为 generic (src=${domIcon.src})` : `✓ DOM src=${domIcon.src}` });
    }

    // 恢复原模型
    log('info', 'model', `恢复模型: ${previousModelId}`);
    store.getState().setChatParams({ modelId: previousModelId });
    await sleep(300);
  } catch (err) {
    stepError = err instanceof Error ? err.message : String(err);
    log('error', 'fatal', stepError);
    stepStatus = 'failed';
  } finally {
    reqCapture.stop();
    stopStepCaptures(captures);
    const fin = finalizeChecks(log, checks, stepStatus, stepError, t0);
    stepStatus = fin.status; stepError = fin.error; verification = fin.verification;
  }
  return makeStepResult('retry_diff_model', {
    status: stepStatus, startTime, t0, capturedRequestBodies: reqCapture.bodies,
    modelIconChecks: iconChecks, persistenceCheck: null,
    verification,
    logs, chatV2Logs: captures.chatV2Capture.logs, consoleLogs: captures.consoleCapture.captured,
    sessionId, error: stepError,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 5: edit_and_resend — 点击编辑 → 修改文字 → 确认重发
// ─────────────────────────────────────────────────────────────────────────────

async function stepEditAndResend(ctx: StepContext): Promise<StepResult> {
  const startTime = new Date().toISOString();
  const { store, sessionId, config } = ctx;
  const { logs, log } = createLogger('edit_and_resend', ctx.onLog);
  const reqCapture = await createRequestBodyCapture(sessionId);
  const captures = startStepCaptures();
  const t0 = Date.now();
  const checks: VerificationCheck[] = [];
  let stepStatus: 'passed' | 'failed' = 'passed';
  let stepError: string | undefined;
  let verification: VerificationResult = { passed: false, checks: [] };

  try {
    const userIdBefore = getLastMessageId(store, 'user');
    const msgCountBefore = store.getState().messageOrder.length;
    log('info', 'pre', `编辑前: 用户消息=${userIdBefore}, 总消息数=${msgCountBefore}`);

    log('info', 'edit', '点击编辑按钮');
    const editClicked = await clickEdit();
    checks.push({ name: '编辑按钮可点击', passed: editClicked,
      detail: editClicked ? '✓ 已点击' : '❌ 编辑按钮不可用或不存在' });
    if (!editClicked) throw new Error('编辑按钮不可用');

    await sleep(500);

    const newText = config.editedPrompt || '请用英文自我介绍一下。(edited)';
    log('info', 'edit', `修改文字: "${newText.slice(0, 40)}..."`);
    const confirmed = editAndConfirm(newText);
    checks.push({ name: '编辑确认成功', passed: confirmed,
      detail: confirmed ? '✓ 已修改并确认' : '❌ 未找到编辑 textarea 或确认按钮' });
    if (!confirmed) throw new Error('编辑确认失败');

    if (!await waitForStreaming(store, 10000)) throw new Error('编辑重发后流式未开始');
    log('info', 'edit', '流式已开始');

    const timeout = config.roundTimeoutMs || 60000;
    if (!await waitForIdle(store, timeout)) throw new Error('编辑重发流式超时');
    log('success', 'edit', '编辑重发完成');

    if (reqCapture.first) {
      const msgs = reqCapture.first.messages as Array<{ role: string; content: unknown }> | undefined;
      const lastUser = msgs ? [...msgs].reverse().find(m => m.role === 'user') : null;
      const userContent = typeof lastUser?.content === 'string' ? lastUser.content : '';
      const hasEditedContent = userContent.includes('edited') || userContent.includes('英文');
      checks.push({ name: '请求体含编辑后内容', passed: hasEditedContent,
        detail: hasEditedContent ? `✓ 用户消息含编辑内容 (${userContent.length}字符)`
          : `❌ 用户消息未包含编辑内容: "${userContent.slice(0, 80)}"` });
      log('info', 'requestBody', JSON.stringify(sanitizeRequestBody(reqCapture.first), null, 2));
    } else {
      checks.push({ name: '请求体已捕获', passed: false, detail: '未捕获' });
    }

    const assistantId = getLastMessageId(store, 'assistant');
    if (assistantId) {
      const effectiveModelId = ctx.resolvedPrimaryModelId || config.primaryModelId;
      const ic = checkModelIcon(store, assistantId, effectiveModelId);
      checks.push({ name: 'Model Icon 完整（编辑重发后）', passed: !ic.iconLost,
        detail: ic.iconLost ? `❌ 编辑重发后 Icon 丢失: ${ic.actualBrand}` : `✓ ${ic.actualBrand}` });
    }

    const msgCountAfter = store.getState().messageOrder.length;
    log('info', 'verify', `编辑重发后消息数: ${msgCountAfter} (之前 ${msgCountBefore})`);
  } catch (err) {
    stepError = err instanceof Error ? err.message : String(err);
    log('error', 'fatal', stepError);
    stepStatus = 'failed';
  } finally {
    reqCapture.stop();
    stopStepCaptures(captures);
    const fin = finalizeChecks(log, checks, stepStatus, stepError, t0);
    stepStatus = fin.status; stepError = fin.error; verification = fin.verification;
  }
  return makeStepResult('edit_and_resend', {
    status: stepStatus, startTime, t0, capturedRequestBodies: reqCapture.bodies,
    modelIconChecks: [], persistenceCheck: null,
    verification,
    logs, chatV2Logs: captures.chatV2Capture.logs, consoleLogs: captures.consoleCapture.captured,
    sessionId, error: stepError,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 6: resend_unchanged — 点击重新发送（不编辑）
// ─────────────────────────────────────────────────────────────────────────────

async function stepResendUnchanged(ctx: StepContext): Promise<StepResult> {
  const startTime = new Date().toISOString();
  const { store, sessionId, config } = ctx;
  const { logs, log } = createLogger('resend_unchanged', ctx.onLog);
  const reqCapture = await createRequestBodyCapture(sessionId);
  const captures = startStepCaptures();
  const t0 = Date.now();
  const checks: VerificationCheck[] = [];
  let persistCheck: PersistenceCheck | null = null;
  let stepStatus: 'passed' | 'failed' = 'passed';
  let stepError: string | undefined;
  let verification: VerificationResult = { passed: false, checks: [] };

  try {
    const userId = getLastMessageId(store, 'user');
    let originalContent = '';
    if (userId) {
      const msg = store.getState().messageMap.get(userId);
      const contentBlock = msg?.blockIds
        .map(id => store.getState().blocks.get(id))
        .find(b => b?.type === 'content');
      originalContent = (contentBlock?.content as string) || '';
      log('info', 'pre', `原用户消息: "${originalContent.slice(0, 60)}" (${originalContent.length}字符)`);
    }

    log('info', 'resend', '点击重新发送按钮');
    const clicked = await clickResend();
    checks.push({ name: '重新发送按钮可点击', passed: clicked,
      detail: clicked ? '✓ 已点击' : '❌ 不可用' });
    if (!clicked) throw new Error('重新发送按钮不可用');

    if (!await waitForStreaming(store, 10000)) throw new Error('重发后流式未开始');
    log('info', 'resend', '流式已开始');

    const timeout = config.roundTimeoutMs || 60000;
    if (!await waitForIdle(store, timeout)) throw new Error('重发流式超时');
    log('success', 'resend', '重新发送完成');

    if (reqCapture.first) {
      const msgs = reqCapture.first.messages as Array<{ role: string; content: unknown }> | undefined;
      const lastUser = msgs ? [...msgs].reverse().find(m => m.role === 'user') : null;
      const sentContent = typeof lastUser?.content === 'string' ? lastUser.content : '';
      const contentMatch = originalContent.length > 0 && sentContent.includes(originalContent.slice(0, 20));
      checks.push({ name: '请求体内容与原内容一致', passed: contentMatch,
        detail: contentMatch ? `✓ 内容匹配 (${sentContent.length}字符)`
          : `❌ 不匹配: 原="${originalContent.slice(0, 40)}" 发="${sentContent.slice(0, 40)}"` });
      log('info', 'requestBody', JSON.stringify(sanitizeRequestBody(reqCapture.first), null, 2));
    } else {
      checks.push({ name: '请求体已捕获', passed: false, detail: '未捕获' });
    }

    const assistantId = getLastMessageId(store, 'assistant');
    if (assistantId) {
      const effectiveModelId = ctx.resolvedPrimaryModelId || config.primaryModelId;
      const ic = checkModelIcon(store, assistantId, effectiveModelId);
      checks.push({ name: 'Model Icon 完整（重发后）', passed: !ic.iconLost,
        detail: ic.iconLost ? `❌ 重发后 Icon 丢失: ${ic.actualBrand}` : `✓ ${ic.actualBrand}` });
    }

    persistCheck = await verifyPersistence(sessionId, 2);
    checks.push({ name: '持久化验证', passed: persistCheck.verified, detail: persistCheck.detail });
  } catch (err) {
    stepError = err instanceof Error ? err.message : String(err);
    log('error', 'fatal', stepError);
    stepStatus = 'failed';
  } finally {
    reqCapture.stop();
    stopStepCaptures(captures);
    const fin = finalizeChecks(log, checks, stepStatus, stepError, t0);
    stepStatus = fin.status; stepError = fin.error; verification = fin.verification;
  }
  return makeStepResult('resend_unchanged', {
    status: stepStatus, startTime, t0, capturedRequestBodies: reqCapture.bodies,
    modelIconChecks: [], persistenceCheck: persistCheck,
    verification,
    logs, chatV2Logs: captures.chatV2Capture.logs, consoleLogs: captures.consoleCapture.captured,
    sessionId, error: stepError,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 7: multi_variant — 设置并行模型 ID → 发送 → 等待所有变体完成
// ─────────────────────────────────────────────────────────────────────────────

async function stepMultiVariant(ctx: StepContext): Promise<StepResult> {
  const startTime = new Date().toISOString();
  const { config } = ctx;
  const { logs, log } = createLogger('multi_variant', ctx.onLog);
  const captures = startStepCaptures();
  const t0 = Date.now();
  const checks: VerificationCheck[] = [];
  let stepStatus: 'passed' | 'failed' = 'passed';
  let stepError: string | undefined;
  let verification: VerificationResult = { passed: false, checks: [] };

  let sessionId = '';
  let store: StoreApi<ChatStore> | null = null;
  let reqCapture: Awaited<ReturnType<typeof createRequestBodyCapture>> | null = null;
  let origSetPending: ((ids: string[] | null) => void) | null = null;

  try {
    const result = await createAndSwitchSession(log, '多变体测试');
    sessionId = result.sessionId;
    store = result.store;
    reqCapture = await createRequestBodyCapture(sessionId);

    // ★ 多变体例外：chip 模式的已选模型是 InputBarV2 的 React useState，
    //   没有 DOM 操作路径。而且 handleSendMessage 会根据 getSelectedModels()
    //   （React 内部状态）调用 setPendingParallelModelIds(null) 覆盖我们的值。
    //   解决方案：临时拦截 setPendingParallelModelIds 的 null 写入，
    //   确保 adapter.buildSendOptions() 能读到我们设置的并行模型 ID。
    const modelIds = [config.primaryModelId, config.secondaryModelId];
    origSetPending = store.getState().setPendingParallelModelIds;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (store as any).setState({
      setPendingParallelModelIds: (ids: string[] | null) => {
        if (ids === null) {
          log('info', 'model', 'setPendingParallelModelIds(null) 已拦截，保留并行模型');
          return;
        }
        origSetPending(ids);
      },
    });
    // 直接写入 state 绕过 action（action 已被替换）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (store as any).setState({ pendingParallelModelIds: modelIds });
    log('info', 'model', `设置并行模型: ${modelIds.join(', ')} (via store, 防清空拦截已激活)`);

    const prompt = '你好，请用一句话自我介绍。';
    log('info', 'input', `输入多变体: "${prompt}"`);

    if (!simulateTyping(prompt)) throw new Error('无法输入文字');
    await sleep(500);

    log('info', 'send', '点击发送');
    if (!await clickSend(log)) {
      log('warn', 'send', '发送按钮不可用，可能模型提及解析未完成');
      await sleep(1000);
      if (!await clickSend(log)) throw new Error('发送按钮不可用');
    }

    if (!await waitForStreaming(store, 15000)) throw new Error('多变体流式未开始');
    log('info', 'send', `流式已开始 (status=${store.getState().sessionStatus})`);

    // 恢复原始 setPendingParallelModelIds，adapter 已读取并行模型 ID
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (store as any).setState({ setPendingParallelModelIds: origSetPending });

    const timeout = (config.roundTimeoutMs || 60000) * 2;
    const done = await waitForIdle(store, timeout);
    checks.push({ name: '所有变体完成', passed: done,
      detail: done ? '✓ 回到 idle' : `❌ ${timeout}ms 后仍为 ${store.getState().sessionStatus}` });

    const assistantId = getLastMessageId(store, 'assistant');
    if (assistantId) {
      const msg = store.getState().messageMap.get(assistantId);
      const variants = msg?.variants || [];
      const hasMultiple = variants.length >= 2;
      checks.push({ name: '多变体已创建', passed: hasMultiple,
        detail: `${variants.length} 个变体: ${variants.map(v => `${v.modelId}(${v.status})`).join(', ')}` });

      for (const variant of variants) {
        const brand = detectProviderBrand(variant.modelId || '');
        const iconLost = brand === 'generic';
        checks.push({ name: `变体 Icon: ${variant.modelId?.slice(0, 20)}`, passed: !iconLost,
          detail: iconLost ? `❌ 变体 modelId="${variant.modelId}" → generic` : `✓ ${brand}` });
      }

      for (const variant of variants) {
        const blockIds = variant.blockIds || [];
        const hasContent = blockIds.some(id => {
          const b = store!.getState().blocks.get(id);
          return b?.type === 'content' && b.content && (b.content as string).length > 0;
        });
        checks.push({ name: `变体内容: ${variant.modelId?.slice(0, 20)}`,
          passed: hasContent || variant.status === 'error' || variant.status === 'cancelled',
          detail: hasContent ? `✓ ${blockIds.length} 个块` : `status=${variant.status}, blocks=${blockIds.length}` });
      }
    } else {
      checks.push({ name: '助手消息存在', passed: false, detail: '未找到助手消息' });
    }

    checks.push({ name: '请求体数量 ≥ 2', passed: reqCapture.count >= 2,
      detail: `${reqCapture.count} 个请求体, 模型: ${reqCapture.models.join(', ')}` });

    const uniqueModels = new Set(reqCapture.models);
    checks.push({ name: '请求体包含多个模型', passed: uniqueModels.size >= 2,
      detail: `${uniqueModels.size} 个不同模型: ${[...uniqueModels].join(', ')}` });

    for (const body of reqCapture.bodies) {
      log('info', 'requestBody', JSON.stringify(sanitizeRequestBody(body.requestBody), null, 2));
    }
  } catch (err) {
    stepError = err instanceof Error ? err.message : String(err);
    log('error', 'fatal', stepError);
    stepStatus = 'failed';
  } finally {
    // 确保 monkey-patch 被恢复（即使在 streaming 前抛错）
    if (store && origSetPending) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const current = store.getState().setPendingParallelModelIds;
      if (current !== origSetPending) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (store as any).setState({ setPendingParallelModelIds: origSetPending });
      }
    }
    reqCapture?.stop();
    stopStepCaptures(captures);
    const fin = finalizeChecks(log, checks, stepStatus, stepError, t0);
    stepStatus = fin.status; stepError = fin.error; verification = fin.verification;
  }
  return makeStepResult('multi_variant', {
    status: stepStatus, startTime, t0, capturedRequestBodies: reqCapture?.bodies || [],
    modelIconChecks: [], persistenceCheck: null,
    verification,
    logs, chatV2Logs: captures.chatV2Capture.logs, consoleLogs: captures.consoleCapture.captured,
    sessionId, error: stepError,
  });
}

// =============================================================================
// 全量运行器
// =============================================================================

let _abortRequested = false;
export function requestAbort() { _abortRequested = true; }
export function isAbortRequested() { return _abortRequested; }
export function resetAbort() { _abortRequested = false; }

const STEP_EXECUTORS: Record<StepName, (ctx: StepContext) => Promise<StepResult>> = {
  send_basic: stepSendBasic,
  stream_abort: stepStreamAbort,
  retry_same_model: stepRetrySameModel,
  retry_diff_model: stepRetryDiffModel,
  edit_and_resend: stepEditAndResend,
  resend_unchanged: stepResendUnchanged,
  multi_variant: stepMultiVariant,
};

export async function runAllInteractionTests(
  config: InteractionTestConfig,
  onStepComplete?: (result: StepResult, index: number, total: number) => void,
  onLog?: (entry: LogEntry) => void,
): Promise<StepResult[]> {
  _abortRequested = false;
  globalLogId = 0;

  const skip = new Set(config.skipSteps || []);
  const stepsToRun = ALL_STEPS.filter(s => !skip.has(s));
  const results: StepResult[] = [];
  const emptyResult = (step: StepName, sid: string, status: 'failed' | 'skipped', error?: string): StepResult => ({
    step, status, startTime: new Date().toISOString(), endTime: new Date().toISOString(),
    durationMs: 0, capturedRequestBodies: [], modelIconChecks: [],
    persistenceCheck: null,
    verification: { passed: status === 'skipped', checks: error ? [{ name: '会话创建', passed: false, detail: error }] : [] },
    logs: [], chatV2Logs: [], consoleLogs: [], sessionId: sid, error,
  });

  // Session A: 步骤 1-6（共享会话）
  const sessionASteps = stepsToRun.filter(s => s !== 'multi_variant');
  let sessionACtx: StepContext | null = null;

  if (sessionASteps.length > 0) {
    const { log: setupLog } = createLogger('setup', onLog);
    try {
      const { store, sessionId } = await createAndSwitchSession(setupLog, '交互链测试');
      sessionACtx = { store, sessionId, config, onLog };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setupLog('error', 'setup', `创建会话失败: ${msg}`);
      for (const step of sessionASteps) {
        const r = emptyResult(step, '', 'failed', msg);
        results.push(r);
        onStepComplete?.(r, results.length - 1, stepsToRun.length);
      }
    }
  }

  if (sessionACtx) {
    for (const step of sessionASteps) {
      if (_abortRequested) {
        const r = emptyResult(step, sessionACtx.sessionId, 'skipped');
        results.push(r);
        onStepComplete?.(r, results.length - 1, stepsToRun.length);
        continue;
      }

      const executor = STEP_EXECUTORS[step];
      let r: StepResult;
      try {
        r = await executor(sessionACtx);
      } catch (err) {
        r = emptyResult(step, sessionACtx.sessionId, 'failed',
          err instanceof Error ? err.message : String(err));
      }
      // send_basic 完成后，从请求体提取实际模型 ID（可能与 config.primaryModelId 不同）
      if (step === 'send_basic' && !sessionACtx.resolvedPrimaryModelId && r.capturedRequestBodies.length > 0) {
        const firstBody = r.capturedRequestBodies[0] as { model?: string };
        if (firstBody?.model) {
          sessionACtx.resolvedPrimaryModelId = firstBody.model;
          const { log: setupLog } = createLogger('setup', onLog);
          setupLog('info', 'model', `实际 API 模型: ${firstBody.model} (config: ${config.primaryModelId})`);
        }
      }
      results.push(r);
      onStepComplete?.(r, results.length - 1, stepsToRun.length);

      if (!_abortRequested) await sleep(2000);
    }
  }

  // Session B: multi_variant（独立会话 — stepMultiVariant 内部创建）
  if (stepsToRun.includes('multi_variant') && !_abortRequested) {
    const mvCtx: StepContext = {
      store: null as unknown as StoreApi<ChatStore>,
      sessionId: '',
      config,
      onLog,
    };
    let r: StepResult;
    try {
      r = await stepMultiVariant(mvCtx);
    } catch (err) {
      r = emptyResult('multi_variant', '', 'failed',
        err instanceof Error ? err.message : String(err));
    }
    results.push(r);
    onStepComplete?.(r, results.length - 1, stepsToRun.length);
  }

  return results;
}

// =============================================================================
// 测试数据清理
// =============================================================================

export interface CleanupResult {
  deletedSessions: number;
  errors: string[];
}

export async function cleanupInteractionTestData(
  onProgress?: (msg: string) => void,
): Promise<CleanupResult> {
  const { invoke } = await import('@tauri-apps/api/core');
  const sm = await getSessionManager();
  const errors: string[] = [];
  let deletedSessions = 0;
  const log = (msg: string) => { console.log(`[InteractionTest:cleanup] ${msg}`); onProgress?.(msg); };

  log('查找测试会话...');
  const PAGE = 100;
  let offset = 0;
  const testSessionIds: string[] = [];

  for (const status of ['active', 'deleted'] as const) {
    offset = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const batch = await invoke<Array<{ id: string; title?: string }>>('chat_v2_list_sessions', {
        status, limit: PAGE, offset,
      });
      for (const s of batch) {
        if (s.title && s.title.startsWith(INTERACTION_TEST_SESSION_PREFIX)) {
          testSessionIds.push(s.id);
        }
      }
      if (batch.length < PAGE) break;
      offset += PAGE;
    }
  }

  log(`找到 ${testSessionIds.length} 个测试会话`);

  for (const sid of testSessionIds) {
    try {
      if (sm.has(sid)) await sm.destroy(sid);
      await invoke('chat_v2_soft_delete_session', { sessionId: sid });
      deletedSessions++;
    } catch (err) {
      errors.push(`session ${sid}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  log(`清理完成: ${deletedSessions} 会话, ${errors.length} 错误`);
  return { deletedSessions, errors };
}
