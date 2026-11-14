import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import native from '../../../platform/native/index.ts';
import { regex } from '../../../platform/native/regex/index.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import anki from '../../anki/index.ts';
import chat from '../../chat/index.ts';
import review from '../../review/index.ts';
import type { AnkiCard, ChatAnkiProjectedReplacement, ChatAnkiRegexMatch, ToolExecutionContext } from '../api.ts';
import chatanki from '../index.ts';
import { applyTransformOps, TransformFieldGrowthError } from '../src/transform.ts';

const LIMIT = 1_048_576;
const vectors: Array<{
  name: string; text: string; pattern: string; replacement: string; limit: number;
  expected: ChatAnkiProjectedReplacement;
}> = [
  { name: 'full-text nonboundary', text: 'afoo', pattern: '\\B(foo)', replacement: '<$1>', limit: LIMIT,
    expected: { ok: true, value: 'a<foo>', bytes: 6 } },
  { name: 'constant first overrun, not final 16', text: 'aaaa', pattern: 'a', replacement: 'XXXX', limit: 5,
    expected: { ok: false, bytes: 8 } },
  { name: 'literal dollar plus capture is six bytes', text: 'abc', pattern: '(b)', replacement: '$$[$1]', limit: LIMIT,
    expected: { ok: true, value: 'a$[b]c', bytes: 6 } },
  { name: 'missing group', text: 'abc', pattern: '(b)', replacement: '${missing}', limit: LIMIT,
    expected: { ok: true, value: 'ac', bytes: 2 } },
  { name: 'greedy capture name', text: 'abc', pattern: '(b)', replacement: '$1x$1', limit: LIMIT,
    expected: { ok: true, value: 'abc', bytes: 3 } },
  { name: 'malformed braced reference', text: 'abc', pattern: '(b)', replacement: '${1x', limit: LIMIT,
    expected: { ok: true, value: 'a${1xc', bytes: 6 } },
  { name: 'tail is the first overrun', text: 'abc', pattern: '(b)', replacement: '<$1>', limit: 4,
    expected: { ok: false, bytes: 5 } },
  { name: 'named full-text capture first overrun', text: 'xbZ', pattern: '(?P<suffix>\\Bb)',
    replacement: '${suffix}${suffix}${suffix}', limit: 3, expected: { ok: false, bytes: 4 } },
];

it.each(vectors)('C4 real projected primitive: $name', async (vector) => {
  const pattern = await regex.compile(vector.pattern);
  const result = await regex.replaceAllProjected(pattern, vector.text, vector.replacement, vector.limit);
  expect(result).toEqual(vector.expected);
  if (!result.ok) expect(Object.hasOwn(result, 'value')).toBe(false);
});

it('C4 keeps the JS safe-integer limit domain separate from the engine u64 counter', async () => {
  const pattern = await regex.compile('(b)');
  expect(await regex.replaceAllProjected(pattern, '', '$1', 0))
    .toEqual({ ok: true, value: '', bytes: 0 });
  expect(await regex.replaceAllProjected(pattern, 'abc', '$1', Number.MAX_SAFE_INTEGER))
    .toEqual({ ok: true, value: 'abc', bytes: 3 });
  for (const limit of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    await expect(regex.replaceAllProjected(pattern, 'abc', '$1', limit)).rejects.toBeInstanceOf(TypeError);
  }
});

it('C4 legacy replacement accounting uses UTF-8 for literal prefixes and suffixes', async () => {
  // Pure accounting check over actual F7 capture data. The fixed capture fixture
  // below is not a replacement regex engine or proof of a production sync provider.
  const before = 'a'.repeat(LIMIT);
  const pattern = await regex.compile('(?s)(.+)');
  const captured = await regex.captures(pattern, before);
  expect(captured).not.toBeNull();
  if (captured === null) throw new Error('expected one full-field native capture');
  const match: ChatAnkiRegexMatch = {
    start: captured.start, end: captured.end, text: captured.text,
    captures: captured.groups.map((group) => group?.text ?? null), named: {},
  };
  for (const [replacement, extraBytes] of [['中$1', 3], ['$1😀', 4]] as const) {
    let caught: unknown;
    try {
      applyTransformOps([{
        kind: 'regex_replace', field: 'front', source: pattern.pattern, replacement,
        matcher: { execAll: () => [match] },
      }], { front: before, back: 'answer', text: null, tags: [] });
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(TransformFieldGrowthError);
    expect(caught).toMatchObject({ opIndex: 0, field: 'front', bytes: LIMIT + extraBytes });
  }
});

it('C4 real chatanki_transform preserves boundaries/first-overrun/oversized exceptions and permissions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatanki-projected-tool-'));
  const storage = createStorageService({ baseDir: dir, dataLocalDir: path.join(dir, 'local') });
  try {
    expect((await storage.migrations.runAll()).success).toBe(true);
    const host = await createTestHost({
      app: { dataDir: dir }, plugins: [native, chat, anki, review, chatanki],
      provide: {
        paths: { appDataDir: dir, os: { home: dir, data: dir, temp: dir } }, storage,
        settings: createSettingsStore({
          db: () => storage.database('mistakes'), secureStore: () => null, isSensitiveKey: () => false,
        }),
        vfs: {}, llm: {}, // neither provider is called; L04 supplies real UI preflight reads
      },
    });
    try {
      const sessionId = 'session-projected';
      const documentId = 'doc-projected';
      const timestamp = '2026-07-13T00:00:00Z';
      host.ctx.anki.documents.insertDocumentTask({
        id: 'task-projected', document_id: documentId, original_document_name: 'regex.md',
        segment_index: 0, content_segment: 'segment', status: 'Completed',
        created_at: timestamp, updated_at: timestamp,
        error_message: null, anki_generation_options_json: '{}',
      });
      host.ctx.anki.documents.setDocumentSessionSource(documentId, sessionId);
      const card = (id: string, front: string, back: string): AnkiCard => ({
        id, front, back, task_id: 'task-projected', text: null, tags: [], images: [],
        is_error_card: false, error_content: null, created_at: timestamp, updated_at: timestamp,
        extra_fields: {}, template_id: null,
      });
      const oversized = 'x'.repeat(LIMIT + 4096);
      const cards = [card('boundary', 'afoo', 'answer'), card('dollar', 'abc', 'answer'),
        card('capture-bomb', 'a'.repeat(2048), 'answer'), card('oversized', 'question', oversized)];
      expect(host.ctx.anki.cards.insertCardsForDocument(documentId, sessionId, cards)).toHaveLength(4);
      const context: ToolExecutionContext = {
        sessionId, messageId: 'message-projected', blockId: 'block-projected',
        emitToolCallStart: () => undefined, emitToolCallEnd: () => undefined,
        emitToolCallError: () => undefined, saveToolBlock: () => undefined, warn: () => undefined,
      };
      const stored = (id: string) => host.ctx.anki.cards.getCardForSession(id, sessionId)!.card;
      const run = async (id: string, pattern: string, replacement: string,
        mode: 'dry_run' | 'apply' = 'dry_run', field: 'front' | 'back' = 'front') => {
        const result = await host.ctx.chatankiTools.execute({
          id: `call-${id}-${mode}`, name: 'chatanki_transform', arguments: {
            documentId, mode, selection: { cardIds: [id] },
            transform: { ops: [{ op: 'regex_replace', field, pattern, replacement }] },
            ...(mode === 'apply' ? { expectedVersions: { [id]: stored(id).updated_at } } : {}),
          },
        }, context);
        expect(result.success, result.error).toBe(true);
        return result.output as Record<string, unknown>;
      };
      const boundary = await run('boundary', '\\B(foo)', '<$1>');
      expect(boundary.diff).toEqual([{
        cardId: 'boundary', fields: ['front'], before: { front: 'afoo' },
        after: { front: 'a<foo>' }, wouldBeInvalid: false,
      }]);
      expect(stored('boundary').front).toBe('afoo');
      expect(await run('boundary', '\\B(foo)', '<$1>', 'apply'))
        .toMatchObject({ status: 'ok', updated: 1, invalid: 0, mutationApplied: true });
      expect(stored('boundary').front).toBe('a<foo>');
      const dollar = await run('dollar', '(b)', '$$[$1]');
      expect(dollar.diff).toMatchObject([{ after: { front: 'a$[b]c' } }]);
      expect(stored('dollar').front).toBe('abc');

      const beforeBomb = stored('capture-bomb');
      const constantBomb = await run('capture-bomb', '(?s).', 'x'.repeat(4096));
      expect(constantBomb).toMatchObject({ invalid: 1, mutationApplied: false });
      expect(constantBomb.diff).toEqual([{
        cardId: 'capture-bomb', invalid: true, error: 'field_growth_exceeded',
        detail: "ops[0] would grow field 'front' to at least 1052672 bytes, exceeding the 1048576 byte limit",
      }]);
      expect(stored('capture-bomb')).toEqual(beforeBomb);
      const detail = "ops[0] would grow field 'front' to at least 1049600 bytes, exceeding the 1048576 byte limit";
      const bomb = await run('capture-bomb', '(?s)(.)', '$1'.repeat(1024));
      expect(bomb).toMatchObject({ invalid: 1, mutationApplied: false });
      expect(bomb.diff).toEqual([{
        cardId: 'capture-bomb', invalid: true, error: 'field_growth_exceeded', detail,
      }]);
      expect(await run('capture-bomb', '(?s)(.)', '$1'.repeat(1024), 'apply')).toMatchObject({
        status: 'blocked', mode: 'apply', updated: 0, invalid: 1, mutationApplied: false,
        results: [{ cardId: 'capture-bomb', status: 'invalid', error: 'field_growth_exceeded', detail }],
      });
      expect(stored('capture-bomb')).toEqual(beforeBomb);

      const beforeOversized = stored('oversized');
      expect(await run('oversized', 'never-matches-9f8e7d', '$1', 'dry_run', 'back'))
        .toMatchObject({ changed: 0, invalid: 0, diff: [], mutationApplied: false });
      const shrinking = await run('oversized', '(x{1000})', '${missing}', 'dry_run', 'back');
      expect(shrinking).toMatchObject({ changed: 1, invalid: 0, mutationApplied: false });
      expect(shrinking.diff).toMatchObject([{ after: { back: 'x'.repeat(oversized.length % 1000) } }]);
      expect(stored('oversized')).toEqual(beforeOversized);

      const foreign = await host.ctx.chatankiTools.execute({
        id: 'call-foreign-projected', name: 'chatanki_transform', arguments: {
          documentId, mode: 'dry_run', transform: { ops: [{ op: 'regex_replace', field: 'front',
            pattern: '(.)', replacement: '$1' }] },
        },
      }, { ...context, sessionId: 'foreign-session' });
      expect(foreign.success).toBe(false);
      expect(foreign.error).toContain('statusNotFound');
      expect(stored('capture-bomb')).toEqual(beforeBomb);
    } finally {
      await host.dispose();
    }
  } finally {
    storage.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 90_000);
