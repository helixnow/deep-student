/**
 * 附件流水线自动化测试 — 核心逻辑模块
 *
 * 供 debug-panel/plugins/AttachmentPipelineTestPlugin.tsx UI 组件使用。
 * 本模块不操作 DOM、不注入 window 全局、不包含 React 组件。
 *
 * 测试矩阵：附件类型(image/pdf) × 注入模式组合 × 模型类型(text/multimodal)
 *
 * 模拟策略（真实路径）：
 *   - 文件上传：DOM <input type="file"> change 事件 → processFilesToAttachments 全流程
 *   - 注入模式：store.updateAttachment + updateContextRefInjectModes（与 UI 面板回调路径一致）
 *   - 模型切换：store.setChatParams（与模型选择面板回调路径一致）
 *   - 发送消息：点击真实发送按钮 [data-testid="btn-send"]（走完整 useInputBarV2 路径：降级/守卫/过滤）
 */

import { CHATV2_LOG_EVENT, type ChatV2LogEntry } from './chatV2Logger';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { createSessionWithDefaults } from '../core/session/createSessionWithDefaults';
import { usePdfProcessingStore } from '@/features/pdf/stores/pdfProcessingStore';
import { getEffectiveReadyModes, getSelectedInjectModes } from '../components/input-bar/injectModeUtils';
import type { AttachmentMediaType } from '../components/input-bar/injectModeUtils';

// =============================================================================
// 类型定义
// =============================================================================

export type AttachmentType = 'image' | 'pdf';
export type ModelType = 'text' | 'multimodal';
export type ImageInjectMode = 'image' | 'ocr';
export type PdfInjectMode = 'text' | 'ocr' | 'image';

export interface TestConfig {
  imageFile?: File;
  pdfFile?: File;
  textModelId: string;
  multimodalModelId: string;
  testPrompt?: string;
  intervalMs?: number;
  roundTimeoutMs?: number;
  skipSend?: boolean;
  /** 仅运行指定附件类型的用例 */
  attachmentTypeFilter?: AttachmentType;
}

export interface TestCase {
  id: string;
  index: number;
  attachmentType: AttachmentType;
  modelType: ModelType;
  modelId: string;
  injectModes: ImageInjectMode[] | PdfInjectMode[] | undefined;
  label: string;
}

export type TestCaseStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';

export interface CapturedConsoleEntry {
  level: 'log' | 'warn' | 'error' | 'debug';
  timestamp: string;
  message: string;
  args: unknown[];
}

export interface TestCaseResult {
  testCase: TestCase;
  status: TestCaseStatus;
  startTime: string;
  endTime: string;
  durationMs: number;
  logs: PipelineLogEntry[];
  chatV2Logs: ChatV2LogEntry[];
  consoleLogs: CapturedConsoleEntry[];
  error?: string;
  attachmentMeta?: Record<string, unknown>;
  responseBlocksSummary?: string[];
  /** 后端发送给 LLM 的真实请求体 */
  capturedRequestBody?: unknown;
  /** LLM 响应的文本内容 */
  responseContent?: string;
  /** 本轮使用的会话 ID */
  sessionId?: string;
  verification: VerificationResult;
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

export type PipelineLogLevel = 'debug' | 'info' | 'warn' | 'error' | 'success';

export interface PipelineLogEntry {
  id: number;
  timestamp: string;
  level: PipelineLogLevel;
  phase: string;
  message: string;
  data?: Record<string, unknown>;
}

export type OverallStatus = 'idle' | 'running' | 'completed' | 'aborted';

export const PIPELINE_TEST_EVENT = 'PIPELINE_TEST_LOG';
export const PIPELINE_TEST_SESSION_PREFIX = '[PipelineTest]';

// =============================================================================
// 日志工具（每轮独立，通过 onLog 回调实时通知 UI）
// =============================================================================

let globalLogId = 0;
const MAX_LOGS_PER_CASE = 500;

function createLogger(testCaseId: string, onLog?: (entry: PipelineLogEntry) => void) {
  const logs: PipelineLogEntry[] = [];
  function log(level: PipelineLogLevel, phase: string, message: string, data?: Record<string, unknown>) {
    const entry: PipelineLogEntry = {
      id: ++globalLogId,
      timestamp: new Date().toISOString(),
      level, phase, message, data,
    };
    if (logs.length < MAX_LOGS_PER_CASE) logs.push(entry);
    const emoji = { debug: '🔍', info: '🔷', warn: '⚠️', error: '❌', success: '✅' }[level];
    console.log(`${emoji} [PipelineTest][${testCaseId}][${phase}] ${message}`, data ?? '');
    onLog?.(entry);
    window.dispatchEvent(new CustomEvent(PIPELINE_TEST_EVENT, { detail: entry }));
  }
  return { logs, log };
}

// =============================================================================
// 文件变异：追加随机二进制字节确保 hash 唯一
// =============================================================================

export async function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

export function createMutatedFile(originalBuffer: ArrayBuffer, originalFile: File, salt: string): File {
  const isPdf = originalFile.type === 'application/pdf' || originalFile.name.toLowerCase().endsWith('.pdf');

  if (isPdf) {
    // ★ PDF-safe mutation: 仅追加 PDF 注释行（% 开头）
    // PDF 解析器从文件末尾向前扫描 %%EOF，会忽略 %%EOF 之后的数据。
    // 之前的做法是追加 32 字节随机二进制数据，这会破坏 PDF 尾部结构
    // (startxref / xref) 导致解析器无法解析 → totalPages=0 → readyModes=[]
    const encoder = new TextEncoder();
    const comment = encoder.encode(`\n%%pipeline-test-salt:${salt}\n`);
    const combined = new Uint8Array(originalBuffer.byteLength + comment.byteLength);
    combined.set(new Uint8Array(originalBuffer), 0);
    combined.set(comment, originalBuffer.byteLength);
    return new File([combined.buffer], originalFile.name, {
      type: originalFile.type,
      lastModified: Date.now(),
    });
  }

  // 非 PDF（图片等）：追加随机字节（PNG/JPEG 有自己的 EOF 标记，追加数据安全）
  const saltBytes = new Uint8Array(32);
  crypto.getRandomValues(saltBytes);
  const encoder = new TextEncoder();
  const textBytes = encoder.encode(`\n%pipeline-test:${salt}\n`);
  const combined = new Uint8Array(originalBuffer.byteLength + saltBytes.byteLength + textBytes.byteLength);
  combined.set(new Uint8Array(originalBuffer), 0);
  combined.set(saltBytes, originalBuffer.byteLength);
  combined.set(textBytes, originalBuffer.byteLength + saltBytes.byteLength);
  return new File([combined.buffer], originalFile.name, {
    type: originalFile.type,
    lastModified: Date.now(),
  });
}

// =============================================================================
// 测试矩阵
// =============================================================================

const IMAGE_MODE_COMBOS: (ImageInjectMode[] | undefined)[] = [
  undefined, ['image'], ['ocr'], ['image', 'ocr'],
];

const PDF_MODE_COMBOS: (PdfInjectMode[] | undefined)[] = [
  undefined, ['text'], ['ocr'], ['image'],
  ['text', 'ocr'], ['text', 'image'], ['ocr', 'image'], ['text', 'ocr', 'image'],
];

export function generateTestMatrix(textModelId: string, multimodalModelId: string, attachmentTypeFilter?: AttachmentType): TestCase[] {
  const cases: TestCase[] = [];
  let idx = 0;
  const models: { type: ModelType; id: string }[] = [
    { type: 'text', id: textModelId },
    { type: 'multimodal', id: multimodalModelId },
  ];
  if (!attachmentTypeFilter || attachmentTypeFilter === 'image') {
    for (const m of models) {
      for (const modes of IMAGE_MODE_COMBOS) {
        const ml = modes ? `[${modes.join(',')}]` : 'default';
        cases.push({ id: `img_${m.type}_${ml}_${idx}`, index: idx++, attachmentType: 'image', modelType: m.type, modelId: m.id, injectModes: modes, label: `Image | ${m.type} | ${ml}` });
      }
    }
  }
  if (!attachmentTypeFilter || attachmentTypeFilter === 'pdf') {
    for (const m of models) {
      for (const modes of PDF_MODE_COMBOS) {
        const ml = modes ? `[${modes.join(',')}]` : 'default';
        cases.push({ id: `pdf_${m.type}_${ml}_${idx}`, index: idx++, attachmentType: 'pdf', modelType: m.type, modelId: m.id, injectModes: modes, label: `PDF | ${m.type} | ${ml}` });
      }
    }
  }
  return cases;
}

// =============================================================================
// 控制台拦截：捕获管线关键日志
// =============================================================================

const CAPTURE_PREFIXES = [
  '[resolveVfsRefs]', '[TauriAdapter]', '[PDF_DEBUG',
  '[FileDef]', '[ImageDef]', '[InputBarUI]', '[MediaProcessing]',
  '[ChatV2]', '[PDF_DEBUG_FE]', 'isMultimodal', '[ChatStore]',
  '[PdfProcessingService]', '[VFS', '[AttachmentUploader]',
  '[injectModeUtils]', 'readyModes', '[ResourceStore]',
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
// 媒体处理事件捕获（Tauri events）
// =============================================================================

interface MediaProcessingEvent {
  type: 'progress' | 'completed' | 'error';
  timestamp: string;
  fileId: string;
  mediaType?: string;
  stage?: string;
  percent?: number;
  readyModes?: string[];
  error?: string;
}

function createMediaProcessingCapture(
  logFn: (level: PipelineLogLevel, phase: string, msg: string, data?: Record<string, unknown>) => void,
) {
  const events: MediaProcessingEvent[] = [];
  const unlisteners: UnlistenFn[] = [];

  async function start() {
    const ul1 = await listen<{ fileId: string; status: { stage: string; percent: number; readyModes: string[]; currentPage?: number; totalPages?: number }; mediaType: string }>(
      'media-processing-progress', (event) => {
        const { fileId, status, mediaType } = event.payload;
        events.push({ type: 'progress', timestamp: new Date().toISOString(), fileId, mediaType, stage: status.stage, percent: status.percent, readyModes: status.readyModes });
        logFn('info', 'mediaEvent:progress', `${mediaType} ${fileId}: ${status.stage} ${Math.round(status.percent)}%`, {
          readyModes: status.readyModes, page: status.currentPage && status.totalPages ? `${status.currentPage}/${status.totalPages}` : undefined,
        });
      },
    );
    unlisteners.push(ul1);

    const ul2 = await listen<{ fileId: string; readyModes: string[]; mediaType: string }>(
      'media-processing-completed', (event) => {
        const { fileId, readyModes, mediaType } = event.payload;
        events.push({ type: 'completed', timestamp: new Date().toISOString(), fileId, mediaType, readyModes });
        logFn('success', 'mediaEvent:completed', `${mediaType} ${fileId} 完成`, { readyModes });
      },
    );
    unlisteners.push(ul2);

    const ul3 = await listen<{ fileId: string; error: string; stage: string; mediaType: string }>(
      'media-processing-error', (event) => {
        const { fileId, error, stage, mediaType } = event.payload;
        events.push({ type: 'error', timestamp: new Date().toISOString(), fileId, mediaType, stage, error });
        logFn('error', 'mediaEvent:error', `${mediaType} ${fileId} 错误: ${error}`, { stage });
      },
    );
    unlisteners.push(ul3);
  }

  return {
    start,
    stop: () => unlisteners.forEach(u => u()),
    events,
    /** 检查指定 fileId 是否收到过任何事件 */
    hasEventsFor: (fileId: string) => events.some(e => e.fileId === fileId),
    /** 获取指定 fileId 的最终 readyModes */
    getFinalReadyModes: (fileId: string): string[] | undefined => {
      const completed = events.filter(e => e.fileId === fileId && e.type === 'completed');
      if (completed.length > 0) return completed[completed.length - 1].readyModes;
      const progress = events.filter(e => e.fileId === fileId && e.type === 'progress');
      if (progress.length > 0) return progress[progress.length - 1].readyModes;
      return undefined;
    },
  };
}

// =============================================================================
// ChatV2 日志捕获
// =============================================================================

function createChatV2LogCapture() {
  const captured: ChatV2LogEntry[] = [];
  const captureStartTime = new Date().toISOString();
  const handler = (e: Event) => {
    const entry = (e as CustomEvent<ChatV2LogEntry>).detail;
    // 只捕获本轮开始之后的事件，排除前一轮的异步残留
    if (entry.timestamp >= captureStartTime && captured.length < MAX_LOGS_PER_CASE) {
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
// DOM 模拟：文件上传
// =============================================================================

function simulateFileUploadViaDOM(file: File): boolean {
  const fileInputs = document.querySelectorAll<HTMLInputElement>('input[type="file"][multiple]');
  if (fileInputs.length === 0) return false;
  try {
    const dt = new DataTransfer();
    dt.items.add(file);
    fileInputs[0].files = dt.files;
    fileInputs[0].dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    return true;
  } catch {
    return false;
  }
}

// =============================================================================
// Store 访问 + 会话管理
// =============================================================================

async function getSessionManager() {
  return (await import('../core/session/sessionManager')).sessionManager;
}

/** 创建全新会话并切换 UI 到它，等待 InputBarUI 就绪 */
async function createAndSwitchSession(
  logFn: (level: PipelineLogLevel, phase: string, msg: string, data?: Record<string, unknown>) => void,
  testLabel?: string,
): Promise<{ store: import('zustand').StoreApi<import('../core/types/store').ChatStore>; sessionId: string }> {
  const sm = await getSessionManager();
  const title = testLabel
    ? `${PIPELINE_TEST_SESSION_PREFIX} ${testLabel}`
    : `${PIPELINE_TEST_SESSION_PREFIX} 自动测试`;
  const session = await createSessionWithDefaults({ mode: 'chat', title });
  logFn('info', 'session', `新建会话: ${session.id}`);

  // 通知 ChatV2Page 切换到新会话
  window.dispatchEvent(new CustomEvent('PIPELINE_TEST_SWITCH_SESSION', {
    detail: { sessionId: session.id },
  }));

  // 等待 sessionManager 确认切换 + InputBarUI 的 file input 出现
  if (!await waitFor(() => sm.getCurrentSessionId() === session.id, 5000, 100)) {
    throw new Error(`会话切换超时: ${session.id}`);
  }
  if (!await waitFor(() => document.querySelectorAll<HTMLInputElement>('input[type="file"][multiple]').length > 0, 10000, 200)) {
    throw new Error('InputBarUI 未就绪（未找到 file input）');
  }
  // 额外等待 TauriAdapter setup 完成
  await sleep(500);

  const store = sm.get(session.id);
  if (!store) throw new Error(`创建会话后无法获取 Store: ${session.id}`);
  logFn('success', 'session', `会话已就绪: ${session.id}`);
  return { store, sessionId: session.id };
}

/** 监听后端真实 LLM 请求体（通过 Tauri 事件 chat_v2_llm_request_body）
 *  tool_call 流程会产生多次请求，第一次包含附件内容，后续是工具结果轮。
 *  因此捕获第一个请求体（包含附件内容），同时记录总请求数。
 */
async function createRequestBodyCapture(sessionId: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let firstBody: any = null;
  let requestCount = 0;
  const unlisten = await listen<{ streamEvent: string; model: string; url: string; requestBody: unknown }>(
    'chat_v2_llm_request_body',
    (event) => {
      const prefix = `chat_v2_event_${sessionId}`;
      if (event.payload.streamEvent === prefix || event.payload.streamEvent.startsWith(`${prefix}_`)) {
        requestCount++;
        // 只保留第一个请求体（包含附件内容），后续的是 tool_call 结果轮
        if (!firstBody) {
          firstBody = event.payload.requestBody;
        }
      }
    },
  );
  return {
    stop: () => unlisten(),
    get body() { return firstBody; },
    get count() { return requestCount; },
  };
}

// =============================================================================
// 工具
// =============================================================================

function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

async function waitFor(cond: () => boolean, timeoutMs: number, pollMs = 300, _label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { if (cond()) return true; await sleep(pollMs); }
  return false;
}

// =============================================================================
// 验证逻辑
// =============================================================================

interface VerifyOpts {
  skipSend: boolean;
  hasContextRef: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  requestBody?: any;
  responseContent?: string;
}

function verifyTestCase(tc: TestCase, consoleLogs: CapturedConsoleEntry[], opts: VerifyOpts): VerificationResult {
  const checks: VerificationCheck[] = [];

  // 1. 无管线错误
  const errLogs = consoleLogs.filter(l => l.level === 'error');
  checks.push({
    name: '无管线错误',
    passed: errLogs.length === 0,
    detail: errLogs.length > 0 ? `发现 ${errLogs.length} 个错误: ${errLogs.map(l => l.message).join('; ')}` : '无错误',
  });

  // 2. ContextRef 创建
  checks.push({
    name: 'ContextRef 创建成功',
    passed: opts.hasContextRef,
    detail: opts.hasContextRef ? '附件的 ContextRef 已确认存在' : '附件无 resourceId 或 ContextRef 不存在',
  });

  // === 以下仅在实际发送时检查 ===
  if (!opts.skipSend) {
    // 3. 控制台日志：注入模式规范化（信息性，不影响 pass/fail）
    // 注意：tool_call 流程下 resolveVfsRefs 可能在不同上下文执行，日志不一定被捕获
    if (tc.modelType === 'text') {
      const normalized = consoleLogs.some(l => l.message.includes('Text-only model: normalized injectModes'));
      checks.push({
        name: '(参考) 文本模型规范化日志',
        passed: true, // 信息性，始终通过
        detail: normalized ? '已检测到规范化日志' : '未检测到（tool_call 流程下正常）',
      });
    }
    if (tc.modelType === 'multimodal') {
      const wronglyNormalized = consoleLogs.some(l => l.message.includes('Text-only model: normalized injectModes'));
      checks.push({
        name: '多模态模型未被降级',
        passed: !wronglyNormalized,
        detail: wronglyNormalized ? '错误：多模态模型触发了文本模型规范化！' : '正确',
      });
    }

    // 4. ★ 后端请求体验证：检查实际发送给 LLM 的内容块
    checks.push(...verifyRequestBody(tc, opts.requestBody));

    // 5. ★ LLM 响应内容验证：检查是否包含失败指示
    checks.push(...verifyResponseContent(opts.responseContent));
  }

  return { passed: checks.every(c => c.passed), checks };
}

/** 验证后端实际发给 LLM 的请求体内容 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function verifyRequestBody(tc: TestCase, body: any): VerificationCheck[] {
  const checks: VerificationCheck[] = [];
  if (!body) {
    checks.push({ name: '请求体已捕获', passed: false, detail: '未捕获到后端请求体（chat_v2_llm_request_body 事件未收到）' });
    return checks;
  }
  checks.push({ name: '请求体已捕获', passed: true, detail: '已捕获后端真实请求体' });

  // 提取最后一个 user 消息
  const messages = body.messages as Array<{ role: string; content: unknown }> | undefined;
  if (!messages?.length) {
    checks.push({ name: '消息列表非空', passed: false, detail: '请求体 messages 为空' });
    return checks;
  }
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUser) {
    checks.push({ name: '用户消息存在', passed: false, detail: '请求体无 user 消息' });
    return checks;
  }

  const content = lastUser.content;

  // ========================================================================
  // 后端请求体 content 格式说明：
  //   多模态模型 + 有 image 注入 → content 是数组 [{type:"text",...}, {type:"image_url",...}]
  //   文本模型 / 无 image 注入   → content 是字符串（附件文本拼入字符串）
  // ========================================================================

  const modes = tc.attachmentType === 'image'
    ? (tc.injectModes as ImageInjectMode[] | undefined)
    : (tc.injectModes as PdfInjectMode[] | undefined);
  const expectImageBlocks = tc.modelType === 'multimodal' && (!modes || modes.includes('image'));

  if (Array.isArray(content)) {
    // content 是数组 — 多模态 + image 模式
    checks.push({ name: 'content 格式', passed: true, detail: `数组: ${content.length} 个内容块` });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const blocks = content as any[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hasImageUrl = blocks.some((b: any) => b.type === 'image_url');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const textLen = blocks.filter((b: any) => b.type === 'text').reduce((sum: number, b: any) => sum + (b.text?.length || 0), 0);

    if (tc.modelType === 'text') {
      // 文本模型不应出现数组 content（意味着有 image_url 泄漏）
      checks.push({ name: '文本模型无 image_url', passed: !hasImageUrl,
        detail: hasImageUrl ? '❌ 文本模型请求体包含 image_url 块' : '✓ 文本模型正确无 image_url' });
    }

    if (tc.modelType === 'multimodal') {
      if (expectImageBlocks) {
        checks.push({ name: '多模态请求含 image_url', passed: hasImageUrl,
          detail: hasImageUrl ? `✓ 包含 image_url + ${textLen}字符文本` : '❌ 多模态模型缺少 image_url' });
      } else {
        checks.push({ name: '多模态 ocr-only 无 image_url', passed: !hasImageUrl,
          detail: hasImageUrl ? '❌ 注入模式不含 image 但有 image_url' : '✓ 仅文本模式，无 image_url' });
      }
    }

    const hasAnyContent = hasImageUrl || textLen > 50;
    checks.push({ name: '附件内容已注入', passed: hasAnyContent,
      detail: hasAnyContent
        ? (hasImageUrl ? `image_url + ${textLen}字符文本` : `${textLen}字符文本`)
        : `仅 ${textLen}字符文本，附件可能未注入` });

  } else if (typeof content === 'string') {
    // content 是字符串 — 文本模型 或 多模态无 image 模式
    const strLen = content.length;
    if (expectImageBlocks) {
      // 多模态 + image 模式应该是数组，但拿到了字符串 → 图片未注入
      checks.push({ name: 'content 格式', passed: false,
        detail: `期望数组(多模态+image)，实际是字符串(${strLen}字符) — 图片可能未注入` });
    } else {
      // 文本模型 或 多模态纯文本模式：字符串是正确的
      checks.push({ name: 'content 格式', passed: true,
        detail: `字符串: ${strLen}字符 (文本模型/纯文本模式)` });
    }

    // 检查字符串中是否包含附件内容（应有实质性文本被注入）
    // 用户发送的 prompt 约 15 字符，如果 content 远超这个长度说明有附件文本注入
    const promptBaseLen = 30; // "请简要描述这个附件的内容。" 约 15 字 + 余量
    const hasInjectedText = strLen > promptBaseLen + 50;
    checks.push({ name: '附件文本已注入', passed: hasInjectedText,
      detail: hasInjectedText
        ? `✓ content ${strLen}字符，含注入文本 (超出基础 ${promptBaseLen}+50)`
        : `content 仅 ${strLen}字符，附件文本可能未注入` });

  } else {
    checks.push({ name: 'content 格式', passed: false,
      detail: `未知类型: ${typeof content}` });
  }

  // ★ 内容质量检查：检测占位符注入
  const contentStr = typeof content === 'string' ? content
    : Array.isArray(content)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ? content.filter((b: any) => b.type === 'text').map((b: any) => b.text || '').join('\n')
      : '';
  if (contentStr) {
    checks.push(...checkContentQuality(contentStr, tc));
  }

  return checks;
}

/** 检测注入内容是否为占位符（无实质内容）*/
function checkContentQuality(content: string, tc: TestCase): VerificationCheck[] {
  const checks: VerificationCheck[] = [];
  // 占位符特征：只有文件名和页码，无实际文本
  const PLACEHOLDER_PATTERNS = [
    /\[PDF@\w+:\d+\]\s+.*第\d+页\s*\n\[文档:.*\]/,
    /ocr_status.*status="unavailable"/,
  ];
  const hasPlaceholder = PLACEHOLDER_PATTERNS.some(p => p.test(content));
  const hasOcrUnavailable = content.includes('status="unavailable"');
  const hasExtractedText = content.includes('<extracted_text>') || content.includes('<ocr_text>');
  // injected_context 内的实质文本长度（排除 XML 标签和元数据）
  const injectedMatch = content.match(/<injected_context>([\s\S]*?)<\/injected_context>/);
  const injectedLen = injectedMatch ? injectedMatch[1].replace(/<[^>]+>/g, '').trim().length : 0;

  if (tc.attachmentType === 'pdf') {
    checks.push({
      name: '注入内容质量',
      passed: !hasPlaceholder || hasExtractedText || injectedLen > 200,
      detail: hasPlaceholder && !hasExtractedText && injectedLen < 200
        ? `⚠️ 注入内容为占位符 (净文本${injectedLen}字符, OCR=${hasOcrUnavailable ? '不可用' : '可用'})，后端文本提取/OCR 可能失败`
        : `✓ 注入内容${injectedLen}字符 (提取文本=${hasExtractedText}, OCR=${!hasOcrUnavailable})`,
    });
  }
  return checks;
}

/** 验证 LLM 响应不含失败/错误指示 */
function verifyResponseContent(content: string | undefined): VerificationCheck[] {
  const checks: VerificationCheck[] = [];
  if (!content) {
    checks.push({ name: 'LLM 响应', passed: false, detail: '未获取到 LLM 响应内容' });
    return checks;
  }
  // 使用更具体的模式，避免 LLM 正常描述技术文档时的误判
  const FAILURE_KW = [
    '无法读取附件', '无法识别附件', '无法加载附件', '无法处理附件',
    '附件处理失败', '附件加载失败', '图片无法识别', '文件无法读取',
    '没有提供附件', '未提供附件', '未找到附件', '没有看到附件',
    '没有收到', '无法查看', '没有上传', '未上传',
  ];
  const found = FAILURE_KW.filter(kw => content.includes(kw));
  checks.push({
    name: 'LLM 响应无失败指示',
    passed: found.length === 0,
    detail: found.length > 0
      ? `响应含失败关键词: [${found.join(', ')}] — "${content.slice(0, 120)}…"`
      : `响应正常 (${content.length} 字符)`,
  });
  return checks;
}

// =============================================================================
// 单轮测试
// =============================================================================

export async function runSingleTestCase(
  testCase: TestCase,
  imageBuffer: ArrayBuffer,
  pdfBuffer: ArrayBuffer,
  originalImageFile: File,
  originalPdfFile: File,
  config: TestConfig,
  onLog?: (entry: PipelineLogEntry) => void,
): Promise<TestCaseResult> {
  const startMs = Date.now();
  const { logs, log } = createLogger(testCase.id, onLog);
  const chatV2Capture = createChatV2LogCapture();
  const consoleCapture = createConsoleCapture();

  const result: TestCaseResult = {
    testCase,
    status: 'running',
    startTime: new Date().toISOString(),
    endTime: '',
    durationMs: 0,
    logs,
    chatV2Logs: chatV2Capture.logs,
    consoleLogs: consoleCapture.captured,
    verification: { passed: false, checks: [] },
  };

  let hasContextRef = false;
  let reqCapture: Awaited<ReturnType<typeof createRequestBodyCapture>> | null = null;
  const mediaCapture = createMediaProcessingCapture(log);

  chatV2Capture.start();
  consoleCapture.start();
  await mediaCapture.start();

  try {
    log('info', 'init', `开始测试: ${testCase.label}`);

    // ★ 每轮创建全新会话，避免历史消息污染
    const { store, sessionId } = await createAndSwitchSession(log, testCase.label);
    result.sessionId = sessionId;

    // ★ 开始监听后端请求体
    reqCapture = await createRequestBodyCapture(sessionId);

    // 设置模型
    store.getState().setChatParams({ modelId: testCase.modelId });
    log('info', 'model', `模型设置: ${testCase.modelId} (${testCase.modelType})`);
    await sleep(200);

    // 文件变异
    const salt = `${testCase.id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const isImage = testCase.attachmentType === 'image';
    const buf = isImage ? imageBuffer : pdfBuffer;
    const orig = isImage ? originalImageFile : originalPdfFile;
    const mutated = createMutatedFile(buf, orig, salt);
    log('info', 'mutation', `文件变异: ${mutated.size}B (salt=${salt})`);

    // DOM 文件上传（先记录数量，再触发 change — change 处理器是同步的）
    const countBeforeUpload = store.getState().attachments.length;
    log('debug', 'upload', `上传前附件数: ${countBeforeUpload}`);
    log('info', 'upload', 'DOM 文件上传...');
    if (!simulateFileUploadViaDOM(mutated)) {
      throw new Error('DOM 上传失败：未找到 <input type="file" multiple>');
    }
    log('success', 'upload', 'change 事件已触发');
    if (!await waitFor(() => store.getState().attachments.length > countBeforeUpload, 10000, 200)) {
      throw new Error('附件 10s 内未出现（数量未增加）');
    }
    const currentAttachments = store.getState().attachments;
    const att = currentAttachments[currentAttachments.length - 1];
    if (!att) throw new Error('附件数量增加但列表为空');
    log('success', 'upload', `附件: id=${att.id} status=${att.status}`, {
      resourceId: att.resourceId, sourceId: att.sourceId,
    });

    // 等待 VFS 上传完成
    if (!await waitFor(() => {
      const a = store.getState().attachments.find(x => x.id === att.id);
      return !!a && a.status !== 'uploading' && a.status !== 'pending';
    }, 30000, 300)) {
      throw new Error('VFS 上传 30s 超时');
    }
    const uploaded = store.getState().attachments.find(x => x.id === att.id)!;
    if (uploaded.status === 'error') {
      throw new Error(`VFS 上传失败: status=error, id=${uploaded.id}`);
    }
    log('success', 'upload', `VFS 完成: status=${uploaded.status}`, {
      resourceId: uploaded.resourceId, processingStatus: uploaded.processingStatus,
    });
    result.attachmentMeta = {
      id: uploaded.id, name: uploaded.name, status: uploaded.status,
      resourceId: uploaded.resourceId, sourceId: uploaded.sourceId,
      processingStatus: uploaded.processingStatus,
    };

    // 验证 ContextRef 存在性
    if (uploaded.resourceId) {
      const refs = store.getState().pendingContextRefs;
      hasContextRef = refs.some(r => r.resourceId === uploaded.resourceId);
      log(hasContextRef ? 'success' : 'warn', 'contextRef',
        hasContextRef ? `ContextRef 已确认: ${uploaded.resourceId}` : `ContextRef 未找到: ${uploaded.resourceId}`,
        { resourceId: uploaded.resourceId, totalRefs: refs.length });
    } else {
      log('warn', 'contextRef', '附件无 resourceId，无法验证 ContextRef');
    }

    // 设置注入模式
    if (testCase.injectModes !== undefined) {
      const modes = isImage
        ? { image: testCase.injectModes as ImageInjectMode[] }
        : { pdf: testCase.injectModes as PdfInjectMode[] };
      store.getState().updateAttachment(uploaded.id, { injectModes: modes });
      if (uploaded.resourceId) {
        store.getState().updateContextRefInjectModes(uploaded.resourceId, {
          image: modes.image, pdf: modes.pdf,
        });
      }
      log('info', 'modes', `注入模式设置完成`, { modes });
      await sleep(100);
    } else {
      log('info', 'modes', '使用默认模式');
    }

    // 等待处理就绪（OCR/PDF 预处理）
    // ★ 模拟真实用户行为：用户会等到附件状态变为 ready（进度条消失）后才发送
    log('info', 'wait', '等待附件 status=ready (模拟用户等待进度条完成)...');
    const ready = await waitFor(() => {
      const a = store.getState().attachments.find(x => x.id === att.id);
      return !!a && a.status === 'ready';
    }, 60000, 500);
    const cur = store.getState().attachments.find(x => x.id === att.id);
    log(ready ? 'success' : 'warn', 'processing',
      ready ? '处理就绪 (status=ready)' : '处理超时 (60s)，继续发送',
      { status: cur?.status, readyModes: cur?.processingStatus?.readyModes });

    // ★ 等待后端媒体处理流水线完成（OCR、页面压缩等需要更长时间）
    const sourceId = cur?.sourceId;
    if (sourceId && isImage === false) {
      // PDF 需要等待后端 pipeline 产出 text/ocr/image 模式
      const hasMediaEvents = mediaCapture.hasEventsFor(sourceId);
      if (!hasMediaEvents) {
        log('info', 'wait:media', `等待后端媒体处理事件 (sourceId=${sourceId})...`);
        const gotEvents = await waitFor(() => mediaCapture.hasEventsFor(sourceId), 15000, 500);
        if (gotEvents) {
          log('success', 'wait:media', '收到媒体处理事件');
          // 继续等待完成
          const mediaCompleted = await waitFor(() => {
            return mediaCapture.events.some(e => e.fileId === sourceId && (e.type === 'completed' || e.type === 'error'));
          }, 45000, 500);
          if (mediaCompleted) {
            const finalModes = mediaCapture.getFinalReadyModes(sourceId);
            log('success', 'wait:media', `媒体处理完成`, { readyModes: finalModes });
          } else {
            log('warn', 'wait:media', '媒体处理 45s 未完成，继续发送');
          }
        } else {
          log('warn', 'wait:media', `15s 内无媒体处理事件 (sourceId=${sourceId})，后端 pipeline 可能未启动`);
        }
      } else {
        // 已有事件，等完成
        const mediaCompleted = await waitFor(() => {
          return mediaCapture.events.some(e => e.fileId === sourceId && (e.type === 'completed' || e.type === 'error'));
        }, 45000, 500);
        const finalModes = mediaCapture.getFinalReadyModes(sourceId);
        log(mediaCompleted ? 'success' : 'warn', 'wait:media',
          mediaCompleted ? `媒体处理完成` : '媒体处理 45s 未完成',
          { readyModes: finalModes, eventCount: mediaCapture.events.filter(e => e.fileId === sourceId).length });
      }
    }

    // ★ 发送前完整状态 dump
    {
      const refs = store.getState().pendingContextRefs;
      log('info', 'preSend:contextRefs', JSON.stringify(refs.map(r => ({
        resourceId: r.resourceId, typeId: r.typeId, hash: r.hash,
        injectModes: r.injectModes, displayName: r.displayName,
      })), null, 2));
      const atts = store.getState().attachments;
      log('info', 'preSend:attachments', JSON.stringify(atts.map(a => ({
        id: a.id, name: a.name, status: a.status, resourceId: a.resourceId,
        sourceId: a.sourceId, processingStatus: a.processingStatus,
        injectModes: a.injectModes, mimeType: a.mimeType, size: a.size,
      })), null, 2));

      // ★ pdfProcessingStore 状态 dump（最新的后端处理状态）
      const latestAtt = atts[atts.length - 1];
      if (latestAtt?.sourceId) {
        const storeStatus = usePdfProcessingStore.getState().get(latestAtt.sourceId);
        log('info', 'preSend:pdfStore', storeStatus
          ? JSON.stringify(storeStatus)
          : `sourceId=${latestAtt.sourceId} 在 pdfProcessingStore 中无记录`);
      }

      // ★ readyModes 缺口分析
      if (latestAtt) {
        const isPdf = latestAtt.mimeType === 'application/pdf' || latestAtt.name.toLowerCase().endsWith('.pdf');
        const mediaType: AttachmentMediaType = isPdf ? 'pdf' : 'image';
        const selectedModes = getSelectedInjectModes(latestAtt, mediaType);
        const pdfStoreStatus = latestAtt.sourceId ? usePdfProcessingStore.getState().get(latestAtt.sourceId) : undefined;
        const effectiveStatus = pdfStoreStatus || latestAtt.processingStatus;
        const effectiveReady = getEffectiveReadyModes(latestAtt, mediaType, effectiveStatus);
        const missingModes = selectedModes.filter(m => !effectiveReady?.includes(m));
        log('info', 'preSend:modeAnalysis', `选中=${JSON.stringify(selectedModes)} 就绪=${JSON.stringify(effectiveReady)} 缺失=${JSON.stringify(missingModes)}`, {
          canSend: missingModes.length === 0,
          effectiveStatusSource: pdfStoreStatus ? 'pdfProcessingStore' : 'att.processingStatus',
        });
      }

      // ★ 媒体处理事件汇总
      log('info', 'preSend:mediaEvents', `共收到 ${mediaCapture.events.length} 个媒体处理事件`,
        mediaCapture.events.length > 0 ? { events: mediaCapture.events.map(e => `${e.type}:${e.fileId}:${e.stage || e.readyModes?.join(',')}`) } : undefined);
    }

    // 发送
    if (config.skipSend) {
      log('info', 'send', 'skipSend=true，跳过');
      result.status = 'passed';
    } else {
      // ★ 模拟真实用户操作：在输入框打字 → 点击发送按钮
      // 发送按钮的 onClick 会走完整的 useInputBarV2.sendMessage 路径：
      //   降级检查 → blockingMode 守卫 → 附件过滤 → store.sendMessage
      const prompt = config.testPrompt || '请简要描述这个附件的内容。';
      store.getState().setInputValue(prompt);
      await sleep(200);

      let sendBtn = document.querySelector('[data-testid="btn-send"]') as HTMLButtonElement | null;
      if (!sendBtn) {
        throw new Error('未找到发送按钮 [data-testid="btn-send"]');
      }
      if (sendBtn.disabled) {
        log('info', 'send', '发送按钮暂时禁用，等待媒体处理完成...');
        const btnReady = await waitFor(() => {
          sendBtn = document.querySelector('[data-testid="btn-send"]') as HTMLButtonElement | null;
          return !!sendBtn && !sendBtn.disabled;
        }, 30000, 500);
        if (!btnReady || !sendBtn || sendBtn.disabled) {
          log('warn', 'send', '发送按钮被禁用 (disabled)，真实用户无法点击');
          const finalAtts = store.getState().attachments;
          for (const a of finalAtts) {
            const isPdf = a.mimeType === 'application/pdf' || a.name.toLowerCase().endsWith('.pdf');
            const mediaType: AttachmentMediaType = isPdf ? 'pdf' : 'image';
            const selected = getSelectedInjectModes(a, mediaType);
            const storeStatus = a.sourceId ? usePdfProcessingStore.getState().get(a.sourceId) : undefined;
            const effective = getEffectiveReadyModes(a, mediaType, storeStatus || a.processingStatus);
            const missing = selected.filter(m => !effective?.includes(m));
            log('info', 'send:disabled:detail', JSON.stringify({
              id: a.id, status: a.status, sourceId: a.sourceId,
              selectedModes: selected, effectiveReady: effective, missingModes: missing,
              attProcessingStatus: a.processingStatus,
              pdfStoreStatus: storeStatus || null,
              mediaEventsReceived: a.sourceId ? mediaCapture.events.filter(e => e.fileId === a.sourceId).length : 0,
            }, null, 2));
          }
          throw new Error('发送按钮被禁用，模拟用户无法发送');
        }
        log('success', 'send', '发送按钮已就绪');
      }
      log('info', 'send', `点击发送按钮: "${prompt.slice(0, 40)}..."`);
      sendBtn.click();

      // 先等状态离开 idle（发送开始），再等回到 idle（发送完成）
      await waitFor(
        () => store.getState().sessionStatus !== 'idle',
        10000, 100,
      );
      log('info', 'send', `发送已开始 (status=${store.getState().sessionStatus})`);

      const done = await waitFor(
        () => store.getState().sessionStatus === 'idle',
        config.roundTimeoutMs || 120000, 500,
      );
      if (done) {
        log('success', 'send', '流式完成');
        // ★ 提取 LLM 响应内容
        const msgs = store.getState().messageMap;
        const lastAssistant = [...msgs.values()].filter(m => m.role === 'assistant').pop();
        if (lastAssistant) {
          const blks = store.getState().blocks;
          result.responseBlocksSummary = (lastAssistant.blockIds || []).map(bid => {
            const b = blks.get(bid);
            return b ? `${b.type}(${typeof b.content === 'string' ? b.content.length : 0})` : `?${bid}`;
          });
          // 提取 content 类型块的文本用于验证（排除 thinking/mcp_tool 等）
          const textContent = (lastAssistant.blockIds || []).map(bid => {
            const b = blks.get(bid);
            return b && b.type === 'content' && typeof b.content === 'string' ? b.content : '';
          }).filter(Boolean).join('\n');
          result.responseContent = textContent;
          log('info', 'response', `块: ${result.responseBlocksSummary.join(', ')}`);
          if (textContent.length > 0) {
            log('info', 'response', `LLM 回复 (${textContent.length}字):`);
            log('info', 'response:full', textContent);
          } else {
            log('warn', 'response', 'LLM content 块无文本内容');
          }
        }
        // ★ 保存捕获的完整请求体到日志（不做任何判断，原样记录）
        result.capturedRequestBody = reqCapture?.body ?? null;
        if (reqCapture?.body) {
          const totalReqs = reqCapture.count;
          log('info', 'requestBody', `已捕获 (共${totalReqs}轮LLM请求)`);
          // 完整 dump 请求体：去掉 base64 图片数据 + system prompt（与注入无关），只保留关键内容
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const sanitized = JSON.parse(JSON.stringify(reqCapture.body, (key: string, val: any) => {
              if (key === 'url' && typeof val === 'string' && val.startsWith('data:')) {
                return `[base64:${val.length}bytes]`;
              }
              return val;
            }));
            // 去掉 system 消息的 content（太长且与附件注入无关）
            if (Array.isArray(sanitized.messages)) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              sanitized.messages = sanitized.messages.map((m: any) => {
                if (m.role === 'system') {
                  return { role: 'system', content: `[system prompt: ${(m.content?.length || 0)}字符, 已省略]` };
                }
                return m;
              });
            }
            log('info', 'requestBody:dump', JSON.stringify(sanitized, null, 2));
          } catch {
            log('warn', 'requestBody:dump', '序列化失败');
          }
        } else {
          log('warn', 'requestBody', '未捕获到后端请求体');
        }

        result.status = 'passed';
      } else {
        log('error', 'send', '流式超时');
        result.status = 'failed';
        result.error = `流式超时 (${config.roundTimeoutMs || 120000}ms)`;
        try { await store.getState().abortStream(); } catch { /* ignore */ }
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log('error', 'fatal', msg);
    result.status = 'failed';
    result.error = msg;
  } finally {
    reqCapture?.stop();
    mediaCapture.stop();
    consoleCapture.stop();
    chatV2Capture.stop();
    result.verification = verifyTestCase(testCase, consoleCapture.captured, {
      skipSend: !!config.skipSend,
      hasContextRef,
      requestBody: result.capturedRequestBody,
      responseContent: result.responseContent,
    });
    // ★ 详细输出每个验证检查结果
    for (const c of result.verification.checks) {
      log(c.passed ? 'success' : 'error', 'verify', `${c.passed ? '✅' : '❌'} ${c.name}: ${c.detail}`);
    }
    if (!result.verification.passed && result.status === 'passed') {
      result.status = 'failed';
      const failedChecks = result.verification.checks.filter(c => !c.passed);
      result.error = '验证未通过: ' + failedChecks.map(c => c.name).join(', ');
    }
    // ★ 最终状态行
    const elapsed = Date.now() - startMs;
    if (result.status === 'passed') {
      log('success', 'result', `✅ 通过 (${elapsed}ms) — ${result.verification.checks.length} 项检查全部通过`);
    } else {
      log('error', 'result', `❌ 失败 (${elapsed}ms) — ${result.error || '未知原因'}`);
    }
    result.endTime = new Date().toISOString();
    result.durationMs = elapsed;
  }
  return result;
}

// =============================================================================
// 全量运行器
// =============================================================================

let _abortRequested = false;

export function requestAbort() { _abortRequested = true; }
export function isAbortRequested() { return _abortRequested; }
export function resetAbort() { _abortRequested = false; }

export async function runAllTests(
  config: TestConfig,
  onCaseComplete?: (result: TestCaseResult, index: number, total: number) => void,
  onLog?: (entry: PipelineLogEntry) => void,
): Promise<TestCaseResult[]> {
  _abortRequested = false;
  globalLogId = 0;
  const matrix = generateTestMatrix(config.textModelId, config.multimodalModelId, config.attachmentTypeFilter);
  const needImage = matrix.some(tc => tc.attachmentType === 'image');
  const needPdf = matrix.some(tc => tc.attachmentType === 'pdf');
  if (needImage && !config.imageFile) throw new Error('测试矩阵包含图片用例但未提供图片文件');
  if (needPdf && !config.pdfFile) throw new Error('测试矩阵包含 PDF 用例但未提供 PDF 文件');
  const [imgBuf, pdfBuf] = await Promise.all([
    needImage && config.imageFile ? readFileAsArrayBuffer(config.imageFile) : Promise.resolve(new ArrayBuffer(0)),
    needPdf && config.pdfFile ? readFileAsArrayBuffer(config.pdfFile) : Promise.resolve(new ArrayBuffer(0)),
  ]);
  const results: TestCaseResult[] = [];
  const interval = config.intervalMs ?? 3000;

  for (const tc of matrix) {
    if (_abortRequested) {
      const skipped: TestCaseResult = {
        testCase: tc, status: 'skipped',
        startTime: new Date().toISOString(), endTime: new Date().toISOString(),
        durationMs: 0, logs: [], chatV2Logs: [], consoleLogs: [],
        verification: { passed: true, checks: [] },
      };
      results.push(skipped);
      onCaseComplete?.(skipped, tc.index, matrix.length);
      continue;
    }
    let r: TestCaseResult;
    try {
      r = await runSingleTestCase(tc, imgBuf, pdfBuf, config.imageFile!, config.pdfFile!, config, onLog);
    } catch (err) {
      // 防止单个用例的未预期异常中断整个测试
      r = {
        testCase: tc, status: 'failed',
        startTime: new Date().toISOString(), endTime: new Date().toISOString(),
        durationMs: 0, logs: [], chatV2Logs: [], consoleLogs: [],
        error: `未捕获异常: ${err instanceof Error ? err.message : String(err)}`,
        verification: { passed: false, checks: [] },
      };
    }
    results.push(r);
    onCaseComplete?.(r, tc.index, matrix.length);

    if (tc.index < matrix.length - 1 && !_abortRequested) await sleep(interval);
  }
  return results;
}

// =============================================================================
// 测试数据清理（会话 + 附件 + 资源）
// =============================================================================

export interface CleanupResult {
  deletedSessions: number;
  deletedAttachments: number;
  errors: string[];
}

/**
 * 清理所有 [PipelineTest] 标记的测试会话。
 * 返回删除的会话数量。
 * @deprecated 使用 cleanupTestData 代替
 */
export async function cleanupTestSessions(): Promise<{ deleted: number; errors: string[] }> {
  const result = await cleanupTestData();
  return { deleted: result.deletedSessions, errors: result.errors };
}

/**
 * 批量清理测试产生的所有废弃数据：
 * 1. 查找所有 [PipelineTest] 标记的测试会话
 * 2. 从会话消息中提取关联的附件 ID
 * 3. 软删除会话
 * 4. 软删除关联附件（VFS files 表中 att_ 开头的记录）
 */
export async function cleanupTestData(
  onProgress?: (msg: string) => void,
): Promise<CleanupResult> {
  const { invoke } = await import('@tauri-apps/api/core');
  const sm = await getSessionManager();
  const errors: string[] = [];
  let deletedSessions = 0;
  let deletedAttachments = 0;
  const log = (msg: string) => { console.log(`[PipelineTest:cleanup] ${msg}`); onProgress?.(msg); };

  // 1. 后端分页加载所有可见和旧状态会话，筛选测试会话
  log('查找测试会话...');
  const PAGE = 100;
  const testSessionIds: string[] = [];

  for (const status of ['active', 'archived', 'deleted'] as const) {
    let offset = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const batch = await invoke<Array<{ id: string; title?: string }>>('chat_v2_list_sessions', {
        status, limit: PAGE, offset,
      });
      for (const s of batch) {
        if (s.title && s.title.startsWith(PIPELINE_TEST_SESSION_PREFIX)) {
          testSessionIds.push(s.id);
        }
      }
      if (batch.length < PAGE) break;
      offset += PAGE;
    }
  }
  log(`找到 ${testSessionIds.length} 个测试会话`);

  // 2. 从测试会话消息中提取附件 ID
  const attachmentIds = new Set<string>();
  for (const sid of testSessionIds) {
    try {
      const sessionData = await invoke<{
        messages?: Array<{
          attachments?: Array<{ id: string }>;
        }>;
      }>('chat_v2_load_session', { sessionId: sid });
      if (sessionData?.messages) {
        for (const msg of sessionData.messages) {
          if (msg.attachments) {
            for (const att of msg.attachments) {
              if (att.id && att.id.startsWith('att_')) {
                attachmentIds.add(att.id);
              }
            }
          }
        }
      }
    } catch {
      // 会话可能已无法加载，跳过
    }
  }
  log(`找到 ${attachmentIds.size} 个关联附件`);

  // 3. 删除测试会话
  log('删除测试会话...');
  for (const sid of testSessionIds) {
    try {
      if (sm.has(sid)) {
        await sm.destroy(sid);
      }
      await invoke('chat_v2_delete_session', { sessionId: sid });
      deletedSessions++;
    } catch (err) {
      errors.push(`session ${sid}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  log(`已删除 ${deletedSessions} 个会话`);

  // 4. 删除关联附件
  if (attachmentIds.size > 0) {
    log('删除关联附件...');
    for (const attId of attachmentIds) {
      try {
        await invoke('vfs_delete_attachment', { attachmentId: attId });
        deletedAttachments++;
      } catch (err) {
        errors.push(`attachment ${attId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    log(`已删除 ${deletedAttachments} 个附件`);
  }

  log(`清理完成: ${deletedSessions} 会话, ${deletedAttachments} 附件, ${errors.length} 错误`);
  return { deletedSessions, deletedAttachments, errors };
}

// =============================================================================
// ★ PDF 文本提取诊断测试（不加盐 vs 加盐）
// =============================================================================

export interface PdfExtractionDiagResult {
  original: {
    sourceId: string;
    isNew: boolean;
    size: number;
    processingStatus?: string;
    readyModes?: string[];
    processingPercent?: number;
    hasExtractedText: boolean;
    extractedTextLen: number;
    pageCount: number | null;
  };
  salted: {
    sourceId: string;
    isNew: boolean;
    size: number;
    processingStatus?: string;
    readyModes?: string[];
    processingPercent?: number;
    hasExtractedText: boolean;
    extractedTextLen: number;
    pageCount: number | null;
  };
  conclusion: string;
}

/**
 * 独立 PDF 文本提取诊断：对比不加盐 / 加盐上传后的后端处理结果。
 * 用于隔离 "盐变异是否破坏 PDF 解析" 这一问题。
 *
 * 使用方法（浏览器控制台）：
 *   import { runPdfExtractionDiag } from '@/features/chat/debug/attachmentPipelineTestPlugin';
 *   const file = document.querySelector('input[type=file]')?.files?.[0];
 *   runPdfExtractionDiag(file).then(r => console.table([r.original, r.salted]));
 */
export async function runPdfExtractionDiag(
  pdfFile: File,
  onLog?: (msg: string) => void,
): Promise<PdfExtractionDiagResult> {
  const log = (msg: string) => {
    const ts = new Date().toISOString().slice(11, 23);
    const line = `[${ts}][pdfDiag] ${msg}`;
    console.log(line);
    onLog?.(line);
  };

  const { invoke } = await import('@tauri-apps/api/core');

  if (!pdfFile || pdfFile.size === 0) throw new Error('请提供有效的 PDF 文件');
  log(`文件: ${pdfFile.name} (${pdfFile.size} bytes)`);

  // ──────────── 0. 检查 pdfium 加载状态 ────────────
  log('── 检查 pdfium 状态 ──');
  try {
    const pdfiumStatus = await invoke<Record<string, string>>('test_pdfium_status');
    for (const [k, v] of Object.entries(pdfiumStatus).sort()) {
      log(`  ${k}: ${v}`);
    }
  } catch (err) {
    log(`  ❌ test_pdfium_status 调用失败: ${err instanceof Error ? err.message : String(err)}`);
  }

  const originalBuf = await readFileAsArrayBuffer(pdfFile);

  // ──────────── 1. 不加盐：直接上传原始 PDF ────────────
  log('── 上传原始 PDF（不加盐）──');
  const origBase64 = arrayBufferToBase64(new Uint8Array(originalBuf));
  const origResult = await invoke<{
    sourceId: string; isNew: boolean; resourceHash: string;
    attachment: { size: number; pageCount?: number; extractedText?: string };
    processingStatus?: string; processingPercent?: number; readyModes?: string[];
  }>('vfs_upload_attachment', {
    params: {
      name: pdfFile.name,
      mimeType: 'application/pdf',
      base64Content: origBase64,
      attachmentType: 'file',
    },
  });
  const origText = origResult.attachment.extractedText || '';
  log(`  sourceId: ${origResult.sourceId}`);
  log(`  isNew: ${origResult.isNew}`);
  log(`  processingStatus: ${origResult.processingStatus}`);
  log(`  readyModes: ${JSON.stringify(origResult.readyModes)}`);
  log(`  pageCount: ${origResult.attachment.pageCount ?? 'null'}`);
  log(`  extractedText: ${origText.length} 字符`);
  if (origText.length > 0) {
    log(`  textPreview: "${origText.slice(0, 200).replace(/\n/g, '\\n')}..."`);
  }

  // ──────────── 2. 加盐：使用当前变异策略 ────────────
  log('── 上传加盐 PDF ──');
  const salt = `diag_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const saltedFile = createMutatedFile(originalBuf, pdfFile, salt);
  const saltedBuf = await readFileAsArrayBuffer(saltedFile);
  const saltedBase64 = arrayBufferToBase64(new Uint8Array(saltedBuf));
  log(`  salt: ${salt}`);
  log(`  saltedSize: ${saltedFile.size} bytes (原始 ${pdfFile.size}, 差 ${saltedFile.size - pdfFile.size} bytes)`);

  const saltResult = await invoke<{
    sourceId: string; isNew: boolean; resourceHash: string;
    attachment: { size: number; pageCount?: number; extractedText?: string };
    processingStatus?: string; processingPercent?: number; readyModes?: string[];
  }>('vfs_upload_attachment', {
    params: {
      name: pdfFile.name,
      mimeType: 'application/pdf',
      base64Content: saltedBase64,
      attachmentType: 'file',
    },
  });
  const saltText = saltResult.attachment.extractedText || '';
  log(`  sourceId: ${saltResult.sourceId}`);
  log(`  isNew: ${saltResult.isNew}`);
  log(`  processingStatus: ${saltResult.processingStatus}`);
  log(`  readyModes: ${JSON.stringify(saltResult.readyModes)}`);
  log(`  pageCount: ${saltResult.attachment.pageCount ?? 'null'}`);
  log(`  extractedText: ${saltText.length} 字符`);
  if (saltText.length > 0) {
    log(`  textPreview: "${saltText.slice(0, 200).replace(/\n/g, '\\n')}..."`);
  }

  // ──────────── 3. 对比结论 ────────────
  const origOk = origText.length > 100;
  const saltOk = saltText.length > 100;
  let conclusion: string;
  if (origOk && saltOk) {
    conclusion = '✅ 原始和加盐 PDF 均成功提取文本 → 盐变异安全';
  } else if (origOk && !saltOk) {
    conclusion = '❌ 原始 PDF 能提取文本，加盐后失败 → 盐变异破坏了 PDF 结构';
  } else if (!origOk && !saltOk) {
    conclusion = '❌ 原始 PDF 也无法提取文本 → pdfium 本身有问题（与盐无关）';
  } else {
    conclusion = '⚠️ 异常：原始无法提取但加盐可以 → 可能是缓存/去重问题';
  }
  log(`\n结论: ${conclusion}`);
  log(`  原始: ${origText.length} 字符, pageCount=${origResult.attachment.pageCount ?? 'null'}, readyModes=${JSON.stringify(origResult.readyModes)}`);
  log(`  加盐: ${saltText.length} 字符, pageCount=${saltResult.attachment.pageCount ?? 'null'}, readyModes=${JSON.stringify(saltResult.readyModes)}`);

  return {
    original: {
      sourceId: origResult.sourceId,
      isNew: origResult.isNew,
      size: pdfFile.size,
      processingStatus: origResult.processingStatus,
      readyModes: origResult.readyModes,
      processingPercent: origResult.processingPercent,
      hasExtractedText: origText.length > 0,
      extractedTextLen: origText.length,
      pageCount: origResult.attachment.pageCount ?? null,
    },
    salted: {
      sourceId: saltResult.sourceId,
      isNew: saltResult.isNew,
      size: saltedFile.size,
      processingStatus: saltResult.processingStatus,
      readyModes: saltResult.readyModes,
      processingPercent: saltResult.processingPercent,
      hasExtractedText: saltText.length > 0,
      extractedTextLen: saltText.length,
      pageCount: saltResult.attachment.pageCount ?? null,
    },
    conclusion,
  };
}

/** Uint8Array → base64 字符串 */
function arrayBufferToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
