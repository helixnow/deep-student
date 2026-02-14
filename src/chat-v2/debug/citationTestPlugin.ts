/**
 * 引用生成与持久化解引用自动化测试 — 核心逻辑模块
 *
 * 供 debug-panel/plugins/CitationTestPlugin.tsx UI 组件使用。
 *
 * 测试链路（顺序执行）：
 *
 *   Phase A — 纯函数测试（无 DOM / 无网络）：
 *     1. parse_citations    : 标准引用解析 (中/英文类型名/图片后缀/边界)
 *     2. segment_text       : 文本按引用标记分段 + hasCitations + countCitations
 *     3. adapter_transform  : Source Adapter 全路径 (citations/toolOutput/mixed blocks)
 *
 *   Phase B — 集成测试（需要会话和 Store）：
 *     4. render_verify      : 发送消息 → 内容含引用标记 → 验证 DOM 中 CitationBadge 渲染
 *     5. persist_roundtrip  : 保存会话 → 重新加载 → 验证 blocks/citations 数据完整性
 *
 * 模拟策略：
 *   - Phase A: 纯函数调用，不操作 DOM 或 Store
 *   - Phase B: 创建真实会话、发送消息（DOM 模拟）、通过 invoke 验证持久化
 */

import { createSessionWithDefaults } from '../core/session/createSessionWithDefaults';
import {
  parseCitations,
  hasCitations,
  countCitations,
  segmentTextByCitations,
  type ParsedCitation,
} from '../utils/citationParser';
import { blocksToSourceBundle } from '../components/panels/sourceAdapter';
import type { Block, Citation } from '../core/types/block';
import type { StoreApi } from 'zustand';
import type { ChatStore } from '../core/types';

// =============================================================================
// 类型定义
// =============================================================================

/**
 * 步骤执行上下文
 * Phase A 纯函数步骤中 store 为 null（不可访问）
 */
interface StepContext {
  store: StoreApi<ChatStore> | null;
  sessionId: string;
  config: CitationTestConfig;
  onLog?: (entry: LogEntry) => void;
}

export type StepName =
  | 'parse_citations'
  | 'segment_text'
  | 'adapter_transform'
  | 'render_verify'
  | 'persist_roundtrip';

export const ALL_STEPS: StepName[] = [
  'parse_citations',
  'segment_text',
  'adapter_transform',
  'render_verify',
  'persist_roundtrip',
];

export interface CitationTestConfig {
  modelId: string;
  prompt?: string;
  roundTimeoutMs?: number;
  skipSteps?: StepName[];
}

export interface VerificationCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface VerificationResult {
  passed: boolean;
  checks: VerificationCheck[];
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

export interface StepResult {
  step: StepName;
  status: 'passed' | 'failed' | 'skipped';
  startTime: string;
  endTime: string;
  durationMs: number;
  verification: VerificationResult;
  logs: LogEntry[];
  error?: string;
  sessionId: string;
}

export type OverallStatus = 'idle' | 'running' | 'completed' | 'aborted';

export const CITATION_TEST_EVENT = 'CITATION_TEST_LOG';
export const CITATION_TEST_SESSION_PREFIX = '[CitationTest]';

/** 要求集成步骤的 store 非 null，否则抛出可读错误 */
function requireStore(ctx: StepContext): StoreApi<ChatStore> {
  if (!ctx.store) throw new Error('此步骤需要集成测试上下文（store 不可为 null）');
  return ctx.store;
}

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
    console.log(`${emoji} [CitationTest][${stepName}][${phase}] ${message}`, data ?? '');
    onLog?.(entry);
    window.dispatchEvent(new CustomEvent(CITATION_TEST_EVENT, { detail: entry }));
  }
  return { logs, log };
}

// =============================================================================
// 工具函数
// =============================================================================

function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

async function waitFor(cond: () => boolean, timeoutMs: number, pollMs = 200): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { if (cond()) return true; await sleep(pollMs); }
  return false;
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
  const title = `${CITATION_TEST_SESSION_PREFIX} ${label}`;
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
// DOM 模拟层
// =============================================================================

function simulateTyping(text: string): boolean {
  const textarea = document.querySelector(
    '[data-testid="input-bar-v2-textarea"]'
  ) as HTMLTextAreaElement | null;
  if (!textarea) return false;
  const nativeSetter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype, 'value'
  )?.set;
  if (nativeSetter) {
    nativeSetter.call(textarea, text);
  } else {
    textarea.value = text;
  }
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.dispatchEvent(new Event('change', { bubbles: true }));
  textarea.focus();
  textarea.setSelectionRange(text.length, text.length);
  return true;
}

async function clickSend(
  log?: (level: LogLevel, phase: string, msg: string, data?: Record<string, unknown>) => void,
  waitMs = 15000,
): Promise<boolean> {
  let btn = document.querySelector('[data-testid="btn-send"]') as HTMLButtonElement | null;
  if (!btn) return false;
  if (btn.disabled) {
    const ready = await waitFor(() => {
      btn = document.querySelector('[data-testid="btn-send"]') as HTMLButtonElement | null;
      return !!btn && !btn.disabled;
    }, waitMs, 300);
    if (!ready || !btn || btn.disabled) return false;
  }
  btn.click();
  return true;
}

async function waitForStreaming(store: StoreApi<ChatStore>, timeoutMs: number): Promise<boolean> {
  return waitFor(() => store.getState().sessionStatus !== 'idle', timeoutMs, 100);
}

async function waitForIdle(store: StoreApi<ChatStore>, timeoutMs: number): Promise<boolean> {
  return waitFor(() => store.getState().sessionStatus === 'idle', timeoutMs, 300);
}

function getLastMessageId(store: StoreApi<ChatStore>, role: 'user' | 'assistant'): string | null {
  const state = store.getState();
  const order = state.messageOrder;
  for (let i = order.length - 1; i >= 0; i--) {
    const msg = state.messageMap.get(order[i]);
    if (msg?.role === role) return order[i];
  }
  return null;
}

// =============================================================================
// 验证辅助
// =============================================================================

function finalizeChecks(
  log: (level: LogLevel, phase: string, msg: string, data?: Record<string, unknown>) => void,
  checks: VerificationCheck[],
  currentStatus: 'passed' | 'failed',
  currentError: string | undefined,
  t0: number,
): { status: 'passed' | 'failed'; error: string | undefined; verification: VerificationResult } {
  for (const c of checks) {
    log(c.passed ? 'success' : 'error', 'verify', `${c.passed ? '✅' : '❌'} ${c.name}: ${c.detail}`);
  }
  const verification: VerificationResult = { passed: checks.every(c => c.passed), checks };
  let status = currentStatus;
  let error = currentError;
  if (!verification.passed && status === 'passed') {
    status = 'failed';
    error = '验证未通过: ' + checks.filter(c => !c.passed).map(c => c.name).join(', ');
  }
  const elapsed = Date.now() - t0;
  log(status === 'passed' ? 'success' : 'error', 'result',
    `${status === 'passed' ? '✅' : '❌'} ${status} (${elapsed}ms)`);
  return { status, error, verification };
}

function makeStepResult(
  step: StepName,
  opts: {
    status: 'passed' | 'failed' | 'skipped';
    startTime: string;
    t0: number;
    verification: VerificationResult;
    logs: LogEntry[];
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
    verification: opts.verification,
    logs: opts.logs,
    sessionId: opts.sessionId,
    error: opts.error,
  };
}

// =============================================================================
// 子断言辅助
// =============================================================================

function assertParse(
  checks: VerificationCheck[],
  label: string,
  text: string,
  expectedCount: number,
  expectedTypes?: string[],
) {
  const result = parseCitations(text);
  const countOk = result.length === expectedCount;
  let typeOk = true;
  if (expectedTypes && countOk) {
    typeOk = expectedTypes.every((t, i) => result[i]?.type === t);
  }
  const passed = countOk && typeOk;
  checks.push({
    name: label,
    passed,
    detail: passed
      ? `✓ ${result.length} 个引用: ${result.map(r => `${r.type}-${r.index}`).join(', ')}`
      : `❌ 期望 ${expectedCount} 个${expectedTypes ? ` (${expectedTypes.join(',')})` : ''}, 实际 ${result.length}: ${result.map(r => `${r.type}-${r.index}`).join(', ')}`,
  });
}

// =============================================================================
// Step 1: parse_citations — 全格式引用解析
// =============================================================================

async function stepParseCitations(ctx: StepContext): Promise<StepResult> {
  const startTime = new Date().toISOString();
  const { logs, log } = createLogger('parse_citations', ctx.onLog);
  const t0 = Date.now();
  const checks: VerificationCheck[] = [];
  let stepStatus: 'passed' | 'failed' = 'passed';
  let stepError: string | undefined;
  let verification: VerificationResult = { passed: false, checks: [] };

  try {
    // 1. 中文引用
    assertParse(checks, '中文-知识库', '这是[知识库-1]的结果', 1, ['rag']);
    assertParse(checks, '中文-记忆', '根据[记忆-1]和[记忆-2]', 2, ['memory', 'memory']);
    assertParse(checks, '中文-搜索', '搜索结果[搜索-1]显示', 1, ['web_search']);
    assertParse(checks, '中文-图片', '图片来源[图片-1]', 1, ['multimodal']);

    // 2. 英文引用
    assertParse(checks, '英文-knowledge', 'See [knowledge-1] for details', 1, ['rag']);
    assertParse(checks, '英文-Knowledge Base', 'From [Knowledge Base-2]', 1, ['rag']);
    assertParse(checks, '英文-memory', 'Based on [memory-1]', 1, ['memory']);
    assertParse(checks, '英文-search', 'Results [search-1] and [Web-2]', 2, ['web_search', 'web_search']);
    assertParse(checks, '英文-image', 'Image [Image-1]', 1, ['multimodal']);

    // 3. 图片后缀
    {
      const r = parseCitations('参考[知识库-1:图片]');
      const hasImage = r.length === 1 && r[0].showImage === true;
      checks.push({ name: '图片后缀(:图片)', passed: hasImage,
        detail: hasImage ? '✓ showImage=true' : `❌ ${JSON.stringify(r[0])}` });
    }
    {
      const r = parseCitations('See [knowledge-1:image]');
      const hasImage = r.length === 1 && r[0].showImage === true;
      checks.push({ name: '图片后缀(:image)', passed: hasImage,
        detail: hasImage ? '✓ showImage=true' : `❌ ${JSON.stringify(r[0])}` });
    }

    // 4. 混合引用
    assertParse(checks, '混合引用',
      '根据[知识库-1]和[记忆-2]以及[搜索-3]的信息', 3, ['rag', 'memory', 'web_search']);

    // 5. 边界情况
    assertParse(checks, '空文本', '', 0);
    assertParse(checks, '无引用', '这是一段普通文字', 0);
    assertParse(checks, '方括号但不是引用', '[foo] [bar-baz]', 0);
    // 注意：[知识库-0] 中 \d+ 匹配 0，正则本身不排斥 index=0
    assertParse(checks, '知识库-0(合法)', '[知识库-0]', 1, ['rag']);

    // 6. hasCitations 和 countCitations
    {
      const has = hasCitations('包含[知识库-1]的文本');
      checks.push({ name: 'hasCitations(有)', passed: has, detail: has ? '✓ true' : '❌ false' });
    }
    {
      const has = hasCitations('普通文本');
      checks.push({ name: 'hasCitations(无)', passed: !has, detail: !has ? '✓ false' : '❌ true' });
    }
    {
      const count = countCitations('[知识库-1][记忆-2][搜索-3]');
      const ok = count === 3;
      checks.push({ name: 'countCitations=3', passed: ok, detail: ok ? '✓ 3' : `❌ ${count}` });
    }

    log('info', 'summary', `共 ${checks.length} 个子测试`);
  } catch (err) {
    stepError = err instanceof Error ? err.message : String(err);
    log('error', 'fatal', stepError);
    stepStatus = 'failed';
  } finally {
    const fin = finalizeChecks(log, checks, stepStatus, stepError, t0);
    stepStatus = fin.status; stepError = fin.error; verification = fin.verification;
  }
  return makeStepResult('parse_citations', {
    status: stepStatus, startTime, t0, verification, logs, sessionId: '', error: stepError,
  });
}

// =============================================================================
// Step 2: segment_text — 文本分段
// =============================================================================

async function stepSegmentText(ctx: StepContext): Promise<StepResult> {
  const startTime = new Date().toISOString();
  const { logs, log } = createLogger('segment_text', ctx.onLog);
  const t0 = Date.now();
  const checks: VerificationCheck[] = [];
  let stepStatus: 'passed' | 'failed' = 'passed';
  let stepError: string | undefined;
  let verification: VerificationResult = { passed: false, checks: [] };

  try {
    // 1. 无引用 → 单文本段
    {
      const segs = segmentTextByCitations('普通文本');
      const ok = segs.length === 1 && segs[0].type === 'text';
      checks.push({ name: '无引用→单段', passed: ok,
        detail: ok ? '✓ 1 text segment' : `❌ ${segs.length} segments: ${JSON.stringify(segs.map(s => s.type))}` });
    }

    // 2. 单引用 → 3段: text + citation + text
    {
      const segs = segmentTextByCitations('前文[知识库-1]后文');
      const ok = segs.length === 3
        && segs[0].type === 'text'
        && segs[1].type === 'citation'
        && segs[2].type === 'text';
      checks.push({ name: '单引用→3段', passed: ok,
        detail: ok ? '✓ text+citation+text'
          : `❌ ${segs.length} segments: ${segs.map(s => s.type).join('+')}` });
    }

    // 3. 连续引用 → citation + citation
    {
      const segs = segmentTextByCitations('[知识库-1][记忆-2]');
      const citCount = segs.filter(s => s.type === 'citation').length;
      const ok = citCount === 2;
      checks.push({ name: '连续引用→2 citation', passed: ok,
        detail: ok ? `✓ ${segs.length} segments, ${citCount} citations`
          : `❌ ${citCount} citations in ${segs.length} segments` });
    }

    // 4. 引用在开头
    {
      const segs = segmentTextByCitations('[搜索-1]然后是文本');
      const ok = segs.length >= 2 && segs[0].type === 'citation';
      checks.push({ name: '引用在开头', passed: ok,
        detail: ok ? '✓ citation first' : `❌ first=${segs[0]?.type}` });
    }

    // 5. 引用在末尾
    {
      const segs = segmentTextByCitations('文本然后是[知识库-1]');
      const ok = segs.length >= 2 && segs[segs.length - 1].type === 'citation';
      checks.push({ name: '引用在末尾', passed: ok,
        detail: ok ? '✓ citation last' : `❌ last=${segs[segs.length - 1]?.type}` });
    }

    // 6. 空文本
    {
      const segs = segmentTextByCitations('');
      checks.push({ name: '空文本→0段', passed: segs.length === 0,
        detail: segs.length === 0 ? '✓ empty' : `❌ ${segs.length} segments` });
    }

    // 7. citation 段内容正确
    {
      const segs = segmentTextByCitations('看[知识库-1]吧');
      const citSeg = segs.find(s => s.type === 'citation');
      const ok = citSeg?.type === 'citation'
        && 'citation' in citSeg
        && (citSeg as { citation: ParsedCitation }).citation.type === 'rag'
        && (citSeg as { citation: ParsedCitation }).citation.index === 1;
      checks.push({ name: 'citation段内容', passed: !!ok,
        detail: ok ? '✓ type=rag, index=1' : `❌ ${JSON.stringify(citSeg)}` });
    }

    log('info', 'summary', `共 ${checks.length} 个子测试`);
  } catch (err) {
    stepError = err instanceof Error ? err.message : String(err);
    log('error', 'fatal', stepError);
    stepStatus = 'failed';
  } finally {
    const fin = finalizeChecks(log, checks, stepStatus, stepError, t0);
    stepStatus = fin.status; stepError = fin.error; verification = fin.verification;
  }
  return makeStepResult('segment_text', {
    status: stepStatus, startTime, t0, verification, logs, sessionId: '', error: stepError,
  });
}

// =============================================================================
// Step 3: adapter_transform — Source Adapter 全路径
// =============================================================================

function makeSyntheticBlock(overrides: Partial<Block> & { id: string; type: string; messageId: string }): Block {
  return {
    status: 'success',
    ...overrides,
  } as Block;
}

async function stepAdapterTransform(ctx: StepContext): Promise<StepResult> {
  const startTime = new Date().toISOString();
  const { logs, log } = createLogger('adapter_transform', ctx.onLog);
  const t0 = Date.now();
  const checks: VerificationCheck[] = [];
  let stepStatus: 'passed' | 'failed' = 'passed';
  let stepError: string | undefined;
  let verification: VerificationResult = { passed: false, checks: [] };

  try {
    // 1. block.citations → UnifiedSourceBundle
    {
      const citations: Citation[] = [
        { type: 'rag', title: 'Doc A', snippet: 'Content A', score: 0.9 },
        { type: 'rag', title: 'Doc B', snippet: 'Content B', score: 0.8 },
      ];
      const blocks: Block[] = [
        makeSyntheticBlock({ id: 'b1', type: 'rag', messageId: 'm1', citations }),
      ];
      const bundle = blocksToSourceBundle(blocks);
      const ok = bundle !== null && bundle.total === 2;
      checks.push({ name: 'citations→bundle', passed: ok,
        detail: ok ? `✓ total=${bundle!.total}, groups=${bundle!.groups.length}` : `❌ bundle=${JSON.stringify(bundle)}` });
    }

    // 2. block.toolOutput (array) → UnifiedSourceBundle
    {
      const blocks: Block[] = [
        makeSyntheticBlock({
          id: 'b2', type: 'rag', messageId: 'm1',
          toolOutput: {
            sources: [
              { title: 'ToolDoc 1', snippet: 'content 1', score: 0.7 },
              { title: 'ToolDoc 2', snippet: 'content 2', score: 0.6 },
            ],
          },
        }),
      ];
      const bundle = blocksToSourceBundle(blocks);
      const ok = bundle !== null && bundle.total === 2;
      checks.push({ name: 'toolOutput.sources→bundle', passed: ok,
        detail: ok ? `✓ total=${bundle!.total}` : `❌ bundle is ${bundle === null ? 'null' : `total=${bundle.total}`}` });
    }

    // 3. block.toolOutput (items format) → bundle
    {
      const blocks: Block[] = [
        makeSyntheticBlock({
          id: 'b3', type: 'memory', messageId: 'm1',
          toolOutput: {
            items: [
              { title: 'Memory Note', note_title: 'My Note', chunk_text: 'note content', score: 0.5 },
            ],
          },
        }),
      ];
      const bundle = blocksToSourceBundle(blocks);
      const ok = bundle !== null && bundle.total === 1;
      checks.push({ name: 'toolOutput.items→bundle', passed: ok,
        detail: ok ? `✓ total=${bundle!.total}` : `❌ bundle is ${bundle === null ? 'null' : `total=${bundle.total}`}` });
    }

    // 4. block.toolOutput (direct array) → bundle
    {
      const blocks: Block[] = [
        makeSyntheticBlock({
          id: 'b4', type: 'web_search', messageId: 'm1',
          toolOutput: [
            { title: 'Web Result', snippet: 'web content', url: 'https://example.com', score: 0.8 },
          ],
        }),
      ];
      const bundle = blocksToSourceBundle(blocks);
      const ok = bundle !== null && bundle.total === 1;
      checks.push({ name: 'toolOutput(数组)→bundle', passed: ok,
        detail: ok ? `✓ total=${bundle!.total}` : `❌ ${bundle === null ? 'null' : `total=${bundle.total}`}` });
    }

    // 5. mixed blocks (rag + memory + web_search) → correct grouping
    {
      const blocks: Block[] = [
        makeSyntheticBlock({
          id: 'b5', type: 'rag', messageId: 'm1',
          citations: [{ type: 'rag', title: 'RAG Doc', score: 0.9 }],
        }),
        makeSyntheticBlock({
          id: 'b6', type: 'memory', messageId: 'm1',
          toolOutput: { sources: [{ title: 'Memory', score: 0.7 }] },
        }),
        makeSyntheticBlock({
          id: 'b7', type: 'web_search', messageId: 'm1',
          toolOutput: [{ title: 'Web', url: 'https://x.com', score: 0.6 }],
        }),
      ];
      const bundle = blocksToSourceBundle(blocks);
      const ok = bundle !== null && bundle.total === 3 && bundle.groups.length >= 2;
      const groupNames = bundle?.groups.map(g => g.group).join(', ') ?? '';
      checks.push({ name: '混合块→分组', passed: ok,
        detail: ok
          ? `✓ total=${bundle!.total}, groups=[${groupNames}]`
          : `❌ total=${bundle?.total}, groups=${bundle?.groups.length}` });
    }

    // 6. 空 blocks → null
    {
      const bundle = blocksToSourceBundle([]);
      checks.push({ name: '空blocks→null', passed: bundle === null,
        detail: bundle === null ? '✓ null' : `❌ ${JSON.stringify(bundle)}` });
    }

    // 7. content block (no citations, no toolOutput) → null
    {
      const blocks: Block[] = [
        makeSyntheticBlock({ id: 'b8', type: 'content', messageId: 'm1', content: 'Hello' }),
      ];
      const bundle = blocksToSourceBundle(blocks);
      checks.push({ name: '纯内容块→null', passed: bundle === null,
        detail: bundle === null ? '✓ null' : `❌ total=${bundle?.total}` });
    }

    // 8. MCP tool block with citations in toolOutput
    {
      const blocks: Block[] = [
        makeSyntheticBlock({
          id: 'b9', type: 'mcp_tool', messageId: 'm1', toolName: 'search_docs',
          toolOutput: {
            citations: [
              { title: 'MCP Result', snippet: 'mcp content', url: 'https://mcp.test' },
            ],
          },
        }),
      ];
      const bundle = blocksToSourceBundle(blocks);
      const ok = bundle !== null && bundle.total === 1;
      checks.push({ name: 'MCP工具块→bundle', passed: ok,
        detail: ok ? `✓ total=${bundle!.total}` : `❌ ${bundle === null ? 'null' : `total=${bundle.total}`}` });
    }

    // 9. citation.type 缺失 → 从 blockType 推断
    {
      const blocks: Block[] = [
        makeSyntheticBlock({
          id: 'b10', type: 'rag', messageId: 'm1',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          citations: [{ title: 'No Type', snippet: 'test' } as any],
        }),
      ];
      const bundle = blocksToSourceBundle(blocks);
      const ok = bundle !== null && bundle.total === 1;
      checks.push({ name: 'citation无type→推断', passed: ok,
        detail: ok ? `✓ total=${bundle!.total}, group=${bundle!.groups[0]?.group}` : '❌ 推断失败' });
    }

    log('info', 'summary', `共 ${checks.length} 个子测试`);
  } catch (err) {
    stepError = err instanceof Error ? err.message : String(err);
    log('error', 'fatal', stepError);
    stepStatus = 'failed';
  } finally {
    const fin = finalizeChecks(log, checks, stepStatus, stepError, t0);
    stepStatus = fin.status; stepError = fin.error; verification = fin.verification;
  }
  return makeStepResult('adapter_transform', {
    status: stepStatus, startTime, t0, verification, logs, sessionId: '', error: stepError,
  });
}

// =============================================================================
// Step 4: render_verify — 发送消息 → 验证 DOM 渲染
// =============================================================================

async function stepRenderVerify(ctx: StepContext): Promise<StepResult> {
  const startTime = new Date().toISOString();
  const store = requireStore(ctx);
  const { sessionId, config } = ctx;
  const { logs, log } = createLogger('render_verify', ctx.onLog);
  const t0 = Date.now();
  const checks: VerificationCheck[] = [];
  let stepStatus: 'passed' | 'failed' = 'passed';
  let stepError: string | undefined;
  let verification: VerificationResult = { passed: false, checks: [] };

  try {
    // 设置模型（与 attachmentPipelineTestPlugin / chatInteractionTestPlugin 一致）
    if (config.modelId) {
      store.getState().setChatParams({ modelId: config.modelId });
      log('info', 'model', `模型设置: ${config.modelId}`);
      await sleep(200);
    }

    // 发送消息触发 LLM 回复
    const prompt = config.prompt || '请用 [知识库-1] 和 [记忆-1] 格式给我一个包含引用标记的示例回复。';
    log('info', 'input', `输入: "${prompt.slice(0, 60)}..."`);
    if (!simulateTyping(prompt)) throw new Error('无法输入文字');
    await sleep(300);

    log('info', 'send', '点击发送');
    if (!await clickSend(log)) throw new Error('发送按钮不可用');

    if (!await waitForStreaming(store, 10000)) throw new Error('流式未开始');
    log('info', 'send', '流式已开始');

    const timeout = config.roundTimeoutMs || 60000;
    if (!await waitForIdle(store, timeout)) {
      log('error', 'send', `流式超时 (${timeout}ms)，尝试中止`);
      try { await store.getState().abortStream(); } catch { /* ignore */ }
      throw new Error(`流式超时 (${timeout}ms)`);
    }
    log('success', 'send', '流式完成');

    // 检查助手消息
    const assistantId = getLastMessageId(store, 'assistant');
    checks.push({ name: '助手消息存在', passed: !!assistantId,
      detail: assistantId ? `✓ ${assistantId}` : '❌ 未找到' });

    if (assistantId) {
      const msg = store.getState().messageMap.get(assistantId);
      const blockIds = msg?.blockIds || [];
      const blocks = blockIds
        .map(id => store.getState().blocks.get(id))
        .filter((b): b is Block => !!b);

      // 检查是否有内容块
      const contentBlocks = blocks.filter(b => b.type === 'content' && b.content);
      checks.push({ name: '内容块存在', passed: contentBlocks.length > 0,
        detail: contentBlocks.length > 0
          ? `✓ ${contentBlocks.length} 个内容块, 总长度 ${contentBlocks.reduce((s, b) => s + ((b.content as string)?.length || 0), 0)} 字符`
          : '❌ 无内容块' });

      // 以下检查为信息性（passed: true），不影响步骤 pass/fail
      // LLM 是否生成引用标记不可控，只记录结果供人工查看
      const allContent = contentBlocks.map(b => b.content as string).join('\n');
      const citationsInContent = parseCitations(allContent);
      checks.push({ name: '内容含引用标记(信息)', passed: true,
        detail: citationsInContent.length > 0
          ? `✓ ${citationsInContent.length} 个引用: ${citationsInContent.map(c => `[${c.typeText}-${c.index}]`).join(', ')}`
          : `ℹ LLM 未生成引用标记（取决于 LLM 行为，非测试缺陷）` });

      // 检查是否有检索块（rag, memory, web_search, multimodal_rag）
      const retrievalBlocks = blocks.filter(b =>
        ['rag', 'memory', 'web_search', 'multimodal_rag'].includes(b.type));
      checks.push({ name: '检索块(信息)', passed: true,
        detail: retrievalBlocks.length > 0
          ? `✓ ${retrievalBlocks.length} 个检索块: ${retrievalBlocks.map(b => `${b.type}(${b.status})`).join(', ')}`
          : `ℹ 无检索块（RAG 未启用或 LLM 未触发）` });

      // Source adapter 转换检查
      const successBlocks = blocks.filter(b => b.status === 'success');
      const bundle = blocksToSourceBundle(successBlocks);
      checks.push({ name: 'Source Adapter 输出(信息)', passed: true,
        detail: bundle
          ? `✓ total=${bundle.total}, groups=[${bundle.groups.map(g => `${g.group}(${g.items.length})`).join(', ')}]`
          : `ℹ 无来源数据` });

      // DOM 渲染检查：查找 citation badge 元素
      await sleep(500); // 等待 React 渲染
      const citationBadges = document.querySelectorAll('[data-citation="true"]');
      checks.push({ name: 'DOM Citation 元素(信息)', passed: true,
        detail: citationBadges.length > 0
          ? `✓ ${citationBadges.length} 个 citation 元素`
          : `ℹ 无 citation 元素（取决于 LLM 是否生成引用）` });
    }

    log('info', 'summary', `共 ${checks.length} 个检查`);
  } catch (err) {
    stepError = err instanceof Error ? err.message : String(err);
    log('error', 'fatal', stepError);
    stepStatus = 'failed';
  } finally {
    const fin = finalizeChecks(log, checks, stepStatus, stepError, t0);
    stepStatus = fin.status; stepError = fin.error; verification = fin.verification;
  }
  return makeStepResult('render_verify', {
    status: stepStatus, startTime, t0, verification, logs, sessionId, error: stepError,
  });
}

// =============================================================================
// Step 5: persist_roundtrip — 持久化往返验证
// =============================================================================

async function stepPersistRoundtrip(ctx: StepContext): Promise<StepResult> {
  const startTime = new Date().toISOString();
  const store = requireStore(ctx);
  const { sessionId } = ctx;
  const { logs, log } = createLogger('persist_roundtrip', ctx.onLog);
  const t0 = Date.now();
  const checks: VerificationCheck[] = [];
  let stepStatus: 'passed' | 'failed' = 'passed';
  let stepError: string | undefined;
  let verification: VerificationResult = { passed: false, checks: [] };

  try {
    // 0. 前置检查：会话中必须有消息（依赖 render_verify 步骤先执行）
    const state = store.getState();
    const messageCount = state.messageOrder.length;
    const blockCount = state.blocks.size;
    if (messageCount === 0) {
      checks.push({ name: '前置条件', passed: false,
        detail: '❌ 会话中无消息。请确保步骤④(渲染验证)未被跳过且成功执行' });
      throw new Error('持久化测试需要会话中已有消息（请先运行步骤④）');
    }

    // 1. 快照当前 store 状态
    log('info', 'snapshot', `Store 快照: ${messageCount} 消息, ${blockCount} 块`);

    // 收集有 citations 或 toolOutput 的块
    const blocksWithData: { id: string; type: string; hasCitations: boolean; hasToolOutput: boolean }[] = [];
    for (const [id, block] of state.blocks) {
      const hasCit = (block.citations?.length ?? 0) > 0;
      const hasOut = block.toolOutput !== undefined && block.toolOutput !== null;
      if (hasCit || hasOut) {
        blocksWithData.push({ id, type: block.type, hasCitations: hasCit, hasToolOutput: hasOut });
      }
    }
    log('info', 'snapshot', `引用数据块: ${blocksWithData.length} 个`, {
      blocks: blocksWithData.map(b => `${b.id}(${b.type})`),
    });

    // 2. 等待后端保存完成
    log('info', 'persist', '等待后端保存...');
    await sleep(2000);

    // 3. 从后端重新加载
    const { invoke } = await import('@tauri-apps/api/core');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const loaded = await invoke<any>('chat_v2_load_session', { sessionId });
    const loadedMessages = loaded?.messages || [];
    log('info', 'load', `从 DB 加载: ${loadedMessages.length} 条消息`);

    // 4. 验证消息数量
    {
      const ok = loadedMessages.length >= messageCount;
      checks.push({ name: '消息数量保留', passed: ok,
        detail: ok
          ? `✓ DB=${loadedMessages.length} ≥ Store=${messageCount}`
          : `❌ DB=${loadedMessages.length} < Store=${messageCount}` });
    }

    // 5. 验证块数据 — 检查每个块的 citations 和 toolOutput 是否保留
    let citationPreserved = 0;
    let citationLost = 0;
    let toolOutputPreserved = 0;
    let toolOutputLost = 0;

    for (const msg of loadedMessages) {
      const msgBlocks = msg.blocks || [];
      for (const block of msgBlocks) {
        const originalBlock = state.blocks.get(block.id);
        if (!originalBlock) continue;

        // 检查 citations
        if (originalBlock.citations && originalBlock.citations.length > 0) {
          if (block.citations && block.citations.length > 0) {
            citationPreserved++;
          } else {
            citationLost++;
            log('warn', 'persist', `citations 丢失: block ${block.id} (${block.type})`);
          }
        }

        // 检查 toolOutput
        if (originalBlock.toolOutput !== undefined && originalBlock.toolOutput !== null) {
          if (block.tool_output !== undefined && block.tool_output !== null) {
            toolOutputPreserved++;
          } else {
            toolOutputLost++;
            log('warn', 'persist', `toolOutput 丢失: block ${block.id} (${block.type})`);
          }
        }
      }
    }

    // 6. 汇总结果
    if (blocksWithData.length > 0) {
      {
        const totalCit = citationPreserved + citationLost;
        const ok = totalCit === 0 || citationLost === 0;
        checks.push({ name: 'citations 持久化', passed: ok,
          detail: totalCit === 0
            ? 'ℹ 无 citations 数据'
            : ok ? `✓ ${citationPreserved}/${totalCit} 保留` : `❌ ${citationLost}/${totalCit} 丢失` });
      }
      {
        const totalOut = toolOutputPreserved + toolOutputLost;
        const ok = totalOut === 0 || toolOutputLost === 0;
        checks.push({ name: 'toolOutput 持久化', passed: ok,
          detail: totalOut === 0
            ? 'ℹ 无 toolOutput 数据'
            : ok ? `✓ ${toolOutputPreserved}/${totalOut} 保留` : `❌ ${toolOutputLost}/${totalOut} 丢失` });
      }
    } else {
      checks.push({ name: '引用数据存在', passed: true,
        detail: 'ℹ 本次会话无引用数据块（RAG 未触发），持久化逻辑无法验证' });
    }

    // 7. 验证 sourceAdapter 仍能从加载的数据生产 bundle
    // 将加载的消息块转换为 Block 格式并测试 adapter
    for (const msg of loadedMessages) {
      if (msg.role !== 'assistant') continue;
      const msgBlocks: Block[] = (msg.blocks || []).map((b: Record<string, unknown>) => ({
        id: b.id as string,
        type: b.block_type as string || b.type as string,
        status: b.status as string || 'success',
        messageId: msg.id as string,
        content: b.content as string | undefined,
        citations: b.citations as Citation[] | undefined,
        toolOutput: b.tool_output,
        toolName: b.tool_name as string | undefined,
      })) as Block[];
      const bundle = blocksToSourceBundle(msgBlocks);
      if (bundle) {
        checks.push({ name: `重载后 adapter(${msg.id.slice(-6)})`, passed: true,
          detail: `✓ total=${bundle.total}, groups=[${bundle.groups.map(g => g.group).join(',')}]` });
      }
    }

    log('info', 'summary', `共 ${checks.length} 个检查`);
  } catch (err) {
    stepError = err instanceof Error ? err.message : String(err);
    log('error', 'fatal', stepError);
    stepStatus = 'failed';
  } finally {
    const fin = finalizeChecks(log, checks, stepStatus, stepError, t0);
    stepStatus = fin.status; stepError = fin.error; verification = fin.verification;
  }
  return makeStepResult('persist_roundtrip', {
    status: stepStatus, startTime, t0, verification, logs, sessionId, error: stepError,
  });
}

// =============================================================================
// 全量运行器
// =============================================================================

let _abortRequested = false;
export function requestAbort() { _abortRequested = true; }
export function resetAbort() { _abortRequested = false; }

const STEP_EXECUTORS: Record<StepName, (ctx: StepContext) => Promise<StepResult>> = {
  parse_citations: stepParseCitations,
  segment_text: stepSegmentText,
  adapter_transform: stepAdapterTransform,
  render_verify: stepRenderVerify,
  persist_roundtrip: stepPersistRoundtrip,
};

export async function runAllCitationTests(
  config: CitationTestConfig,
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
    durationMs: 0,
    verification: { passed: status === 'skipped', checks: error ? [{ name: '初始化', passed: false, detail: error }] : [] },
    logs: [], sessionId: sid, error,
  });

  // Phase A: 纯函数测试（不需要会话）
  const pureSteps: StepName[] = ['parse_citations', 'segment_text', 'adapter_transform'];
  // Phase A 纯函数步骤不访问 store，传入 null
  const pureCtx: StepContext = {
    store: null,
    sessionId: '',
    config,
    onLog,
  };

  for (const step of pureSteps) {
    if (!stepsToRun.includes(step)) continue;
    if (_abortRequested) {
      const r = emptyResult(step, '', 'skipped');
      results.push(r);
      onStepComplete?.(r, results.length - 1, stepsToRun.length);
      continue;
    }

    let r: StepResult;
    try {
      r = await STEP_EXECUTORS[step](pureCtx);
    } catch (err) {
      r = emptyResult(step, '', 'failed', err instanceof Error ? err.message : String(err));
    }
    results.push(r);
    onStepComplete?.(r, results.length - 1, stepsToRun.length);
    if (!_abortRequested) await sleep(500);
  }

  // Phase B: 集成测试（需要会话）
  const integrationSteps: StepName[] = ['render_verify', 'persist_roundtrip'];
  const needIntegration = integrationSteps.some(s => stepsToRun.includes(s));

  if (needIntegration && !_abortRequested) {
    const { log: setupLog } = createLogger('setup', onLog);
    let integrationCtx: StepContext | null = null;

    try {
      const { store, sessionId } = await createAndSwitchSession(setupLog, '引用测试');
      integrationCtx = { store, sessionId, config, onLog };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setupLog('error', 'setup', `创建会话失败: ${msg}`);
      for (const step of integrationSteps) {
        if (!stepsToRun.includes(step)) continue;
        const r = emptyResult(step, '', 'failed', msg);
        results.push(r);
        onStepComplete?.(r, results.length - 1, stepsToRun.length);
      }
    }

    if (integrationCtx) {
      for (const step of integrationSteps) {
        if (!stepsToRun.includes(step)) continue;
        if (_abortRequested) {
          const r = emptyResult(step, integrationCtx.sessionId, 'skipped');
          results.push(r);
          onStepComplete?.(r, results.length - 1, stepsToRun.length);
          continue;
        }

        let r: StepResult;
        try {
          r = await STEP_EXECUTORS[step](integrationCtx);
        } catch (err) {
          r = emptyResult(step, integrationCtx.sessionId, 'failed',
            err instanceof Error ? err.message : String(err));
        }
        results.push(r);
        onStepComplete?.(r, results.length - 1, stepsToRun.length);
        if (!_abortRequested) await sleep(1000);
      }
    }
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

export async function cleanupCitationTestData(
  onProgress?: (msg: string) => void,
): Promise<CleanupResult> {
  const { invoke } = await import('@tauri-apps/api/core');
  const sm = await getSessionManager();
  const errors: string[] = [];
  let deletedSessions = 0;
  const log = (msg: string) => { console.log(`[CitationTest:cleanup] ${msg}`); onProgress?.(msg); };

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
        if (s.title && s.title.startsWith(CITATION_TEST_SESSION_PREFIX)) {
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
