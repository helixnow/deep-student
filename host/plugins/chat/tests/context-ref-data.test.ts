import { expect, it } from 'vitest';
import { decodeVfsContextRefData } from '../api.ts';

it('chat/api.ts publishes the serde_json::from_str::<VfsContextRefData> decoder', () => {
  const ref = { sourceId: 'note_1', resourceHash: 'h1', type: 'note', name: 'Note' };
  expect(decodeVfsContextRefData(JSON.stringify({
    refs: [ref, { ...ref, sourceId: 'img_1', type: { image: null }, resourceId: 'res_1', injectModes: { image: ['ocr'] } }],
    truncated: false, totalCount: 2,
  }))).toEqual({
    refs: [ref, { ...ref, sourceId: 'img_1', type: 'image', resourceId: 'res_1', injectModes: { image: ['ocr'] } }],
    truncated: false, totalCount: 2,
  });
  expect(decodeVfsContextRefData('{"refs":[{"sourceId":"a","resourceHash":"h","type":"video","name":"n"}]}')).toBeNull();
  expect(decodeVfsContextRefData('{"refs":[],"totalCount":-1}')).toBeNull();
  expect(decodeVfsContextRefData('not json')).toBeNull();
});
