import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AnkiCard } from '../../../../contracts/ipc/generated/_shared.ts';
import { createNodeCrypto, createWebCrypto } from '../../../platform/crypto/index.ts';
import { batchExportNoteToAnkiCard, computeAnkiCardContentHash as hashWith, rustPathFileName, sanitizeFilenameComponent, sanitizeFilenameWithExtension } from '../src/card-utils.ts';

const nodeCrypto = createNodeCrypto();
const computeAnkiCardContentHash = (card: AnkiCard) => hashWith(card, nodeCrypto);

describe('cmd/anki_connect.rs::batch_export_tests', () => {
  it('test_batch_export_note_to_anki_card_sets_text_from_fields', () => {
    const card = batchExportNoteToAnkiCard({ fields: { Front: '', Back: '', Text: 'a {{c1::b}} c' }, tags: [], images: [] }, 0, 'cloze');
    expect(card.text).toBe('a {{c1::b}} c');
  });
  it('test_batch_export_note_to_anki_card_fallback_text_key', () => {
    const card = batchExportNoteToAnkiCard({ fields: { text: 'x {{c1::y}} z' }, tags: [], images: [] }, 1, null);
    expect(card.text).toBe('x {{c1::y}} z');
  });
  it('batch export cards take two Utc::now().to_rfc3339() samples for created_at and updated_at', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2099-11-07T00:00:00.123Z') });
    try {
      const card = batchExportNoteToAnkiCard({ fields: { Front: 'f', Back: 'b' }, tags: [], images: [] }, 0, null);
      expect(card.created_at).toMatch(/^2099-11-07T00:00:00\.123(?:\d{3}){0,2}\+00:00$/);
      expect(card.updated_at).toMatch(/^2099-11-07T00:00:00\.123(?:\d{3}){0,2}\+00:00$/);
      expect(card.updated_at > card.created_at).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it('test_sanitize_filename_component_strips_path_segments', () => {
    expect(sanitizeFilenameComponent('../unsafe/../../deck?.apkg', 'fallback', 'posix')).toBe('deck_.apkg');
    expect(sanitizeFilenameComponent('..\\unsafe\\deck?.apkg', 'fallback', 'win32')).toBe('deck_.apkg');
    expect(sanitizeFilenameComponent('..\\unsafe\\deck?.apkg', 'fallback', 'posix')).toBe('_unsafe_deck_.apkg');
  });
  it('Path::file_name is lexical: trailing `..`, roots and bare Windows prefixes have no file name', () => {
    expect(rustPathFileName('a/b/..', 'posix')).toBeNull();
    expect(rustPathFileName('a/b/.', 'posix')).toBe('b');
    expect(rustPathFileName('a/b//', 'posix')).toBe('b');
    expect(rustPathFileName('/', 'posix')).toBeNull();
    expect(rustPathFileName('.', 'posix')).toBeNull();
    expect(rustPathFileName('C:', 'win32')).toBeNull();
    expect(rustPathFileName('C:deck', 'win32')).toBe('deck');
    expect(rustPathFileName('C:\\', 'win32')).toBeNull();
    expect(rustPathFileName('\\\\server\\share', 'win32')).toBeNull();
    expect(rustPathFileName('\\\\server\\share\\deck', 'win32')).toBe('deck');
    expect(rustPathFileName('\\\\?\\C:\\deck', 'win32')).toBe('deck');
    expect(rustPathFileName('\\\\?\\UNC\\server\\share', 'win32')).toBeNull();
    expect(rustPathFileName('C:deck', 'posix')).toBe('C:deck');
    expect(sanitizeFilenameComponent('deck/..', 'fallback', 'posix')).toBe('fallback');
  });
  it('test_sanitize_filename_with_extension_normalizes_suffix', () => {
    expect(sanitizeFilenameWithExtension(' deck-name ', 'fallback', 'apkg', 'posix')).toBe('deck-name.apkg');
  });
  const fixture = () => ({ ...batchExportNoteToAnkiCard({ fields: { Zeta: 'z', Alpha: 'a' }, tags: ['a', 'b'], images: [] }, 0, 'tmpl-1'), front: 'front', back: 'back', text: 'text' });
  it('content_hash_is_stable_across_extra_field_iteration_order', () => {
    const card = fixture();
    const first = computeAnkiCardContentHash(card);
    expect(first).toBe(computeAnkiCardContentHash(card));
    expect(first).toHaveLength(40);
    expect(first).toBe(computeAnkiCardContentHash({ ...card, extra_fields: { Alpha: 'a', Zeta: 'z' } }));
  });
  it('content_hash_changes_when_content_changes', () => {
    const card = fixture();
    const base = computeAnkiCardContentHash(card);
    expect(base).not.toBe(computeAnkiCardContentHash({ ...card, back: 'different' }));
    expect(base).not.toBe(computeAnkiCardContentHash({ ...card, extra_fields: { ...card.extra_fields, Alpha: 'mutated' } }));
    expect(computeAnkiCardContentHash({ ...card, front: 'ab', back: 'c' })).not.toBe(computeAnkiCardContentHash({ ...card, front: 'a', back: 'bc' }));
  });
  it('content_hash is sha1 over the explicit byte layout with extra_fields keys in UTF-8 byte order, on node and web crypto', () => {
    const card = { ...fixture(), extra_fields: { '\u{1F600}': 'astral', '\uFF01': 'bmp' }, tags: ['t1', 't2'], text: null };
    const expected = createHash('sha1')
      .update('front\x1fback\x1f\x1f\uFF01\x1ebmp\x1e\u{1F600}\x1eastral\x1e\x1ft1\x1et2\x1e\x1ftmpl-1')
      .digest('hex');
    expect(computeAnkiCardContentHash(card)).toBe(expected);
    expect(hashWith(card, createWebCrypto())).toBe(expected);
  });
});
