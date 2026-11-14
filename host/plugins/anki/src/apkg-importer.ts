/**
 * APKG 导入服务（`crates/dstu-anki/src/apkg_importer_service.rs` 全量移植）。
 *
 * 管线：有界 zip 扫描 → 集合库解出（legacy anki21/anki2 或现代 anki21b：
 * zstd + protobuf 媒体清单）→ 只读 SQLite 内省 → 卡片映射 → 同一个 immediate
 * 事务写入 `document_tasks` + `anki_cards`（可选同时建 FSRS 状态）→ 事务后补建
 * 缺失模板。媒体条目按清单落盘到 `media_dir`，所有跳过原因结构化进报告。
 *
 * SQL 在 `repository/apkg-import.ts`；本文件只做解析、映射、换算与编排。
 * 错误以 Rust `AppError` 的 serde 值（普通对象 `{ error_type, message, details }`）
 * 直接抛出，`details.errorCode` 与服务端错误码一致。
 */
import type { ApkgImportResult, ApkgReviewEnqueueReport } from './apkg-types.ts';
import { ioErrorText } from './files.ts';
import { ankiLocalRuntime } from './local-runtime.ts';
import {
  APKG_ERROR_INVALID_INPUT,
  APKG_ERROR_NOT_FOUND,
  APKG_ERROR_NOT_FILE,
  MAX_APKG_ARCHIVE_BYTES,
  appErrorWithCode,
  defaultImportLimits,
  fileError,
  limitError,
  rustFileName,
  validationError,
  type ApkgImportRuntime,
  type ImportLimits,
} from './apkg-import-types.ts';
import {
  colpkgUnsupportedError,
  isColpkgSourceName,
  parseArchive,
  parseArchiveWithNativeCompression,
} from './apkg-import-archive.ts';
import { persistPackage, safeSourceName } from './apkg-import-persist.ts';

export * from './apkg-import-types.ts';
export * from './apkg-import-media.ts';
export * from './apkg-import-zstd.ts';
export * from './apkg-import-mapping.ts';
export * from './apkg-import-metadata.ts';
export * from './apkg-import-collection.ts';
export * from './apkg-import-archive.ts';
export * from './apkg-import-fsrs.ts';
export * from './apkg-import-persist.ts';

// ============================================================================
// 服务入口
// ============================================================================

/** `ApkgImporterService`。 */
export class ApkgImporterService {
  private readonly runtime: ApkgImportRuntime;
  private mediaDir: string | null;
  private enqueueForReview: boolean;

  constructor(runtime: ApkgImportRuntime) {
    this.runtime = runtime;
    this.mediaDir = runtime.mediaDir ?? null;
    this.enqueueForReview = false;
  }

  /** 导入即入队：卡片写入与 FSRS 状态建档在同一事务内完成。 */
  withReviewEnqueue(): this {
    this.enqueueForReview = true;
    return this;
  }

  /** 启用媒体导入：包内媒体按清单文件名解出到 `mediaDir`。 */
  withMediaDir(mediaDir: string): this {
    this.mediaDir = mediaDir;
    return this;
  }

  /** 校验并读取 `import_path` 的源文件。 */
  private readPathBytes(sourcePath: string): { bytes: Uint8Array; sourceName: string } {
    if (sourcePath === '') {
      throw validationError(APKG_ERROR_INVALID_INPUT, 'APKG path must not be empty');
    }
    if (isColpkgSourceName(sourcePath)) throw colpkgUnsupportedError();

    let metadata: { kind: string; size: number };
    try {
      metadata = ankiLocalRuntime().stat(sourcePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw appErrorWithCode(
          'NotFound',
          APKG_ERROR_NOT_FOUND,
          `APKG file was not found: ${sourcePath}`,
        );
      }
      throw fileError(`Failed to inspect APKG file ${sourcePath}: ${ioErrorText(error)}`);
    }
    if (metadata.kind !== 'file') {
      throw validationError(APKG_ERROR_NOT_FILE, `APKG path is not a regular file: ${sourcePath}`);
    }
    if (metadata.size === 0) {
      throw validationError(APKG_ERROR_INVALID_INPUT, 'APKG file is empty');
    }
    if (metadata.size > MAX_APKG_ARCHIVE_BYTES) {
      throw limitError(`APKG file is larger than the ${MAX_APKG_ARCHIVE_BYTES} byte limit`);
    }

    let bytes: Uint8Array;
    try {
      bytes = ankiLocalRuntime().readBytes(sourcePath);
    } catch (error) {
      throw fileError(`Failed to open APKG file ${sourcePath}: ${ioErrorText(error)}`);
    }
    return { bytes, sourceName: rustFileName(sourcePath) ?? 'imported.apkg' };
  }

  /** `import_path`。 */
  importPath(sourcePath: string, sessionId: string | null = null): ApkgImportResult {
    const { bytes, sourceName } = this.readPathBytes(sourcePath);
    return this.importReader(bytes, sourceName, sessionId, defaultImportLimits());
  }

  /** `import_path` 的异步路径：zstd 经 F7 `nativeCompression` 解压。 */
  async importPathAsync(sourcePath: string, sessionId: string | null = null): Promise<ApkgImportResult> {
    const { bytes, sourceName } = this.readPathBytes(sourcePath);
    return this.importReaderAsync(bytes, sourceName, sessionId, defaultImportLimits());
  }

  /** `import_bytes`。 */
  importBytes(bytes: Uint8Array, sourceName: string | null, sessionId: string | null = null): ApkgImportResult {
    this.validateBytes(bytes, sourceName);
    return this.importReader(
      bytes,
      sourceName ?? 'imported.apkg',
      sessionId,
      defaultImportLimits(),
    );
  }

  /** `import_bytes` 的异步路径：zstd 经 F7 `nativeCompression` 解压。 */
  async importBytesAsync(
    bytes: Uint8Array,
    sourceName: string | null,
    sessionId: string | null = null,
  ): Promise<ApkgImportResult> {
    this.validateBytes(bytes, sourceName);
    return this.importReaderAsync(
      bytes,
      sourceName ?? 'imported.apkg',
      sessionId,
      defaultImportLimits(),
    );
  }

  private validateBytes(bytes: Uint8Array, sourceName: string | null): void {
    if (bytes.length === 0) {
      throw validationError(APKG_ERROR_INVALID_INPUT, 'APKG data must not be empty');
    }
    if (bytes.length > MAX_APKG_ARCHIVE_BYTES) {
      throw limitError(`APKG data is larger than the ${MAX_APKG_ARCHIVE_BYTES} byte limit`);
    }
    if (sourceName !== null && isColpkgSourceName(sourceName)) throw colpkgUnsupportedError();
  }

  /** `import_reader`：解析归档并在应用库落库。 */
  importReader(
    bytes: Uint8Array,
    sourceName: string,
    sessionId: string | null,
    limits: Partial<ImportLimits> = {},
  ): ApkgImportResult {
    const effectiveLimits: ImportLimits = { ...defaultImportLimits(), ...limits };
    const parsed = parseArchive(bytes, effectiveLimits, this.runtime, this.mediaDir);
    return persistPackage(
      this.runtime,
      parsed,
      sourceName,
      sessionId,
      this.enqueueForReview,
    );
  }

  /** `import_reader` 的异步路径：先由 F7 服务预解压，再复用同步入库。 */
  async importReaderAsync(
    bytes: Uint8Array,
    sourceName: string,
    sessionId: string | null,
    limits: Partial<ImportLimits> = {},
  ): Promise<ApkgImportResult> {
    const effectiveLimits: ImportLimits = { ...defaultImportLimits(), ...limits };
    const parsed = await parseArchiveWithNativeCompression(
      bytes,
      effectiveLimits,
      this.runtime,
      this.mediaDir,
    );
    return persistPackage(
      this.runtime,
      parsed,
      sourceName,
      sessionId,
      this.enqueueForReview,
    );
  }
}

/** `safe_source_name`（供命令层复用）。 */
export function safeApkgSourceName(sourceName: string): string {
  return safeSourceName(sourceName);
}

/** `is_colpkg_source_name`（供命令层复用）。 */
export function isColpkgSourcePath(sourceName: string): boolean {
  return isColpkgSourceName(sourceName);
}

export type { ApkgReviewEnqueueReport };

