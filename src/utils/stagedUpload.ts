/**
 * 大文件分块暂存上传（对应 Rust `staged_upload` 模块）
 *
 * 旧路径把整份文件在 WebView 里 readAsDataURL → base64 → JSON IPC，一个 200MB
 * 文件会同时占用 ArrayBuffer + base64 字符串 + JSON 字符串等多份内存，手机上
 * 渲染进程 OOM（Android 会连带杀掉整个应用）。
 *
 * 新路径：`File.slice()` 逐块读取（默认 4MB），每块经 IPC 追加到 Rust 侧临时
 * 文件，WebView 任一时刻只持有一个分块；消费命令（`vfs_upload_attachment` /
 * `dstu_create`）以 `stagedUploadId` 取走完整文件。
 * - 桌面：原始二进制 IPC（Uint8Array body + 请求头），零编码开销；
 * - Android：wry 拦截不到请求体，Tauri 走 postMessage 并把 Uint8Array 序列化成
 *   数字数组（体积 ×3.5），因此改发 `{ uploadId, offset, data: base64 }`。
 * 已有文件路径（拖放/对话框/content://）时用 `stagePathUpload`，Rust 直接复制。
 */
import { invoke } from '@tauri-apps/api/core';
import { isAndroid } from './platform';

/** 超过该大小走分块暂存；更小的文件保留原 base64 快速路径 */
export const STAGED_UPLOAD_THRESHOLD = 8 * 1024 * 1024;
/** 分块大小（Rust 侧硬上限 16MB） */
export const STAGED_UPLOAD_CHUNK_SIZE = 4 * 1024 * 1024;

export function shouldUseStagedUpload(size: number): boolean {
  return size > STAGED_UPLOAD_THRESHOLD;
}

export interface StageBlobOptions {
  name: string;
  /** 已发送字节数回调（每块完成后触发） */
  onProgress?: (loaded: number, total: number) => void;
  signal?: AbortSignal;
  /** 测试注入：覆盖平台判断 */
  android?: boolean;
  chunkSize?: number;
}

function abortError(): Error {
  const error = new Error('Upload aborted');
  error.name = 'AbortError';
  return error;
}

function readBlobAsArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file chunk'));
    reader.readAsArrayBuffer(blob);
  });
}

/** 分块转 base64：FileReader.readAsDataURL 由浏览器原生编码，不经 JS 字符串拼接 */
function readBlobAsBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file chunk'));
    reader.readAsDataURL(blob);
  });
}

export async function abortStagedUpload(uploadId: string): Promise<void> {
  try {
    await invoke('staged_upload_abort', { uploadId });
  } catch (error: unknown) {
    console.warn('[stagedUpload] abort failed:', uploadId, error);
  }
}

/**
 * 把 Blob/File 分块写入 Rust 暂存区，返回 uploadId。
 * 失败或取消时会通知 Rust 删除临时文件。
 */
export async function stageBlobUpload(blob: Blob, options: StageBlobOptions): Promise<string> {
  const { name, onProgress, signal } = options;
  const android = options.android ?? isAndroid();
  const chunkSize = options.chunkSize ?? STAGED_UPLOAD_CHUNK_SIZE;
  const total = blob.size;
  if (signal?.aborted) throw abortError();

  const uploadId = await invoke<string>('staged_upload_begin', { name, totalSize: total });
  try {
    let offset = 0;
    while (offset < total) {
      if (signal?.aborted) throw abortError();
      const end = Math.min(offset + chunkSize, total);
      const slice = blob.slice(offset, end);
      if (android) {
        const data = await readBlobAsBase64(slice);
        if (signal?.aborted) throw abortError();
        await invoke<number>('staged_upload_append', { uploadId, offset, data });
      } else {
        const bytes = new Uint8Array(await readBlobAsArrayBuffer(slice));
        if (signal?.aborted) throw abortError();
        await invoke<number>('staged_upload_append', bytes, {
          headers: {
            'x-upload-id': uploadId,
            'x-upload-offset': String(offset),
          },
        });
      }
      offset = end;
      onProgress?.(offset, total);
    }
    return uploadId;
  } catch (error: unknown) {
    void abortStagedUpload(uploadId);
    throw error;
  }
}

/**
 * 已有文件路径（本地路径或 content:// URI）时，由 Rust 流式复制进暂存区。
 * WebView 不经手任何文件字节。
 */
export async function stagePathUpload(path: string): Promise<{ uploadId: string; size: number }> {
  return invoke<{ uploadId: string; size: number }>('staged_upload_from_path', { path });
}

/**
 * 按字节预算限流：同时进行的任务权重（字节数）之和不超过 maxBytes。
 * 单个任务超过预算时独占执行（不会饿死）。用于大文件导入：后端消费暂存
 * 文件时会整份读入内存，按「个数」并发 3 个 200MB 文件在手机上同样会 OOM。
 */
export function createByteBudgetLimiter(maxBytes: number) {
  let inFlight = 0;
  let running = 0;
  const waiters: Array<{ weight: number; start: () => void }> = [];

  const canStart = (weight: number) => running === 0 || inFlight + weight <= maxBytes;
  const pump = () => {
    while (waiters.length > 0 && canStart(waiters[0].weight)) {
      const next = waiters.shift()!;
      inFlight += next.weight;
      running += 1;
      next.start();
    }
  };

  return async function run<T>(weight: number, task: () => Promise<T>): Promise<T> {
    const normalized = Math.max(0, weight);
    await new Promise<void>((resolve) => {
      waiters.push({ weight: normalized, start: resolve });
      pump();
    });
    try {
      return await task();
    } finally {
      inFlight -= normalized;
      running -= 1;
      pump();
    }
  };
}
