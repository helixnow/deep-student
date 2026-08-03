/**
 * 文本预览内容加载器
 *
 * 对 epub/xls/ods/rtf/html 等二进制或富格式，走后端 DocumentParser 提取文本；
 * 对 txt/md/csv/json/xml 等纯文本，直接解码（BOM 感知：UTF-8 / UTF-16 LE / UTF-16 BE）。
 */

import { invoke } from '@tauri-apps/api/core';
import { base64ToUint8Array } from '@/utils/base64FileUtils';

const BACKEND_EXTRACTED_EXTENSIONS = new Set([
  'epub',
  'xls',
  'xlsb',
  'ods',
  'rtf',
  'html',
  'htm',
]);

function getExtension(fileName: string): string {
  const idx = fileName.lastIndexOf('.');
  return idx >= 0 ? fileName.slice(idx + 1).toLowerCase() : '';
}

/** 是否需要后端 DocumentParser 提取文本（直接 UTF-8 解码会得到乱码） */
export function needsBackendTextExtraction(fileName: string): boolean {
  return BACKEND_EXTRACTED_EXTENSIONS.has(getExtension(fileName));
}

/** 文本解码可能使用的编码标签 */
export type TextPreviewEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'gbk' | 'utf-8 (lossy)';

/** 解码结果 + 实际使用的编码（供状态条等 UI 展示） */
export interface DecodedTextPreview {
  text: string;
  encoding: TextPreviewEncoding;
}

/**
 * BOM / 内容感知的文本解码（富返回：携带实际使用的编码）。
 * - UTF-16 LE/BE 通过 BOM 识别
 * - 其余先按严格 UTF-8 解码（TextDecoder 默认剥离 UTF-8 BOM）
 * - 严格解码失败 → 尝试 GBK（中文环境遗留编码最常见），再退化为有损 UTF-8
 */
export function decodeTextPreviewBytesDetailed(bytes: Uint8Array): DecodedTextPreview {
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' };
    }
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be' };
    }
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    try {
      // GBK 解码不抛错（非法序列替换为 U+FFFD）；catch 覆盖环境不支持 gbk 标签的情况
      return { text: new TextDecoder('gbk').decode(bytes), encoding: 'gbk' };
    } catch {
      return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8 (lossy)' };
    }
  }
}

/**
 * BOM / 内容感知的文本解码（保留原签名的兼容包装）。
 */
export function decodeTextPreviewBytes(bytes: Uint8Array): string {
  return decodeTextPreviewBytesDetailed(bytes).text;
}

function decodeRawBase64(rawBase64: string): DecodedTextPreview | null {
  const bytes = base64ToUint8Array(rawBase64);
  if (!bytes) return null;
  try {
    return decodeTextPreviewBytesDetailed(bytes);
  } catch (err: unknown) {
    console.error('[textPreviewLoader] Decode failed:', err);
    return null;
  }
}

interface ResolveResourceRefResult {
  content?: string | null;
  found?: boolean;
}

async function resolveTextViaBackend(options: {
  nodeId: string;
  fileName: string;
  contentHash?: string;
}): Promise<string | null> {
  const result = await invoke<ResolveResourceRefResult[] | ResolveResourceRefResult>(
    'vfs_resolve_resource_refs',
    {
      refs: [{
        sourceId: options.nodeId,
        resourceHash: options.contentHash ?? '',
        type: 'file',
        name: options.fileName,
      }],
    }
  );
  const resolved = Array.isArray(result) ? result[0] : result;
  // found + 空字符串视为"内容为空"而非"未找到"，由上层渲染空状态
  if (resolved?.found && typeof resolved.content === 'string') {
    return resolved.content;
  }
  return null;
}

/** 富加载结果：文本 + 编码（后端提取的文本无原始字节，encoding 为 null） */
export interface LoadedTextPreview {
  text: string;
  /** 实际解码使用的编码；后端提取（epub/xls 等）或原样透传时为 null */
  encoding: TextPreviewEncoding | null;
}

/**
 * 加载文本预览内容（富返回：携带解码编码信息）。
 * 语义与 loadTextPreviewContent 一致：未找到时返回 null，空文件返回 text 为空字符串。
 */
export async function loadTextPreviewContentDetailed(options: {
  nodeId: string;
  fileName: string;
  contentHash?: string;
  rawBase64?: string | null;
}): Promise<LoadedTextPreview | null> {
  const { nodeId, fileName, contentHash, rawBase64 } = options;

  if (needsBackendTextExtraction(fileName)) {
    const text = await resolveTextViaBackend({ nodeId, fileName, contentHash });
    return text !== null ? { text, encoding: null } : null;
  }

  if (rawBase64) {
    // 解码失败时原样返回：调用方传入的可能已是纯文本而非 base64
    return decodeRawBase64(rawBase64) ?? { text: rawBase64, encoding: null };
  }

  // 无本地 base64 时仍尝试后端（兼容仅有 VFS 内容的场景）
  const text = await resolveTextViaBackend({ nodeId, fileName, contentHash });
  return text !== null ? { text, encoding: null } : null;
}

/**
 * 加载文本预览内容（保留原签名的兼容包装）
 * @param rawBase64 可选：已加载的 base64（纯文本格式直接解码；其他格式忽略）
 * @returns 文本内容（可能为空字符串，表示文件为空）；未找到时返回 null
 */
export async function loadTextPreviewContent(options: {
  nodeId: string;
  fileName: string;
  contentHash?: string;
  rawBase64?: string | null;
}): Promise<string | null> {
  const result = await loadTextPreviewContentDetailed(options);
  return result ? result.text : null;
}
