/**
 * Shared URL sanitizer for generative-ui href/src (and similar) values.
 * Trim first; never throw. Schemes are allowlisted; empty is allowed.
 */

export const GENERATIVE_URL_SAFE_SCHEMES = ['http', 'https', 'mailto', 'tel'] as const;

const SAFE_SCHEME_SET: ReadonlySet<string> = new Set(GENERATIVE_URL_SAFE_SCHEMES);

/** 空白与 C0/C1，用于还原 `java\\tscript:` 一类混淆。用 fromCharCode 避免源码里写控制字符字面量。 */
const SCHEME_OBFUSCATION_RE = new RegExp(
  `[\\s${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}]+`,
  'g',
);

/** 仅允许静态位图 data URI；`svg+xml` 可执行故排除。 */
const SAFE_DATA_IMAGE_RE = /^data:image\/(?:png|jpe?g|gif|webp|avif)(?:[;,/]|$)/i;

function normalizeForSchemeCheck(value: string): string {
  return value.replace(SCHEME_OBFUSCATION_RE, '').toLowerCase();
}

/** True for javascript/vbscript/file/non-image data URLs and leading //. */
export function isDangerousGenerativeUrl(value: string): boolean {
  if (typeof value !== 'string') return true;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('//')) return true;
  if (trimmed.startsWith('#')) return false;

  const normalized = normalizeForSchemeCheck(trimmed);
  if (normalized.startsWith('//')) return true;

  if (normalized.startsWith('data:')) {
    return !SAFE_DATA_IMAGE_RE.test(normalized);
  }

  const colonIdx = trimmed.indexOf(':');
  const slashIdx = trimmed.indexOf('/');
  if (colonIdx !== -1 && (slashIdx === -1 || colonIdx < slashIdx)) {
    const scheme = normalizeForSchemeCheck(trimmed.slice(0, colonIdx));
    return !SAFE_SCHEME_SET.has(scheme);
  }

  return false;
}

/** Inverse of {@link isDangerousGenerativeUrl}; empty string is allowed. */
export function isAllowedGenerativeUrl(value: string): boolean {
  return !isDangerousGenerativeUrl(value);
}

/** Trimmed original, or `''` when the URL is dangerous / not a string. */
export function sanitizeGenerativeUrl(value: string): string {
  if (typeof value !== 'string') return '';
  if (isDangerousGenerativeUrl(value)) return '';
  return value.trim();
}
