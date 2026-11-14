/**
 * L13b 提供给其他 lane 的扩展点。
 * Rust: dstu-vfs/src/vfs/hooks.rs 的 NoteDeleteHook（memory 在 extensions 中注册）。
 */
import type {} from '@deepseek-ai/cordis';
import type { VfsUploadFileParams, VfsUploadFileResult } from '../../../contracts/ipc/generated/L13-vfs-api.ts';

export type Disposer = () => void;

/**
 * 笔记删除钩子：删除前调用 `captureDelete`，返回删除成功后要执行的收尾动作
 * （Rust 语义：先快照上下文、后清理）。返回 null 表示与该笔记无关。
 */
export interface NoteDeleteHook {
  captureDelete(noteId: string): (() => void) | null;
}

/** hooks.rs:118-136: synchronous callbacks over a registration-order snapshot. */
export interface ResourceCreatedHook {
  onResourceCreated(resourceId: string): void;
}

/** L13 DstuUploadPort. The upload implementation is shared with vfs_upload_file.
 * Not provided by this plugin: the production vfs_upload_file is registered by L13
 * (vfs/index.ts), so the provider must reuse that function (BLOCKERS.md D29).
 */
export interface DstuUploadService {
  isSupportedUploadType(name: string, mimeType: string): boolean;
  maxUploadSizeBytes(mimeType: string): number;
  upload(params: VfsUploadFileParams, context?: unknown): Promise<VfsUploadFileResult>;
}

/** Rust note_delete_continuations：按注册顺序收集，删除成功后逐个执行。 */
export interface VfsHandlersHooks {
  readonly version: 1;
  registerNoteDeleteHook(hook: NoteDeleteHook): Disposer;
}

/** Resource-create capability, separate from the existing note-only consumer contract. */
export interface VfsResourceCreatedHooks {
  registerResourceCreatedHook(hook: ResourceCreatedHook): Disposer;
  notifyResourceCreated(resourceId: string): void;
}
export const vfsHooksService = { name: 'vfsHooks', version: '1.0.0' } as const;

declare module '@deepseek-ai/cordis' {
  interface Context {
    vfsHooks: VfsHandlersHooks & VfsResourceCreatedHooks;
  }
}

/**
 * Rust `crate::vfs::ref_handlers::extract_file_text_with_strategy`（ref_handlers.rs:340-412），
 * 供 L14 qbank（reference.rs `library_source`、qbank_import_source.rs）在自己的连接上调用：
 * OCR 页文本与 `extracted_text` 按 UTF-8 字节长度取大者；`extracted_text` 缺失或不足 1000 字节且给了
 * 非空 base64 时，先用 L18 DocumentParser 实时解析（解析失败静默忽略）。无可用文本返回 null。
 */
export interface VfsRefTextService {
  readonly version: 1;
  extractFileTextWithStrategy(
    conn: import('../../platform/storage/api.ts').SqlExecutor,
    sourceId: string,
    fileName: string,
    base64Content: string | null,
  ): Promise<string | null>;
}
export const vfsRefTextService = { name: 'vfsRefText', version: '1.0.0' } as const;

/**
 * Rust `vfs::handlers::read_pdf_page_image_bytes`（handlers.rs:2943-3103），
 * `vfs_get_pdf_page_image` 与 L18 `pdf_page_image` 工具共用的页图字节源。
 */
export { readPdfPageImageBytes, type PdfPageImageBytes, type PdfPageImageSource } from './src/pdf.ts';

declare module '@deepseek-ai/cordis' {
  interface Context {
    vfsRefText: VfsRefTextService;
  }
}
