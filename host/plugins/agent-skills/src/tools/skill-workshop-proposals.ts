/**
 * Skill workshop proposal store: `<appData>/skill_proposals/<id>/PROPOSAL.json`
 * plus package files, the serde-compatible metadata codec, proposal ids and the
 * approval-scope revision check from
 * `src-tauri/crates/dstu-agent/src/chat_v2/tools/skill_workshop_executor.rs`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isPortableSkillPathComponent } from '../skill-package.ts';
import { JsonReader } from '../../../../platform/util/api.ts';
import {
  SKILL_FILE_NAME, U64_MAX, errorText, exactUnsigned, normalizePackagePath, packageFileMeta,
  packageSha256, sha256Hex, updateLengthPrefixed, updateU64, validatePackageFiles, workshopJson,
  type PackageFile, type ProposalFileMeta, type WorkshopUnsigned,
} from './skill-workshop-package.ts';

export const PROPOSALS_SUBDIR = 'skill_proposals';
export const PROPOSAL_META_FILE = 'PROPOSAL.json';

export interface ProposalMeta {
  proposalId: string;
  action: string;
  skillId: string;
  contentSha256: string;
  createdAt: string;
  sessionId: string;
  status: string;
  previousSha256?: string;
  packageSha256?: string;
  files: ProposalFileMeta[];
  previousPackageSha256?: string;
  previousFiles: ProposalFileMeta[];
  packageVersion: WorkshopUnsigned;
}

export interface ProposalFileInput {
  path: string;
  content?: string;
  contentBase64?: string;
}

export interface AgentWorkshopMarker {
  sourceKind: string;
  proposalId: string;
  contentSha256: string;
  packageSha256: string;
  packageVersion: WorkshopUnsigned;
  files: ProposalFileMeta[];
  previousPackageSha256?: string;
  installedAt: string;
  sessionId: string;
}

export interface WorkshopLogger {
  warn?(message: string): void;
}

/** `proposal_revision_sha256`: binds every field the approval scope names. */
export function proposalRevisionSha256(meta: ProposalMeta): string {
  const hasher = createHash('sha256');
  for (const field of [
    meta.proposalId, meta.action, meta.skillId, meta.contentSha256, meta.createdAt,
    meta.sessionId, meta.status, meta.previousSha256 ?? '', meta.packageSha256 ?? '',
    meta.previousPackageSha256 ?? '',
  ]) updateLengthPrefixed(hasher, field);
  updateU64(hasher, meta.packageVersion);
  for (const file of [...meta.files, ...meta.previousFiles]) {
    updateLengthPrefixed(hasher, file.path);
    updateLengthPrefixed(hasher, file.sha256);
    updateU64(hasher, file.size);
  }
  return hasher.digest('hex');
}

export function verifyApprovedProposal(
  meta: ProposalMeta,
  proposalFiles: readonly PackageFile[],
  expectedContentSha256: string,
  expectedProposalRevision: string,
): string {
  const actualRevision = proposalRevisionSha256(meta);
  if (actualRevision !== expectedProposalRevision) {
    throw new Error(
      `Proposal changed after approval scope was created: expected revision `
      + `${expectedProposalRevision}, got ${actualRevision}. Review the proposal again before applying.`,
    );
  }
  if (meta.contentSha256 !== expectedContentSha256) {
    throw new Error(
      `Proposal metadata content hash changed after approval scope was created: expected `
      + `${expectedContentSha256}, got ${meta.contentSha256}. Review the proposal again before applying.`,
    );
  }
  const skill = proposalFiles.find(file => file.path === SKILL_FILE_NAME);
  if (skill === undefined) throw new Error('Proposal package is missing SKILL.md');
  const actualSha256 = sha256Hex(skill.bytes);
  if (actualSha256 !== expectedContentSha256) {
    throw new Error(
      `Proposal SKILL.md changed after approval scope was created: expected `
      + `${expectedContentSha256}, got ${actualSha256}. Review the proposal again before applying.`,
    );
  }
  if (meta.packageSha256 !== undefined) {
    const actualPackageSha256 = packageSha256(proposalFiles);
    if (actualPackageSha256 !== meta.packageSha256) {
      throw new Error(
        `Proposal package changed after approval scope was created: expected `
        + `${meta.packageSha256}, got ${actualPackageSha256}. Review the proposal again before applying.`,
      );
    }
    if (workshopJson(packageFileMeta(proposalFiles)) !== workshopJson(meta.files)) {
      throw new Error(
        'Proposal file manifest changed after approval scope was created. '
        + 'Review the proposal again before applying.',
      );
    }
  }
  return actualSha256;
}

export function generateProposalId(
  now: Date = new Date(),
  suffix?: () => string,
): string {
  const random = suffix ?? (() => Array.from({ length: 4 }, () => {
    const code = 97 + Math.floor(Math.random() * 26);
    return String.fromCharCode(code);
  }).join(''));
  return `wp_${now.getTime()}_${random()}`;
}

export function validateProposalId(proposalId: string): void {
  const trimmed = proposalId.trim();
  if (trimmed === '') throw new Error('proposal_id must not be empty');
  const valid = trimmed.startsWith('wp_') && trimmed.length > 4
    && [...trimmed].every(ch => /[A-Za-z0-9_]/.test(ch));
  if (!valid) {
    throw new Error(
      `Invalid proposal_id '${proposalId}': expected wp_<timestamp>_<suffix>`,
    );
  }
}

export function validateWorkshopSkillId(skillId: string): void {
  const trimmed = skillId.trim();
  if (trimmed === '') throw new Error('skill_id must not be empty');
  if (!/^[\p{L}\p{N}_-]+$/u.test(trimmed) || !isPortableSkillPathComponent(trimmed)) {
    throw new Error(
      'skill_id must be a portable directory name containing only letters, numbers, '
      + 'hyphens, and underscores',
    );
  }
}

export function proposalDir(root: string, proposalId: string): string {
  return path.join(root, proposalId);
}

function metaPath(dir: string): string {
  return path.join(dir, PROPOSAL_META_FILE);
}

export function readProposalMeta(dir: string): ProposalMeta {
  let text: string;
  try { text = fs.readFileSync(metaPath(dir), 'utf8'); }
  catch (error) { throw new Error(`Failed to read ${PROPOSAL_META_FILE}: ${errorText(error)}`); }
  try {
    const reader = new JsonReader(text);
    const meta = decodeProposalMeta(reader);
    reader.end();
    return meta;
  }
  catch (error) { throw new Error(`Invalid ${PROPOSAL_META_FILE}: ${errorText(error)}`); }
}

// Mirrors the serde derives of `ProposalMeta` / `ProposalFileMeta` /
// `AgentWorkshopMarker` (skill_workshop_executor.rs:47-108) as driven by
// serde_json `deserialize_struct` (de.rs:1820-1866). Map form: known fields in
// input order with duplicate detection, unknown fields as `IgnoredAny`, then
// missing fields (`Option` without default → None). Sequence form (derive
// `visit_seq`): fields in declaration order; an exhausted sequence takes the
// field's explicit `#[serde(default)]` or fails with `invalid length`, then
// `end_seq` reports surplus elements without decoding them.
type SerdeField = 'string' | 'optionString' | 'u64' | 'usize' | 'files';
/** Field kind and serde fallback: `required` = no `#[serde(default)]`; otherwise the default value. */
type SerdeFieldSpec = readonly [name: string, kind: SerdeField, fallback: 'required' | { value: unknown }];

function serdeFieldValue(reader: JsonReader, kind: SerdeField): unknown {
  if (kind === 'string') return reader.readString();
  if (kind === 'optionString') return reader.readOptionNone() ? null : reader.readString();
  if (kind === 'u64' || kind === 'usize') return exactUnsigned(reader.readUnsigned(kind, U64_MAX));
  reader.beginArray();
  const files: ProposalFileMeta[] = [];
  while (reader.nextItem()) files.push(decodeProposalFileMeta(reader));
  return files;
}

function serdeStruct(reader: JsonReader, name: string, fields: readonly SerdeFieldSpec[]): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  if (reader.peekKind() === 'array') {
    reader.beginArray(`struct ${name}`);
    let open = true;
    fields.forEach(([key, kind, fallback], index) => {
      if (open && reader.nextItem()) { record[key] = serdeFieldValue(reader, kind); return; }
      open = false;
      if (fallback === 'required') {
        throw reader.error(`invalid length ${index}, expected struct ${name} with ${fields.length} elements`);
      }
      record[key] = fallback.value;
    });
    if (open) reader.endArray();
    return record;
  }
  reader.beginObject(`struct ${name}`);
  for (let key = reader.nextKey(); key !== null; key = reader.nextKey()) {
    const spec = fields.find(([field]) => field === key);
    if (spec === undefined) { reader.skipIgnoredValue(); continue; }
    if (Object.hasOwn(record, key)) throw reader.fieldError(`duplicate field \`${key}\``);
    record[key] = serdeFieldValue(reader, spec[1]);
  }
  for (const [key, kind, fallback] of fields) {
    if (Object.hasOwn(record, key)) continue;
    if (fallback !== 'required') record[key] = fallback.value;
    else if (kind === 'optionString') record[key] = null;
    else throw reader.error(`missing field \`${key}\``);
  }
  return record;
}

const NONE = { value: null };
const NO_FILES = { get value(): ProposalFileMeta[] { return []; } };
const PACKAGE_VERSION_DEFAULT = { value: 1 };

const PROPOSAL_FILE_META_FIELDS: readonly SerdeFieldSpec[] = [
  ['path', 'string', 'required'], ['sha256', 'string', 'required'], ['size', 'usize', 'required'],
];

function decodeProposalFileMeta(reader: JsonReader): ProposalFileMeta {
  const record = serdeStruct(reader, 'ProposalFileMeta', PROPOSAL_FILE_META_FIELDS);
  return { path: record.path as string, sha256: record.sha256 as string, size: record.size as WorkshopUnsigned };
}

const PROPOSAL_META_FIELDS: readonly SerdeFieldSpec[] = [
  ['proposalId', 'string', 'required'], ['action', 'string', 'required'],
  ['skillId', 'string', 'required'], ['contentSha256', 'string', 'required'],
  ['createdAt', 'string', 'required'], ['sessionId', 'string', 'required'],
  ['status', 'string', 'required'], ['previousSha256', 'optionString', NONE],
  ['packageSha256', 'optionString', NONE], ['files', 'files', NO_FILES],
  ['previousPackageSha256', 'optionString', NONE], ['previousFiles', 'files', NO_FILES],
  ['packageVersion', 'u64', PACKAGE_VERSION_DEFAULT],
];

function decodeProposalMeta(reader: JsonReader): ProposalMeta {
  const record = serdeStruct(reader, 'ProposalMeta', PROPOSAL_META_FIELDS);
  return {
    proposalId: record.proposalId as string,
    action: record.action as string,
    skillId: record.skillId as string,
    contentSha256: record.contentSha256 as string,
    createdAt: record.createdAt as string,
    sessionId: record.sessionId as string,
    status: record.status as string,
    ...(typeof record.previousSha256 === 'string' ? { previousSha256: record.previousSha256 } : {}),
    ...(typeof record.packageSha256 === 'string' ? { packageSha256: record.packageSha256 } : {}),
    files: record.files as ProposalFileMeta[],
    ...(typeof record.previousPackageSha256 === 'string'
      ? { previousPackageSha256: record.previousPackageSha256 } : {}),
    previousFiles: record.previousFiles as ProposalFileMeta[],
    packageVersion: record.packageVersion as WorkshopUnsigned,
  };
}

// `previous_package_sha256` has no `#[serde(default)]`: None when absent from a
// map, but a required element in sequence form.
const AGENT_WORKSHOP_MARKER_FIELDS: readonly SerdeFieldSpec[] = [
  ['sourceKind', 'string', 'required'], ['proposalId', 'string', 'required'],
  ['contentSha256', 'string', 'required'], ['packageSha256', 'string', { value: '' }],
  ['packageVersion', 'u64', PACKAGE_VERSION_DEFAULT], ['files', 'files', NO_FILES],
  ['previousPackageSha256', 'optionString', 'required'],
  ['installedAt', 'string', 'required'], ['sessionId', 'string', 'required'],
];

/** Rust decodes the whole `AgentWorkshopMarker`; any failure yields previous version 0 (skill_workshop_executor.rs:797-802). */
export function parseAgentWorkshopMarkerVersion(text: string): WorkshopUnsigned {
  const reader = new JsonReader(text);
  const record = serdeStruct(reader, 'AgentWorkshopMarker', AGENT_WORKSHOP_MARKER_FIELDS);
  reader.end();
  return record.packageVersion as WorkshopUnsigned;
}

export function decodeAgentWorkshopMarkerVersion(value: unknown): WorkshopUnsigned {
  return parseAgentWorkshopMarkerVersion(workshopJson(value));
}

export function writeProposalMeta(
  dir: string,
  meta: ProposalMeta,
  logger: WorkshopLogger = {},
): void {
  try { fs.mkdirSync(dir, { recursive: true }); }
  catch (error) { throw new Error(`Failed to create proposal directory: ${errorText(error)}`); }
  let jsonText: string;
  try { jsonText = workshopJson(meta, 2); }
  catch (error) { throw new Error(`Failed to serialize proposal meta: ${errorText(error)}`); }
  const target = metaPath(dir);
  const temporary = path.join(dir, `.${PROPOSAL_META_FILE}.tmp-${randomUUID()}`);
  const backup = path.join(dir, `.${PROPOSAL_META_FILE}.backup-${randomUUID()}`);
  const hadTarget = fs.existsSync(target);
  try {
    const fd = fs.openSync(temporary, 'w');
    try { fs.writeFileSync(fd, jsonText); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    if (hadTarget) {
      try { fs.renameSync(target, backup); }
      catch (error) {
        throw new Error(
          `Failed to stage previous ${PROPOSAL_META_FILE} for replacement: ${errorText(error)}`,
        );
      }
    }
    try { fs.renameSync(temporary, target); }
    catch (error) {
      if (hadTarget) {
        try { fs.renameSync(backup, target); }
        catch (restoreError) {
          logger.warn?.(
            `[SkillWorkshopExecutor] failed to restore previous ${PROPOSAL_META_FILE}: `
            + errorText(restoreError),
          );
        }
      }
      throw new Error(`Failed to publish ${PROPOSAL_META_FILE}: ${errorText(error)}`);
    }
    if (hadTarget) {
      try { fs.rmSync(backup); }
      catch (cleanupError) {
        logger.warn?.(
          `[SkillWorkshopExecutor] failed to remove ${PROPOSAL_META_FILE} backup: `
          + errorText(cleanupError),
        );
      }
    }
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); }
    catch (cleanupError) {
      logger.warn?.(
        `[SkillWorkshopExecutor] failed to remove ${PROPOSAL_META_FILE} temp file: `
        + errorText(cleanupError),
      );
    }
    throw error;
  }
}

export function writeProposalFiles(
  dir: string,
  files: readonly PackageFile[],
  meta: ProposalMeta,
  logger: WorkshopLogger = {},
): void {
  try { fs.mkdirSync(dir, { recursive: true }); }
  catch (error) { throw new Error(`Failed to create proposal directory: ${errorText(error)}`); }
  for (const file of files) {
    const target = path.join(dir, file.path);
    try { fs.mkdirSync(path.dirname(target), { recursive: true }); }
    catch (error) {
      throw new Error(`Failed to create proposal package directory: ${errorText(error)}`);
    }
    try {
      const fd = fs.openSync(target, 'w');
      try { fs.writeFileSync(fd, file.bytes); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
    } catch (error) {
      throw new Error(`Failed to write proposal file '${file.path}': ${errorText(error)}`);
    }
  }
  writeProposalMeta(dir, meta, logger);
}

export function readProposalPackage(dir: string, meta: ProposalMeta): PackageFile[] {
  if (meta.files.length === 0) {
    let bytes: Buffer;
    try { bytes = fs.readFileSync(path.join(dir, SKILL_FILE_NAME)); }
    catch (error) { throw new Error(`Failed to read proposal SKILL.md: ${errorText(error)}`); }
    return validatePackageFiles([{ path: SKILL_FILE_NAME, bytes }]);
  }
  const byPath = new Map<string, Buffer>();
  for (const file of meta.files) {
    const normalized = normalizePackagePath(file.path);
    const target = path.join(dir, normalized);
    let metadata: fs.Stats;
    try { metadata = fs.lstatSync(target); }
    catch (error) {
      throw new Error(`Failed to inspect proposal file '${normalized}': ${errorText(error)}`);
    }
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`Proposal file '${normalized}' must be a regular non-symlink file`);
    }
    let bytes: Buffer;
    try { bytes = fs.readFileSync(target); }
    catch (error) {
      throw new Error(`Failed to read proposal file '${normalized}': ${errorText(error)}`);
    }
    byPath.set(normalized, bytes);
  }
  return validatePackageFiles([...byPath].map(([filePath, bytes]) => ({ path: filePath, bytes })));
}

export function countPendingProposals(root: string): number {
  if (!fs.existsSync(root)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const meta = readProposalMeta(path.join(root, entry.name));
      if (meta.status === 'pending') count += 1;
    } catch { continue; }
  }
  return count;
}
