/**
 * 通用错误处理工具函数
 * 解决前端显示 [object Object] 的问题
 */

import { t } from './i18n';

/**
 * 将任意错误对象转换为可读的错误消息字符串
 * @param error 错误对象
 * @returns 格式化的错误消息
 */
export const getErrorMessage = (error: unknown): string => {
  // 标准 Error 对象
  if (error instanceof Error) {
    return sanitizeErrorMessage(error.message);
  }
  
  // 字符串错误
  if (typeof error === 'string') {
    return error;
  }
  
  // Tauri 错误对象检查
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return sanitizeErrorMessage((error as { message: string }).message);
  }
  
  // 尝试 JSON 序列化
  try {
    const stringified = JSON.stringify(error);
    if (stringified === '{}' && Object.keys(error as object).length === 0) {
      return t('utils.errors.unknown_error_occurred');
    }
    return sanitizeErrorMessage(stringified);
  } catch {
    return t('utils.errors.unserializable_error');
  }
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