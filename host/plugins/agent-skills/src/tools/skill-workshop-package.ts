/**
 * Skill workshop package model: path layout, size limits, content validation
 * and the deterministic package hashes from
 * `src-tauri/crates/dstu-agent/src/chat_v2/tools/skill_workshop_executor.rs`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assessSkillPackageRisk } from '../skill-package.ts';
import { AGENT_INSTALLED_MARKER } from './skill-install-executor.ts';

export const SKILL_FILE_NAME = 'SKILL.md';
export const MAX_CONTENT_BYTES = 40_000;
export const MAX_PACKAGE_FILES = 256;
export const MAX_PACKAGE_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_PACKAGE_TOTAL_BYTES = 32 * 1024 * 1024;

/** D3: safe values stay numbers; larger u64/usize values remain exact internally. */
export type WorkshopUnsigned = number | bigint;
export const U64_MAX = (1n << 64n) - 1n;
export function exactUnsigned(value: bigint): WorkshopUnsigned {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
}

export function workshopJson(value: unknown, space?: number): string {
  // Persist JSON number tokens, not quoted decimal strings (serde u64/usize).
  const json = JSON as JSON & { rawJSON(text: string): unknown };
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? json.rawJSON(item.toString()) : item, space);
}

export interface ProposalFileMeta {
  path: string;
  sha256: string;
  size: WorkshopUnsigned;
}

export interface PackageFile {
  path: string;
  bytes: Buffer;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function normalizeWorkshopSha256(raw: string, field: string): string {
  const normalized = raw.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`${field} must be a 64-character SHA-256 hex digest`);
  }
  return normalized;
}

export function updateLengthPrefixed(hasher: ReturnType<typeof createHash>, value: string): void {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(bytes.length));
  hasher.update(length);
  hasher.update(bytes);
}

export function updateU64(hasher: ReturnType<typeof createHash>, value: WorkshopUnsigned): void {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(value));
  hasher.update(bytes);
}

/** Deterministic package hash over sorted `(path, bytes)` pairs. */
export function packageSha256(files: readonly PackageFile[]): string {
  const ordered = [...files].sort((left, right) => Buffer.compare(
    Buffer.from(left.path), Buffer.from(right.path),
  ));
  const hasher = createHash('sha256');
  for (const file of ordered) {
    updateLengthPrefixed(hasher, file.path);
    updateU64(hasher, file.bytes.length);
    hasher.update(file.bytes);
  }
  return hasher.digest('hex');
}

export function packageFileMeta(files: readonly PackageFile[]): ProposalFileMeta[] {
  return files
    .map(file => ({ path: file.path, sha256: sha256Hex(file.bytes), size: file.bytes.length }))
    .sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
}

export function normalizePackagePath(raw: string): string {
  if (raw === '' || raw.includes('\\') || path.isAbsolute(raw)) {
    throw new Error(`Invalid skill package path: ${JSON.stringify(raw)}`);
  }
  const parts: string[] = [];
  for (const part of raw.split('/')) {
    if (part === '' || part === '.' || part === '..') {
      throw new Error(`Invalid skill package path: ${JSON.stringify(raw)}`);
    }
    parts.push(part);
  }
  const normalized = parts.join('/');
  const lower = normalized.toLowerCase();
  const allowed = lower === SKILL_FILE_NAME.toLowerCase()
    || ['scripts/', 'references/', 'assets/', 'agents/', 'templates/', 'examples/']
      .some(prefix => lower.startsWith(prefix))
    || lower === '_meta.json'
    || lower === 'skill-card.md'
    || (!lower.includes('/')
      && (lower === 'readme'
        || lower.startsWith('readme.')
        || lower === 'license'
        || lower.startsWith('license.')));
  if (!allowed) {
    throw new Error(
      `Skill package path '${raw}' is outside the supported Agent Skills package layout `
      + '(SKILL.md, scripts/, references/, assets/, agents/, templates/, examples/, README*, '
      + 'LICENSE*, _meta.json, skill-card.md)',
    );
  }
  return lower === SKILL_FILE_NAME.toLowerCase() ? SKILL_FILE_NAME : normalized;
}

export function validateContent(content: string): void {
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.length === 0) throw new Error('content must not be empty');
  if (bytes.length > MAX_CONTENT_BYTES) {
    throw new Error(`content exceeds ${MAX_CONTENT_BYTES} byte limit (got ${bytes.length} bytes)`);
  }
  const lines = content.trimStart().split(/\r?\n/);
  if (lines[0] !== '---' || !lines.slice(1).includes('---')) {
    throw new Error(
      'content must contain a complete YAML frontmatter block delimited by exact --- lines',
    );
  }
}

/** Normalize, limit-check, dedupe and sort a proposed package. */
export function validatePackageFiles(files: readonly PackageFile[]): PackageFile[] {
  if (files.length === 0) throw new Error('files must contain SKILL.md');
  if (files.length > MAX_PACKAGE_FILES) {
    throw new Error(`Skill package exceeds ${MAX_PACKAGE_FILES} file limit`);
  }
  const seen = new Set<string>();
  const normalizedFiles: PackageFile[] = [];
  let total = 0;
  for (const file of files) {
    const normalized = normalizePackagePath(file.path);
    const folded = normalized.toLowerCase();
    if (seen.has(folded)) {
      throw new Error(`Skill package contains duplicate path: ${normalized}`);
    }
    seen.add(folded);
    if (file.bytes.length > MAX_PACKAGE_FILE_BYTES) {
      throw new Error(
        `Skill package file '${normalized}' exceeds ${MAX_PACKAGE_FILE_BYTES} byte limit`,
      );
    }
    total += file.bytes.length;
    if (!Number.isSafeInteger(total)) throw new Error('Skill package total size overflow');
    if (total > MAX_PACKAGE_TOTAL_BYTES) {
      throw new Error(`Skill package exceeds ${MAX_PACKAGE_TOTAL_BYTES} byte total limit`);
    }
    normalizedFiles.push({ path: normalized, bytes: file.bytes });
  }
  const skill = normalizedFiles.find(file => file.path === SKILL_FILE_NAME);
  if (skill === undefined) throw new Error('Skill package must contain SKILL.md');
  let skillText: string;
  try { skillText = new TextDecoder('utf-8', { fatal: true }).decode(skill.bytes); }
  catch (error) { throw new Error(`SKILL.md is not valid UTF-8: ${errorText(error)}`); }
  validateContent(skillText);
  return normalizedFiles.sort((left, right) => Buffer.compare(
    Buffer.from(left.path), Buffer.from(right.path),
  ));
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

function decodeBase64(raw: string): Buffer {
  const encoded = raw.trim();
  if (encoded.length % 4 !== 0 || !BASE64_PATTERN.test(encoded)) {
    throw new Error('Invalid base64');
  }
  return Buffer.from(encoded, 'base64');
}

export function packageFilesFromArgs(args: unknown): [PackageFile[], boolean] {
  const record = asRecord(args);
  if ('files' in record) {
    const rawFiles = record.files;
    if (!Array.isArray(rawFiles)) throw new Error('Invalid files list: expected an array');
    const files: PackageFile[] = rawFiles.map((entry) => {
      const input = asRecord(entry);
      const inputPath = typeof input.path === 'string' ? input.path : '';
      const hasContent = typeof input.content === 'string';
      const hasBase64 = typeof input.content_base64 === 'string'
        || typeof input.contentBase64 === 'string';
      if (hasContent && hasBase64) {
        throw new Error(
          `File '${inputPath}' must provide exactly one of content or content_base64`,
        );
      }
      if (!hasContent && !hasBase64) {
        throw new Error(`File '${inputPath}' must provide content or content_base64`);
      }
      let bytes: Buffer;
      if (hasContent) bytes = Buffer.from(input.content as string, 'utf8');
      else {
        const encoded = (input.content_base64 ?? input.contentBase64) as string;
        try { bytes = decodeBase64(encoded); }
        catch (error) {
          throw new Error(`Invalid base64 content for '${inputPath}': ${errorText(error)}`);
        }
      }
      return { path: inputPath, bytes };
    });
    return [validatePackageFiles(files), true];
  }
  const content = record.content;
  if (typeof content !== 'string') throw new Error('content or files is required');
  validateContent(content);
  return [[{ path: SKILL_FILE_NAME, bytes: Buffer.from(content, 'utf8') }], false];
}

/** Walk a package directory rejecting symlinks; excludes the install marker. */
export function readPackageDirectory(root: string): PackageFile[] {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(root); }
  catch { throw new Error(`Skill directory does not exist: ${JSON.stringify(root)}`); }
  if (!stat.isDirectory()) throw new Error(`Skill directory does not exist: ${JSON.stringify(root)}`);
  const files: PackageFile[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Skill packages may not contain symlinks: ${JSON.stringify(target)}`);
      }
      if (entry.isDirectory()) { walk(target); continue; }
      if (!entry.isFile()) continue;
      const relative = path.relative(root, target).replaceAll('\\', '/');
      if (relative === AGENT_INSTALLED_MARKER) continue;
      try {
        files.push({ path: relative, bytes: fs.readFileSync(target) });
      } catch (error) {
        throw new Error(`Failed to read package file: ${errorText(error)}`);
      }
    }
  };
  walk(root);
  return validatePackageFiles(files);
}

export function workshopRisk(files: readonly PackageFile[]): [string, string[]] {
  return assessSkillPackageRisk(files.map(file => ({
    relative: file.path, bytes: file.bytes,
  })));
}
