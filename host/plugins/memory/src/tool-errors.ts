/**
 * Tool failure localization — TS mirror of `dstu-core/src/tool_args.rs`
 * (`ensure_localized_error` / `with_localized_message`), used by the ported
 * chat_v2 tool executors.
 */

const MAX_ERROR_DETAIL_CHARS = 2000;

export interface LocalizedMessage {
  messageKey: string;
  messageParams: Record<string, unknown>;
  messageFallback: { 'zh-CN': string; 'en-US': string };
  message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function withLocalizedMessage(payload: Record<string, unknown>, messageKey: string,
  messageParams: Record<string, unknown>, zhCn: string, enUs: string): Record<string, unknown> {
  return {
    ...payload,
    messageKey,
    messageParams,
    messageFallback: { 'zh-CN': zhCn, 'en-US': enUs },
    message: `${zhCn} / ${enUs}`,
  };
}

function truncateErrorDetail(value: string): { detail: string; truncated: boolean } {
  const chars = Array.from(value);
  return chars.length <= MAX_ERROR_DETAIL_CHARS
    ? { detail: value, truncated: false }
    : { detail: chars.slice(0, MAX_ERROR_DETAIL_CHARS).join(''), truncated: true };
}

/** Rust `ensure_localized_error` (legacy JSON objects keep their message contract). */
export function ensureLocalizedError(error: string, defaultCode: string, messageKey: string,
  zhCn: string, enUs: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(error);
  } catch (failure) {
    void failure;
    parsed = null;
  }
  const legacyObject = isRecord(parsed);
  const payload: Record<string, unknown> = isRecord(parsed) ? { ...parsed } : {};
  if (payload['code'] === undefined) payload['code'] = defaultCode;
  if (!legacyObject) {
    const detail = truncateErrorDetail(error);
    payload['detail'] = detail.detail;
    payload['detailTruncated'] = detail.truncated;
  }
  if (payload['retryable'] === undefined) payload['retryable'] = false;
  const actualCode = payload['code'] ?? defaultCode;
  const hasContract = typeof payload['messageKey'] === 'string'
    && isRecord(payload['messageParams']) && isRecord(payload['messageFallback'])
    && typeof payload['message'] === 'string';
  if (hasContract) {
    const params = payload['messageParams'] as Record<string, unknown>;
    payload['messageParams'] = { ...params, code: actualCode };
    return JSON.stringify(payload);
  }
  return JSON.stringify(withLocalizedMessage(payload, messageKey, { code: actualCode }, zhCn, enUs));
}
