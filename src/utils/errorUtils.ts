/**
 * 通用错误处理工具函数
 * 解决前端显示 [object Object] 的问题
 */

import i18n from '../i18n';

export interface StructuredErrorDetails {
  code?: string;
  message?: string;
  detail?: string;
  hint?: string;
  messageKey?: string;
}

export interface UserFacingErrorOptions {
  includeDetails?: boolean;
  includeHint?: boolean;
}

/**
 * 将任意错误对象转换为可读的错误消息字符串
 * @param error 错误对象
 * @returns 格式化的错误消息
 */
export const getErrorMessage = (error: unknown): string => {
  const details = getErrorDetails(error);
  if (details.message || details.detail || details.code) {
    return sanitizeErrorMessage(details.message ?? details.detail ?? details.code ?? '');
  }

  if (error === null || error === undefined) {
    return i18n.t('common:utils.errors.unknown_error_occurred', {
      defaultValue: 'An unknown error occurred',
    });
  }

  try {
    const stringified = JSON.stringify(error);
    if (!stringified || stringified === '{}') {
      return i18n.t('common:utils.errors.unknown_error_occurred', {
        defaultValue: 'An unknown error occurred',
      });
    }
    return sanitizeErrorMessage(stringified);
  } catch {
    return i18n.t('common:utils.errors.unserializable_error', {
      defaultValue: 'An unserializable error occurred',
    });
  }
};

/**
 * 提取后端结构化错误详情。
 * Tauri invoke 失败通常把 JSON 放在 Error.message 中，部分命令则直接返回错误对象。
 */
export const getErrorDetails = (error: unknown): StructuredErrorDetails => {
  const raw = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : undefined;

  if (raw) {
    const parsed = parseStructuredError(raw);
    if (parsed) return parsed;
    return { message: raw };
  }

  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const nested = typeof record.error === 'string'
      ? parseStructuredError(record.error)
      : record.error && typeof record.error === 'object'
        ? getErrorDetails(record.error)
        : undefined;
    const message = typeof record.message === 'string' ? record.message : undefined;
    const detail = typeof record.detail === 'string' ? record.detail : undefined;
    const code = typeof record.code === 'string'
      ? record.code
      : typeof record.errorCode === 'string'
        ? record.errorCode
        : undefined;
    const hint = typeof record.hint === 'string' ? record.hint : undefined;
    const messageKey = typeof record.message_key === 'string'
      ? record.message_key
      : typeof record.messageKey === 'string'
        ? record.messageKey
        : undefined;

    return {
      code: code ?? nested?.code,
      message: message ?? nested?.message,
      detail: detail ?? nested?.detail,
      hint: hint ?? nested?.hint,
      messageKey: messageKey ?? nested?.messageKey,
    };
  }

  return {};
};

function parseStructuredError(raw: string): StructuredErrorDetails | null {
  const text = raw.trim();
  if (!text.startsWith('{') || !text.endsWith('}')) return null;

  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const nested = parsed.error && typeof parsed.error === 'object'
      ? parsed.error as Record<string, unknown>
      : undefined;
    const message = typeof parsed.message === 'string'
      ? parsed.message
      : typeof parsed.detail === 'string'
        ? parsed.detail
        : typeof parsed.error === 'string'
          ? parsed.error
          : undefined;
    const code = typeof parsed.code === 'string'
      ? parsed.code
      : typeof parsed.errorCode === 'string'
        ? parsed.errorCode
        : undefined;
    const hint = typeof parsed.hint === 'string' ? parsed.hint : undefined;
    const messageKey = typeof parsed.message_key === 'string'
      ? parsed.message_key
      : typeof parsed.messageKey === 'string'
        ? parsed.messageKey
        : undefined;

    const details: StructuredErrorDetails = {
      code: code ?? (typeof nested?.code === 'string' ? nested.code : undefined),
      message: message ?? (typeof nested?.message === 'string' ? nested.message : undefined),
      detail: typeof parsed.detail === 'string' ? parsed.detail : undefined,
      hint,
      messageKey,
    };
    return Object.values(details).some((value) => Boolean(value?.trim())) ? details : null;
  } catch {
    return null;
  }
}

/**
 * 将错误转换为稳定的当前语言前缀，并保留可用的后端诊断信息。
 */
export const formatUserFacingError = (
  error: unknown,
  prefixKey: string,
  fallbackPrefix: string,
  options: UserFacingErrorOptions = {},
): string => {
  const { includeDetails = true, includeHint = true } = options;
  const prefix = i18n.t(prefixKey, { defaultValue: fallbackPrefix });
  if (!includeDetails) return prefix;

  const details = getErrorDetails(error);
  const rawMessage = getErrorMessage(error);
  const translatedMessage = details.messageKey
    ? i18n.t(details.messageKey, { defaultValue: '' })
    : '';
  const diagnosticParts = [
    details.code ? `[${details.code}]` : '',
    translatedMessage && translatedMessage !== details.message ? translatedMessage : '',
    rawMessage,
    includeHint && details.hint && details.hint !== rawMessage ? details.hint : '',
  ].filter(Boolean);
  const diagnostic = [...new Set(diagnosticParts)].join(' | ');

  return diagnostic ? `${prefix}: ${diagnostic}` : prefix;
};

/**
 * 格式化错误消息，添加前缀
 * @param prefix 错误前缀
 * @param error 错误对象
 * @returns 格式化的完整错误消息
 */
export const formatErrorMessage = (prefix: string, error: unknown): string => {
  const errorMessage = getErrorMessage(error);
  return `${prefix}: ${errorMessage}`;
};

/**
 * 安全的错误日志记录
 * @param context 上下文信息
 * @param error 错误对象
 */
export const logError = (context: string, error: unknown): void => {
  const errorMessage = getErrorMessage(error);
  console.error(`❌ ${context}:`, errorMessage, error);
};

/**
 * 将错误信息进行路径脱敏，移除编译机/源码绝对路径等敏感信息
 */
function sanitizeErrorMessage(message: string): string {
  let out = message || '';
  // 1) 脱敏常见的 Cargo/Crates 源码路径（index.crates.io/.../crate-x.y.z/src/...）
  out = out.replace(/\/?[A-Za-z]:?[^\s]*?index\.crates\.io[^\s]*/gi, '[crates-src]');
  // 2) 脱敏常见的用户主目录路径（/Users/<name>/..., C:\\Users\\<name>\\...）
  out = out.replace(/\/?Users\/[^\s/]+\//g, '/Users/[redacted]/');
  out = out.replace(/C:\\Users\\[^\\\s]+\\/gi, 'C:\\Users\\[redacted]\\');
  // 3) 脱敏工作区绝对路径（将很长的绝对路径压缩显示）
  out = out.replace(/\/?[A-Za-z]:?[^\s]*?\.(rs|ts|tsx|js)(?::\d+(?::\d+)?)?/gi, (m) => {
    // 保留文件名与行列号，截断前缀
    const parts = m.split(/\\|\//);
    const last = parts[parts.length - 1];
    return last.startsWith('[crates-src]') ? last : `[path]/${last}`;
  });
  return out;
}
