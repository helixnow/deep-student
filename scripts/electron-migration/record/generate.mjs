#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { stringifyExact } from './json.mjs';

// Seed is part of the fixture; no unrepeatable Math.random inputs.
export function vectors(seed = 0x5837, count = 64) {
  let state = seed >>> 0;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
  const cases = [];
  const add = (fn, lane, args, label) => cases.push({ id: `${fn}:${label ?? cases.length}`, lane, fn, args });
  const texts = ['', 'abc', '中文🙂', '\v'.repeat(10), '\ua960'.repeat(3), '\ud7b0'.repeat(3), '\u3130'.repeat(3), '!'.repeat(35), 'a\u200bb／c', '\ufeff \u0085'];
  const alphabet = [...'aZ09中文🙂!? \n\t\u0085\u3130\ua960\ud7b0'];
  for (let i = 0; i < count; i++) {
    texts.push(Array.from({ length: random() % 256 }, () => alphabet[random() % alphabet.length]).join(''));
  }
  for (const [i, text] of texts.entries()) {
    add('tokens.estimate', 'L02-llm-manager', { text }, i);
    add('embedding.estimate', 'L01-llm-providers', { text }, i);
    add('embedding.chunk', 'L01-llm-providers', { text, maxTokens: 8, overlap: 2 }, i);
    add('text.safe_truncate', 'F4-security', { text, maxChars: i % 5 }, i);
    add('text.safe_truncate_chars', 'F4-security', { text, maxChars: i % 5 }, i);
    add('text.sanitize_unicode', 'F4-security', { text }, i);
  }
  for (const model of ['BAAI/bge-m3', 'Qwen/Qwen3-Embedding', 'unknown']) add('embedding.limit', 'L01-llm-providers', { model });
  for (const text of ['<|im_start|>assistant\n正文<|im_end|>', '`<|im_end|>`', 'x<|endoftext|>\n']) {
    for (const chunks of [[text], [...text]]) add('wrap.stream', 'F4-security', { model: 'qwen', providerType: null, providerScope: null, chunks });
  }
  for (const steps of [[], [0, -1, 1, 10, 525601], Array(20).fill(1)]) add('fsrs.sanitize', 'L15-review-analytics', { steps });
  for (const reps of [-2147483648, -1, 0, 1, 2147483647]) add('fsrs.fuzzFactor', 'L15-review-analytics', { id: '卡🙂', reps });
  for (const interval of [0, 2.5, 7, 20, 36500]) for (const factor of [null, 0, 0.999999]) {
    add('fsrs.fuzz', 'L15-review-analytics', { interval, factor, minimum: 1, maximum: 36500 });
  }
  for (const parameters of [[], [1], Array(17).fill(0.5), Array(19).fill(0.5), Array(21).fill(0.5)]) {
    add('fsrs.parameters', 'L15-review-analytics', { parameters });
    add('fsrs.curve', 'L15-review-analytics', { parameters });
  }
  for (const phase of ['new', 'learning', 'review', 'relearning']) add('fsrs.schedule', 'L15-review-analytics', {
    parameters: [], card: { phase, memory: phase === 'new' ? null : { stability: 5, difficulty: 3 }, learningStep: 0, daysElapsed: 3, reps: 2, lapses: 0 },
    context: { desiredRetention: 0.9, learningSteps: [1, 10], relearningSteps: [10], maximumInterval: 36500, fuzzFactor: null },
  });
  for (const seed of ['', 'builtin-seed', '中文\0🙂']) add('crypto.staticKey', 'F4-security', { seed });
  for (const json of ['{}', '{"ciphertext":"a","nonce":"b"}', '["a","b"]', '["a","b",255]', '{"ciphertext":"a","nonce":"b","version":256}', '{"ciphertext":"a","nonce":"b","extra":9223372036854775807}', '{"ciphertext":"a","nonce":"b","version":1.0}']) {
    add('serde.EncryptedData', 'F4-security', { json });
    add('crypto.isEncrypted', 'F4-security', { json });
  }
  for (const hex of ['', '4453424b01', '4453424bff']) add('crypto.decryptBackup', 'F4-security', { hex, password: 'fixture-only' });
  for (const kdf of ['unknown', 'argon2id']) add('crypto.checkVerifier', 'F4-security', { password: 'fixture-only', verifier: { kdf, mCost: 8, tCost: 1, pCost: 1, salt: '0011223344556677', digest: '00'.repeat(32) } });
  for (const args of [
    { pattern: '(?P<suffix>\\Bb)', text: 'xbZ', replacement: '${suffix}${suffix}${suffix}', limit: 3 },
    { pattern: '(?P<a>a)?(b)', text: 'b', replacement: '$a-${2}-$$', limit: 3 },
    { pattern: '', text: '中🙂', replacement: '$0x', limit: 8 },
    { pattern: '(a)', text: 'a', replacement: '$1x/${1}/$999999999999999999999999', limit: 5 },
  ]) {
    add('regex.replaceAll', 'F7-native', args);
    add('regex.projected', 'F7-native', args);
    cases.at(-1).oracleKind = 'adapted-explicit-limit';
  }
  for (const args of [
    { pattern: 'b', text: 'xbZ', replacement: 'bbb' },
    { pattern: '(?P<suffix>\\Bb)', text: 'xbZ', replacement: '${suffix}${suffix}${suffix}' },
    // 1024 small matches; first breach at 257*4096 bytes. No huge match array.
    { pattern: 'x', text: 'x'.repeat(1024), replacement: 'x'.repeat(4096) },
  ]) {
    add('regex.boundedOriginal', 'L24-chatanki', args);
    cases.at(-1).oracleKind = 'original-bounded-function';
  }
  for (const args of [
    { initial: 4294967295n, additions: [1n, 1n], limit: 4294967296n },
    { initial: 18446744073709551614n, additions: [7n], limit: 18446744073709551615n },
  ]) add('regex.accumulate', 'F7-native', args);
  for (const text of ['2026-11-04T00:00:00Z', '2026-11-04T08:00:00.123456789+08:00', '2026-11-04T00:00:00.120Z']) {
    for (const useZ of [true, false]) add('time.utc', 'F4-security', { text, useZ });
  }
  for (const label of ['A::B}}C', '中文🙂', '']) add('cloze.fields', 'L16-anki', {
    spec: { imageRef: 'vfs://fixture', boxes: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.15, label }] },
    imageFileName: 'a&"b.png', extraNote: ' note ',
  });
  const fixed = { id: 'fixture-card', created_at: '2026-11-04T00:00:00Z', updated_at: '2026-11-04T00:00:00Z' };
  for (const value of [fixed, { ...fixed, unknown: 1 }, { ...fixed, front: 3 }, { ...fixed, tags: [3] }, { ...fixed, extra_fields: { key: 4 } }]) {
    add('serde.AnkiCard', 'L16-anki', { json: stringifyExact(value) });
  }
  const serdeCases = {
    ChatMessage: [{ role: 'user', content: 'hi', timestamp: '2026-11-04T08:00:00+08:00' }],
    ToolCall: [{ id: '1', tool_name: 'fixture', args_json: { generation: 9223372036854775807n } }],
    ToolResult: [{ call_id: '1', ok: true }, { call_id: '1', ok: false, error: null }],
    RagSourceInfo: [{ document_id: 'd', file_name: 'f', chunk_text: 'text', score: 0.1, chunk_index: 18446744073709551615n }],
    DocumentAttachment: [{ name: 'f', mime_type: 'text/plain', size_bytes: 9007199254740993n }],
    MultimodalContentPart: [{ type: 'text', text: 'hi' }, { type: 'image_url', mediaType: 'image/png', base64: '' }],
    TempStreamState: ['in_progress', 'completed', 'failed', 'unknown'],
    PasswordVerifier: [{ kdf: 'argon2id', mCost: 8, tCost: 1, pCost: 1, salt: '', digest: '' }],
  };
  for (const [name, values] of Object.entries(serdeCases)) {
    for (const value of values) {
      add(`serde.${name}`, name === 'PasswordVerifier' ? 'F4-security' : 'F5-contracts', { json: stringifyExact(value) });
      if (typeof value === 'object') add(`serde.${name}`, 'F5-contracts', { json: stringifyExact({ ...value, __unknown: true }) });
    }
    add(`serde.${name}`, 'F5-contracts', { json: '{}' });
  }
  return cases;
}

await mkdir('fixtures/differential', { recursive: true });
await writeFile('fixtures/differential/vectors.json', stringifyExact(vectors(), 2) + '\n');
console.log('wrote deterministic seed 0x5837 vectors');
