/**
 * Chat V2 - 资源库工具函数
 *
 * 提供 hash 计算、数据转换等工具函数。
 *
 * 约束：
 * 1. 前端计算 hash 使用 crypto.subtle.digest('SHA-256', ...)
 * 2. hash 计算必须与后端一致（均为 SHA-256）
 */

import { nanoid } from 'nanoid';
import { IMAGE_SIZE_LIMIT, FILE_SIZE_LIMIT, type ResourceType } from './types';

// ============================================================================
// Hash 计算
// ============================================================================

/**
 * 计算字符串的 SHA-256 哈希
 *
 * @param content 字符串内容
 * @returns 十六进制哈希字符串
 */
export async function calculateStringHash(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  return calculateBufferHash(data.buffer as ArrayBuffer);
}

/**
 * 计算 ArrayBuffer 的 SHA-256 哈希
 *
 * @param buffer 二进制数据
 * @returns 十六进制哈希字符串
 */
export async function calculateBufferHash(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 计算数据的 SHA-256 哈希（自动判断类型）
 *
 * @param data 字符串或 ArrayBuffer
 * @returns 十六进制哈希字符串
 */
export async function calculateHash(data: string | ArrayBuffer): Promise<string> {
  if (typeof data === 'string') {
    return calculateStringHash(data);
  }
  return calculateBufferHash(data);
}

// ============================================================================
// ID 生成
// ============================================================================

/**
 * 生成资源 ID
 *
 * 格式：res_{nanoid(10)}
 *
 * @returns 资源 ID
 */
export function generateResourceId(): string {
  return `res_${nanoid(10)}`;
}

// ============================================================================
// 数据转换
// ============================================================================

/**
 * 将 ArrayBuffer 转换为 Base64 字符串
 *
 * @param buffer ArrayBuffer
 * @returns Base64 字符串
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * 将 Base64 字符串转换为 ArrayBuffer
 *
 * @param base64 Base64 字符串
 * @returns ArrayBuffer
 */
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * 将 File 对象转换为 Base64 字符串
 *
 * @param file File 对象
 * @returns Base64 字符串
 */
export async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // result 是 data:xxx;base64,yyy 格式，需要提取 base64 部分
      const result = reader.result as string;
      const commaIndex = result.indexOf(',');
      if (commaIndex === -1) {
        reject(new Error('Invalid data URL format'));
        return;
      }
      resolve(result.substring(commaIndex + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * 将 File 对象转换为 ArrayBuffer
 *
 * @param file File 对象
 * @returns ArrayBuffer
 */
export async function fileToArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

// ============================================================================
// 验证函数
// ============================================================================

/**
 * 验证文件大小是否在限制范围内
 *
 * @param size 文件大小（字节）
 * @param type 资源类型
 * @returns 是否在限制范围内
 */
export function validateFileSize(size: number, type: ResourceType): boolean {
  if (type === 'image') {
    return size <= IMAGE_SIZE_LIMIT;
  }
  // file 类型及其他
  return size <= FILE_SIZE_LIMIT;
}

/**
 * 获取文件大小限制（格式化字符串）
 *
 * @param type 资源类型
 * @returns 格式化的大小限制字符串
 */
export function getFileSizeLimitText(type: ResourceType): string {
  const limit = type === 'image' ? IMAGE_SIZE_LIMIT : FILE_SIZE_LIMIT;
  const mb = limit / (1024 * 1024);
  return `${mb}MB`;
}

/**
 * 格式化文件大小
 *
 * @param bytes 字节数
 * @returns 格式化字符串
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// ============================================================================
// 类型判断
// ============================================================================

/**
 * 根据 MIME 类型判断资源类型
 *
 * @param mimeType MIME 类型
 * @returns 资源类型
 */
export function getResourceTypeFromMime(mimeType: string): ResourceType {
  if (mimeType.startsWith('image/')) {
    return 'image';
  }
  return 'file';
}

/**
 * 判断是否为图片类型
 *
 * @param mimeType MIME 类型
 * @returns 是否为图片
 */
export function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith('image/');
}

/**
 * 判断是否为文本类型
 *
 * @param mimeType MIME 类型
 * @returns 是否为文本
 */
export function isTextMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/xml' ||
    mimeType === 'application/javascript'
  );
}
