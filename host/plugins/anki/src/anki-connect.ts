/**
 * AnkiConnect 客户端（`dstu-anki/src/anki_connect_service.rs:307-567,1590-1684`）。
 * 只依赖 Node 内建 fetch；错误文案与 Rust 逐字一致。
 */
import { canonicalReason } from '../../../platform/util/portable.ts';
import type { AnkiLogger } from './logger.ts';
import { ankiLocalRuntime } from './local-runtime.ts';
import {
  SerdeJsonError,
  jsonNodeAsU64,
  jsonNodeToJs,
  parseAnkiConnectResponseBytes,
  parseAnkiConnectResponseText,
  stringArrayFromNode,
  type JsonNode,
} from './serde-json.ts';

export const ANKI_CONNECT_URL = 'http://127.0.0.1:8765';
export const ANKI_CONNECT_MIN_VERSION = 6n;

interface AnkiRequest {
  action: string;
  version: number;
  params?: unknown;
}

interface AnkiResponse {
  result: JsonNode | null;
  error: string | null;
}

/** reqwest `Response::text()`：UTF-8 宽松解码（非法字节替换为 U+FFFD）。 */
function decodeUtf8Lossy(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

/** `response.json::<AnkiConnectResponse>()`：严格 UTF-8 + reqwest Decode 前缀。 */
function parseResponseJson(bytes: Uint8Array): AnkiResponse {
  try {
    return parseAnkiConnectResponseBytes(bytes);
  } catch (error) {
    if (error instanceof SerdeJsonError) {
      throw new Error(`error decoding response body: ${error.message}`);
    }
    throw error;
  }
}

/** `serde_json::from_str::<AnkiConnectResponse>`：version 路径，无 reqwest 前缀。 */
function parseResponseText(text: string): AnkiResponse {
  return parseAnkiConnectResponseText(text);
}

/** serde `Value` 的 Debug（version 非数字告警日志）。 */
function debugValue(node: JsonNode): string {
  switch (node.kind) {
    case 'null': return 'Null';
    case 'boolean': return `Bool(${node.value})`;
    case 'string': return `String(${JSON.stringify(node.value)})`;
    case 'number': return `Number(${node.raw})`;
    case 'array': return `Array [${node.items.map(debugValue).join(', ')}]`;
    case 'object': return `Object {${node.entries.map(([key, value]) => `${JSON.stringify(key)}: ${debugValue(value)}`).join(', ')}}`;
  }
}

function debugJsonNode(node: JsonNode | null): string {
  return node === null ? 'None' : `Some(${debugValue(node)})`;
}

/** `anki_connect_service.rs:384-401`：版本协商与旧版本错误文案。 */
export function evaluateVersionResponse(parsed: AnkiResponse, logger?: AnkiLogger): true {
  if (parsed.error !== null) throw new Error(`AnkiConnect错误: ${parsed.error}`);
  const version = jsonNodeAsU64(parsed.result);
  if (version !== null) {
    if (version < ANKI_CONNECT_MIN_VERSION) {
      throw new Error(`AnkiConnect 插件版本过旧（API v${version}，需要 ≥ v${ANKI_CONNECT_MIN_VERSION}）。请在 Anki 中更新 AnkiConnect 插件（代码：2055492159）后重试`);
    }
    return true;
  }
  // 非数字结果：兼容极旧/魔改版本，放行（Rust 记录 warn）。
  logger?.warn(`⚠️ AnkiConnect version 返回非数字结果，跳过版本协商: ${debugJsonNode(parsed.result)}`);
  return true;
}

/** reqwest `Error::is_timeout` / `is_connect` / `is_request` 的近似判定。 */
function classifyFetchError(error: unknown): 'timeout' | 'connect' | 'request' | 'other' {
  const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause;
  const code = typeof cause?.code === 'string' ? cause.code : undefined;
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return 'timeout';
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'EAI_AGAIN') return 'connect';
  if (code !== undefined) return 'request';
  return error instanceof TypeError ? 'request' : 'other';
}

/** Rust `response.status()` 的 Display（`200 OK`、`404 Not Found`）。 */
export function statusText(status: number): string {
  return `${status} ${canonicalReason(status) ?? ''}`.trim();
}

function isSuccess(status: number): boolean {
  return status >= 200 && status <= 299;
}

/** Rust `TcpStream::connect_timeout(127.0.0.1:8765, 5s)` 的等价检查（经本地运行时端口的 `node:net`）。 */
function probePort(host: string, port: number, timeoutMs: number): Promise<Error | null> {
  return ankiLocalRuntime().probeTcp(host, port, timeoutMs)
    .then((error) => (error === null ? null : Object.assign(new Error(error.message), error)));
}

/** `std::io::Error` 的 Display（macOS/Linux：`Connection refused (os error 61)`）。 */
function ioDisplay(error: { readonly code?: string; readonly errno?: unknown; readonly message: string }): string {
  const strerror: Record<string, string> = {
    ECONNREFUSED: 'Connection refused', ETIMEDOUT: 'Operation timed out',
    EHOSTUNREACH: 'No route to host', ENETUNREACH: 'Network is unreachable',
  };
  const text = error.code !== undefined ? strerror[error.code] : undefined;
  if (text !== undefined && typeof error.errno === 'number') return `${text} (os error ${Math.abs(error.errno)})`;
  return error.message;
}

/**
 * reqwest `Kind::Body` 的 Display（`bytes()`/`text()`/`json()` 读取响应体失败）：
 * `request or response body error: <source>`；总超时到期时 source 为 `operation timed out`。
 */
function bodyErrorText(error: unknown): string {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return 'request or response body error: operation timed out';
  }
  const cause = (error as { cause?: unknown } | undefined)?.cause;
  const source = cause instanceof Error ? cause.message : error instanceof Error ? error.message : String(error);
  return `request or response body error: ${source}`;
}

/** reqwest `Response`：`send()` 只到响应头为止，响应体在调用方的 text/json 阶段再读。 */
interface AnkiHttpResponse {
  status: number;
  /** 读取失败时抛 `request or response body error: …`。 */
  body(): Promise<Uint8Array>;
}

async function postAnkiWithStatus(request: AnkiRequest, timeoutMs: number): Promise<AnkiHttpResponse> {
  const response = await fetch(ANKI_CONNECT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'DeepStudent/1.0' },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return {
    status: response.status,
    body: async () => {
      try {
        return new Uint8Array(await response.arrayBuffer());
      } catch (error) {
        throw new Error(bodyErrorText(error));
      }
    },
  };
}

/** `response.json::<AnkiConnectResponse>()`：读体失败（Body）与解码失败（Decode）都在这一步。 */
async function readResponseJson(response: AnkiHttpResponse): Promise<AnkiResponse> {
  return parseResponseJson(await response.body());
}

/** `check_anki_connect_availability`（`anki_connect_service.rs:308-437`）。 */
export async function checkAnkiConnectAvailability(logger?: AnkiLogger): Promise<boolean> {
  const portError = await probePort('127.0.0.1', 8765, 5000);
  if (portError !== null) {
    logger?.warn(`❌ 端口8765无法访问: ${ioDisplay(portError)}`);
    throw new Error(
      `端口8765无法访问: ${ioDisplay(portError)} \n\n这通常意味着：\n1. Anki桌面程序未运行\n2. AnkiConnect插件未安装或未启用\n3. 端口被其他程序占用\n\n解决方法：\n1. 启动Anki桌面程序\n2. 安装AnkiConnect插件（代码：2055492159）\n3. 重启Anki以激活插件`,
    );
  }

  // GET 探测失败仅告警，继续 POST 版本检测（Rust 行为）。
  try {
    await fetch(ANKI_CONNECT_URL, { signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    if (!(error instanceof TypeError || (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')))) throw error;
    logger?.debug(`⚠️ AnkiConnect GET 探测失败（忽略，继续版本检测）: ${(error as Error).message}`);
  }

  const request: AnkiRequest = { action: 'version', version: 6 };
  let response: AnkiHttpResponse;
  try {
    response = await postAnkiWithStatus(request, 15_000);
  } catch (error) {
    logger?.warn(`❌ AnkiConnect连接错误详情: ${error instanceof Error ? error.message : String(error)}`);
    const kind = classifyFetchError(error);
    if (kind === 'timeout') throw new Error('AnkiConnect连接超时，请确保Anki桌面程序正在运行并启用了AnkiConnect插件');
    if (kind === 'connect') throw new Error('无法连接到AnkiConnect服务器，请确保：1)Anki正在运行 2)AnkiConnect插件已安装并启用 3)端口8765未被占用');
    const text = error instanceof Error ? error.message : String(error);
    if (text.includes('connection closed')) throw new Error('连接被AnkiConnect服务器关闭，可能原因：1)AnkiConnect版本过旧 2)请求格式不兼容 3)需要重启Anki');
    throw new Error(`AnkiConnect连接失败: ${text}`);
  }

  if (!isSuccess(response.status)) {
    let errorText: string;
    try {
      errorText = decodeUtf8Lossy(await response.body());
    } catch {
      errorText = '无法读取错误内容';
    }
    throw new Error(`AnkiConnect HTTP错误: ${statusText(response.status)} - 内容: ${errorText}`);
  }
  let text: string;
  try {
    text = decodeUtf8Lossy(await response.body());
  } catch (error) {
    throw new Error(`读取响应内容失败: ${(error as Error).message}`);
  }
  let parsed: AnkiResponse;
  try {
    parsed = parseResponseText(text);
  } catch (error) {
    throw new Error(`解析AnkiConnect响应失败: ${(error as Error).message} - 响应内容: ${text}`);
  }
  return evaluateVersionResponse(parsed, logger);
}

/** `get_deck_names`（`anki_connect_service.rs:439-479`）。 */
export async function getDeckNames(): Promise<string[]> {
  return invokeListAction('deckNames', null, '牌组列表', '请求牌组列表失败');
}

/** `get_model_names`（`anki_connect_service.rs:481-521`）。 */
export async function getModelNames(): Promise<string[]> {
  return invokeListAction('modelNames', null, '笔记类型列表', '请求笔记类型列表失败');
}

async function invokeListAction(action: string, params: unknown, label: string, requestFailurePrefix: string): Promise<string[]> {
  const request: AnkiRequest = { action, version: 6, ...(params === null ? {} : { params }) };
  let response: AnkiHttpResponse;
  try {
    response = await postAnkiWithStatus(request, 5000);
  } catch (error) {
    throw new Error(`${requestFailurePrefix}: ${(error as Error).message}`);
  }
  if (!isSuccess(response.status)) throw new Error(`AnkiConnect HTTP错误: ${statusText(response.status)}`);
  let parsed: AnkiResponse;
  try {
    parsed = await readResponseJson(response);
  } catch (error) {
    throw new Error(`解析AnkiConnect响应失败: ${(error as Error).message}`);
  }
  if (parsed.error !== null) throw new Error(`AnkiConnect错误: ${parsed.error}`);
  if (parsed.result === null) throw new Error('AnkiConnect返回空结果');
  try {
    return stringArrayFromNode(parsed.result);
  } catch (error) {
    throw new Error(`解析${label}失败: ${(error as Error).message}`);
  }
}

/** `create_deck_if_not_exists`（`anki_connect_service.rs:1590-1634`）。 */
export async function createDeckIfNotExists(deckName: string): Promise<void> {
  const request: AnkiRequest = { action: 'createDeck', version: 6, params: { deck: deckName } };
  let response: AnkiHttpResponse;
  try {
    response = await postAnkiWithStatus(request, 10_000);
  } catch (error) {
    throw new Error(`创建牌组失败: ${(error as Error).message}`);
  }
  if (!isSuccess(response.status)) throw new Error(`AnkiConnect HTTP错误: ${statusText(response.status)}`);
  let parsed: AnkiResponse;
  try {
    parsed = await readResponseJson(response);
  } catch (error) {
    throw new Error(`解析AnkiConnect响应失败: ${(error as Error).message}`);
  }
  if (parsed.error !== null && !parsed.error.includes('already exists')) {
    throw new Error(`创建牌组时出错: ${parsed.error}`);
  }
}

/** `import_apkg`（`anki_connect_service.rs:1636-1684`）。 */
export async function importApkg(path: string, logger?: AnkiLogger): Promise<boolean> {
  if (!path.trim()) throw new Error('APKG 路径不能为空');
  await checkAnkiConnectAvailability(logger);
  const request: AnkiRequest = { action: 'importPackage', version: 6, params: { path } };
  let response: AnkiHttpResponse;
  try {
    response = await postAnkiWithStatus(request, 60_000);
  } catch (error) {
    throw new Error(`请求AnkiConnect导入失败: ${(error as Error).message}`);
  }
  if (!isSuccess(response.status)) throw new Error(`AnkiConnect HTTP错误: ${statusText(response.status)}`);
  let parsed: AnkiResponse;
  try {
    parsed = await readResponseJson(response);
  } catch (error) {
    throw new Error(`解析AnkiConnect响应失败: ${(error as Error).message}`);
  }
  if (parsed.error !== null) throw new Error(`导入APKG失败: ${parsed.error}`);
  return true;
}

// ---------------------------------------------------------------- 通用 action（重试）

/** `AnkiConnectMediaMode`（`anki_connect_service.rs:24-45`）。 */
export type AnkiConnectMediaMode = 'upload_media' | 'inline_base64' | 'skip';

/** `AnkiConnectMediaMode::parse`。 */
export function parseMediaMode(raw: string): AnkiConnectMediaMode {
  const value = raw.trim().toLowerCase();
  if (value === 'skip') return 'skip';
  if (value === 'inline_base64' || value === 'inline-base64' || value === 'inline') return 'inline_base64';
  return 'upload_media';
}

export const ANKI_CONNECT_DEFAULT_BATCH_SIZE = 50;
export const ANKI_CONNECT_MAX_BATCH_SIZE = 500;
export const ANKI_CONNECT_DEFAULT_RETRY_TIMES = 1;

/** 同步可调参数（`anki_connect_service.rs:49-120`）。 */
export interface AnkiConnectSyncOptions {
  batchSize: number;
  retryTimes: number;
  mediaMode: AnkiConnectMediaMode;
}

export function defaultSyncOptions(): AnkiConnectSyncOptions {
  return {
    batchSize: ANKI_CONNECT_DEFAULT_BATCH_SIZE,
    retryTimes: ANKI_CONNECT_DEFAULT_RETRY_TIMES,
    mediaMode: 'upload_media',
  };
}

/** `AnkiConnectSyncOptions::sanitize`。 */
export function sanitizeSyncOptions(options: AnkiConnectSyncOptions): AnkiConnectSyncOptions {
  const batchSize = options.batchSize === 0
    ? ANKI_CONNECT_DEFAULT_BATCH_SIZE
    : Math.min(options.batchSize, ANKI_CONNECT_MAX_BATCH_SIZE);
  return { ...options, batchSize };
}

/** `AnkiConnectSyncOptions::from_setting_strings`。 */
export function syncOptionsFromSettings(
  batchSize: string | null,
  retryTimes: string | null,
  mediaMode: string | null,
): AnkiConnectSyncOptions {
  const parsedBatch = batchSize === null ? null : Number.parseInt(batchSize.trim(), 10);
  const batch = parsedBatch !== null && Number.isFinite(parsedBatch) && parsedBatch > 0
    ? parsedBatch : ANKI_CONNECT_DEFAULT_BATCH_SIZE;
  const parsedRetry = retryTimes === null ? null : /^\d+$/.test(retryTimes.trim()) ? Number(retryTimes.trim()) : null;
  const retry = parsedRetry !== null && parsedRetry <= 0xffff_ffff ? parsedRetry : ANKI_CONNECT_DEFAULT_RETRY_TIMES;
  return sanitizeSyncOptions({
    batchSize: batch,
    retryTimes: retry,
    mediaMode: mediaMode === null ? 'upload_media' : parseMediaMode(mediaMode),
  });
}

/** `retry_backoff_ms`。 */
export function retryBackoffMs(retryIndex: number): number {
  if (retryIndex === 0) return 500;
  if (retryIndex === 1) return 1000;
  return 2000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `invoke_anki_connect_action`（`anki_connect_service.rs:634-726`）。
 * 只有网络类失败（超时/连接失败/HTTP 错误/响应解析失败）重试；
 * AnkiConnect 业务错误直接返回。
 */
export async function invokeAnkiConnectAction(
  action: string,
  params: unknown,
  timeoutSecs: number,
  retryTimes: number,
): Promise<unknown> {
  const request: AnkiRequest = params === null || params === undefined
    ? { action, version: 6 }
    : { action, version: 6, params };
  const attempts = Math.min(retryTimes + 1, Number.MAX_SAFE_INTEGER);
  let lastError = `AnkiConnect 请求失败(${action})`;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(retryBackoffMs(attempt - 1));

    let response: Response;
    try {
      response = await fetch(ANKI_CONNECT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(timeoutSecs * 1000),
      });
    } catch (error) {
      const kind = classifyFetchError(error);
      lastError = kind === 'timeout'
        ? `AnkiConnect 请求超时(${action}): 请确认 Anki 正在运行且未被弹窗阻塞`
        : kind === 'connect'
          ? `无法连接 AnkiConnect(${action}): 请确认 Anki 已启动并安装了 AnkiConnect 插件`
          : `AnkiConnect 请求失败(${action}): ${error instanceof Error ? error.message : String(error)}`;
      if (kind !== 'timeout' && kind !== 'connect' && kind !== 'request') return Promise.reject(new Error(lastError));
      continue;
    }

    if (!isSuccess(response.status)) {
      lastError = `AnkiConnect HTTP错误(${action}): ${statusText(response.status)}`;
      continue;
    }

    let parsed: AnkiResponse;
    try {
      parsed = parseResponseJson(new Uint8Array(await response.arrayBuffer().catch((error: unknown) => {
        throw new Error(bodyErrorText(error));
      })));
    } catch (error) {
      lastError = `解析AnkiConnect响应失败(${action}): ${(error as Error).message}`;
      continue;
    }
    if (parsed.error !== null) throw new Error(`AnkiConnect错误(${action}): ${parsed.error}`);
    return parsed.result === null ? null : jsonNodeToJs(parsed.result);
  }

  throw new Error(retryTimes > 0 ? `${lastError}（已重试 ${retryTimes} 次）` : lastError);
}

/** `get_model_field_names`（`anki_connect_service.rs:524-567`）。 */
export async function getModelFieldNames(modelName: string): Promise<string[]> {
  let response: AnkiHttpResponse;
  try {
    response = await postAnkiWithStatus(
      { action: 'modelFieldNames', version: 6, params: { modelName } },
      10_000,
    );
  } catch (error) {
    throw new Error(`获取模型字段失败: ${(error as Error).message}`);
  }
  if (!isSuccess(response.status)) throw new Error(`AnkiConnect HTTP错误: ${statusText(response.status)}`);
  let parsed: AnkiResponse;
  try {
    parsed = await readResponseJson(response);
  } catch (error) {
    throw new Error(`解析AnkiConnect响应失败: ${(error as Error).message}`);
  }
  if (parsed.error !== null) throw new Error(`获取模型字段失败: ${parsed.error}`);
  if (parsed.result === null) throw new Error('AnkiConnect返回空结果');
  try {
    return stringArrayFromNode(parsed.result);
  } catch (error) {
    throw new Error(`解析模型字段失败: ${(error as Error).message}`);
  }
}
