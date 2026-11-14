// serde parity for ChatAnkiRunArgs / ChatAnkiStartArgs (chatanki_executor.rs:404–465, 573–634, 685–727).
import { expect, it } from 'vitest';
import { parseChatAnkiRunArgs, parseChatAnkiStartArgs } from '../src/run-args.ts';

const rawJSON = (text: string) => (JSON as typeof JSON & { rawJSON(text: string): unknown }).rawJSON(text);
const run = { goal: 'g', templateMode: 'all' };
const start = { goal: 'g', content: 'c', templateMode: 'all' };

it('rename_all camelCase: snake spellings without an alias are unknown keys and ignored', () => {
  const args = parseChatAnkiRunArgs({
    ...run, resource_id: 'file_a', resource_ids: ['file_b'], template_id: 't', template_ids: ['t2'],
    deck_name: 'Deck', note_type: 'Cloze', max_cards: 5,
  });
  expect(args).toMatchObject({
    resourceId: null, resourceIds: [], templateId: null, templateIds: null, deckName: null, noteType: null, maxCards: null,
  });
});

it('snake aliases Rust declares are accepted; both spellings at once is a duplicate field', () => {
  expect(parseChatAnkiRunArgs({
    ...run, extra_requirements: 'x', output_protocol: 'json_object', visual_hint: 'v', content_format: 'prose',
    enable_qa_pass: false, enable_critic_pass: true, enable_fsrs_feedback: true, max_images: '3', enable_preference_memory: false,
  })).toMatchObject({
    extraRequirements: 'x', outputProtocol: 'json_object', visualHint: 'v', contentFormat: 'prose', enableQaPass: false,
    enableCriticPass: true, enableFsrsFeedback: true, maxImages: 3, enablePreferenceMemory: false,
  });
  expect(() => parseChatAnkiRunArgs({ ...run, extraRequirements: 'a', extra_requirements: 'b' }))
    .toThrow('duplicate field `extraRequirements`');
});

it('missing fields are reported in struct order after the visit; type errors win in input order', () => {
  expect(() => parseChatAnkiRunArgs({})).toThrow('missing field `goal`');
  expect(() => parseChatAnkiRunArgs({ goal: 'g' })).toThrow('missing field `templateMode`');
  expect(() => parseChatAnkiRunArgs({ deckName: 3 })).toThrow('invalid type: number, expected a string');
  expect(() => parseChatAnkiStartArgs({ goal: 'g', templateMode: 'all' })).toThrow('missing field `content`');
});

it('templateMode/contentFormat use Value::deserialize_enum texts', () => {
  expect(() => parseChatAnkiRunArgs({ goal: 'g', templateMode: 'one' }))
    .toThrow('unknown variant `one`, expected one of `single`, `multiple`, `all`');
  expect(() => parseChatAnkiRunArgs({ ...run, contentFormat: null })).toThrow('invalid type: null, expected string or map');
  expect(parseChatAnkiRunArgs({ goal: 'g', templateMode: { single: null } }).templateMode).toBe('single');
});

it('maxCards: i32 range and integer literal checks, raw-number atoms included', () => {
  expect(parseChatAnkiRunArgs({ ...run, maxCards: '+7' }).maxCards).toBe(7);
  expect(parseChatAnkiRunArgs({ ...run, maxCards: rawJSON('12') }).maxCards).toBe(12);
  expect(() => parseChatAnkiRunArgs({ ...run, maxCards: rawJSON('5.0') })).toThrow('maxCards must be an integer');
  expect(() => parseChatAnkiRunArgs({ ...run, maxCards: 2 ** 31 })).toThrow('maxCards out of i32 range');
  expect(() => parseChatAnkiRunArgs({ ...run, maxCards: '2147483648' })).toThrow('maxCards string must be a valid integer');
  expect(() => parseChatAnkiRunArgs({ ...run, maxCards: true })).toThrow('maxCards must be integer or numeric string');
  expect(parseChatAnkiRunArgs({ ...run, maxCards: '  ' }).maxCards).toBeNull();
});

it('maxImages: u32 deserializer with its own texts', () => {
  expect(() => parseChatAnkiRunArgs({ ...run, maxImages: -1 })).toThrow('maxImages must be a non-negative integer');
  expect(() => parseChatAnkiRunArgs({ ...run, maxImages: '-1' })).toThrow('maxImages string must be a valid integer');
  expect(() => parseChatAnkiRunArgs({ ...run, maxImages: 2 ** 32 })).toThrow('maxImages out of u32 range');
  expect(parseChatAnkiRunArgs({ ...run, maxImages: 4 }).maxImages).toBe(4);
});

it('start ignores run-only keys instead of decoding them', () => {
  const args = parseChatAnkiStartArgs({ ...start, route: 5, resourceIds: 'x', visualHint: [], maxImages: 'bad' });
  expect(args).toMatchObject({ route: null, resourceIds: [], visualHint: null, maxImages: null, content: 'c' });
});
