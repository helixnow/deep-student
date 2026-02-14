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
 *   - 发送消息：store.sendMessage（与发送按钮 onClick 回调路径一致）
 */

import { CHATV2_LOG_EVENT, type ChatV2LogEntry } from './chatV2Logger';
import { listen } from '@tauri-apps/api/event';
import { createSessionWithDefaults } from '../core/session/createSessionWithDefaults';

// =============================================================================
// 类型定义
// =============================================================================

export type AttachmentType = 'image' | 'pdf';
export type ModelType = 'text' | 'multimodal';
export type ImageInjectMode = 'image' | 'ocr';
export type PdfInjectMode = 'text' | 'ocr' | 'image';

export interface TestConfig {
  imageFile: File;
  pdfFile: File;
  textModelId: string;
  multimodalModelId: string;
  testPrompt?: string;
  intervalMs?: number;
  roundTimeoutMs?: number;
  skipSend?: boolean;
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
  // 使用随机二进制字节而非文本追加，对任何文件格式都安全改变 hash
  const saltBytes = new Uint8Array(32);
  crypto.getRandomValues(saltBytes);
  // 额外追加 salt 文本以便调试追溯
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

export function generateTestMatrix(textModelId: string, multimodalModelId: string): TestCase[] {
  const cases: TestCase[] = [];
  let idx = 0;
  const models: { type: ModelType; id: string }[] = [
    { type: 'text', id: textModelId },
    { type: 'multimodal', id: multimodalModelId },
  ];
  for (const m of models) {
    for (const modes of IMAGE_MODE_COMBOS) {
      const ml = modes ? `[${modes.join(',')}]` : 'default';
      cases.push({ id: `img_${m.type}_${ml}_${idx}`, index: idx++, attachmentType: 'image', modelType: m.type, modelId: m.id, injectModes: modes, label: `Image | ${m.type} | ${ml}` });
    }
  }
  for (const m of models) {
    for (const modes of PDF_MODE_COMBOS) {
      const ml = modes ? `[${modes.join(',')}]` : 'default';
      cases.push({ id: `pdf_${m.type}_${ml}_${idx}`, index: idx++, attachmentType: 'pdf', modelType: m.type, modelId: m.id, injectModes: modes, label: `PDF | ${m.type} | ${ml}` });
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
  // 附件注入后 content 应为数组格式（包含 text/image_url 块）
  if (!Array.isArray(content)) {
    checks.push({
      name: 'content 为数组格式',
      passed: false,
      detail: `content 是 ${typeof content}，非数组 — 附件内容可能未注入`,
    });
    return checks;
  }
  checks.push({ name: 'content 为数组格式', passed: true, detail: `${content.length} 个内容块` });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blocks = content as any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hasImageUrl = blocks.some((b: any) => b.type === 'image_url');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const textLen = blocks.filter((b: any) => b.type === 'text').reduce((sum: number, b: any) => sum + (b.text?.length || 0), 0);

  // 文本模型：绝不应有 image_url
  if (tc.modelType === 'text') {
    checks.push({
      name: '文本模型无 image_url',
      passed: !hasImageUrl,
      detail: hasImageUrl ? '❌ 文本模型请求体包含 image_url 块！' : '✓ 文本模型正确无 image_url',
    });
  }

  // 多模态模型：根据注入模式检查 image_url 是否应存在
  if (tc.modelType === 'multimodal') {
    const modes = tc.attachmentType === 'image'
      ? (tc.injectModes as ImageInjectMode[] | undefined)
      : (tc.injectModes as PdfInjectMode[] | undefined);
    const expectImage = !modes || modes.includes('image');
    if (expectImage) {
      checks.push({
        name: '多模态请求含 image_url',
        passed: hasImageUrl,
        detail: hasImageUrl ? '✓ 多模态模型正确包含 image_url' : '❌ 多模态模型缺少 image_url 块',
      });
    } else {
      // 明确指定了模式且不包含 image：应无 image_url
      checks.push({
        name: '多模态 ocr-only 无 image_url',
        passed: !hasImageUrl,
        detail: hasImageUrl ? '❌ 注入模式未包含 image 但请求体有 image_url' : '✓ 正确：仅 ocr/text 模式，无 image_url',
      });
    }
  }

  // 附件内容应被注入（image_url 或文本内容 > 阈值）
  const hasContent = hasImageUrl || textLen > 50;
  checks.push({
    name: '附件内容已注入请求体',
    passed: hasContent,
    detail: hasContent
      ? (hasImageUrl ? `image_url + ${textLen} 字符文本` : `${textLen} 字符文本内容`)
      : `仅 ${textLen} 字符文本，附件内容可能未注入`,
  });

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

  chatV2Capture.start();
  consoleCapture.start();

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
    const curStatus = store.getState().attachments.find(x => x.id === att.id)?.status;
    if (curStatus !== 'processing' && curStatus !== 'ready') {
      log('info', 'processing', `跳过处理等待 (status=${curStatus})`);
    }
    if (curStatus === 'processing' || curStatus === 'ready') {
      log('info', 'wait', '等待预处理完全就绪...');
      const ready = await waitFor(() => {
        const a = store.getState().attachments.find(x => x.id === att.id);
        if (!a) return false;
        if (a.status === 'ready') return true;
        const rm = a.processingStatus?.readyModes || [];
        return rm.length > 0;
      }, 60000, 500);
      const cur = store.getState().attachments.find(x => x.id === att.id);
      log(ready ? 'success' : 'warn', 'processing',
        ready ? '处理就绪' : '处理超时，继续',
        { status: cur?.status, readyModes: cur?.processingStatus?.readyModes });
    }

    // 发送
    if (config.skipSend) {
      log('info', 'send', 'skipSend=true，跳过');
      result.status = 'passed';
    } else {
      const prompt = config.testPrompt || '请简要描述这个附件的内容。';
      store.getState().setInputValue(prompt);
      await sleep(100);
      log('info', 'send', `发送: "${prompt.slice(0, 40)}..."`);
      const p = store.getState().sendMessage(prompt);
      await sleep(500);

      const done = await waitFor(
        () => store.getState().sessionStatus === 'idle',
        config.roundTimeoutMs || 120000, 500,
      );
      try { await Promise.race([p, sleep(2000)]); } catch { /* ignore */ }

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
            log('info', 'response', `LLM 回复 (${textContent.length}字): ${textContent.slice(0, 150).replace(/\n/g, ' ')}${textContent.length > 150 ? '...' : ''}`);
          } else {
            log('warn', 'response', 'LLM content 块无文本内容');
          }
        }
        // ★ 保存捕获的请求体 + 详细摘要
        result.capturedRequestBody = reqCapture?.body ?? null;
        if (reqCapture?.body) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const rb = reqCapture.body as any;
          const msgs = rb?.messages as Array<{ role: string; content: unknown }> | undefined;
          const lastU = msgs ? [...msgs].reverse().find(m => m.role === 'user') : null;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const blocks = Array.isArray(lastU?.content) ? lastU.content as any[] : [];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const imgCount = blocks.filter((b: any) => b.type === 'image_url').length;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const txtLen = blocks.filter((b: any) => b.type === 'text').reduce((s: number, b: any) => s + (b.text?.length || 0), 0);
          const totalReqs = reqCapture.count;
          log('info', 'requestBody',
            `已捕获第1轮 (共${totalReqs}轮) | messages=${msgs?.length || 0} | user.content: ${blocks.length} 块 (image_url=${imgCount}, text=${txtLen}字符)`,
            { model: rb?.model });
          if (totalReqs > 1) {
            log('info', 'requestBody', `模型使用了 tool_call: 共 ${totalReqs} 轮 LLM 请求`);
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
  const matrix = generateTestMatrix(config.textModelId, config.multimodalModelId);
  const [imgBuf, pdfBuf] = await Promise.all([
    readFileAsArrayBuffer(config.imageFile),
    readFileAsArrayBuffer(config.pdfFile),
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
      r = await runSingleTestCase(tc, imgBuf, pdfBuf, config.imageFile, config.pdfFile, config, onLog);
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
