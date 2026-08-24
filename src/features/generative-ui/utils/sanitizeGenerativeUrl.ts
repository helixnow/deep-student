/**
 * Shared URL sanitizer for generative-ui href/src (and similar) values.
 * Trim first; never throw. Dangerous schemes are denylisted; empty is allowed.
 */

const DANGEROUS_SCHEME_RE = /^(?:javascript|vbscript|file)\s*:/i;
const DATA_SCHEME_RE = /^data\s*:/i;
const SAFE_DATA_IMAGE_RE = /^data\s*:image\//i;

/** True for javascript/vbscript/file/non-image data URLs and leading //. */
export function isDangerousGenerativeUrl(value: string): boolean {
  if (typeof value !== 'string') return true;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('//')) return true;
  if (DANGEROUS_SCHEME_RE.test(trimmed)) return true;
  if (DATA_SCHEME_RE.test(trimmed) && !SAFE_DATA_IMAGE_RE.test(trimmed)) return true;
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
