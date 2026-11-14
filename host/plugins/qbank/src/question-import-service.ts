/**
 * `question_import_service.rs` 的 v2（QuestionDocument 草稿）导入与恢复：
 * - `prepare_document`（420-608）：zip / json / 完整来源三条分支 → 版本化草稿，不直接写正式题目
 * - `resume_import` 的 schema_version 2 分支（741-821）
 * - `create_import_session`（2729-2790）、`decode_text_content`（3071-3093）、
 *   `authoring_config_fingerprint`（3100-3107）
 * - 命令层 `question_import_draft_response`（commands.rs:1069-1085）
 *
 * 取消语义（Rust：被 `tokio::select!` 丢弃的 future 在下一个 await 点停止）：管线中的每个异步步骤都经
 * `ImportRun.step` 等待，恢复执行时若信号已取消就立即抛出，不再产生任何副作用或进度事件。
 */
import { CommandError } from '../../../kernel/api.ts';
import { sha256HexSync } from '../../../platform/crypto/sync.ts';
import { AppError } from '../../../platform/errors/api.ts';
import type { AppError as AppErrorValue, JsonValue } from '../../../platform/errors/api.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { rs, toRustJson } from '../../../platform/serde-compat/index.ts';
import { JsonSyntaxError, decodeBase64Standard, parseJsonDocument, type JsonNode } from '../../../platform/util/portable.ts';
import type { ApiConfig } from '../../llm/api.ts';
import { ExamSheetSessionError, type ExamSheetSessionService, type PageSlice } from '../../media/api.ts';
import type { ExamRepository, QuestionRepository } from '../../vfs-repos/api.ts';
import type {
  QuestionDocument, QuestionImportDraftResponse, QuestionImportProgress, SourceRange,
} from '../api.ts';
import { questionDocument } from '../repository/authoring-decode.ts';
import { SerdeDecodeError, json, opt, req, string, struct, u32, vec, type Decoder } from '../repository/serde-decode.ts';
import * as authoring from './authoring-service.ts';
import { validateDocument } from './document.ts';
import * as qbankExport from './export-service.ts';
import type { QbankLogger } from './ports.ts';
import { QbankServiceError } from './question-service.ts';
import { legacyPages } from './source-bundle-identity.ts';
import { nodeToValue, valueFromStr } from './raw-json-number.ts';
import type { SourceBundle, SourcePage } from './source-bundle.ts';

export { valueFromStr };

type JsonObject = { [key: string]: JsonValue };

/** `ImportRequest`（question_import_service.rs:193-204）。 */
export interface ImportRequest {
  content: string;
  format: string;
  name: string | null;
  session_id: string | null;
  folder_id: string | null;
  model_config_id: string | null;
  /** Visual-First 架构下忽略，保留兼容性。 */
  pdf_prefer_ocr: boolean | null;
  source_ranges: SourceRange[];
}

/** `ImportResult`（207-218，`Default` 派生）。 */
export interface ImportResult {
  session_id: string;
  name: string;
  imported_count: number;
  total_questions: number;
  draft_job_id: string | null;
  draft_version: number | null;
  draft_document: JsonValue | null;
  model_route: JsonValue | null;
  committed: boolean;
}

function defaultResult(sessionId: string, name: string): ImportResult {
  return {
    session_id: sessionId, name, imported_count: 0, total_questions: 0, draft_job_id: null,
    draft_version: null, draft_document: null, model_route: null, committed: false,
  };
}

/** 进度通道（Rust `Option<UnboundedSender<QuestionImportProgress>>`，发送失败被 `let _` 忽略）。 */
export type ProgressSink = ((event: QuestionImportProgress) => void) | null;

/**
 * 完整来源分支（非 zip/json）与 v2 恢复依赖的来源准备与抽取。
 * 生产实现见 `question-import-runner.ts`（`load_source_bundle_cancellable` / `SourceBundle::scoped` /
 * `resolve_question_authoring_config` / `run_document`）。
 */
export interface DocumentAuthoring {
  loadSourceBundle(content: string, format: string, name: string, cancel: AbortSignal | null): Promise<SourceBundle>;
  scoped(bundle: SourceBundle, ranges: readonly SourceRange[]): SourceBundle;
  resolveAuthoringConfig(modelConfigId: string | null): Promise<ApiConfig>;
  runDocument(bundle: SourceBundle, config: ApiConfig, cancel: AbortSignal | null):
    Promise<[QuestionDocument, JsonObject]>;
}

export interface ImportServiceHost {
  readonly db: DatabaseHandle;
  readonly blobsDir: string;
  /** L11 `exam_sheets` 唯一写入方。 */
  readonly exams: ExamRepository;
  readonly questions: QuestionRepository;
  readonly portable: qbankExport.ImportHost;
  readonly authoring: authoring.AuthoringHost;
  readonly documents: DocumentAuthoring;
  readonly log?: QbankLogger;
}

/** 一次导入尝试的取消上下文。 */
export class ImportRun {
  readonly cancel: AbortSignal | null;
  readonly #onCancelled: string;

  /** `onCancelled`：被取消时命令层报告的消息（流式导入与恢复不同）。 */
  constructor(cancel: AbortSignal | null, onCancelled: string) {
    this.cancel = cancel;
    this.#onCancelled = onCancelled;
  }

  get cancelled(): boolean {
    return this.cancel?.aborted === true;
  }

  /** `QuestionImportService::check_cancelled`。 */
  checkCancelled(): void {
    if (this.cancelled) throw new QbankServiceError(AppError.validation('题目解析已取消'));
  }

  /** 等待一个 await 点；取消后恢复执行即停止（future 被 drop 的等价物）。 */
  async step<T>(promise: Promise<T>): Promise<T> {
    let value: T;
    try {
      value = await promise;
    } catch (error) {
      if (this.cancelled) throw new QbankServiceError(AppError.validation(this.#onCancelled));
      throw error;
    }
    if (this.cancelled) throw new QbankServiceError(AppError.validation(this.#onCancelled));
    return value;
  }
}

/** 任意抛出值 → AppError 线缆值（`?` 原样传播）。 */
export function toAppError(error: unknown): AppErrorValue {
  if (error instanceof QbankServiceError) return error.appError as AppErrorValue;
  if (error instanceof CommandError) return error.value as AppErrorValue;
  return AppError.database(error instanceof Error ? error.message : String(error));
}

/** AppError 的 serde 输出（error_type / message / details，None → null）。 */
function appErrorValue(error: AppErrorValue): JsonValue {
  return { error_type: error.error_type, message: error.message, details: error.details ?? null };
}

function rethrow(error: unknown): never {
  if (error instanceof QbankServiceError) throw error;
  throw new QbankServiceError(toAppError(error));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** L11 仓储失败 `map_err(|e| AppError::database(e.to_string()))`。 */
function database<T>(operation: () => T, prefix = ''): T {
  try {
    return operation();
  } catch (error) {
    throw new QbankServiceError(AppError.database(`${prefix}${errorText(error)}`));
  }
}

function send(progress: ProgressSink, event: QuestionImportProgress): void {
  if (progress === null) return;
  progress(event);
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value);
}

/** `Value::as_str`。 */
function asStr(value: JsonValue | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

/** `value["key"]`（缺失或非对象 → Null）。 */
function index(value: JsonValue | undefined, key: string): JsonValue {
  return isObject(value) && Object.hasOwn(value, key) ? value[key]! : null;
}

// ---------------------------------------------------------------------------
// 纯函数

/** `decode_text_content`：严格 STANDARD Base64 → UTF-8（去 BOM）→ GBK（无错误）→ GB18030（有损）。 */
export function decodeTextContent(base64Content: string): string {
  const decoded = decodeBase64Standard(base64Content);
  if (decoded.error !== undefined) {
    throw new QbankServiceError(AppError.validation(`Base64 解码失败: ${decoded.error}`));
  }
  const bytes = decoded.bytes;
  const utf8 = strictDecode('utf-8', bytes);
  if (utf8 !== null) return utf8.startsWith('\u{FEFF}') ? utf8.slice(1) : utf8;
  const gbk = strictDecode('gbk', bytes);
  if (gbk !== null) return gbk;
  return new TextDecoder('gb18030').decode(bytes);
}

/** 无错误解码；有非法序列返回 null（`String::from_utf8` Err / encoding_rs `had_errors`）。 */
function strictDecode(label: string, bytes: Uint8Array): string | null {
  try {
    return new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

/**
 * `serde_json::to_value(&ApiConfig)`（`dstu-core/src/llm_config.rs:10-125`，camelCase）在
 * `remove("api_key")`（camelCase 下不命中）与 `remove("headers")` 之后的形状。preserve_order 的
 * `Map::remove` 是 `swap_remove`：末字段 `resolvedAdapterId` 被换到 `headers` 的位置。
 */
const FINGERPRINT_SNAPSHOT = rs.struct({
  id: rs.string, name: rs.string, vendor_id: rs.option(rs.string), vendor_name: rs.option(rs.string),
  provider_type: rs.option(rs.string), provider_scope: rs.option(rs.string), auth_mode: rs.option(rs.string),
  api_protocol: rs.option(rs.string), supports_openai_responses: rs.option(rs.bool), api_key: rs.string,
  base_url: rs.string, model: rs.string, is_multimodal: rs.bool, is_reasoning: rs.bool, is_embedding: rs.bool,
  is_reranker: rs.bool, is_image_generation: rs.bool, enabled: rs.bool, model_adapter: rs.string,
  max_output_tokens: rs.u32, temperature: rs.f32, supports_tools: rs.bool, gemini_api_version: rs.string,
  is_builtin: rs.bool, is_read_only: rs.bool, reasoning_effort: rs.option(rs.string),
  reasoning_mode: rs.option(rs.string), thinking_enabled: rs.bool, thinking_budget: rs.option(rs.i32),
  include_thoughts: rs.bool, min_p: rs.option(rs.f32), top_k: rs.option(rs.u32), enable_thinking: rs.option(rs.bool),
  supports_reasoning: rs.bool, resolved_adapter_id: rs.option(rs.string),
  top_p_override: rs.option(rs.f32), frequency_penalty_override: rs.option(rs.f32),
  presence_penalty_override: rs.option(rs.f32), repetition_penalty: rs.option(rs.f32),
  reasoning_split: rs.option(rs.bool), effort: rs.option(rs.string), verbosity: rs.option(rs.string),
  is_favorite: rs.bool, max_tokens_limit: rs.option(rs.u32), context_window: rs.option(rs.u32),
  extra_body: rs.option(rs.indexMap(rs.value())),
}, { renameAll: 'camelCase', name: 'ApiConfig' });

/** 非 `Option` 字段缺失时取 serde 默认值（`default_*` 函数与 `#[serde(default)]`）。 */
const API_CONFIG_DEFAULTS = {
  id: '', name: '', apiKey: '', baseUrl: '', model: '', isMultimodal: false, isReasoning: false, isEmbedding: false,
  isReranker: false, isImageGeneration: false, enabled: false, modelAdapter: 'general', maxOutputTokens: 8192,
  temperature: 0.7, supportsTools: false, geminiApiVersion: 'v1', isBuiltin: false, isReadOnly: false,
  thinkingEnabled: false, includeThoughts: false, supportsReasoning: false, isFavorite: false,
};

/**
 * `authoring_config_fingerprint`：serde 快照移除 `api_key` / `headers` 后取 SHA-256。
 * 注意 Rust 的 camelCase 序列化里键名是 `apiKey`，`remove("api_key")` 不命中——密文 apiKey
 * 仍参与指纹，这里逐字保留该行为（换 key 即视为配置变化）。
 */
export function authoringConfigFingerprint(config: ApiConfig): string {
  const defined = Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined));
  const text = toRustJson({ ...API_CONFIG_DEFAULTS, ...defined }, FINGERPRINT_SNAPSHOT);
  return sha256HexSync(text);
}

/** `ExamSheetPreviewPage` serde 输出（models.rs:451，skip_serializing_if 字段按条件省略）。 */
function previewPage(page: PageSlice): JsonObject {
  return {
    page_index: page.page_index,
    blob_hash: page.blob_hash,
    width: page.width,
    height: page.height,
    // original_image_path: String::new() → skip_serializing_if = "String::is_empty"
    cards: [],
    // raw_ocr_text: None → 省略
    ocr_completed: true,
    parse_completed: false,
  };
}

// ---------------------------------------------------------------------------
// 会话

/** `create_import_session`。 */
export function createImportSession(host: ImportServiceHost, request: ImportRequest, qbankName: string,
  pages: readonly PageSlice[]): string {
  const sessionId = request.session_id;
  if (sessionId !== null) {
    const sheet = database(() => host.exams.getExamSheet(host.db, sessionId));
    if (sheet === null) throw new QbankServiceError(AppError.not_found('目标题目集不存在'));
    database(() => host.exams.updateStatus(host.db, sessionId, 'importing'));
    return sessionId;
  }
  const tempId = crypto.randomUUID();
  const preview: JsonObject = {
    temp_id: tempId,
    exam_name: qbankName,
    pages: pages.map(previewPage),
    // raw_model_response / instructions: None → 省略
    session_id: tempId,
  };
  const sheet = database(() => host.exams.createExamSheet(host.db, {
    examName: qbankName,
    tempId,
    metadataJson: {},
    previewJson: preview,
    status: 'importing',
    folderId: request.folder_id,
  }), '创建题目集失败: ');
  return sheet.id;
}

function updateImportState(host: ImportServiceHost, sessionId: string, state: JsonObject): void {
  database(() => host.exams.updateImportState(host.db, sessionId, state));
}

/** `SourceBundle` 的 serde 输出（字段序 sources/pages/text/format；SourcePage 字段序见 runner.rs:42）。 */
export function bundleValue(bundle: SourceBundle): JsonObject {
  return {
    sources: bundle.sources,
    pages: bundle.pages.map(page => ({
      source_id: page.source_id, page: page.page, blob_hash: page.blob_hash,
      width: page.width, height: page.height, text_hint: page.text_hint,
    })),
    text: bundle.text,
    format: bundle.format,
  };
}

/** `SourcePage`（无 serde 属性；`Option` 字段缺失按 None）。 */
const sourcePage: Decoder<SourcePage> = struct<SourcePage>('SourcePage', {
  source_id: req(string), page: req(u32), blob_hash: req(string), width: req(u32), height: req(u32),
  text_hint: opt(string),
});

/** `SourceBundle` 的 `Deserialize`：四个字段必填。 */
const sourceBundle: Decoder<SourceBundle> = struct<SourceBundle>('SourceBundle', {
  sources: req(vec(json)), pages: req(vec(sourcePage)), text: req(string), format: req(string),
});

// ---------------------------------------------------------------------------
// prepare_document

function serializeDocument(document: QuestionDocument): JsonObject {
  // 文档由字段序与 Rust 一致的解码器产出，且 QuestionDocument 无 skip_serializing_if：直接即为 serde 输出。
  return document as unknown as JsonObject; // boundary-allow unchecked-cast: 已经 questionDocument 解码器校验
}

function decodeDocument(raw: JsonValue, prefix: string): QuestionDocument {
  try {
    return questionDocument(raw, '');
  } catch (error) {
    if (error instanceof SerdeDecodeError) {
      throw new QbankServiceError(AppError.validation(`${prefix}${error.message}`));
    }
    throw error;
  }
}

function validate(document: QuestionDocument): void {
  try {
    validateDocument(document);
  } catch (error) {
    rethrow(error);
  }
}

/** json 分支：把旧版 `{questions:[...]}` 规范化为 QuestionDocument v2 extract。 */
function normalizeLegacyJson(raw: JsonValue): void {
  if (isObject(raw) && Object.hasOwn(raw, 'schema_version')) return;
  // `raw["questions"].as_array_mut()`：非对象根在 Rust 中 IndexMut 会 panic（null 根视为空对象）。
  const items = isObject(raw) ? raw.questions : undefined;
  if (!Array.isArray(items)) throw new QbankServiceError(AppError.validation('JSON 需要 questions 数组'));
  items.forEach((item, position) => {
    if (!isObject(item)) {
      // Rust `item["local_id"] = ...` 对非对象（非 null）元素 panic；命令以失败结束。
      throw new QbankServiceError(AppError.internal(`cannot access key "local_id" in JSON ${
        Array.isArray(item) ? 'array' : item === null ? 'null' : typeof item}`));
    }
    item.local_id = `q${position + 1}`;
    if (!Object.hasOwn(item, 'question_type')) {
      item.question_type = Object.hasOwn(item, 'questionType') ? item.questionType! : 'other';
    }
    if (!Object.hasOwn(item, 'original_label')) {
      item.original_label = Object.hasOwn(item, 'questionLabel') ? item.questionLabel! : `${position + 1}`;
    }
    delete item.questionType;
    delete item.questionLabel;
    delete item.question_label;
  });
  (raw as JsonObject).schema_version = 2;
  (raw as JsonObject).mode = 'extract';
}

function getOr(raw: JsonValue, key: string, fallback: JsonValue): JsonValue {
  return isObject(raw) && Object.hasOwn(raw, key) ? raw[key]! : fallback;
}

/** `prepare_document`。 */
export async function prepareDocument(host: ImportServiceHost, request: ImportRequest, progress: ProgressSink,
  trustedConfig: ApiConfig | null, run: ImportRun): Promise<ImportResult> {
  const qbankName = request.name ?? '导入的题目集';
  run.checkCancelled();
  send(progress, { type: 'Preprocessing', stage: 'preparing_sources', message: '正在准备完整来源...', percent: 2 });
  let preparedSession: string | null = null;
  let document: QuestionDocument;
  let metadata: JsonObject;
  let pages: PageSlice[];
  if (request.format === 'zip') {
    const imported = await qbankExport.importPackage(host.portable, request.content);
    document = imported.document;
    metadata = imported.metadata as JsonObject;
    pages = [];
  } else if (request.format === 'json') {
    let text: string;
    try {
      text = decodeTextContent(request.content);
    } catch {
      text = request.content;
    }
    let raw: JsonValue;
    try {
      raw = valueFromStr(text);
    } catch (error) {
      throw new QbankServiceError(AppError.validation(`JSON 解析失败: ${errorText(error)}`));
    }
    normalizeLegacyJson(raw);
    metadata = {
      sources: getOr(raw, 'sources', []),
      pages: getOr(raw, 'source_pages', []),
      source_format: 'json',
    };
    document = decodeDocument(raw, '题目 JSON 契约无效: ');
    validate(document);
    pages = [];
  } else {
    const originalBundle = await run.step(
      host.documents.loadSourceBundle(request.content, request.format, qbankName, run.cancel));
    const bundle = request.source_ranges.length === 0
      ? originalBundle : host.documents.scoped(originalBundle, request.source_ranges);
    run.checkCancelled();
    const config = trustedConfig ?? await run.step(host.documents.resolveAuthoringConfig(request.model_config_id));
    const legacy = legacyPages(bundle);
    const session = createImportSession(host, request, qbankName, legacy);
    const fingerprint = authoringConfigFingerprint(config);
    updateImportState(host, session, {
      schema_version: 2, source_bundle: bundleValue(bundle), model_config_id: config.id,
      model_fingerprint: fingerprint, qbank_name: qbankName,
    });
    send(progress, { type: 'SessionCreated', session_id: session, name: qbankName, total_chunks: 1 });
    preparedSession = session;
    send(progress, {
      type: 'Preprocessing', stage: 'understanding_document',
      message: `正在使用 ${config.name} 理解完整材料...`, percent: 25,
    });
    try {
      [document, metadata] = await run.step(host.documents.runDocument(bundle, config, run.cancel));
    } catch (error) {
      if (!run.cancelled) {
        // `let _ = update_import_state(...)`：记录失败原因，写入失败被忽略。
        try {
          host.exams.updateImportState(host.db, session, {
            schema_version: 2, source_bundle: bundleValue(bundle), model_config_id: config.id,
            model_fingerprint: fingerprint, qbank_name: qbankName, last_error: appErrorValue(toAppError(error)),
          });
        } catch { // boundary-allow empty-catch: question_import_service.rs:529 `let _ =` 显式忽略且 Rust 无日志
        }
      }
      rethrow(error);
    }
    pages = legacy;
  }
  if (document.questions.length === 0) {
    throw new QbankServiceError(AppError.validation('未提取到可作答题目，未创建正式内容'));
  }
  run.checkCancelled();
  const sessionId = preparedSession ?? createImportSession(host, request, qbankName, pages);
  const jobId = authoring.saveDraft(host.authoring, sessionId, document, metadata);
  const draft = authoring.getDraft(host.authoring, jobId);
  const draftJson = serializeDocument(document);
  // 旧 checkpoint 只保存版本化草稿指针；正式题目在用户显式确认前不创建。
  updateImportState(host, sessionId, { schema_version: 2, job_id: jobId });
  if (progress !== null) {
    send(progress, { type: 'SessionCreated', session_id: sessionId, name: qbankName, total_chunks: 1 });
    const questions = Array.isArray(draftJson.questions) ? draftJson.questions : [];
    questions.forEach((question, position) => {
      send(progress, { type: 'QuestionParsed', question, question_index: position, total_parsed: position + 1 });
    });
    send(progress, {
      type: 'Completed', session_id: sessionId, name: qbankName, total_questions: document.questions.length,
      partial: draft.status !== 'ready', failed_count: 0,
    });
  }
  let total = 0;
  try {
    total = host.questions.countQuestions(host.db, sessionId);
  } catch { // boundary-allow empty-catch: question_import_service.rs:595 `.unwrap_or(0)`，Rust 无日志
    total = 0;
  }
  return {
    session_id: sessionId, name: qbankName, imported_count: 0, total_questions: total,
    draft_job_id: jobId, draft_version: draft.version, draft_document: draftJson, model_route: metadata,
    committed: false,
  };
}

// ---------------------------------------------------------------------------
// resume_import（schema_version 2）

/** `resume_import` 的结果：v2 分支已处理，或交给旧版 checkpoint 恢复。 */
export type ResumeDispatch =
  | { readonly kind: 'done'; readonly result: ImportResult }
  | { readonly kind: 'legacy'; readonly stateStr: string };

/**
 * `resume_import`（741-821）：读取导入状态；schema_version 2 走草稿流程，
 * 其余（含 JSON 解析失败）交给旧版 checkpoint 状态机。
 */
export async function resumeV2(host: ImportServiceHost, sessionId: string, run: ImportRun): Promise<ResumeDispatch> {
  const stateStr = database(() => host.exams.getImportState(host.db, sessionId), '读取导入状态失败: ');
  if (stateStr === null) throw new QbankServiceError(AppError.not_found('未找到可恢复的导入状态'));
  const root = parseStateDocument(stateStr);
  // `if let Ok(state)` 失败或 `state["schema_version"] != 2` → 旧版 checkpoint。
  if (root === null || !isSchemaVersionTwo(root)) return { kind: 'legacy', stateStr };
  const state = nodeToValue(root);
  if (isObject(state) && Object.hasOwn(state, 'source_bundle')) {
    let bundle: SourceBundle;
    try {
      bundle = sourceBundle(state.source_bundle, '');
    } catch (error) {
      if (error instanceof SerdeDecodeError) throw new QbankServiceError(AppError.validation(error.message));
      throw error;
    }
    const config = await run.step(host.documents.resolveAuthoringConfig(asStr(index(state, 'model_config_id'))));
    if (asStr(index(state, 'model_fingerprint')) !== authoringConfigFingerprint(config)) {
      throw new QbankServiceError(AppError.configuration('恢复任务的模型配置已变化，请从原文件创建新解析任务'));
    }
    const [document, metadata] = await run.step(host.documents.runDocument(bundle, config, run.cancel));
    run.checkCancelled();
    const jobId = authoring.saveDraft(host.authoring, sessionId, document, metadata);
    const draft = authoring.getDraft(host.authoring, jobId);
    updateImportState(host, sessionId, { schema_version: 2, job_id: jobId });
    return {
      kind: 'done',
      result: {
        ...defaultResult(sessionId, asStr(index(state, 'qbank_name')) ?? '题目集'),
        draft_job_id: jobId, draft_version: draft.version, draft_document: serializeDocument(document),
        model_route: metadata,
      },
    };
  }
  const jobId = asStr(index(state, 'job_id'));
  if (jobId === null) throw new QbankServiceError(AppError.validation('草稿恢复状态缺少job_id'));
  const draft = authoring.getDraft(host.authoring, jobId);
  const sheet = database(() => host.exams.getExamSheet(host.db, sessionId));
  if (sheet === null) throw new QbankServiceError(AppError.not_found('目标题目集不存在'));
  return {
    kind: 'done',
    result: {
      ...defaultResult(sessionId, sheet.examName ?? ''),
      draft_job_id: jobId, draft_version: draft.version,
      draft_document: serializeDocument(draft.document), model_route: draft.metadata as JsonValue,
    },
  };
}

function parseStateDocument(stateStr: string): JsonNode | null {
  try {
    return parseJsonDocument(stateStr);
  } catch (error) {
    if (error instanceof JsonSyntaxError) return null;
    throw error;
  }
}

/**
 * `state["schema_version"] == 2`：`Value: PartialEq<i32>` 走 `as_i64`，只有整数 2 相等
 * （`2.0` / `2e0` 是 F64，不等）；重复键 last-wins；非对象根 → Null，不等。
 */
function isSchemaVersionTwo(root: JsonNode): boolean {
  if (root.kind !== 'object') return false;
  let version: JsonNode | undefined;
  for (const member of root.members) if (member.key === 'schema_version') version = member.value;
  if (version === undefined || version.kind !== 'number') return false;
  const number = version.value;
  // Value::as_i64：只有 u64/i64 的整数值 2 命中；f64 的 2.0/2e0 与 arbitrary 都不算。
  return (number.kind === 'u64' || number.kind === 'i64') && number.value === 2n;
}

// ---------------------------------------------------------------------------
// 命令层

/** `question_import_draft_response`（commands.rs:1069-1085）：`ExamSheetSessionDetail` flatten 后追加字段。 */
export async function draftResponse(sessions: ExamSheetSessionService, result: ImportResult):
  Promise<QuestionImportDraftResponse> {
  let detail;
  try {
    detail = await sessions.getExamSheetSessionDetail(result.session_id);
  } catch (error) {
    // L18 ExamSheetSessionError 携带 AppError 线缆值；Rust `?` 原样传播。
    if (error instanceof ExamSheetSessionError) throw new QbankServiceError(error.appError);
    rethrow(error);
  }
  return {
    ...detail,
    draft_job_id: result.draft_job_id,
    draft_version: result.draft_version,
    draft_document: result.draft_document,
    model_route: result.model_route,
    committed: result.committed,
  };
}

/** IPC `ImportQuestionBankRequest`（commands.rs:1011，全部可选字段 `#[serde(default)]`）→ `ImportRequest`。 */
export function importRequestOf(request: {
  content: string; format: string; name?: string | null; folder_id?: string | null; session_id?: string | null;
  model_config_id?: string | null; pdf_prefer_ocr?: boolean | null; source_ranges?: SourceRange[];
}): ImportRequest {
  return {
    content: request.content,
    format: request.format,
    name: request.name ?? null,
    session_id: request.session_id ?? null,
    folder_id: request.folder_id ?? null,
    model_config_id: request.model_config_id ?? null,
    pdf_prefer_ocr: request.pdf_prefer_ocr ?? null,
    source_ranges: request.source_ranges ?? [],
  };
}

