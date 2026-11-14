/** Canonical question-bank interchange export (question_export_service/authoring.rs). */
import { toBase64, utf8Encode } from '../../../platform/crypto/encoding.ts';
import { sha256HexSync } from '../../../platform/crypto/sync.ts';
import { concatBytes } from '../../../platform/zip/core/format.ts';
import * as path from '../../../platform/util/path.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { qbankLocalRuntime } from '../src/local-runtime.ts';
import type { Question, QuestionImage, SourceRef } from '../api.ts';
import { listQuestions } from './questions.ts';
import { valueFromStr } from '../src/raw-json-number.ts';
import { ExportNotFound, ExportValidation, PORTABLE_LIMIT_BYTES, collectHashes } from './portable-shared.ts';

export interface ExportMaterial {
  local_id: string; content: string; images: QuestionImage[]; source_refs: SourceRef[];
}
export interface ExportGroup {
  local_id: string; label: string; material_ids: string[]; question_ids: string[];
}
export interface ExportDocument {
  schema_version: number; mode: string; materials: ExportMaterial[]; groups: ExportGroup[];
  questions: Record<string, unknown>[]; coverage: unknown[]; issues: unknown[]; unmatched_answers: unknown[];
  sources: Record<string, unknown>[]; source_pages: Record<string, unknown>[];
}
export interface PortableExport { base64: string; name: string }

/** `serde_json::from_str::<Value>(..).map_err(error)`：数字原文保留，错误为 serde_json Display。 */
function parse<T>(raw: string): T {
  try {
    return valueFromStr(raw) as T;
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
}


function loadAllQuestions(db: SqlExecutor, examId: string): Question[] {
  const questions: Question[] = [];
  let page = 1;
  for (;;) {
    const result = listQuestions(db, examId, {}, page, 100);
    questions.push(...result.questions);
    if (!result.has_more) break;
    page += 1;
  }
  return questions;
}

export function exportDocument(db: SqlExecutor, examId: string): ExportDocument {
  const questions = loadAllQuestions(db, examId);
  const materials = db.all<{ id: string; content: string; images_json: string; source_refs_json: string }>(
    `SELECT id, content, images_json, source_refs_json FROM qbank_materials
     WHERE exam_id = ?1 AND deleted_at IS NULL ORDER BY created_at, id`, [examId])
    .map(row => ({
      local_id: row.id, content: row.content,
      images: parse<QuestionImage[]>(row.images_json),
      source_refs: parse<SourceRef[]>(row.source_refs_json),
    }));
  const groups: ExportGroup[] = [];
  for (const row of db.all<{ id: string; label: string }>(
    `SELECT id, label FROM qbank_groups WHERE exam_id = ?1 AND deleted_at IS NULL
     ORDER BY position, id`, [examId])) {
    const materialIds = db.all<{ material_id: string }>(
      `SELECT l.material_id FROM qbank_group_materials l
       JOIN qbank_materials m ON m.id = l.material_id
       WHERE l.group_id = ?1 AND l.deleted_at IS NULL AND m.deleted_at IS NULL
       ORDER BY l.position, l.id`, [row.id]).map(link => link.material_id);
    const questionIds = db.all<{ id: string }>(
      `SELECT id FROM questions WHERE group_id = ?1 AND deleted_at IS NULL
       ORDER BY group_position, id`, [row.id]).map(question => question.id);
    if (questionIds.length > 0) {
      groups.push({ local_id: row.id, label: row.label, material_ids: materialIds, question_ids: questionIds });
    }
  }
  const sources: Record<string, unknown>[] = [];
  const pages: Record<string, unknown>[] = [];
  for (const row of db.all<{ id: string; descriptor_json: string }>(
    `SELECT id, descriptor_json FROM qbank_sources WHERE exam_id = ?1 AND deleted_at IS NULL
     ORDER BY created_at, id`, [examId])) {
    const descriptor = parse<Record<string, unknown>>(row.descriptor_json);
    descriptor.source_id = row.id;
    const rawPages = Array.isArray(descriptor.pages) ? descriptor.pages as Record<string, unknown>[] : [];
    for (const rawPage of rawPages) {
      const page = { ...rawPage, source_id: row.id };
      pages.push(page);
    }
    sources.push(descriptor);
  }
  const items = questions.map(question => {
    const provenance = db.pluck<string>('SELECT provenance_json FROM questions WHERE id = ?1', [question.id]);
    let data: Record<string, unknown> | null = null;
    if (provenance !== undefined && provenance !== null) {
      try { data = valueFromStr(provenance) as Record<string, unknown> | null; } catch { data = null; }
    }
    const array = (key: string): unknown[] => Array.isArray(data?.[key]) ? data[key] as unknown[] : [];
    return {
      local_id: question.id,
      group_id: question.group_id,
      original_label: question.question_label,
      content: question.content,
      question_type: question.question_type,
      options: question.options,
      answer: question.answer,
      explanation: question.explanation,
      structured_data: question.structured_data,
      difficulty: question.difficulty,
      tags: question.tags,
      images: question.images,
      source_refs: array('source_refs'),
      answer_source_refs: array('answer_source_refs'),
      section_path: array('section_path'),
      source_ref: question.source_ref,
      answer_origin: question.answer_origin,
      variant_parent_local_id: question.parent_id,
    };
  });
  return {
    schema_version: 2, mode: 'extract', materials, groups, questions: items,
    coverage: [], issues: [], unmatched_answers: [], sources, source_pages: pages,
  };
}


function blobPath(db: SqlExecutor, blobsDir: string, hash: string): string {
  const relative = db.pluck<string>('SELECT relative_path FROM blobs WHERE hash = ?1', [hash]);
  if (relative === undefined) throw new ExportNotFound(`导出缺少源资产: ${hash}`);
  return path.join(blobsDir, relative);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xFF]! ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

interface ZipEntry { name: string; data: Uint8Array }

const UTC_FLAG = 0x0800;

function u16(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(offset, value, true);
}

function u32(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value, true);
}

/** 与 Rust `zip 0.6`（deflated）逐字节一致的本地头 + 中央目录；压缩经本地运行时（`node:zlib`）。 */
export function buildZip(entries: ZipEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = utf8Encode(entry.name);
    const compressed = qbankLocalRuntime().deflateRaw(entry.data);
    const crc = crc32(entry.data);
    const local = new Uint8Array(30);
    u32(local, 0, 0x04034b50);
    u16(local, 4, 20);
    u16(local, 6, UTC_FLAG);
    u16(local, 8, 8);
    u16(local, 10, 0);
    u16(local, 12, 0x21);
    u32(local, 14, crc);
    u32(local, 18, compressed.length);
    u32(local, 22, entry.data.length);
    u16(local, 26, name.length);
    u16(local, 28, 0);
    chunks.push(local, name, compressed);
    const directory = new Uint8Array(46);
    u32(directory, 0, 0x02014b50);
    u16(directory, 4, 20);
    u16(directory, 6, 20);
    u16(directory, 8, UTC_FLAG);
    u16(directory, 10, 8);
    u16(directory, 12, 0);
    u16(directory, 14, 0x21);
    u32(directory, 16, crc);
    u32(directory, 20, compressed.length);
    u32(directory, 24, entry.data.length);
    u16(directory, 28, name.length);
    u16(directory, 30, 0);
    u16(directory, 32, 0);
    u16(directory, 34, 0);
    u16(directory, 36, 0);
    u32(directory, 38, 0);
    u32(directory, 42, offset);
    central.push(directory, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralBytes = concatBytes(central);
  const end = new Uint8Array(22);
  u32(end, 0, 0x06054b50);
  u16(end, 4, 0);
  u16(end, 6, 0);
  u16(end, 8, entries.length);
  u16(end, 10, entries.length);
  u32(end, 12, centralBytes.length);
  u32(end, 16, offset);
  u16(end, 20, 0);
  return concatBytes([...chunks, centralBytes, end]);
}


function sha256(data: Uint8Array): string {
  return sha256HexSync(data);
}

export function exportPortable(db: SqlExecutor, blobsDir: string, examId: string): PortableExport {
  const document = exportDocument(db, examId);
  const all = new Set<string>();
  collectHashes(document, all);
  const assets = new Map<string, Uint8Array>();
  let total = 0;
  for (const hash of [...all].sort()) {
    const file = blobPath(db, blobsDir, hash);
    let bytes: Uint8Array;
    try {
      bytes = qbankLocalRuntime().readFile(file);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
    total += bytes.length;
    if (total > PORTABLE_LIMIT_BYTES) {
      throw new ExportValidation('便携题库超过200MB安全限制，请减少来源资产后导出');
    }
    if (sha256(bytes) !== hash) throw new ExportValidation('源资产哈希校验失败，已停止导出');
    assets.set(hash, bytes);
  }
  const manifest = {
    schema_version: 2,
    assets: [...assets.keys()].map(hash => ({ hash, path: `assets/${hash}` })),
  };
  const archive = buildZip([
    { name: 'document.json', data: utf8Encode(JSON.stringify(document)) },
    { name: 'manifest.json', data: utf8Encode(JSON.stringify(manifest)) },
    ...[...assets].map(([hash, bytes]) => ({ name: `assets/${hash}`, data: bytes })),
  ]);
  return { base64: toBase64(archive), name: `question-bank-${examId}.zip` };
}

export type { SqlExecutor };
