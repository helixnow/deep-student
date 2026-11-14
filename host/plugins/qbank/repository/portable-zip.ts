/**
 * Reading a portable question-bank package (authoring.rs:198-220) without Node modules: the central
 * directory comes from the portable ZIP core (`zip 0.6.6` parsing and `ZipError` Display texts); entry
 * data follows `ZipArchive::by_index` + `read_to_end` (flate2 1.1.9 deflate, CRC checked only at EOF).
 */
import {
  ZipFormatError, ZipReader, crc32Update, memoryZipSource, toReadableStream, webZipCodec, type ZipEntry,
} from '../../../platform/zip/core/index.ts';
import { ExportValidation, PORTABLE_LIMIT_BYTES } from './portable-shared.ts';

export type PathFlavor = 'darwin' | 'win32' | 'linux';

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const FLAG_ENCRYPTED = 0x0001;

/** `ZipFileData::enclosed_name`（zip 0.6.6 read.rs）按宿主 `Path::components` 判定。 */
export function hasEnclosedName(name: string, platform: PathFlavor): boolean {
  if (name.includes('\0')) return false;
  const windows = platform === 'win32';
  if (windows ? /^([A-Za-z]:|[\\/])/.test(name) : name.startsWith('/')) return false;
  let depth = 0;
  for (const part of name.split(windows ? /[\\/]/ : '/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (depth === 0) return false;
      depth -= 1;
    } else {
      depth += 1;
    }
  }
  return true;
}

/**
 * `by_index_with_optional_password`：加密标志 → `find_content`（本地头签名，`Take` 截取压缩数据，
 * 越过文件尾时少读）→ `make_crypto_reader`（压缩方法）。
 */
function byIndex(archive: Uint8Array, entry: ZipEntry): Uint8Array {
  if ((entry.flags & FLAG_ENCRYPTED) !== 0) {
    throw new ZipFormatError('UnsupportedArchive', 'Password required to decrypt file');
  }
  const at = entry.localHeaderOffset;
  const header = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  if (at + 4 > archive.length) throw new ZipFormatError('Io', 'failed to fill whole buffer');
  if (header.getUint32(at, true) !== LOCAL_FILE_HEADER_SIGNATURE) {
    throw new ZipFormatError('InvalidArchive', 'Invalid local file header');
  }
  if (at + 30 > archive.length) throw new ZipFormatError('Io', 'failed to fill whole buffer');
  const start = at + 30 + header.getUint16(at + 26, true) + header.getUint16(at + 28, true);
  if (entry.compression === 'unsupported') {
    throw new ZipFormatError('UnsupportedArchive', 'Compression method not supported');
  }
  return archive.subarray(Math.min(start, archive.length), Math.min(start + entry.compressedSize, archive.length));
}

interface InflateBudget { remaining: number }

function spend(budget: InflateBudget, bytes: number): void {
  // RUST-FIX(RF-W03-portable-zip-actual-size-bound): Rust 只累计中央目录声明的大小，每个条目再 take(200 MiB + 1)；声明大小撒谎的条目可绕过总量上限，这里实际解压量也计入同一上限。
  budget.remaining -= bytes;
  if (budget.remaining < 0) throw new ExportValidation('便携包解压超过安全限制');
}

function concat(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** flate2 `DeflateDecoder`：损坏数据为 `corrupt deflate stream`；输入耗尽时返回 `Ok(0)`，交给 CRC 校验。 */
async function inflateRaw(compressed: Uint8Array, budget: InflateBudget): Promise<Uint8Array> {
  const reader = toReadableStream([compressed]).pipeThrough(webZipCodec.inflateRaw()).getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    let next: ReadableStreamReadResult<Uint8Array>;
    try {
      next = await reader.read();
    } catch (error) {
      if (error instanceof TypeError && (error as { code?: unknown }).code === 'Z_BUF_ERROR') break;
      throw new ZipFormatError('Io', 'corrupt deflate stream');
    }
    if (next.done) break;
    try {
      spend(budget, next.value.length);
    } catch (error) {
      await reader.cancel();
      throw error;
    }
    chunks.push(next.value);
    length += next.value.length;
  }
  return concat(chunks, length);
}

/**
 * authoring.rs:198-220：每个条目先 `by_index`（目录也校验本地头与压缩方法），目录跳过；
 * 无 `enclosed_name` 或重名、声明大小累计超过上限时报 Validation；其余 zip 错误原样上抛
 * （调用方 `map_err(error)` → Database）。
 */
export async function readPortableEntries(bytes: Uint8Array, platform: PathFlavor,
  limit = PORTABLE_LIMIT_BYTES): Promise<Map<string, Uint8Array>> {
  const reader = await ZipReader.open(memoryZipSource(bytes));
  const entries = new Map<string, Uint8Array>();
  const budget: InflateBudget = { remaining: limit };
  let declared = 0;
  for (const entry of reader.entries) {
    const compressed = byIndex(bytes, entry);
    if (entry.isDirectory) continue;
    if (!hasEnclosedName(entry.name, platform) || entries.has(entry.name)) {
      throw new ExportValidation('便携包包含无效或重复路径');
    }
    declared += entry.size;
    if (declared > limit) throw new ExportValidation('便携包解压超过安全限制');
    let data: Uint8Array;
    if (entry.compression === 'stored') {
      spend(budget, compressed.length);
      data = compressed.slice();
    } else {
      data = await inflateRaw(compressed, budget);
    }
    if (crc32Update(data, 0) !== entry.crc32) throw new ZipFormatError('Io', 'Invalid checksum');
    entries.set(entry.name, data);
  }
  return entries;
}
