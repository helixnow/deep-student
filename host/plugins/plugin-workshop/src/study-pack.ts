/**
 * Plugin System v2 P4 — Study Pack (`.dspack`) archive builder & share-time publisher
 * namespace rewriter (RFC-002).
 *
 * Portable (Node-free): reuses `host/platform/zip/core` (`MemoryZipSink` + `ZipWriter`)
 * and `host/kernel/manifest.ts` + `host/kernel/plugin-id.ts`.
 */
import { checkManifest, type PluginPackageKind } from '../../../kernel/manifest.ts';
import {
  ASSIGNED_PUBLISHERS,
  FORBIDDEN_PUBLISHERS,
  isValidPluginId,
  reservedIdProblem,
} from '../../../kernel/plugin-id.ts';
import { MemoryZipSink, ZipWriter } from '../../../platform/zip/core/index.ts';

const PUBLISHER_PATTERN = /^[a-z][a-z0-9-]{1,38}$/;
const SLUG_PATTERN = /^[a-z][a-z0-9-]{1,62}$/;
const WORKSHOP_PUBLISHER = 'workshop';
const DEFAULT_APP_VERSION = '0.20.9';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export interface ShareRewriteOptions {
  /** Target community publisher namespace (e.g. `alice`). */
  publisher: string;
  /** Optional package slug; derived safely from `displayName`, package name, or existing id if omitted. */
  slug?: string;
  /** Optional author string to record in `deepStudent.author`. */
  author?: string;
  /** Optional display name override to record in `deepStudent.displayName`. */
  displayName?: string;
  /** App version used when validating the rewritten manifest (defaults to current host app line). */
  appVersion?: string;
}

export interface StudyPackArchiveFile {
  path: string;
  bytes: Uint8Array;
}

/**
 * Returns the archive extension for a package kind: `.dspack` for study packs,
 * `.dstuplugin` for standard plugins (default).
 */
export function exportPackageExtension(manifestKind?: PluginPackageKind): '.dstuplugin' | '.dspack' {
  return manifestKind === 'study-pack' ? '.dspack' : '.dstuplugin';
}

function validateSharePublisher(publisher: string): string {
  if (typeof publisher !== 'string' || !PUBLISHER_PATTERN.test(publisher)) {
    throw new Error(
      `SHARE_PUBLISHER_INVALID: publisher ${JSON.stringify(publisher)} must match ${PUBLISHER_PATTERN.source}`,
    );
  }
  if (FORBIDDEN_PUBLISHERS.includes(publisher)) {
    throw new Error(`SHARE_PUBLISHER_FORBIDDEN: publisher "${publisher}" is forbidden`);
  }
  if (Object.hasOwn(ASSIGNED_PUBLISHERS, publisher) || publisher === WORKSHOP_PUBLISHER) {
    throw new Error(`SHARE_PUBLISHER_RESERVED: publisher "${publisher}" is reserved and cannot be used for sharing`);
  }
  return publisher;
}

function sanitizeSlugCandidate(raw: string): string | null {
  let cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!cleaned) return null;
  if (!/^[a-z]/.test(cleaned)) cleaned = `p-${cleaned}`;
  cleaned = cleaned.slice(0, 63).replace(/-+$/g, '');
  return SLUG_PATTERN.test(cleaned) ? cleaned : null;
}

function isWorkshopUuidSlug(slug: string): boolean {
  return /^plugin-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(slug);
}

function deriveSlug(
  pkg: Record<string, unknown>,
  ds: Record<string, unknown>,
  options: ShareRewriteOptions,
  kind: PluginPackageKind,
): string {
  if (options.slug !== undefined) {
    if (!SLUG_PATTERN.test(options.slug)) {
      throw new Error(
        `SHARE_SLUG_INVALID: slug ${JSON.stringify(options.slug)} must match ${SLUG_PATTERN.source}`,
      );
    }
    return options.slug;
  }

  const candidates: string[] = [];
  if (typeof options.displayName === 'string') candidates.push(options.displayName);
  if (typeof ds.displayName === 'string') candidates.push(ds.displayName);
  if (typeof pkg.name === 'string') {
    const stripped = pkg.name
      .replace(/^@[^/]+\//, '')
      .replace(/^deepstudent-(?:pack|plugin)-/i, '');
    if (stripped) candidates.push(stripped);
  }
  if (typeof ds.id === 'string') {
    const dot = ds.id.indexOf('.');
    const existingSlug = dot >= 0 ? ds.id.slice(dot + 1) : '';
    if (existingSlug && !isWorkshopUuidSlug(existingSlug)) {
      candidates.push(existingSlug);
    }
  }

  for (const candidate of candidates) {
    const slug = sanitizeSlugCandidate(candidate);
    if (slug) return slug;
  }

  return kind === 'study-pack' ? 'study-pack' : 'plugin';
}

/**
 * Rewrites a local/workshop `package.json` manifest into a shareable community package:
 * - Validates `publisher` against `host/kernel/plugin-id.ts` rules (rejecting forbidden and
 *   assigned publishers such as `dstu`, `local`, `test`, `example`, `workshop`, `community`).
 * - Rewrites `deepStudent.id` from `workshop.plugin-*` / `local.*` to `<publisher>.<slug>`.
 * - Updates `package.json#name` to `deepstudent-pack-<slug>` (study-pack) or `deepstudent-plugin-<slug>`.
 * - Sets `deepStudent.author` / `deepStudent.displayName` when provided.
 * - Strips top-level `scripts` for safe distribution.
 * - Validates the resulting package via `checkManifest(..., { context: 'community-install' })`.
 */
export function rewriteManifestForSharing(
  pkg: Record<string, unknown>,
  options: ShareRewriteOptions,
): Record<string, unknown> {
  if (!isRecord(pkg) || !isRecord(pkg.deepStudent)) {
    throw new Error('SHARE_MANIFEST_INVALID: package.json must contain a "deepStudent" object');
  }

  const publisher = validateSharePublisher(options.publisher);
  const rewritten = structuredClone(pkg);
  const ds = rewritten.deepStudent as Record<string, unknown>;
  const kind: PluginPackageKind = ds.kind === 'study-pack' ? 'study-pack' : 'plugin';
  const slug = deriveSlug(rewritten, ds, options, kind);
  const nextId = `${publisher}.${slug}`;

  if (!isValidPluginId(nextId)) {
    throw new Error(`SHARE_ID_INVALID: generated plugin id ${JSON.stringify(nextId)} is invalid`);
  }
  const reserved = reservedIdProblem(nextId, 'community-install');
  if (reserved) {
    throw new Error(`SHARE_PUBLISHER_RESERVED: ${reserved}`);
  }

  ds.id = nextId;
  rewritten.name = kind === 'study-pack' ? `deepstudent-pack-${slug}` : `deepstudent-plugin-${slug}`;

  if (options.author !== undefined) {
    const trimmedAuthor = options.author.trim();
    if (trimmedAuthor) ds.author = trimmedAuthor;
  }
  if (options.displayName !== undefined) {
    const trimmedName = options.displayName.trim();
    if (trimmedName) ds.displayName = trimmedName;
  }

  delete rewritten.scripts;

  const checked = checkManifest(rewritten, {
    appVersion: options.appVersion ?? DEFAULT_APP_VERSION,
    context: 'community-install',
  });
  if (!checked.ok) {
    throw checked.error;
  }

  return rewritten;
}

/**
 * Packs a study pack (or plugin) file list into an uncompressed/deflated ZIP byte array
 * (`.dspack` / `.dstuplugin`) using the repo's portable `platform/zip/core` writer.
 */
export async function createStudyPackArchive(
  files: readonly StudyPackArchiveFile[],
): Promise<Uint8Array> {
  const sink = new MemoryZipSink();
  const writer = new ZipWriter(sink);
  const seen = new Set<string>();

  for (const file of files) {
    const normalized = file.path.replaceAll('\\', '/').replace(/^\.\//, '');
    if (
      !normalized
      || normalized.startsWith('/')
      || normalized.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
    ) {
      throw new Error(`STUDY_PACK_INVALID_PATH: invalid archive path ${JSON.stringify(file.path)}`);
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`STUDY_PACK_DUPLICATE_PATH: duplicate archive path ${JSON.stringify(normalized)}`);
    }
    seen.add(key);
    await writer.addBytes(normalized, file.bytes);
  }

  await writer.finish();
  return sink.bytes();
}
