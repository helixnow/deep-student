/**
 * X7-L16-SERDE：`AnkiCard` 入参按 `dstu-core/src/models.rs:1380-1412` 的 serde 规则解码。
 * `#[serde(default)]` 只覆盖“字段缺失”；显式错类型（含 null 落到非 Option 字段）必须报
 * Tauri `invalid args` 错误，且不落库、不写文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decodeAnkiCardInput } from '../src/anki-cards.ts';
import { createAnkiTestEnv, type AnkiTestEnv } from './env.ts';

const NOW = () => '2026-11-04T00:00:00+00:00';

function base(): Record<string, unknown> {
  return { id: 'card-serde', task_id: 'task-serde', front: 'Q', back: 'A', tags: [], images: [], extra_fields: {} };
}

describe('decodeAnkiCardInput (models.rs AnkiCard serde)', () => {
  it('missing fields take serde defaults; Option fields accept null', () => {
    const card = decodeAnkiCardInput({ text: null, error_content: null, template_id: null }, NOW);
    expect(card).toMatchObject({
      front: '', back: '', text: null, tags: [], images: [], task_id: '', is_error_card: false,
      error_content: null, created_at: NOW(), updated_at: NOW(), extra_fields: {}, template_id: null,
    });
    expect(card.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it.each([
    [{ front: 3 }, 'invalid type: number, expected a string'],
    [{ back: null }, 'invalid type: null, expected a string'],
    [{ text: 1.5 }, 'invalid type: number, expected a string'],
    [{ tags: [3] }, 'invalid type: number, expected a string'],
    [{ tags: 'x' }, 'invalid type: string "x", expected a sequence'],
    [{ images: null }, 'invalid type: null, expected a sequence'],
    [{ id: null }, 'invalid type: null, expected a string'],
    [{ task_id: false }, 'invalid type: boolean `false`, expected a string'],
    [{ is_error_card: 'true' }, 'invalid type: string "true", expected a boolean'],
    [{ is_error_card: null }, 'invalid type: null, expected a boolean'],
    [{ error_content: [] }, 'invalid type: sequence, expected a string'],
    [{ created_at: null }, 'invalid type: null, expected a string'],
    [{ updated_at: {} }, 'invalid type: map, expected a string'],
    [{ extra_fields: { key: 3 } }, 'invalid type: number, expected a string'],
    [{ extra_fields: [] }, 'invalid type: sequence, expected a map'],
    [{ extra_fields: null }, 'invalid type: null, expected a map'],
    [{ template_id: 7 }, 'invalid type: number, expected a string'],
  ])('rejects explicit wrong type %j', (patch, detail) => {
    expect(() => decodeAnkiCardInput({ ...base(), ...patch }, NOW)).toThrow(detail);
  });

  it('reports the first invalid field in input key order (serde visits the map in order)', () => {
    expect(() => decodeAnkiCardInput({ tags: [true], front: 2 }, NOW))
      .toThrow('invalid type: boolean `true`, expected a string');
    expect(() => decodeAnkiCardInput({ front: 2, tags: [true] }, NOW))
      .toThrow('invalid type: number, expected a string');
  });

  it('ignores unknown fields (no deny_unknown_fields)', () => {
    expect(decodeAnkiCardInput({ ...base(), unknown: 3 }, NOW).front).toBe('Q');
  });
});

describe('Host entry points reject bad AnkiCard fields without side effects', () => {
  // 一个迁移库供本组复用（每例重建 env 会长时间同步阻塞 worker）；每例前重置固定行。
  let env: AnkiTestEnv;
  beforeAll(async () => {
    env = await createAnkiTestEnv();
    env.storage.database('mistakes').run(`INSERT INTO document_tasks (id, document_id, original_document_name,
      segment_index, content_segment, status, anki_generation_options_json)
      VALUES ('task-serde', 'doc', 'd', 0, 's', 'Completed', '{}')`);
  }, 120_000);
  beforeEach(() => {
    const db = env.storage.database('mistakes');
    db.run("DELETE FROM anki_cards WHERE id = 'card-serde'");
    db.run(`INSERT INTO anki_cards (id, task_id, front, back) VALUES ('card-serde', 'task-serde', 'old', 'old')`);
  });
  afterAll(async () => {
    await env.dispose();
  }, 120_000);

  it.each([
    [{ front: 3 }, 'invalid type: number, expected a string'],
    [{ tags: [3] }, 'invalid type: number, expected a string'],
    [{ extra_fields: { key: 3 } }, 'invalid type: number, expected a string'],
  ])('update_anki_card rejects %j before writing', async (patch, detail) => {
    await expect(env.host.invoke('update_anki_card', { card: { ...base(), ...patch } }))
      .rejects.toBe(`invalid args \`card\` for command \`update_anki_card\`: ${detail}`);
    expect(env.storage.database('mistakes').get('SELECT front, back FROM anki_cards WHERE id = ?1', ['card-serde']))
      .toEqual({ front: 'old', back: 'old' });
  });

  it('export_cards_as_apkg rejects a bad element before writing any file', async () => {
    const downloads = path.join(env.dir, 'Downloads');
    await expect(env.host.invoke('export_cards_as_apkg', {
      selectedCards: [base(), { ...base(), id: 'b', extra_fields: { key: 3 } }],
      deckName: 'Deck',
      noteType: 'Basic',
    })).rejects.toBe(
      'invalid args `selectedCards` for command `export_cards_as_apkg`: invalid type: number, expected a string',
    );
    expect(fs.existsSync(path.join(downloads, 'Deck.apkg'))).toBe(false);
  });
});
