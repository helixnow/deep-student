/**
 * APKG 归档扫描：collection 解压、媒体落盘与临时集合库生命周期。
 */
import { decodeUtf8Lossy } from '../../../platform/util/utf8.ts';
import { hostPath as path } from '../../../platform/util/path.ts';
import { ZipArchiveReader, ZipError } from './apkg-zip.ts';
import type { ApkgMediaReport } from './apkg-types.ts';
import { ioErrorText } from './files.ts';
import { equalBytes } from './bytes.ts';
import { ankiLocalRuntime } from './local-runtime.ts';
import {
  APKG_ERROR_COLLECTION_INVALID,
  APKG_ERROR_COLLECTION_MISSING,
  APKG_ERROR_COLPKG,
  APKG_ERROR_INVALID_ARCHIVE,
  APKG_ERROR_LIMIT_EXCEEDED,
  APKG_ERROR_NOT_FOUND,
  ANKI_SCHED_METADATA_KEYS,
  ANKI_DUE_TIMESTAMP_THRESHOLD,
  MAX_APKG_ARCHIVE_BYTES,
  MAX_COLLECTION_BYTES,
  MAX_ENTRY_BYTES,
  MAX_MEDIA_MANIFEST_BYTES,
  MAX_TOTAL_UNCOMPRESSED_BYTES,
  MAX_ZIP_ENTRIES,
  MEDIA_SKIP_REASON_ENTRY_MISSING,
  MEDIA_SKIP_REASON_ENTRY_OVERSIZED,
  MEDIA_SKIP_REASON_FILENAME_CONFLICT,
  MEDIA_SKIP_REASON_IMPORT_DISABLED,
  MEDIA_SKIP_REASON_IO_ERROR,
  MEDIA_SKIP_REASON_MANIFEST_UNPARSED,
  MEDIA_SKIP_REASON_MEDIA_DIR_UNAVAILABLE,
  MEDIA_SKIP_REASON_ORPHAN_ENTRY,
  MEDIA_SKIP_REASON_UNSAFE_FILENAME,
  SQLITE_HEADER,
  ZSTD_MAGIC,
  appErrorWithCode,
  byteLen,
  eqIgnoreAsciiCase,
  rustExtension,
  compareUtf8,
  errorMessage,
  fileError,
  limitError,
  validationError,
  type ApkgImportRuntime,
  type AppErrorValue,
  type ImportLimits,
  type ParsedPackage,
} from './apkg-import-types.ts';
import type { AnkiLogger } from './logger.ts';
import { MediaSkipTracker, sanitizeMediaFilename } from './apkg-import-media.ts';
import { parseCollectionDatabase } from './apkg-import-collection.ts';
import {
  isZstdFrame,
  parseModernMediaManifest,
  zstdDecompressUpTo,
  zstdDecompressUpToWith,
} from './apkg-import-zstd.ts';
import type { NativeCompression } from '../../../platform/native/api.ts';

// ============================================================================
// 集合库字节：SQLite 校验 / zstd 解压
// ============================================================================

export function decodeCollection(
  bytes: Uint8Array,
  limit: number,
  predecoded?: Uint8Array,
): Uint8Array {
  if (predecoded !== undefined) {
    if (!equalBytes(predecoded.subarray(0, SQLITE_HEADER.length), SQLITE_HEADER)) {
      throw validationError(
        APKG_ERROR_COLLECTION_INVALID,
        'Decompressed APKG collection is not a SQLite database',
      );
    }
    return predecoded;
  }
  if (equalBytes(bytes.subarray(0, SQLITE_HEADER.length), SQLITE_HEADER)) return bytes;
  if (!isZstdFrame(bytes)) {
    throw validationError(
      APKG_ERROR_COLLECTION_INVALID,
      'APKG collection is neither SQLite nor supported zstd-compressed SQLite',
    );
  }

  let decompressed: { overflow: boolean; data: Uint8Array };
  try {
    decompressed = zstdDecompressUpTo(bytes, limit);
  } catch (error) {
    throw validationError(
      APKG_ERROR_COLLECTION_INVALID,
      `Failed to decompress APKG collection: ${errorMessage(error)}`,
    );
  }
  if (decompressed.overflow || decompressed.data.length > limit) {
    throw limitError(`Decompressed APKG collection exceeds the ${limit} byte limit`);
  }
  const decoded = decompressed.data;
  if (!equalBytes(decoded.subarray(0, SQLITE_HEADER.length), SQLITE_HEADER)) {
    throw validationError(
      APKG_ERROR_COLLECTION_INVALID,
      'Decompressed APKG collection is not a SQLite database',
    );
  }
  return decoded;
}

// ============================================================================
// 归档扫描与媒体落盘
// ============================================================================

function isSafeZipEntryName(name: string): boolean {
  if (name === '' || name.startsWith('/') || name.startsWith('\\') || name.includes('\\')) return false;
  if (name === '.' || name.startsWith('./')) return false;
  return !name.split('/').some((part) => part === '..');
}

function isNumericMediaName(name: string): boolean {
  return name !== '' && /^[0-9]+$/.test(name);
}

export function isColpkgSourceName(name: string): boolean {
  const extension = rustExtension(name);
  return extension !== null && eqIgnoreAsciiCase(extension, 'colpkg');
}

export function colpkgUnsupportedError(): AppErrorValue {
  return validationError(
    APKG_ERROR_COLPKG,
    '暂不支持导入 .colpkg 集合包。请在 Anki 中使用「文件 → 导出 → 牌组（.apkg）」按牌组导出后再导入。',
  );
}

function setUniqueEntry(
  slots: { anki21: number | null; anki2: number | null; anki21b: number | null; manifest: number | null },
  slot: 'anki21' | 'anki2' | 'anki21b' | 'manifest',
  index: number,
  name: string,
): void {
  if (slots[slot] !== null) {
    throw validationError(
      APKG_ERROR_INVALID_ARCHIVE,
      `APKG contains duplicate ${name} entries`,
    );
  }
  slots[slot] = index;
}

function readZipEntryBounded(
  archive: ZipArchiveReader,
  index: number,
  limit: number,
  label: string,
): Uint8Array {
  try {
    return archive.readEntry(index, limit);
  } catch (error) {
    if (error instanceof ZipError && error.kind === 'limit') {
      throw limitError(`APKG ${label} exceeds the ${limit} byte limit`);
    }
    if (error instanceof ZipError && error.kind === 'open') {
      throw validationError(
        APKG_ERROR_INVALID_ARCHIVE,
        `Failed to open APKG ${label}: ${error.message}`,
      );
    }
    throw validationError(
      APKG_ERROR_INVALID_ARCHIVE,
      `Failed to decompress APKG ${label}: ${errorMessage(error)}`,
    );
  }
}

/** 把单个媒体条目按包版本解出，最多读取 `maxBytes + 1` 字节。 */
function copyMediaEntry(
  entryBytes: Uint8Array,
  maxBytes: number,
  modernPackage: boolean,
  predecoded?: Uint8Array,
): { written: number; bytes: Uint8Array | null } {
  if (modernPackage && predecoded !== undefined) {
    return predecoded.length > maxBytes
      ? { written: predecoded.length, bytes: null }
      : { written: predecoded.length, bytes: predecoded };
  }
  if (!modernPackage) {
    const limited = entryBytes.subarray(0, maxBytes + 1);
    return limited.length > maxBytes
      ? { written: limited.length, bytes: null }
      : { written: limited.length, bytes: limited };
  }
  // 现代 APKG 的媒体条目通常是 zstd 帧：探测 magic 后解压；非 zstd 数据原样拷贝。
  const header = entryBytes.subarray(0, 4);
  if (header.length === 4 && equalBytes(header, ZSTD_MAGIC)) {
    let result: { overflow: boolean; data: Uint8Array };
    try {
      result = zstdDecompressUpTo(entryBytes, maxBytes + 1);
    } catch (error) {
      throw new Error(errorMessage(error));
    }
    if (result.overflow || result.data.length > maxBytes) {
      return { written: maxBytes + 1, bytes: null };
    }
    return { written: result.data.length, bytes: result.data };
  }
  const limited = entryBytes.subarray(0, maxBytes + 1);
  return limited.length > maxBytes
    ? { written: limited.length, bytes: null }
    : { written: limited.length, bytes: limited };
}

function mediaFilesHaveEqualContents(leftPath: string, rightPath: string): boolean {
  const left = ankiLocalRuntime().readBytes(leftPath);
  const right = ankiLocalRuntime().readBytes(rightPath);
  return equalBytes(left, right);
}

interface ExtractMediaResult {
  mediaPaths: Map<string, string>;
  importedKeys: number;
}

function extractDeclaredMedia(
  archive: ZipArchiveReader,
  manifestEntries: ReadonlyMap<string, string>,
  mediaDir: string,
  limits: ImportLimits,
  warnings: string[],
  skipTracker: MediaSkipTracker,
  modernPackage: boolean,
  logger: AnkiLogger,
  predecoded: ReadonlyMap<number, Uint8Array>,
): ExtractMediaResult {
  const mediaPaths = new Map<string, string>();
  let importedKeys = 0;
  if (manifestEntries.size === 0) return { mediaPaths, importedKeys };

  try {
    ankiLocalRuntime().mkdirp(mediaDir);
  } catch (error) {
    warnings.push(
      `创建媒体目录失败，本次导入跳过全部媒体 (${mediaDir}): ${ioErrorText(error)}`,
    );
    const names = [...manifestEntries.values()].sort(compareUtf8);
    for (const name of names) skipTracker.record(MEDIA_SKIP_REASON_MEDIA_DIR_UNAVAILABLE, name);
    return { mediaPaths, importedKeys };
  }

  // 按清单键排序，保证告警/报告顺序稳定可测：先字节长度，再字典序（数字键即数值序）。
  const sortedEntries = [...manifestEntries.entries()].sort((left, right) => {
    const leftKey = left[0];
    const rightKey = right[0];
    return byteLen(leftKey) - byteLen(rightKey) || compareUtf8(leftKey, rightKey);
  });

  for (const [key, rawName] of sortedEntries) {
    const fileName = sanitizeMediaFilename(rawName);
    if (fileName === null) {
      warnings.push(`媒体清单文件名不安全，已跳过: ${rawName}`);
      skipTracker.record(MEDIA_SKIP_REASON_UNSAFE_FILENAME, rawName);
      continue;
    }
    const target = path.join(mediaDir, fileName);
    // 纵深防御：安全化后的目标必须仍在媒体目录内（zip slip / 路径穿越兜底）。
    if (path.normalize(path.dirname(target)) !== path.normalize(mediaDir)) {
      warnings.push(`媒体目标路径越出媒体目录，已跳过: ${rawName}`);
      skipTracker.record(MEDIA_SKIP_REASON_UNSAFE_FILENAME, rawName);
      continue;
    }

    // 必须先确认包内条目存在，再考虑复用同名目标。
    const entryIndex = archive.findLastIndexByName(key);
    if (entryIndex === undefined) {
      warnings.push(`媒体清单声明的条目在包内缺失，已跳过: ${key} (${fileName})`);
      skipTracker.record(MEDIA_SKIP_REASON_ENTRY_MISSING, fileName);
      continue;
    }

    let existingMetadata: { kind: string; size: number } | null = null;
    try {
      const stats = ankiLocalRuntime().lstat(target);
      if (stats.kind !== 'file') {
        warnings.push(`媒体目标已存在但不是普通文件，已跳过: ${fileName}`);
        skipTracker.record(MEDIA_SKIP_REASON_IO_ERROR, fileName);
        continue;
      }
      existingMetadata = stats;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        warnings.push(`检查媒体目标失败，已跳过 ${fileName}: ${ioErrorText(error)}`);
        skipTracker.record(MEDIA_SKIP_REASON_IO_ERROR, fileName);
        continue;
      }
      existingMetadata = null;
    }

    let entryBytes: Uint8Array;
    try {
      entryBytes = archive.readEntry(entryIndex);
    } catch (error) {
      warnings.push(`解压媒体文件失败，已跳过 ${fileName}: ${errorMessage(error)}`);
      skipTracker.record(MEDIA_SKIP_REASON_IO_ERROR, fileName);
      continue;
    }

    if (existingMetadata !== null) {
      // 先把包内（现代包为解压后的）内容落在内存里，再与既有目标逐字节比较。
      // 只凭文件名复用会让卡片静默链接到旧内容。
      let copied: { written: number; bytes: Uint8Array | null };
      try {
        copied = copyMediaEntry(
          entryBytes,
          limits.maxEntryBytes,
          modernPackage,
          modernPackage ? predecoded.get(entryIndex) : undefined,
        );
      } catch (error) {
        warnings.push(`解压媒体文件失败，已跳过 ${fileName}: ${errorMessage(error)}`);
        skipTracker.record(MEDIA_SKIP_REASON_IO_ERROR, fileName);
        continue;
      }
      if (copied.written > limits.maxEntryBytes || copied.bytes === null) {
        warnings.push(`媒体文件解压后超过 ${limits.maxEntryBytes} 字节上限，已跳过: ${fileName}`);
        skipTracker.record(MEDIA_SKIP_REASON_ENTRY_OVERSIZED, fileName);
        continue;
      }
      const stagedPath = path.join(
        path.dirname(mediaDir),
        `.apkg-media-check-${globalThis.crypto.randomUUID()}.tmp`,
      );
      try {
        ankiLocalRuntime().writeBytes(stagedPath, copied.bytes);
        if (mediaFilesHaveEqualContents(stagedPath, target)) {
          mediaPaths.set(rawName, target);
          importedKeys += 1;
        } else {
          warnings.push(`媒体目录已有同名但内容不同的文件，已跳过: ${fileName}`);
          skipTracker.record(MEDIA_SKIP_REASON_FILENAME_CONFLICT, fileName);
        }
      } catch (error) {
        warnings.push(`校验同名媒体内容失败，已跳过 ${fileName}: ${ioErrorText(error)}`);
        skipTracker.record(MEDIA_SKIP_REASON_IO_ERROR, fileName);
      } finally {
        try {
          ankiLocalRuntime().remove(stagedPath);
        } catch (error) {
          logger.warn(`[apkg_import] 清理媒体校验临时文件失败: ${ioErrorText(error)}`);
        }
      }
      continue;
    }

    let copied: { written: number; bytes: Uint8Array | null };
    try {
      copied = copyMediaEntry(entryBytes, limits.maxEntryBytes, modernPackage,
        modernPackage ? predecoded.get(entryIndex) : undefined);
    } catch (error) {
      warnings.push(`解压媒体文件失败，已跳过 ${fileName}: ${errorMessage(error)}`);
      skipTracker.record(MEDIA_SKIP_REASON_IO_ERROR, fileName);
      continue;
    }
    // 解压炸弹防护：实际解压量超过单条目上限时中止并不落盘。
    if (copied.written > limits.maxEntryBytes || copied.bytes === null) {
      warnings.push(`媒体文件解压后超过 ${limits.maxEntryBytes} 字节上限，已跳过: ${fileName}`);
      skipTracker.record(MEDIA_SKIP_REASON_ENTRY_OVERSIZED, fileName);
      continue;
    }
    try {
      // create_new 语义（O_CREAT|O_EXCL）：拒绝符号链接、绝不截断既有路径。
      ankiLocalRuntime().writeBytes(target, copied.bytes, { exclusive: true });
    } catch (error) {
      warnings.push(`创建媒体文件失败，已跳过 ${fileName}: ${ioErrorText(error)}`);
      skipTracker.record(MEDIA_SKIP_REASON_IO_ERROR, fileName);
      continue;
    }
    mediaPaths.set(rawName, target);
    importedKeys += 1;
  }
  return { mediaPaths, importedKeys };
}

/** `parse_archive`：扫描归档 → 集合库 → 媒体。 */
/**
 * 异步路径：用 F7 `nativeCompression` 预解压所有可识别的 zstd 条目。
 *
 * 只缓存成功且未超限的结果；任何失败都留给同步路径按原有错误/告警文案处理，
 * 保证窗口上限、输出上限与媒体 skip 语义不变。
 */
export async function predecodeArchiveZstdEntries(
  archiveBytes: Uint8Array,
  limits: ImportLimits,
  compression: NativeCompression,
  logger?: Pick<AnkiLogger, 'debug'>,
): Promise<Map<number, Uint8Array>> {
  const predecoded = new Map<number, Uint8Array>();
  let archive: ZipArchiveReader;
  try {
    archive = ZipArchiveReader.open(archiveBytes);
  } catch {
    return predecoded;
  }
  for (let index = 0; index < archive.length; index += 1) {
    let name: string;
    try {
      name = archive.entry(index).name;
    } catch {
      continue;
    }
    let limit: number;
    let readLimit: number | undefined;
    if (name === 'collection.anki21' || name === 'collection.anki2' || name === 'collection.anki21b') {
      limit = limits.maxCollectionBytes;
      readLimit = limit;
    } else if (name === 'media') {
      limit = MAX_MEDIA_MANIFEST_BYTES;
      readLimit = limit;
    } else if (isNumericMediaName(name)) {
      limit = limits.maxEntryBytes;
      readLimit = undefined;
    } else {
      continue;
    }
    let raw: Uint8Array;
    try {
      raw = archive.readEntry(index, readLimit);
    } catch {
      continue;
    }
    if (!isZstdFrame(raw)) continue;
    try {
      const decoded = await zstdDecompressUpToWith(compression, raw, limit);
      if (!decoded.overflow) predecoded.set(index, decoded.data);
    } catch (error) {
      // 保留同步路径的错误/告警映射；本缓存失败不改变可观察行为。
      logger?.debug(
        `[apkg_import] native zstd 预解压跳过 ${name}: ${errorMessage(error)}`,
      );
    }
  }
  return predecoded;
}

/** 异步路径入口：有 F7 服务时先预解压，再复用同步归档扫描。 */
export async function parseArchiveWithNativeCompression(
  archiveBytes: Uint8Array,
  limits: ImportLimits,
  runtime: ApkgImportRuntime,
  mediaDir: string | null,
): Promise<ParsedPackage> {
  const compression = runtime.compression;
  const predecoded = compression === null || compression === undefined
    ? undefined
    : await predecodeArchiveZstdEntries(archiveBytes, limits, compression, runtime.logger);
  return parseArchive(archiveBytes, limits, runtime, mediaDir, predecoded);
}

export function parseArchive(
  archiveBytes: Uint8Array,
  limits: ImportLimits,
  runtime: ApkgImportRuntime,
  mediaDir: string | null,
  predecoded: ReadonlyMap<number, Uint8Array> = new Map(),
): ParsedPackage {
  let archive: ZipArchiveReader;
  try {
    archive = ZipArchiveReader.open(archiveBytes);
  } catch (error) {
    throw validationError(APKG_ERROR_INVALID_ARCHIVE, `Invalid APKG zip archive: ${errorMessage(error)}`);
  }
  if (archive.isEmpty) {
    throw validationError(APKG_ERROR_INVALID_ARCHIVE, 'APKG archive is empty');
  }
  if (archive.length > limits.maxEntries) {
    throw limitError(`APKG archive contains more than ${limits.maxEntries} entries`);
  }

  const slots: {
    anki21: number | null;
    anki2: number | null;
    anki21b: number | null;
    manifest: number | null;
  } = { anki21: null, anki2: null, anki21b: null, manifest: null };
  const numericMedia = new Set<string>();
  let totalUncompressed = 0;

  for (let index = 0; index < archive.length; index += 1) {
    const entry = archive.entry(index);
    const name = entry.name;
    if (!isSafeZipEntryName(name)) {
      throw validationError(APKG_ERROR_INVALID_ARCHIVE, `APKG contains an unsafe zip entry path: ${name}`);
    }
    if (entry.declaredSize > limits.maxEntryBytes) {
      throw limitError(`APKG entry ${name} exceeds the ${limits.maxEntryBytes} byte limit`);
    }
    totalUncompressed += entry.declaredSize;
    if (!Number.isSafeInteger(totalUncompressed)) {
      throw limitError('APKG uncompressed size overflow');
    }
    if (totalUncompressed > limits.maxTotalUncompressedBytes) {
      throw limitError(
        `APKG uncompressed content exceeds the ${limits.maxTotalUncompressedBytes} byte limit`,
      );
    }

    switch (name) {
      case 'collection.anki21':
        setUniqueEntry(slots, 'anki21', index, name);
        break;
      case 'collection.anki2':
        setUniqueEntry(slots, 'anki2', index, name);
        break;
      case 'collection.anki21b':
        setUniqueEntry(slots, 'anki21b', index, name);
        break;
      case 'media':
        setUniqueEntry(slots, 'manifest', index, name);
        break;
      default:
        if (isNumericMediaName(name) && numericMedia.has(name)) {
          throw validationError(APKG_ERROR_INVALID_ARCHIVE, `APKG contains duplicate media entry ${name}`);
        }
        if (isNumericMediaName(name)) numericMedia.add(name);
        break;
    }
  }

  // 集合优先级：legacy anki21 → 现代 anki21b → anki2。
  // 现代包里的 collection.anki2 只是“请升级 Anki”占位库，anki21b 必须先于 anki2；
  // 同时携带 legacy anki21 时仍优先走成熟的 legacy 路径。
  let collectionIndex: number;
  let modernPackage: boolean;
  if (slots.anki21 !== null) {
    collectionIndex = slots.anki21;
    modernPackage = false;
  } else if (slots.anki21b !== null) {
    collectionIndex = slots.anki21b;
    modernPackage = true;
  } else if (slots.anki2 !== null) {
    collectionIndex = slots.anki2;
    modernPackage = false;
  } else {
    throw validationError(
      APKG_ERROR_COLLECTION_MISSING,
      'APKG does not contain collection.anki21, collection.anki21b or collection.anki2',
    );
  }

  const encodedCollection = readZipEntryBounded(
    archive,
    collectionIndex,
    limits.maxCollectionBytes,
    'collection database',
  );
  const collectionBytes = decodeCollection(
    encodedCollection,
    limits.maxCollectionBytes,
    predecoded.get(collectionIndex),
  );

  const declaredMedia = new Set<string>();
  const manifestEntries = new Map<string, string>();
  const mediaWarnings: string[] = [];
  let manifestUnparsed = false;
  if (slots.manifest !== null) {
    const manifest = readZipEntryBounded(
      archive,
      slots.manifest,
      MAX_MEDIA_MANIFEST_BYTES,
      'media manifest',
    );
    if (modernPackage) {
      // 现代包媒体清单是 zstd + protobuf（MediaEntries）；
      // 解析失败降级为“无媒体导入”，不阻断卡片导入。
      try {
        for (const [key, value] of parseModernMediaManifest(
          manifest,
          predecoded.get(slots.manifest),
        )) manifestEntries.set(key, value);
      } catch (error) {
        manifestUnparsed = true;
        mediaWarnings.push(
          `现代 APKG 媒体清单解析失败，本次导入跳过全部媒体: ${errorMessage(error)}`,
        );
      }
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(decodeUtf8Lossy(manifest)) as unknown;
      } catch (error) {
        throw validationError(
          APKG_ERROR_INVALID_ARCHIVE,
          `APKG media manifest is invalid JSON: ${errorMessage(error)}`,
        );
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw validationError(
          APKG_ERROR_INVALID_ARCHIVE,
          'APKG media manifest is invalid JSON: invalid type: expected map',
        );
      }
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value !== 'string') {
          throw validationError(
            APKG_ERROR_INVALID_ARCHIVE,
            'APKG media manifest is invalid JSON: invalid type: expected string',
          );
        }
        manifestEntries.set(key, value);
      }
    }
    for (const key of manifestEntries.keys()) {
      if (!isNumericMediaName(key)) {
        throw validationError(
          APKG_ERROR_INVALID_ARCHIVE,
          `APKG media manifest contains an invalid key: ${key}`,
        );
      }
      declaredMedia.add(key);
    }
  }
  for (const key of numericMedia) declaredMedia.add(key);

  // 媒体导入：仅当调用方提供媒体目录时进行；未提供时保持旧行为（全部计入 skipped）。
  const skipTracker = new MediaSkipTracker();
  let mediaPaths = new Map<string, string>();
  let mediaImported = 0;
  if (mediaDir !== null) {
    if (manifestUnparsed) {
      // 清单不可解析时无法知道数字条目对应的真实文件名，按 zip 键统计。
      const keys = [...declaredMedia].sort(compareUtf8);
      for (const key of keys) skipTracker.record(MEDIA_SKIP_REASON_MANIFEST_UNPARSED, key);
      mediaPaths = new Map();
      mediaImported = 0;
    } else {
      const extracted = extractDeclaredMedia(
        archive,
        manifestEntries,
        mediaDir,
        limits,
        mediaWarnings,
        skipTracker,
        modernPackage,
        runtime.logger,
        predecoded,
      );
      mediaPaths = extracted.mediaPaths;
      mediaImported = extracted.importedKeys;
      // 包内存在但清单未声明的数字条目：无文件名可用，结构化记为孤儿条目。
      const orphans = [...numericMedia]
        .filter((key) => !manifestEntries.has(key))
        .sort(compareUtf8);
      for (const key of orphans) {
        mediaWarnings.push(`包内数字媒体条目未出现在 media 清单中，已跳过: ${key}`);
        skipTracker.record(MEDIA_SKIP_REASON_ORPHAN_ENTRY, key);
      }
    }
  } else {
    const names = [...declaredMedia]
      .map((key) => manifestEntries.get(key) ?? key)
      .sort(compareUtf8);
    for (const name of names) skipTracker.record(MEDIA_SKIP_REASON_IMPORT_DISABLED, name);
    mediaPaths = new Map();
    mediaImported = 0;
  }
  const mediaSkipped = Math.max(0, declaredMedia.size - mediaImported);
  const mediaReport: ApkgMediaReport = {
    declared: declaredMedia.size,
    imported: mediaImported,
    skipped: mediaSkipped,
    skips: skipTracker.intoSkips(),
    mediaDir: mediaDir !== null && declaredMedia.size > 0 ? mediaDir : null,
  };

  const collectionPath = writeTemporaryCollection(runtime.tempDir, collectionBytes);
  let packageResult: ParsedPackage;
  try {
    packageResult = parseCollectionDatabase(
      runtime,
      collectionPath,
      limits.maxMaterializedCardBytes,
      mediaPaths,
      modernPackage,
    );
  } finally {
    try {
      ankiLocalRuntime().remove(collectionPath);
    } catch (error) {
      runtime.logger.warn(`[apkg_import] 清理临时集合文件失败: ${ioErrorText(error)}`);
    }
  }

  packageResult.mediaSkipped = mediaSkipped;
  packageResult.mediaImported = mediaImported;
  packageResult.mediaReport = mediaReport;
  packageResult.warnings.push(...mediaWarnings);
  return packageResult;
}

function writeTemporaryCollection(tempDir: string, bytes: Uint8Array): string {
  try {
    ankiLocalRuntime().mkdirp(tempDir);
  } catch (error) {
    throw fileError(`Failed to create temporary APKG collection file: ${ioErrorText(error)}`);
  }
  const filePath = path.join(tempDir, `apkg_collection_${globalThis.crypto.randomUUID()}.anki2`);
  try {
    ankiLocalRuntime().writeBytes(filePath, bytes);
  } catch (error) {
    throw fileError(`Failed to write temporary APKG collection file: ${ioErrorText(error)}`);
  }
  return filePath;
}
