import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { AnkiCard } from '../../../../contracts/ipc/generated/_shared.ts';
import { fieldChecksum, stableModelIdForTemplate, stableNoteGuid } from '../src/apkg-export-model.ts';

afterEach(() => vi.unstubAllGlobals());

it('keeps SHA-1 checksums and anonymous GUID UTF-8 ordering without Buffer', () => {
  const card: AnkiCard = {
    id: '', task_id: '', front: '问题😀', back: '答案', text: null,
    tags: ['学习', '😀'], images: [], is_error_card: false, error_content: null,
    created_at: '', updated_at: '', template_id: '模板',
    // UTF-8 order differs from JS UTF-16 order for these two keys.
    extra_fields: { '\u{10000}': 'a', '\ue000': 'b' },
  };
  const expectedGuid = createHash('sha1').update([
    'deep-student-apkg-guid-v1', 'content', card.front, card.back, '',
    '\ue000\x1eb\x1e\u{10000}\x1ea\x1e', '学习\x1e😀\x1e', '模板',
  ].join('\x1f')).digest('hex').slice(0, 20);
  const expectedChecksum = createHash('sha1').update('问题😀').digest().readUInt32BE(0);
  const expectedModelId = stableModelIdForTemplate('模板😀');

  vi.stubGlobal('Buffer', undefined);
  expect(fieldChecksum('<b>问题😀</b>')).toBe(expectedChecksum);
  expect(fieldChecksum('<i></i>')).toBe(0);
  expect(stableNoteGuid(card)).toBe(expectedGuid);
  expect(stableModelIdForTemplate('模板😀')).toBe(expectedModelId);
});
