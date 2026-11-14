/** `import_portable` (question_export_service/authoring.rs:187-322). */
import { decodeBase64Standard, parseJsonDocumentBytes } from '../../../platform/util/portable.ts';
import { toHex } from '../../../platform/crypto/encoding.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { BlobRepository, FileRepository } from '../../vfs-repos/api.ts';
import type { QuestionDocument } from '../api.ts';
import { validateDocument } from '../src/document.ts';
import { nodeToValue } from '../src/raw-json-number.ts';
import { questionDocument } from './authoring-decode.ts';
import { ExportNotFound, ExportValidation, PORTABLE_LIMIT_BYTES, collectHashes } from './portable-shared.ts';
import { readPortableEntries, type PathFlavor } from './portable-zip.ts';

export interface ImportedPortable { document: QuestionDocument; metadata: Record<string, unknown> }

/** L11 owns `blobs`/`files`; qbank only calls its repositories on the same connection. */
export interface PortableAssetRepos { readonly blobs: BlobRepository; readonly files: FileRepository }

/** `serde_json::from_slice::<Value>(..).map_err(error)`. */
function parseSlice(bytes: Uint8Array): Record<string, unknown> {
  try {
    return nodeToValue(parseJsonDocumentBytes(bytes)) as Record<string, unknown>;
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
}

/** serde_json `value["key"]` on a non-object is `Null`. */
function fieldsOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Entries come from `readPortableEntries`, which never hands out SharedArrayBuffer-backed views. */
async function sha256Hex(data: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource)));
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte);
}

/** authoring.rs:258-263：`image::guess_format`（image 0.24.9 MAGIC_BYTES，WebP 只认 `RIFF` 前缀）。 */
function guessImageMime(bytes: Uint8Array): string {
  if (startsWith(bytes, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) return 'image/png';
  if (startsWith(bytes, [0xFF, 0xD8, 0xFF])) return 'image/jpeg';
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46])) return 'image/webp';
  return 'application/octet-stream';
}

function imageExtension(mime: string): string {
  return mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : 'webp';
}

export async function importPortable(db: DatabaseHandle, blobsDir: string, repos: PortableAssetRepos,
  encoded: string, platform: PathFlavor): Promise<ImportedPortable> {
  // authoring.rs:192-194：严格 STANDARD Base64，失败 `map_err(error)` → Database。
  const decodedBase64 = decodeBase64Standard(encoded);
  if (decodedBase64.error !== undefined) throw new Error(decodedBase64.error);
  const bytes = decodedBase64.bytes;
  if (bytes.length > PORTABLE_LIMIT_BYTES) throw new ExportValidation('便携题库超过200MB安全限制');
  const entries = await readPortableEntries(bytes, platform);
  const manifestRaw = entries.get('manifest.json');
  if (manifestRaw === undefined) throw new ExportValidation('缺少资产清单');
  const manifest = fieldsOf(parseSlice(manifestRaw));
  if (manifest.schema_version !== 2) throw new ExportValidation('便携包版本不支持');
  const documentRaw = entries.get('document.json');
  if (documentRaw === undefined) throw new ExportValidation('缺少题目文档');
  const document = parseSlice(documentRaw);
  const required = new Set<string>();
  collectHashes(document, required);
  const verified = new Set<string>();
  if (!Array.isArray(manifest.assets)) throw new ExportValidation('资产清单无效');
  for (const item of manifest.assets as unknown[]) {
    const asset = fieldsOf(item);
    const hash = asset.hash;
    if (typeof hash !== 'string') throw new ExportValidation('资产缺少hash');
    if (asset.path !== `assets/${hash}` || verified.has(hash)) throw new ExportValidation('资产路径或哈希重复');
    verified.add(hash);
    const data = entries.get(`assets/${hash}`);
    if (data === undefined) throw new ExportNotFound('便携包缺少声明资产');
    if (await sha256Hex(data) !== hash) throw new ExportValidation('便携包资产哈希校验失败');
  }
  if (required.size !== verified.size || [...required].some(hash => !verified.has(hash))) {
    throw new ExportValidation('便携包内容与资产清单不一致');
  }
  const images = new Map<string, Record<string, unknown>>();
  for (const hash of verified) {
    const data = entries.get(`assets/${hash}`)!;
    const mime = guessImageMime(data);
    // authoring.rs:265-285: VfsBlobRepo::store_blob(.., Some(mime), None) then VfsFileRepo::create_file.
    const blob = repos.blobs.storeBlob(db, blobsDir, data, mime, null);
    if (mime.startsWith('image/')) {
      const name = `figure_${hash}.${imageExtension(mime)}`;
      const file = repos.files.createFile(db, blob.hash, name, data.length, 'image', mime, blob.hash, null);
      images.set(hash, { id: file.id, name, mime, hash: blob.hash });
    }
  }
  for (const field of ['questions', 'materials']) {
    for (const item of Array.isArray(document[field]) ? document[field] as Record<string, unknown>[] : []) {
      const list = Array.isArray(item.images) ? item.images as Record<string, unknown>[] : [];
      item.images = list.map(image => {
        const hash = typeof image.hash === 'string' ? image.hash : '';
        const replacement = images.get(hash);
        if (replacement === undefined) throw new ExportValidation('题目配图资产类型无效');
        return { ...replacement, ...(image.role === undefined ? {} : { role: image.role }),
          ...(image.name === undefined ? {} : { name: image.name }) };
      });
      if (field === 'materials') {
        item.figures = Array.isArray(item.figures) ? item.figures : [];
        item.source_refs = Array.isArray(item.source_refs) ? item.source_refs : [];
        item.content = typeof item.content === 'string' ? item.content : '';
        continue;
      }
      const question = item;
      question.group_id = question.group_id ?? null;
      question.original_label = question.original_label ?? null;
      question.section_path = Array.isArray(question.section_path) ? question.section_path : [];
      question.options = question.options ?? null;
      question.answer = question.answer ?? null;
      question.explanation = question.explanation ?? null;
      question.structured_data = question.structured_data ?? null;
      question.difficulty = question.difficulty ?? null;
      question.tags = Array.isArray(question.tags) ? question.tags : [];
      question.source_refs = Array.isArray(question.source_refs) ? question.source_refs : [];
      question.answer_source_refs = Array.isArray(question.answer_source_refs) ? question.answer_source_refs : [];
      question.figures = Array.isArray(question.figures) ? question.figures : [];
      question.answer_origin = question.answer_origin ?? null;
      question.smiles = question.smiles ?? null;
      question.smiles_caption = question.smiles_caption ?? null;
      question.parent_id = question.parent_id ?? null;
      const variant = question.variant_parent_local_id;
      question.parent_local_id = question.parent_local_id ?? (typeof variant === 'string' ? variant : null);
      delete question.variant_parent_local_id;
      question.source_ref = question.source_ref ?? null;
    }
  }
  // authoring.rs:316-318：`document["sources"]` 缺失为 Null；typed 解码失败 `map_err(error)` → Database；再 validate。
  const metadata = { sources: document.sources ?? null, pages: document.source_pages ?? null,
    source_format: 'portable_v2' };
  const typed = questionDocument(document, '');
  validateDocument(typed);
  return { document: typed, metadata };
}
