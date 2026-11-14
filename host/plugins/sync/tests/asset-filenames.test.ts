import { expect, it } from 'vitest';
import * as names from '../src/asset-filenames.ts';

function roundtrip(raw: string): string {
  const encoded = names.encodeSegment(raw);
  expect(names.decodeSegment(encoded)).toBe(raw);
  expect(names.sanitizeSegment(encoded)).toBe(encoded);
  return encoded;
}
it('rclone_style_unsafe_characters_roundtrip_without_collisions', () => {
  const encoded = roundtrip('a:b?c*d"e<f>g|h\\i\t.txt');
  expect(encoded.startsWith('‛er')).toBe(true);
  for (const char of '\\/:*?"<>|') expect(encoded).not.toContain(char);
  expect(/\p{Cc}/u.test(encoded)).toBe(false);
  expect(encoded).not.toBe(roundtrip('a：b？c＊d＂e＜f＞g｜h＼i␉.txt'));
});
it('reserved_trailing_and_dot_names_are_safe_and_reversible', () => {
  for (const raw of ['CON', 'con.txt', 'COM1.pdf', 'LPT9', 'report.', 'draft ', '.', '..']) {
    const encoded = roundtrip(raw);
    expect(() => names.validateEncodedSegment(encoded)).not.toThrow();
    expect(encoded).not.toBe(raw);
  }
  expect(names.encodeSegment('console.log')).toBe('console.log');
});
it('nfc_and_nfd_remain_distinct_nfc_safe_keys_and_roundtrip', () => {
  const nfc = roundtrip('caf\u00e9.png'); const nfd = roundtrip('cafe\u0301.png');
  expect(nfc).not.toBe(nfd);
  expect(nfc.normalize('NFC')).toBe(nfc); expect(nfd.normalize('NFC')).toBe(nfd);
  expect(nfd.startsWith('‛eh')).toBe(true);
});
it('marker_and_quote_in_user_name_are_data_not_protocol', () => {
  for (const raw of ['‛erCON', '‛eh616263', 'literal‛quote']) roundtrip(raw);
});
it('malformed_or_noncanonical_encodings_fail_closed', () => {
  for (const encoded of ['‛e', '‛exabc', '‛eh0', '‛ehzz', '‛erabc‛', '‛erplain']) {
    expect(() => names.decodeSegment(encoded)).toThrow();
    expect(names.sanitizeSegment(encoded)).toBeNull();
  }
});
it('segment_and_total_path_limits_fail_closed_without_truncation', () => {
  expect(() => names.encodeSegment('a'.repeat(255))).not.toThrow();
  expect(() => names.encodeSegment('a'.repeat(256))).toThrow();
  expect(() => names.encodeSegment('a'.repeat(250) + ':')).toThrow();
  expect(() => names.encodeAssetKeySegments('active', 'images', ['a'.repeat(120), 'b'.repeat(120)])).toThrow();
  expect(names.sanitizeAssetKey('active/images/' + 'a'.repeat(300))).toBeNull();
});
it('paths_roundtrip_and_traversal_fails_closed', () => {
  const key = names.encodeAssetKeySegments('active', 'images', ['sub:dir', 'CON.txt', 'cafe\u0301.png']);
  expect(names.decodeAssetKey(key)).toBe('active/images/sub:dir/CON.txt/cafe\u0301.png');
  expect(names.sanitizeAssetKey(key)).toBe(key);
  for (const invalid of ['active/images', 'active//x', 'active/images/../x', 'active/images//x', 'evil/images/x']) {
    expect(names.sanitizeAssetKey(invalid)).toBeNull();
  }
});
it('legacy_lossy_alias_is_available_beside_new_key', () => {
  const key = names.encodeAssetKeySegments('active', 'images', ['pic:1?.png']);
  expect(key).not.toBe('active/images/pic_1_.png');
  expect(names.legacySanitizedAssetKey(key)).toBe('active/images/pic_1_.png');
  expect(names.legacySanitizedAssetKey('active/images/plain_name.png')).toBe('active/images/plain_name.png');
});
it('casefold_keeps_case_conflicts_but_not_nfc_nfd_collision', () => {
  expect(names.casefoldKey('active/images/Logo.png')).toBe(names.casefoldKey('active/images/logo.png'));
  const nfc = names.encodeAssetKeySegments('active', 'images', ['caf\u00e9.png']);
  const nfd = names.encodeAssetKeySegments('active', 'images', ['cafe\u0301.png']);
  expect(names.casefoldKey(nfc)).not.toBe(names.casefoldKey(nfd));
});
it('conflict_messages_carry_stable_marker', () => {
  for (const message of [names.localDuplicateMessage('k', 'a', 'b'), names.localCaseConflictMessage('a', 'b'),
    names.uploadCaseConflictMessage('a', 'b'), names.downloadCaseConflictMessage('a', 'b'), names.shadowedDivergentMessage('a', 'b')]) {
    expect(message.startsWith(names.FILENAME_CONFLICT_MARKER)).toBe(true);
  }
});
it('keeps char-wise Unicode lowercasing and all control/quoted replacement mappings', () => {
  expect(names.casefoldKey('ΟΣ')).toBe('οσ');
  for (let code = 0; code <= 159; code++) roundtrip(`x${String.fromCodePoint(code)}y`);
  for (const raw of ['\ufeffx\u0080', '␠␡．', 'COM0', 'lpt9.txt', 'name. .']) roundtrip(raw);
  expect(() => names.decodeSegment('‛ehff')).toThrow('文件名编码还原后不是有效 UTF-8');
});
