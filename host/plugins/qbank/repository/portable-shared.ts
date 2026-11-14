/** Shared by the portable export and import halves of question_export_service/authoring.rs. */

export class ExportNotFound extends Error {}
export class ExportValidation extends Error {}

/** authoring.rs:158/196/210：导出资产总量、便携包大小与解压声明总量的同一上限。 */
export const PORTABLE_LIMIT_BYTES = 200 * 1024 * 1024;

/** authoring.rs:123 `hashes`。 */
export function collectHashes(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectHashes(item, out);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if ((key === 'hash' || key === 'blob_hash') && typeof child === 'string'
      && child.length === 64 && /^[0-9a-fA-F]+$/.test(child)) {
      out.add(child);
    }
    collectHashes(child, out);
  }
}
