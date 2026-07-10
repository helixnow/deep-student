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

/**
 * BOM / 内容感知的文本解码。
 * - UTF-16 LE/BE 通过 BOM 识别
 * - 其余先按严格 UTF-8 解码（TextDecoder 默认剥离 UTF-8 BOM）
 * - 严格解码失败 → 尝试 GBK（中文环境遗留编码最常见），再退化为有损 UTF-8
 */
export function decodeTextPreviewBytes(bytes: Uint8Array): string {
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    }
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      return new TextDecoder('utf-16be').decode(bytes.subarray(2));
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      // GBK 解码不抛错（非法序列替换为 U+FFFD）；catch 覆盖环境不支持 gbk 标签的情况
      return new TextDecoder('gbk').decode(bytes);
    } catch {
      return new TextDecoder('utf-8').decode(bytes);
    }
  }
}

function decodeRawBase64(rawBase64: string): string | null {
  const bytes = base64ToUint8Array(rawBase64);
  if (!bytes) return null;
  try {
    return decodeTextPreviewBytes(bytes);
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

/**
 * 加载文本预览内容
 * @param rawBase64 可选：已加载的 base64（纯文本格式直接解码；其他格式忽略）
 * @returns 文本内容（可能为空字符串，表示文件为空）；未找到时返回 null
 */
export async function loadTextPreviewContent(options: {
  nodeId: string;
  fileName: string;
  contentHash?: string;
  rawBase64?: string | null;
}): Promise<string | null> {
  const { nodeId, fileName, contentHash, rawBase64 } = options;

  if (needsBackendTextExtraction(fileName)) {
    return resolveTextViaBackend({ nodeId, fileName, contentHash });
  }

  if (rawBase64) {
    // 解码失败时原样返回：调用方传入的可能已是纯文本而非 base64
    return decodeRawBase64(rawBase64) ?? rawBase64;
  }

  // 无本地 base64 时仍尝试后端（兼容仅有 VFS 内容的场景）
  return resolveTextViaBackend({ nodeId, fileName, contentHash });
}
