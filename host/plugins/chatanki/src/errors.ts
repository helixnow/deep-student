// Rust: chatanki_executor.rs:11883–11960 error key humanization.

// ============================================================================
// Errors (chatanki_executor.rs:11883–11960)
// ============================================================================

const CHATANKI_ERROR_PREFIX = 'blocks.ankiCards.errors.';

const CHATANKI_ERROR_MESSAGES: Record<string, string> = {
  addArgsRequired: 'adding cards requires a documentId and 1-100 cards in the request',
  ankiConnectUnavailable: 'AnkiConnect is unavailable; ask the user to open Anki with the AnkiConnect add-on enabled, then retry',
  ankiSyncEmpty: 'no cards were imported into Anki; check that Anki is running, the note type exists, and card fields are non-empty',
  cardContentRequired: 'each card must have a non-empty front/back or non-empty cloze text',
  contextRefInvalid: 'the attachment reference is invalid; remove and re-add the attachment before retrying',
  databaseUnavailable: 'the card database is currently unavailable; wait and retry later instead of repeating immediately',
  documentIdRequired: 'missing documentId; supply the card-generation document id',
  generationFailed: 'card generation failed with no usable cards produced; check the model configuration or the error details',
  missingClozeNoteType: 'Anki is missing the Cloze note type; ask the user to create it in Anki first',
  noContent: 'no content available for card generation; provide text or upload a file first',
  pipelineTimeout: 'generation took too long and automatic updates stopped; query later with chatanki_status or regenerate',
  retemplateSelectorRequired: 'retemplate requires exactly one of documentId or cardIds',
  reviewSelectorRequired: 'enqueueing a review requires exactly one of documentId or cardIds',
  startFailed: 'failed to start card generation; retry or adjust the template/settings',
  statusNotFound: 'no live card task found for the given id under this session; the id may be wrong, or the content was created in a different card-making session (session-scoped tools cannot touch other sessions\' documents). Do not retry the same id: for cross-session changes call chatanki_list_library_cards to locate the card (cardId + content version), then use the chatanki_*_library_card tools (update/delete/enqueue/set_suspended/undo), pass libraryCardIds to chatanki_sync/chatanki_export, or ask the user to edit it in the flashcards app library',
  templateDatabaseUnavailable: 'the template database is currently unavailable; retry later',
  templateLoadFailed: 'failed to load the template; retry or re-import the template',
  templateNotFound: 'template not found; choose another template or import it first',
  updateArgsRequired: 'updating a card requires cardId, expectedVersion and at least one modified field',
  waitInvalidArgs: 'chatanki_wait requires ankiBlockId or documentId',
  waitNotFound: 'no card block found yet; wait a moment or call chatanki_status with the documentId',
  waitTimeout: 'waiting timed out; query later with chatanki_status or retry with a longer timeout',
};

export type AnkiConnectErrorCode =
  | 'anki_connect_version_unsupported'
  | 'anki_connect_offline'
  | 'anki_connect_timeout'
  | 'anki_connect_connection_closed'
  | 'anki_connect_http_error'
  | 'anki_connect_model_mismatch'
  | 'anki_connect_model_error'
  | 'anki_connect_protocol_error'
  | 'anki_connect_unavailable';

export interface AnkiConnectErrorInfo {
  code: AnkiConnectErrorCode;
  message: string;
  retryable: boolean;
  detectedVersion?: number;
  requiredVersion?: number;
}

const CJK_CHAR_RE = /[\u3400-\u9fff\uf900-\ufaff]/;

function stripChineseDetail(detail: string): string {
  const cleaned = detail
    .replace(/\s*-\s*内容:\s*无法读取错误内容/g, ' (unreadable response body)')
    .replace(/\s*-\s*内容:\s*/g, ' - ')
    .replace(/\s*-\s*响应内容:\s*/g, ' - response: ')
    .replace(/（已重试\s*(\d+)\s*次）/g, ' (retried $1 time(s))')
    .trim();
  return cleaned;
}

/**
 * Classifies raw L16 AnkiConnect errors (which may contain Chinese copy or raw OS
 * errors like `Connection refused (os error 111)`) into locale-neutral, actionable
 * English diagnostics with machine-readable error codes.
 */
export function classifyAnkiConnectError(rawError: string): AnkiConnectErrorInfo {
  const text = rawError.trim();
  const lower = text.toLowerCase();

  // 1. Model verification wrapper (`无法核对 Anki 模型，发送尚未开始: <inner>`).
  const verifyModelMatch = text.match(/^无法核对\s*Anki\s*模型[，,]发送尚未开始\s*[:：]\s*(.+)$/s);
  if (verifyModelMatch !== null) {
    const innerRaw = verifyModelMatch[1]!.trim();
    const inner = classifyAnkiConnectError(innerRaw);
    if (
      inner.code === 'anki_connect_version_unsupported'
      || inner.code === 'anki_connect_offline'
      || inner.code === 'anki_connect_timeout'
      || inner.code === 'anki_connect_connection_closed'
    ) {
      return inner;
    }
    const cleanInner = CJK_CHAR_RE.test(innerRaw) ? inner.message : innerRaw;
    return {
      code: 'anki_connect_model_error',
      retryable: inner.retryable,
      message: `[anki_connect_model_error] Failed to verify Anki note models before syncing: ${cleanInner}`,
    };
  }

  // 2. API version mismatch (e.g. AnkiConnect v5 < v6).
  const versionMatch =
    text.match(/API\s*v(\d+)\s*[，,]\s*需要\s*[≥>=]+\s*v(\d+)/i)
    ?? text.match(/AnkiConnect\s+API\s*v(\d+)\s+is\s+(?:too\s+old|unsupported).*?v(\d+)/i)
    ?? text.match(/version\s+v?(\d+)\s+(?:is\s+)?(?:too\s+old|unsupported).*?v?(\d+)/i);
  if (versionMatch !== null || text.includes('AnkiConnect 插件版本过旧') || lower.includes('anki_connect_version_unsupported')) {
    const detectedVersion = versionMatch !== null ? Number.parseInt(versionMatch[1]!, 10) : 5;
    const requiredVersion = versionMatch !== null ? Number.parseInt(versionMatch[2]!, 10) : 6;
    return {
      code: 'anki_connect_version_unsupported',
      retryable: false,
      detectedVersion,
      requiredVersion,
      message: `[anki_connect_version_unsupported] AnkiConnect API v${detectedVersion} is unsupported (requires >= v${requiredVersion}). `
        + 'Ask the user to update the AnkiConnect add-on (code 2055492159) in Anki and restart Anki before retrying; '
        + 'do not bypass this check via shell or direct HTTP calls.',
    };
  }

  // 3. Timeout.
  if (
    text.includes('连接超时')
    || text.includes('请求超时')
    || lower.includes('operation timed out')
    || lower.includes('timed out')
    || lower.includes('etimedout')
    || lower.includes('anki_connect_timeout')
  ) {
    return {
      code: 'anki_connect_timeout',
      retryable: true,
      message: '[anki_connect_timeout] AnkiConnect request timed out on 127.0.0.1:8765. '
        + 'Ask the user to confirm Anki is responsive and not blocked by a modal dialog, then retry.',
    };
  }

  // 4. Connection closed unexpectedly.
  if (
    text.includes('连接被AnkiConnect服务器关闭')
    || lower.includes('connection closed')
    || lower.includes('anki_connect_connection_closed')
  ) {
    return {
      code: 'anki_connect_connection_closed',
      retryable: true,
      message: '[anki_connect_connection_closed] AnkiConnect closed the connection unexpectedly. '
        + 'Ask the user to ensure AnkiConnect (>= v6) is installed and restart Anki, then retry.',
    };
  }

  // 5. Offline / port 8765 unreachable / connection refused.
  if (
    text.includes('端口8765无法访问')
    || text.includes('无法连接到AnkiConnect')
    || text.includes('无法连接 AnkiConnect')
    || lower.includes('connection refused')
    || lower.includes('econnrefused')
    || lower.includes('no route to host')
    || lower.includes('network is unreachable')
    || lower.includes('ehostunreach')
    || lower.includes('enetunreach')
    || lower.includes('anki_connect_offline')
  ) {
    return {
      code: 'anki_connect_offline',
      retryable: true,
      message: '[anki_connect_offline] AnkiConnect is offline or unreachable on 127.0.0.1:8765. '
        + 'Ask the user to open Anki desktop, confirm the AnkiConnect add-on (code 2055492159) is installed and enabled, '
        + 'and ensure port 8765 is available, then retry.',
    };
  }

  // 6. HTTP error.
  const httpMatch = text.match(/^AnkiConnect\s*HTTP错误(?:\(([^)]+)\))?\s*:\s*(.+)$/s);
  if (httpMatch !== null) {
    const action = httpMatch[1]?.trim();
    const detail = stripChineseDetail(httpMatch[2]!);
    const scope = action ? ` for ${action}` : '';
    const suffix = !CJK_CHAR_RE.test(detail) && detail.length > 0 ? `: ${detail}` : '';
    return {
      code: 'anki_connect_http_error',
      retryable: true,
      message: `[anki_connect_http_error] AnkiConnect returned an HTTP error${scope}${suffix}. Verify AnkiConnect is running properly and retry.`,
    };
  }

  // 7. Template/model mismatch or field-read errors.
  const mismatchMatch = text.match(/^Anki 模型「([^」]+)」与本地模板/);
  if (mismatchMatch !== null) {
    return {
      code: 'anki_connect_model_mismatch',
      retryable: false,
      message: `[anki_connect_model_mismatch] Anki model "${mismatchMatch[1]}" differs from the local template fields, card templates, or CSS. `
        + 'Create a new template version or duplicate the template before syncing; the existing Anki model was not modified.',
    };
  }
  const modelFieldMatch = text.match(/^无法读取 Anki 模型「([^」]+)」的字段/);
  if (modelFieldMatch !== null) {
    return {
      code: 'anki_connect_model_error',
      retryable: true,
      message: `[anki_connect_model_error] Failed to read fields for Anki model "${modelFieldMatch[1]}" before syncing.`,
    };
  }
  if (
    text.includes('Anki 模型名称不能为空')
    || text.includes('模板未配置字段')
    || text.includes('模板缺少正面/背面 HTML')
  ) {
    return {
      code: 'anki_connect_model_error',
      retryable: false,
      message: '[anki_connect_model_error] Local template definition is incomplete (missing model name, fields, or front/back HTML) and cannot create an Anki model.',
    };
  }

  // 8. AnkiConnect protocol / response errors.
  const apiErrorMatch = text.match(/^AnkiConnect错误(?:\(([^)]+)\))?\s*:\s*(.+)$/s);
  if (apiErrorMatch !== null) {
    const action = apiErrorMatch[1]?.trim();
    const detail = stripChineseDetail(apiErrorMatch[2]!);
    const scope = action ? ` (${action})` : '';
    const detailText = !CJK_CHAR_RE.test(detail) && detail.length > 0 ? detail : 'unexpected AnkiConnect error';
    return {
      code: 'anki_connect_protocol_error',
      retryable: false,
      message: `[anki_connect_protocol_error] AnkiConnect error${scope}: ${detailText}`,
    };
  }
  const parseMatch = text.match(/^(?:解析AnkiConnect响应失败|读取响应内容失败|AnkiConnect连接失败|AnkiConnect 请求失败|请求牌组列表失败|请求笔记类型列表失败|获取模型字段失败)(?:\(([^)]+)\))?\s*:\s*(.+)$/s);
  if (parseMatch !== null) {
    const action = parseMatch[1]?.trim();
    const detail = stripChineseDetail(parseMatch[2]!);
    const scope = action ? ` (${action})` : '';
    const suffix = !CJK_CHAR_RE.test(detail) && detail.length > 0 ? `: ${detail}` : '';
    return {
      code: 'anki_connect_protocol_error',
      retryable: true,
      message: `[anki_connect_protocol_error] Failed to communicate with AnkiConnect${scope}${suffix}. Verify AnkiConnect is running and retry.`,
    };
  }
  if (text.includes('AnkiConnect返回空结果')) {
    return {
      code: 'anki_connect_protocol_error',
      retryable: true,
      message: '[anki_connect_protocol_error] AnkiConnect returned an empty result. Verify AnkiConnect (>= v6) is healthy and retry.',
    };
  }

  // 9. Fallback: preserve clean non-CJK error details; replace any unexpected CJK strings.
  if (text.length === 0 || CJK_CHAR_RE.test(text)) {
    return {
      code: 'anki_connect_unavailable',
      retryable: true,
      message: '[anki_connect_unavailable] AnkiConnect is unavailable. Ask the user to open Anki desktop with AnkiConnect (>= v6) enabled and retry.',
    };
  }
  return {
    code: 'anki_connect_unavailable',
    retryable: true,
    message: text.startsWith('[anki_connect_') ? text : `[anki_connect_unavailable] ${text}`,
  };
}

/** 保留 i18n key，追加 LLM 可读描述与修复建议（幂等，避免重复拼接）。 */
export function humanizeChatAnkiError(error: string): string {
  if (!error.startsWith(CHATANKI_ERROR_PREFIX)) return error;
  const rest = error.slice(CHATANKI_ERROR_PREFIX.length);
  if (rest.includes(': ')) return error;
  const message = CHATANKI_ERROR_MESSAGES[rest] ?? 'unrecognized chatanki error code';
  return `${CHATANKI_ERROR_PREFIX}${rest}: ${message}`;
}
