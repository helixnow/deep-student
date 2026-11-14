/**
 * Materialize binary MCP tool content into session-scoped task files, ported
 * from `src-tauri/crates/dstu-agent/src/chat_v2/tools/mcp_content_materializer.rs`.
 *
 * Text content passes through unchanged. Image blocks and resource blobs are
 * base64-decoded under per-item/aggregate budgets, MIME-validated against magic
 * bytes, written collision-safely under `<artifact_root>/mcp/<server>/<tool>/`,
 * and replaced with an artifact descriptor plus source metadata.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { artifactRoot } from '../../../agent-workspace/api.ts';
import { setMcpOutputMaterialization } from './mcp-materialization-port.ts';
import {
  TaskObjectHandleBuilder, derivedEdge, hashTransformParams, managedLocator,
  withParamsHash,
} from './task-objects.ts';

export const MCP_SUBDIR = 'mcp';
export const MAX_BINARY_ITEMS = 16;
export const MAX_ITEM_BYTES = 16 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
export const MAX_ENCODED_ITEM_BYTES = Math.floor((MAX_ITEM_BYTES + 2) / 3) * 4;
export const MAX_COLLISION_ATTEMPTS = 100;
export const MAX_NAME_CHARS = 96;

export interface McpOutputProvenance {
  provider: string;
  server: string;
  tool: string;
}

function nonBlankString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** `McpOutputProvenance::from_usage`. */
export function mcpProvenanceFromUsage(
  tool: string,
  usage: unknown,
): McpOutputProvenance {
  const record = typeof usage === 'object' && usage !== null && !Array.isArray(usage)
    ? usage as Record<string, unknown> : {};
  const provider = nonBlankString(record.provider) ?? 'mcp';
  const server = nonBlankString(record.server_id) ?? nonBlankString(record.serverId)
    ?? 'unknown-server';
  return { provider, server, tool };
}

interface MaterializedFile {
  relativePath: string;
  displayName: string;
  originalName: string;
  sizeBytes: number;
  sha256: string;
  mimeType: string;
  sourceUri: string;
}

interface MaterializationBudget {
  items: number;
  totalBytes: number;
}

/** Async wrapper matching `spawn_blocking`; the work itself is synchronous. */
export async function materializeMcpToolOutput(
  output: unknown,
  artifactRoot: string,
  provenance: McpOutputProvenance,
): Promise<unknown> {
  return materializeMcpToolOutputAtRoot(output, artifactRoot, provenance);
}

export function materializeMcpToolOutputAtRoot(
  output: unknown,
  artifactRoot: string,
  provenance: McpOutputProvenance,
): unknown {
  const budget: MaterializationBudget = { items: 0, totalBytes: 0 };
  if (Array.isArray(output)) {
    materializeContentArray(output, artifactRoot, provenance, budget);
  } else if (typeof output === 'object' && output !== null) {
    const content = (output as Record<string, unknown>).content;
    if (Array.isArray(content)) {
      materializeContentArray(content, artifactRoot, provenance, budget);
    }
  }
  return output;
}

function materializeContentArray(
  content: unknown[],
  artifactRoot: string,
  provenance: McpOutputProvenance,
  budget: MaterializationBudget,
): void {
  content.forEach((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return;
    const object = item as Record<string, unknown>;
    if (object.type === 'image') {
      materializeImage(object, index, artifactRoot, provenance, budget);
    } else if (object.type === 'resource') {
      materializeResource(object, index, artifactRoot, provenance, budget);
    }
  });
}

function mimeFromMap(object: Record<string, unknown>): string | undefined {
  const raw = object.mimeType ?? object.mime_type;
  if (typeof raw !== 'string') return undefined;
  const normalized = normalizeMime(raw);
  return normalized === '' ? undefined : normalized;
}

function normalizeMime(raw: string): string {
  return (raw.split(';')[0] ?? '').trim().toLowerCase();
}

function materializeImage(
  object: Record<string, unknown>,
  index: number,
  artifactRoot: string,
  provenance: McpOutputProvenance,
  budget: MaterializationBudget,
): void {
  if (typeof object.data !== 'string') return;
  const declaredMime = mimeFromMap(object);
  if (declaredMime === undefined) throw new Error('MCP image content is missing mimeType');
  const sourceUri = `mcp://${sanitizeSegment(provenance.server)}/`
    + `${sanitizeSegment(provenance.tool)}/image/${index + 1}`;
  const bytes = decodeBoundedBase64(object.data, budget);
  const effectiveMime = validateMime(declaredMime, bytes, true);
  const requestedName = `image-${index + 1}.${extensionForMime(effectiveMime)}`;
  const file = writeMaterializedFile(
    artifactRoot, requestedName, sourceUri, effectiveMime, bytes, provenance,
  );
  delete object.data;
  object.mimeType = effectiveMime;
  delete object.mime_type;
  object.artifact = artifactMetadata(file, provenance);
  object.source = sourceMetadata(file, provenance);
}

function materializeResource(
  object: Record<string, unknown>,
  index: number,
  artifactRoot: string,
  provenance: McpOutputProvenance,
  budget: MaterializationBudget,
): void {
  const resource = object.resource;
  if (typeof resource !== 'object' || resource === null || Array.isArray(resource)) return;
  const map = resource as Record<string, unknown>;
  if (typeof map.blob !== 'string') return;
  const rawUri = nonBlankString(map.uri);
  const sourceUri = rawUri ?? `mcp://${sanitizeSegment(provenance.server)}/`
    + `${sanitizeSegment(provenance.tool)}/resource/${index + 1}`;
  const declaredMime = mimeFromMap(map) ?? 'application/octet-stream';
  const bytes = decodeBoundedBase64(map.blob, budget);
  const effectiveMime = validateMime(declaredMime, bytes, false);
  const requestedName = nameFromSourceUri(sourceUri)
    ?? `resource-${index + 1}.${extensionForMime(effectiveMime)}`;
  const file = writeMaterializedFile(
    artifactRoot, requestedName, sourceUri, effectiveMime, bytes, provenance,
  );
  delete map.blob;
  map.mimeType = effectiveMime;
  delete map.mime_type;
  map.artifact = artifactMetadata(file, provenance);
  map.source = sourceMetadata(file, provenance);
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

function decodeBoundedBase64(
  encoded: string,
  budget: MaterializationBudget,
): Uint8Array {
  if (budget.items >= MAX_BINARY_ITEMS) {
    throw new Error(`MCP result exceeds the ${MAX_BINARY_ITEMS} binary item limit`);
  }
  if (encoded.length > MAX_ENCODED_ITEM_BYTES) {
    throw new Error(
      `MCP binary item exceeds the ${MAX_ITEM_BYTES / (1024 * 1024)} MiB decoded-size limit`,
    );
  }
  if (encoded.length % 4 !== 0 || !BASE64_PATTERN.test(encoded)) {
    throw new Error('MCP binary item contains invalid base64');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > MAX_ITEM_BYTES) {
    throw new Error(
      `MCP binary item exceeds the ${MAX_ITEM_BYTES / (1024 * 1024)} MiB decoded-size limit`,
    );
  }
  const newTotal = budget.totalBytes + bytes.length;
  if (!Number.isSafeInteger(newTotal)) throw new Error('MCP binary result size overflow');
  if (newTotal > MAX_TOTAL_BYTES) {
    throw new Error(
      `MCP binary result exceeds the ${MAX_TOTAL_BYTES / (1024 * 1024)} MiB aggregate limit`,
    );
  }
  budget.items += 1;
  budget.totalBytes = newTotal;
  return bytes;
}

function validateMime(declaredRaw: string, bytes: Uint8Array, requireImage: boolean): string {
  const declared = normalizeMime(declaredRaw);
  if (declared === '' || /[\u0000-\u001f\u007f]/.test(declared)) {
    throw new Error('MCP binary item has an invalid MIME type');
  }
  const detected = detectMagicMime(bytes);
  if (detected === 'application/x-executable') {
    throw new Error('MCP binary item has an executable signature and was quarantined');
  }
  if (requireImage && !declared.startsWith('image/')) {
    throw new Error(`MCP image declared non-image MIME type '${declared}'`);
  }
  if ((requireImage || declared.startsWith('image/'))
    && (detected === undefined || !detected.startsWith('image/'))) {
    throw new Error('MCP image bytes do not have a supported image signature');
  }
  if (detected !== undefined) {
    const compatible = declared === detected
      || declared === 'application/octet-stream'
      || (detected === 'application/zip' && isZipContainerMime(declared));
    if (!compatible) {
      throw new Error(
        `MCP binary MIME mismatch: declared '${declared}', detected '${detected}'`,
      );
    }
    if (declared === 'application/octet-stream') return detected;
  }
  return declared;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return Buffer.from(bytes.subarray(start, end)).toString('latin1');
}

function detectMagicMime(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return 'image/gif';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (ascii(bytes, 0, 5) === '%PDF-') return 'application/pdf';
  if (ascii(bytes, 0, 2) === 'MZ'
    || startsWith(bytes, [0x7f, 0x45, 0x4c, 0x46])
    || startsWith(bytes, [0xfe, 0xed, 0xfa, 0xce])
    || startsWith(bytes, [0xfe, 0xed, 0xfa, 0xcf])
    || startsWith(bytes, [0xcf, 0xfa, 0xed, 0xfe])) return 'application/x-executable';
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])
    || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])
    || startsWith(bytes, [0x50, 0x4b, 0x07, 0x08])) return 'application/zip';
  return undefined;
}

function isZipContainerMime(mime: string): boolean {
  return mime === 'application/zip'
    || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    || mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    || mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    || mime === 'application/epub+zip';
}

export function extensionForMime(mime: string): string {
  switch (mime) {
    case 'image/png': return 'png';
    case 'image/jpeg': return 'jpg';
    case 'image/gif': return 'gif';
    case 'image/webp': return 'webp';
    case 'application/pdf': return 'pdf';
    case 'application/zip': return 'zip';
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': return 'docx';
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': return 'xlsx';
    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation': return 'pptx';
    case 'application/epub+zip': return 'epub';
    default: return 'bin';
  }
}

function nameFromSourceUri(uri: string): string | undefined {
  const withoutFragment = uri.split('#')[0] ?? uri;
  const withoutQuery = withoutFragment.split('?')[0] ?? withoutFragment;
  const segments = withoutQuery.split('/');
  const leaf = segments[segments.length - 1] ?? '';
  if (leaf.trim() === '') return undefined;
  return sanitizeFileName(leaf);
}

export function sanitizeSegment(raw: string): string {
  const cleaned = [...raw]
    .map(ch => (/[A-Za-z0-9_-]/.test(ch) ? ch : '_'))
    .slice(0, 48)
    .join('');
  const trimmed = cleaned.replace(/^_+|_+$/g, '');
  return trimmed === '' ? 'unknown' : trimmed;
}

export function sanitizeFileName(raw: string): string {
  const segments = raw.split(/[/\\]/);
  const leaf = segments[segments.length - 1] ?? raw;
  const cleaned = [...leaf]
    .map(ch => (/[A-Za-z0-9._-]/.test(ch) ? ch : '_'))
    .slice(0, MAX_NAME_CHARS)
    .join('');
  const trimmed = cleaned.replace(/^[._]+|[._]+$/g, '');
  return trimmed === '' ? 'resource.bin' : trimmed;
}

function writeMaterializedFile(
  artifactRoot: string,
  requestedName: string,
  sourceUri: string,
  mimeType: string,
  bytes: Uint8Array,
  provenance: McpOutputProvenance,
): MaterializedFile {
  try { fs.mkdirSync(artifactRoot, { recursive: true }); }
  catch (error) { throw new Error(`Failed to create MCP artifact root: ${errorText(error)}`); }
  let root: string;
  try { root = fs.realpathSync(artifactRoot); }
  catch (error) {
    throw new Error(`Failed to canonicalize MCP artifact root: ${errorText(error)}`);
  }
  const relativeDir = [MCP_SUBDIR, sanitizeSegment(provenance.server), sanitizeSegment(provenance.tool)]
    .join('/');
  const directory = ensureSafeDirectory(root, relativeDir);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const requested = sanitizeFileName(requestedName);
  const stem = stemOf(requested) || 'resource';
  // The source URI is untrusted: always derive the extension from the
  // validated media type so a PDF cannot be persisted as an executable.
  const ext = extensionForMime(mimeType);
  const baseName = `${stem}-${sha256.slice(0, 12)}.${ext}`;

  for (let attempt = 0; attempt <= MAX_COLLISION_ATTEMPTS; attempt += 1) {
    const fileName = attempt === 0
      ? baseName
      : `${stem}-${sha256.slice(0, 12)}-${attempt}.${ext}`;
    const target = path.join(directory, fileName);
    let fd: number;
    try { fd = fs.openSync(target, 'wx'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw new Error(`Failed to create MCP artifact: ${errorText(error)}`);
    }
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } catch (error) {
      fs.closeSync(fd);
      throw new Error(`Failed to write MCP artifact: ${errorText(error)}`);
    }
    fs.closeSync(fd);
    const relative = `${relativeDir}/${fileName}`;
    assertRuntimeRelativePath(relative);
    return {
      relativePath: relative,
      displayName: fileName,
      originalName: requested,
      sizeBytes: bytes.length,
      sha256,
      mimeType,
      sourceUri,
    };
  }
  throw new Error('MCP artifact filename collision limit exceeded');
}

function stemOf(fileName: string): string {
  const index = fileName.lastIndexOf('.');
  if (index <= 0) return fileName;
  return fileName.slice(0, index);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Local port of `normalize_runtime_relative_path` for the generated path. */
function assertRuntimeRelativePath(raw: string): void {
  if (raw === '' || raw === '.') return;
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
    throw new Error('Path must be relative to the selected runtime root');
  }
  for (const part of raw.split('/')) {
    if (part === '..') throw new Error('Parent directory traversal is not allowed');
  }
}

function ensureSafeDirectory(root: string, relative: string): string {
  let current = root;
  for (const segment of relative.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new Error('MCP artifact directory contains an unsafe path component');
    }
    current = path.join(current, segment);
    let metadata: fs.Stats | undefined;
    try { metadata = fs.lstatSync(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Failed to inspect MCP artifact directory: ${errorText(error)}`);
      }
      metadata = undefined;
    }
    if (metadata !== undefined) {
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error('MCP artifact directory must not contain symlinks');
      }
    } else {
      try { fs.mkdirSync(current); }
      catch (error) {
        throw new Error(`Failed to create MCP artifact directory: ${errorText(error)}`);
      }
    }
  }
  let canonical: string;
  try { canonical = fs.realpathSync(current); }
  catch (error) {
    throw new Error(`Failed to canonicalize MCP artifact directory: ${errorText(error)}`);
  }
  if (canonical !== root && !canonical.startsWith(`${root}${path.sep}`)) {
    throw new Error('MCP artifact directory escapes the session root');
  }
  return canonical;
}

function artifactMetadata(
  file: MaterializedFile,
  provenance: McpOutputProvenance,
): Record<string, unknown> {
  const handle = new TaskObjectHandleBuilder(
    `mcp-artifact:${file.sha256}`,
    'artifact',
    file.displayName,
    provenance.provider,
  )
    .sourceUri(file.sourceUri)
    .server(provenance.server)
    .tool(provenance.tool)
    .derivedEdge(withParamsHash(
      derivedEdge(file.sourceUri, `mcp.materialize:${provenance.server}/${provenance.tool}`),
      hashTransformParams({
        server: provenance.server,
        tool: provenance.tool,
        source_uri: file.sourceUri,
        content_sha256: file.sha256,
      }),
    ))
    .mediaType(file.mimeType)
    .sizeBytes(file.sizeBytes)
    .sha256(file.sha256)
    .locator(managedLocator('artifacts', file.relativePath))
    .providerRef({
      provider: provenance.provider,
      externalId: file.sourceUri,
      containerId: provenance.server,
    })
    .capabilities({
      readable: true,
      materializable: true,
      writable: false,
      shareable: false,
      sendable: false,
      deletable: true,
    })
    .build();
  return {
    kind: 'artifact',
    root_id: 'artifacts',
    relative_path: file.relativePath,
    sha256: file.sha256,
    mime_type: file.mimeType,
    size_bytes: file.sizeBytes,
    source_uri: file.sourceUri,
    original_name: file.originalName,
    provider: provenance.provider,
    server: provenance.server,
    tool: provenance.tool,
    object_handle: handle,
  };
}

function sourceMetadata(
  file: MaterializedFile,
  provenance: McpOutputProvenance,
): Record<string, unknown> {
  return {
    kind: 'source',
    uri: file.sourceUri,
    mime_type: file.mimeType,
    provider: provenance.provider,
    server: provenance.server,
    tool: provenance.tool,
  };
}

/**
 * The desktop implementation of `mcp-materialization-port.ts`: `GeneralToolExecutor` runs on mobile too,
 * so materialization (sync fs + artifact root) is installed from here, where `api.ts` loads it on desktop.
 */
setMcpOutputMaterialization({
  materialize: (output, target) => {
    let root: string;
    try { root = artifactRoot(target.dataDir, target.sessionId, true).path; }
    catch (error) { return Promise.reject(error); }
    return materializeMcpToolOutput(output, root, mcpProvenanceFromUsage(target.toolName, target.usage));
  },
});
