import type { AnkiCard } from '../../../../contracts/ipc/generated/_shared.ts';
import type { BatchExportNote } from '../../../../contracts/ipc/generated/L16-anki.ts';
import type { CryptoService } from '../../../platform/crypto/api.ts';
import type { PathFlavor } from '../../../platform/files/api.ts';
import { orderedNowEpochNanos, toRfc3339 } from '../../../platform/time/index.ts';
import { compareUtf8 } from '../../../platform/util/portable.ts';

/**
 * Rust `Path::file_name`, purely lexical: `.` components vanish, a trailing `..`, a bare root or
 * a bare Windows prefix (`C:`, `\\server\share`, `\\?\…`) has no file name.
 */
export function rustPathFileName(raw: string, flavor: PathFlavor): string | null {
  let rest = raw;
  if (flavor === 'win32') {
    const verbatim = /^[\\/]{2}[?.][\\/]/.exec(rest);
    if (verbatim) {
      rest = rest.slice(verbatim[0].length);
      if (/^UNC[\\/]/i.test(rest)) rest = rest.slice(4).replace(/^[^\\/]*[\\/]?[^\\/]*/, '');
      else if (/^[A-Za-z]:/.test(rest)) rest = rest.slice(2);
      else rest = rest.replace(/^[^\\/]*/, '');
    } else if (/^[\\/]{2}[^\\/]/.test(rest)) {
      rest = rest.slice(2).replace(/^[^\\/]*[\\/]?[^\\/]*/, '');
    } else if (/^[A-Za-z]:/.test(rest)) {
      rest = rest.slice(2);
    }
  }
  const parts = rest.split(flavor === 'win32' ? /[\\/]/ : '/').filter((part) => part !== '' && part !== '.');
  const last = parts.at(-1);
  return last === undefined || last === '..' ? null : last;
}

// cmd/anki_connect.rs:114-165. Path::file_name follows the host platform, hence the explicit flavor.
export function sanitizeFilenameComponent(raw: string, fallback: string, flavor: PathFlavor): string {
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  const base = rustPathFileName(trimmed, flavor) ?? fallback;
  let sanitized = base.replace(/[\p{Cc}/\\:*?"<>|]/gu, '_').trim().replace(/^\.+|\.+$/g, '');
  while (sanitized.includes('..')) sanitized = sanitized.replaceAll('..', '.');
  return sanitized === '' || sanitized === '.' || sanitized === '..' ? fallback : sanitized;
}

export function sanitizeFilenameWithExtension(raw: string, fallbackName: string, extension: string, flavor: PathFlavor): string {
  const safe = sanitizeFilenameComponent(raw, fallbackName, flavor);
  const requiredExt = extension.replace(/^\.+/, '');
  return safe.toLowerCase().endsWith(`.${requiredExt.toLowerCase()}`) ? safe : `${safe}.${requiredExt}`;
}

// cmd/anki_connect.rs:37-70. Explicitly sorted map entries, never JSON-hashed.
export function computeAnkiCardContentHash(card: AnkiCard, crypto: Pick<CryptoService, 'createHasher'>): string {
  const hash = crypto.createHasher('SHA-1');
  hash.update(card.front).update('\x1f').update(card.back).update('\x1f');
  hash.update(card.text ?? '').update('\x1f');
  for (const key of Object.keys(card.extra_fields).sort(compareUtf8)) {
    hash.update(key).update('\x1e').update(card.extra_fields[key]!).update('\x1e');
  }
  hash.update('\x1f');
  for (const tag of card.tags) hash.update(tag).update('\x1e');
  return hash.update('\x1f').update(card.template_id ?? '').digestHex();
}

// cmd/anki_connect.rs:1291-1319.
export function batchExportNoteToAnkiCard(note: BatchExportNote, index: number, templateId: string | null): AnkiCard {
  return {
    id: `batch_${index}`, front: note.fields.Front ?? '', back: note.fields.Back ?? '',
    text: note.fields.Text ?? note.fields.text ?? null, tags: note.tags ?? [], images: note.images ?? [],
    extra_fields: note.fields, template_id: templateId, task_id: '', is_error_card: false, error_content: null,
    created_at: toRfc3339(orderedNowEpochNanos()),
    updated_at: toRfc3339(orderedNowEpochNanos()),
  };
}
