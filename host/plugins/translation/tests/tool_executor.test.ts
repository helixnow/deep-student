import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { createTestHost } from '../../../kernel/testing.ts';
// boundary-allow cross-plugin-impl: install L11's production owner through its plugin entry for translation-save tests
import vfsRepos from '../../vfs-repos/index.ts';
import { updateTranslationMetadata } from './pending-metadata-owner.ts';
import { setTranslationLogger } from '../src/logging.ts';
import {
  MAX_LANGUAGE_CODE_CHARS, MAX_PIPELINE_SEGMENT_CHARS, MAX_PROMPT_OVERRIDE_CHARS, MAX_RESULT_READ_CHUNK_CHARS,
  MAX_TOOL_TEXT_FIELD_CHARS, MAX_TRANSLATED_OUTPUT_CHARS, MAX_TRANSLATION_TEXT_CHARS,
  MIN_TRANSLATED_OUTPUT_CHARS, OUTPUT_EXPANSION_FACTOR, STALE_CLAIM_REDEEM_AFTER_MS,
  TRANSLATION_RESULT_CACHE_MAX_CHARS, TRANSLATION_RESULT_CACHE_MAX_ENTRIES,
  TRANSLATION_RESULT_TTL_MS, TranslationResultCache, TranslationToolExecutor,
  TranslationToolFailure, buildPersistedMetadata, defaultCachedMeta, ensureNotCancelled,
  parseTranslateArgs, parseTranslationResultReadArgs, parseTranslationSaveArgs,
  replaceTranslationResultCache, resolveToolExecutor, splitCodePoints, splitTranslationText,
  translatedOutputLimit, unicodePreview, validateLanguageCode, withTranslationCache,
  type CachedTranslationMeta,
} from '../src/tool_executor.ts';

function validTranslateArgs(): Record<string, unknown> {
  return {
    text: 'Hello, world!',
    source_lang: 'en',
    target_lang: 'zh-CN',
    formality: 'formal',
    domain: 'academic',
    terms: [{ src: 'world', dst: '世界' }],
  };
}

function meta(overrides: Partial<CachedTranslationMeta> = {}): CachedTranslationMeta {
  return { ...defaultCachedMeta(), ...overrides };
}

function insertSimple(
  cache: TranslationResultCache,
  session: string,
  source: string,
  translated: string,
  nowMs: number,
): string {
  return cache.insertAt({
    ownerSessionId: session,
    source,
    translated,
    sourceLang: 'en',
    targetLang: 'zh',
    meta: defaultCachedMeta(),
    nowMs,
  });
}

class GeneralCatchAllExecutor {
  canHandle(_toolName: string): boolean { return true; }
  name(): string { return 'GeneralToolExecutor'; }
}

describe('src/chat_v2/tools/translation_executor.rs', () => {
  it('handles_translation_tools_and_sensitivity', () => {
    const executor = new TranslationToolExecutor();
    expect(executor.canHandle('translate_text')).toBe(true);
    expect(executor.canHandle('builtin-translate_text')).toBe(true);
    expect(executor.canHandle('builtin-translation_result_read')).toBe(true);
    expect(executor.canHandle('builtin-translation_save')).toBe(true);
    expect(executor.canHandle('translation_delete')).toBe(false);
    expect(executor.name()).toBe('TranslationToolExecutor');
    expect(executor.sensitivityLevel('builtin-translate_text')).toBe('low');
    expect(executor.sensitivityLevel('builtin-translation_result_read')).toBe('low');
    expect(executor.sensitivityLevel('translation_save')).toBe('medium');
    expect(executor.concurrencyClass('translate_text')).toBe('serial');
    expect(executor.concurrencyClass('builtin-translation_result_read')).toBe('read_only');
  });

  it('registers_before_general_catch_all', () => {
    const executors = [new TranslationToolExecutor(), new GeneralCatchAllExecutor()];
    for (const toolName of [
      'builtin-translate_text',
      'builtin-translation_result_read',
      'builtin-translation_save',
    ]) {
      const executor = resolveToolExecutor(executors, toolName);
      expect(executor, 'translation executor must be registered').toBeDefined();
      expect(executor!.name()).toBe('TranslationToolExecutor');
    }
  });

  it('translated_output_limit_is_proportional_with_floor_and_ceiling', () => {
    expect(translatedOutputLimit(0)).toBe(MIN_TRANSLATED_OUTPUT_CHARS);
    expect(translatedOutputLimit(100)).toBe(MIN_TRANSLATED_OUTPUT_CHARS);
    expect(translatedOutputLimit(10_000)).toBe(10_000 * OUTPUT_EXPANSION_FACTOR);
    expect(translatedOutputLimit(MAX_TRANSLATION_TEXT_CHARS)).toBe(MAX_TRANSLATED_OUTPUT_CHARS);
    expect(MAX_TRANSLATION_TEXT_CHARS + MAX_TRANSLATED_OUTPUT_CHARS)
      .toBeLessThanOrEqual(TRANSLATION_RESULT_CACHE_MAX_CHARS);
  });

  it('translate_args_accept_prompt_override_and_reject_blank_or_oversized', () => {
    const withPrompt = validTranslateArgs();
    withPrompt.prompt_override = 'You are a poetry translator. Keep rhyme.';
    const parsed = parseTranslateArgs(withPrompt);
    expect(parsed.promptOverride).toBe('You are a poetry translator. Keep rhyme.');

    const blank = validTranslateArgs();
    blank.prompt_override = '   ';
    expect(() => parseTranslateArgs(blank)).toThrow();

    const oversized = validTranslateArgs();
    oversized.prompt_override = 'x'.repeat(MAX_PROMPT_OVERRIDE_CHARS + 1);
    expect(() => parseTranslateArgs(oversized)).toThrow();

    expect(parseTranslateArgs(validTranslateArgs()).promptOverride).toBeUndefined();
  });

  it('result_read_args_are_strict_and_bounded', () => {
    const parsed = parseTranslationResultReadArgs({
      translation_result_id: 'translation_result_123',
      offset_chars: 100,
      limit_chars: 500,
    });
    expect(parsed.resultId).toBe('translation_result_123');
    expect(parsed.offsetChars).toBe(100);
    expect(parsed.limitChars).toBe(500);

    const defaults = parseTranslationResultReadArgs({ translation_result_id: 'translation_result_123' });
    expect(defaults.offsetChars).toBe(0);
    expect(defaults.limitChars).toBe(MAX_TOOL_TEXT_FIELD_CHARS);

    const invalid: unknown[] = [
      {},
      { translation_result_id: 'id', limit_chars: 0 },
      { translation_result_id: 'id', limit_chars: MAX_RESULT_READ_CHUNK_CHARS + 1 },
      { translation_result_id: 'id', offset_chars: -1 },
      { translation_result_id: 'id', offset_chars: '0' },
      { translation_result_id: 'id', unknown: true },
    ];
    for (const value of invalid) {
      let message = '';
      try { parseTranslationResultReadArgs(value); } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message, `${JSON.stringify(value)} must be rejected`).not.toBe('');
    }
  });

  it('translate_args_parse_strict_inline_terms', () => {
    const parsed = parseTranslateArgs(validTranslateArgs());
    expect(parsed.sourceLang).toBe('en');
    expect(parsed.targetLang).toBe('zh-CN');
    expect(parsed.formality).toBe('formal');
    expect(parsed.domain).toBe('academic');
    expect(parsed.terms).toEqual([['world', '世界']]);

    const extra = validTranslateArgs();
    extra.terms = [{ src: 'world', dst: '世界', note: 'not allowed' }];
    expect(() => parseTranslateArgs(extra)).toThrow();

    const duplicate = {
      text: 'hello',
      source_lang: 'en',
      target_lang: 'zh',
      terms: [
        { src: 'hello', dst: '你好' },
        { src: 'hello', dst: '您好' },
      ],
    };
    expect(() => parseTranslateArgs(duplicate)).toThrow();
  });

  it('translate_args_reject_glossary_id_and_invalid_enums', () => {
    const withGlossaryId = {
      text: 'hello',
      source_lang: 'en',
      target_lang: 'zh',
      glossary_id: null,
    };
    let failure: unknown;
    try { parseTranslateArgs(withGlossaryId); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(TranslationToolFailure);
    expect((failure as Error).message).toContain('GLOSSARY_ID_UNSUPPORTED');

    for (const [field, value] of [['formality', 'friendly'], ['domain', 'financial']] as const) {
      const args = validTranslateArgs();
      args[field] = value;
      expect(() => parseTranslateArgs(args), `${field} must reject`).toThrow();
    }
  });

  it('language_validation_is_bounded_and_target_cannot_be_auto', () => {
    expect(() => validateLanguageCode('en', 'source_lang', true)).not.toThrow();
    expect(() => validateLanguageCode('zh-Hans', 'target_lang', false)).not.toThrow();
    expect(() => validateLanguageCode('auto', 'source_lang', true)).not.toThrow();
    expect(() => validateLanguageCode('auto', 'target_lang', false)).toThrow();
    expect(() => validateLanguageCode('en_US', 'source_lang', true)).toThrow();
    expect(() => validateLanguageCode('中文', 'source_lang', true)).toThrow();

    const args = validTranslateArgs();
    args.source_lang = 'a'.repeat(MAX_LANGUAGE_CODE_CHARS + 1);
    expect(() => parseTranslateArgs(args)).toThrow();
  });

  it('unicode_preview_never_splits_a_character', () => {
    const input = '译'.repeat(MAX_TOOL_TEXT_FIELD_CHARS + 1);
    const [preview, truncated] = unicodePreview(input, MAX_TOOL_TEXT_FIELD_CHARS);
    expect(truncated).toBe(true);
    expect(Array.from(preview)).toHaveLength(MAX_TOOL_TEXT_FIELD_CHARS);
    expect(preview).toBe('译'.repeat(MAX_TOOL_TEXT_FIELD_CHARS));
  });

  it('paragraph_aware_segmentation_is_bounded_and_lossless', () => {
    const text = 'first para\n\nsecond paragraph is longer\n\n第三段内容';
    const segments = splitTranslationText(text, 18);
    expect(segments.length).toBeGreaterThan(1);
    expect(segments.join('')).toBe(text);
    expect(segments.every(segment => Array.from(segment).length <= 18)).toBe(true);
    expect(segments[0]!.endsWith('\n\n')).toBe(true);

    const unicode = '你好吗世界'.repeat(11);
    const unicodeSegments = splitTranslationText(unicode, 7);
    expect(unicodeSegments.join('')).toBe(unicode);
    expect(unicodeSegments.every(segment => Array.from(segment).length <= 7)).toBe(true);

    // A hard cut prefers the last whitespace in the latter half so ASCII
    // words are not split mid-word when any space is available.
    const spaced = 'alpha beta gamma delta epsilon';
    const spacedSegments = splitTranslationText(spaced, 12);
    expect(spacedSegments.join('')).toBe(spaced);
    expect(spacedSegments.every(segment => Array.from(segment).length <= 12)).toBe(true);
    for (const segment of spacedSegments.slice(0, -1)) {
      expect(segment.endsWith(' '), `segment ${JSON.stringify(segment)} must end at a word boundary`).toBe(true);
    }
  });

  it('segmentation matches split_translation_text prefix.ends_with on random inputs', () => {
    // translation_executor.rs:531-585 over a string, checking the paragraph suffix on the segment prefix.
    const reference = (text: string, maxChars: number): string[] => {
      const segments: string[] = [];
      const preferred = Math.max(Math.trunc(maxChars / 2), 1);
      let start = 0;
      while (start < text.length) {
        const remaining = text.slice(start);
        let seen = 0;
        let offset = 0;
        let hard: number | undefined;
        let paragraph: number | undefined;
        let newline: number | undefined;
        let whitespace: number | undefined;
        for (const character of remaining) {
          if (seen === maxChars) { hard = start + offset; break; }
          seen++;
          const relativeEnd = offset + character.length;
          offset = relativeEnd;
          if (seen < preferred || !/^\s$/u.test(character)) continue;
          whitespace = start + relativeEnd;
          if (character !== '\n') continue;
          newline = start + relativeEnd;
          const prefix = remaining.slice(0, relativeEnd);
          if (prefix.endsWith('\n\n') || prefix.endsWith('\r\n\r\n')) paragraph = start + relativeEnd;
        }
        const end = hard === undefined ? text.length : paragraph ?? newline ?? whitespace ?? hard;
        segments.push(text.slice(start, end));
        start = end;
      }
      return segments;
    };
    let seed = 0x5eed;
    const next = (bound: number): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return (seed >>> 8) % bound;
    };
    const alphabet = ['a', 'b', ' ', '\n', '\n', '\r', '\t', '译', '😀', '\u3000'];
    for (let round = 0; round < 500; round++) {
      const length = next(80);
      let text = '';
      for (let index = 0; index < length; index++) text += alphabet[next(alphabet.length)];
      const maxChars = 1 + next(20);
      expect(splitTranslationText(text, maxChars), `${JSON.stringify(text)} / ${maxChars}`)
        .toEqual(reference(text, maxChars));
    }
  });

  it('segmentation of a maximum-size, newline-dense source is linear', () => {
    const lines = 'a\n'.repeat(MAX_TRANSLATION_TEXT_CHARS / 2);
    const lineSegments = splitTranslationText(lines, MAX_PIPELINE_SEGMENT_CHARS);
    expect(lineSegments.join('')).toBe(lines);
    expect(lineSegments).toHaveLength(5);
    expect(lineSegments.every(segment => segment.length === MAX_PIPELINE_SEGMENT_CHARS && segment.endsWith('\n'))).toBe(true);

    const paragraphs = 'line\r\n\r\n'.repeat(MAX_TRANSLATION_TEXT_CHARS / 8);
    const paragraphSegments = splitTranslationText(paragraphs, MAX_PIPELINE_SEGMENT_CHARS);
    expect(paragraphSegments.join('')).toBe(paragraphs);
    expect(paragraphSegments.every(segment => segment.length <= MAX_PIPELINE_SEGMENT_CHARS && segment.endsWith('\r\n\r\n'))).toBe(true);
  });

  it('segmentation reads each code point at most four times, however dense the newlines', () => {
    // Rebuilding the segment prefix on every newline reads 50-1500 times per code point on these inputs.
    const cases: Array<[string, number]> = [
      ['a\n', 4_000], ['\n', 4_000], ['\r\n', 4_001], ['line\r\n\r\n', 4_000], ['a\r\n\r\n', 333], ['😀\n\n', 1_001],
    ];
    for (const [unit, maxChars] of cases) {
      const chars = Array.from(unit.repeat(Math.ceil(20_000 / unit.length)));
      let reads = 0;
      const counted = new Proxy(chars, {
        get(target, key, receiver) {
          if (typeof key === 'string' && key.length > 0 && key.charCodeAt(0) >= 48 && key.charCodeAt(0) <= 57) reads++;
          return Reflect.get(target, key, receiver);
        },
      });
      const segments = splitCodePoints(counted, maxChars);
      expect(segments.join('')).toBe(chars.join(''));
      expect(segments).toEqual(splitTranslationText(chars.join(''), maxChars));
      expect(reads, `${JSON.stringify(unit)} / ${maxChars}`).toBeLessThanOrEqual(4 * chars.length);
    }
  });

  it('cancellation_guard_rejects_before_or_between_segments', () => {
    expect(() => ensureNotCancelled(false)).not.toThrow();
    let failure: unknown;
    try { ensureNotCancelled(true); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(TranslationToolFailure);
    expect((failure as Error).message).toContain('TRANSLATION_CANCELLED');
  });

  it('result_cache_enforces_owner_ttl_entry_and_character_bounds', () => {
    const now = Date.now();
    const cache = new TranslationResultCache(2, 12, 60_000);
    const first = insertSimple(cache, 'session-a', 'abc', 'def', now);
    expect(cache.peekAt(first, 'session-b', now)).toBeUndefined();
    expect(cache.peekAt(first, 'session-a', now)).toBeDefined();

    const second = insertSimple(cache, 'session-a', 'ghi', 'jkl', now);
    const third = insertSimple(cache, 'session-a', 'mno', 'pqr', now);
    expect(cache.peekAt(first, 'session-a', now)).toBeUndefined();
    expect(cache.peekAt(second, 'session-a', now)).toBeDefined();
    expect(cache.peekAt(third, 'session-a', now)).toBeDefined();
    expect(cache.totalChars).toBeLessThanOrEqual(12);

    expect(cache.peekAt(second, 'session-a', now + 60_000)).toBeUndefined();
    expect(cache.totalChars).toBe(0);

    const tinyCache = new TranslationResultCache(1, 3, 60_000);
    let failure: unknown;
    try { insertSimple(tinyCache, 'session', 'abcd', 'x', now); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(TranslationToolFailure);
    expect((failure as Error).message).toContain('TRANSLATION_RESULT_TOO_LARGE');
  });

  it('result_cache_is_consumed_explicitly', () => {
    const now = Date.now();
    const cache = new TranslationResultCache(2, 100, 60_000);
    const resultId = insertSimple(cache, 'session', 'hello', '你好', now);
    expect(cache.remove(resultId, 'session')).toBe(true);
    expect(cache.remove(resultId, 'session')).toBe(false);
    expect(cache.peekAt(resultId, 'session', now)).toBeUndefined();
  });

  it('result_cache_claim_prevents_concurrent_double_save_and_can_be_released', () => {
    const now = Date.now();
    const cache = new TranslationResultCache(2, 100, 60_000);
    const resultId = insertSimple(cache, 'session', 'hello', '你好', now);

    expect(cache.claimAt(resultId, 'session', now).kind).toBe('claimed');
    expect(cache.claimAt(resultId, 'session', now).kind).toBe('busy');
    expect(cache.releaseClaim(resultId, 'session')).toBe(true);
    expect(cache.claimAt(resultId, 'session', now).kind).toBe('claimed');
    expect(cache.claimAt(resultId, 'other-session', now).kind).toBe('not_found');
    expect(cache.remove(resultId, 'session')).toBe(true);
    expect(cache.claimAt(resultId, 'session', now).kind).toBe('not_found');
  });

  it('result_cache_stale_claim_is_reclaimable_after_crash_window', () => {
    const now = Date.now();
    const cache = new TranslationResultCache(2, 100, 3_600_000);
    const resultId = insertSimple(cache, 'session', 'hello', '你好', now);

    expect(cache.claimAt(resultId, 'session', now).kind).toBe('claimed');
    // Simulate a save that crashed after persistence but before consuming the
    // cache entry: while the claim is fresh, retries see busy...
    expect(cache.claimAt(resultId, 'session', now + STALE_CLAIM_REDEEM_AFTER_MS - 1_000).kind).toBe('busy');
    // ...and once the crash window elapses, the claim is reclaimable so the
    // reference is never permanently poisoned.
    expect(cache.claimAt(resultId, 'session', now + STALE_CLAIM_REDEEM_AFTER_MS).kind).toBe('claimed');
    expect(cache.remove(resultId, 'session')).toBe(true);
  });

  it('result_cache_peek_does_not_consume_or_respect_claims', () => {
    const now = Date.now();
    const cache = new TranslationResultCache(2, 100, 60_000);
    const resultId = insertSimple(cache, 'session', 'hello', '你好', now);
    expect(cache.claimAt(resultId, 'session', now).kind).toBe('claimed');
    // Read access stays available while a save is in flight.
    const peeked = cache.peekAt(resultId, 'session', now);
    expect(peeked?.translated).toBe('你好');
    expect(cache.peekAt(resultId, 'session', now)).toBeDefined();
  });

  it('global_result_cache_rejects_expired_save_source', () => {
    const now = Date.now();
    replaceTranslationResultCache(new TranslationResultCache(
      TRANSLATION_RESULT_CACHE_MAX_ENTRIES,
      TRANSLATION_RESULT_CACHE_MAX_CHARS,
      TRANSLATION_RESULT_TTL_MS,
    ));
    const resultId = withTranslationCache(cache => cache.insertAt({
      ownerSessionId: 'expired-session',
      source: 'old source',
      translated: 'old translation',
      sourceLang: 'en',
      targetLang: 'zh-CN',
      meta: defaultCachedMeta(),
      nowMs: now - TRANSLATION_RESULT_TTL_MS - 1_000,
    }));
    const args = parseTranslationSaveArgs({ translation_result_id: resultId });

    let failure: unknown;
    try { TranslationToolExecutor.resolveSaveSource(args, 'expired-session'); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(TranslationToolFailure);
    expect((failure as Error).message).toContain('TRANSLATION_RESULT_NOT_FOUND');
  });

  describe('SegmentCheckpoint::fail (translation_executor.rs:873-935)', () => {
    const source = 'a '.repeat(60_000);
    const call = { id: 'call-1', name: 'builtin-translate_text', arguments: { text: source, source_lang: 'en', target_lang: 'zh-CN' } };
    const failingSecondSegment = () => {
      let calls = 0;
      return {
        sessionId: 'checkpoint-session',
        isCancelled: () => false,
        runner: {
          async run(request: { text: string }) {
            if (++calls === 2) throw new Error('provider down');
            return { translated_text: `T${Array.from(request.text).length}` } as never;
          },
        },
      };
    };

    it('caches the completed segments under a partial result id', async () => {
      replaceTranslationResultCache(new TranslationResultCache(
        TRANSLATION_RESULT_CACHE_MAX_ENTRIES, TRANSLATION_RESULT_CACHE_MAX_CHARS, TRANSLATION_RESULT_TTL_MS));
      const segments = splitTranslationText(source, MAX_PIPELINE_SEGMENT_CHARS);
      expect(segments).toHaveLength(2);
      const firstChars = Array.from(segments[0]!).length;
      const executor = new TranslationToolExecutor();
      const result = await executor.execute(call as never, failingSecondSegment());
      expect(result.success).toBe(false);
      const output = result.output as Record<string, unknown> & { partial: Record<string, unknown> };
      expect(Object.keys(output)).toEqual(['code', 'message', 'message_truncated', 'message_key', 'hint', 'retryable', 'partial']);
      expect(output.code).toBe('TRANSLATION_FAILED');
      expect(output.message).toBe('provider down');
      expect(output.partial).toMatchObject({
        partial: true, completed_segments: 1, segment_count: 2, failed_segment_index: 2,
        completed_source_chars: firstChars, translated_chars: `T${firstChars}`.length, translated_preview: `T${firstChars}`,
        expires_in_seconds: TRANSLATION_RESULT_TTL_MS / 1000,
      });
      expect(output.partial.checkpoint_unavailable).toBeUndefined();
      const read = executor.readResult({ translation_result_id: output.partial.translation_result_id }, failingSecondSegment());
      expect(read).toMatchObject({ chunk: `T${firstChars}`, partial: true, completed_segments: 1, segment_count: 2, has_more: false });
    });

    it('reports checkpoint_unavailable and logs the cache error when the partial result does not fit', async () => {
      replaceTranslationResultCache(new TranslationResultCache(TRANSLATION_RESULT_CACHE_MAX_ENTRIES, 10, TRANSLATION_RESULT_TTL_MS));
      const warnings: string[] = [];
      setTranslationLogger({ warn: message => { warnings.push(message); }, error() {}, info() {}, debug() {} });
      try {
        const result = await new TranslationToolExecutor().execute(call as never, failingSecondSegment());
        const partial = (result.output as { partial: Record<string, unknown> }).partial;
        expect(partial.checkpoint_unavailable).toBe(true);
        expect(partial.translation_result_id).toBeUndefined();
        expect(partial.expires_in_seconds).toBeUndefined();
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatch(/^\[TranslationToolExecutor\] Failed to checkpoint partial translation: \{"code":"TRANSLATION_RESULT_TOO_LARGE","message":"The complete translation requires \d+ cached characters; capacity is 10\."/);
      } finally {
        setTranslationLogger(null);
        replaceTranslationResultCache(new TranslationResultCache(
          TRANSLATION_RESULT_CACHE_MAX_ENTRIES, TRANSLATION_RESULT_CACHE_MAX_CHARS, TRANSLATION_RESULT_TTL_MS));
      }
    });
  });

  it('persisted_metadata_snapshot_matches_workbench_keys', () => {
    const snapshot = TranslationToolExecutor.buildPersistedMetadata(meta({
      formality: 'formal',
      domain: 'academic',
      terms: [['agent', '智能体']],
      promptOverride: 'Keep citations intact.',
      partial: false,
      completedSegments: 2,
      segmentCount: 2,
    }), 'cached_result');
    expect(snapshot.origin).toBe('chat_agent');
    expect(snapshot.sourceMode).toBe('cached_result');
    expect(snapshot.formality).toBe('formal');
    expect(snapshot.domain).toBe('academic');
    expect(snapshot.glossary).toEqual([['agent', '智能体']]);
    expect(snapshot.customPrompt).toBe('Keep citations intact.');
    expect(snapshot.partial).toBeUndefined();

    const partial = buildPersistedMetadata(meta({
      partial: true,
      completedSegments: 1,
      segmentCount: 3,
    }), 'cached_result');
    expect(partial.partial).toBe(true);
    expect(partial.completedSegments).toBe(1);
    expect(partial.segmentCount).toBe(3);
    expect(partial.formality).toBeUndefined();
    expect(partial.glossary).toBeUndefined();

    const inline = buildPersistedMetadata(meta(), 'inline');
    expect(inline.sourceMode).toBe('inline');
  });

  it('save_args_require_exactly_one_source_mode', () => {
    const cached = parseTranslationSaveArgs({
      translation_result_id: 'translation_result_123',
      title: 'Lecture translation',
      folder_id: 'folder_123',
    });
    expect(cached.mode.kind).toBe('cached_result');

    const inline = parseTranslationSaveArgs({
      source: 'hello',
      translated: '你好',
      source_lang: 'en',
      target_lang: 'zh',
    });
    expect(inline.mode.kind).toBe('inline');

    expect(() => parseTranslationSaveArgs({
      translation_result_id: 'translation_result_123',
      source: 'hello',
      translated: '你好',
      source_lang: 'en',
      target_lang: 'zh',
    })).toThrow();
    expect(() => parseTranslationSaveArgs({})).toThrow();

    const oversized = 'x'.repeat(MAX_TOOL_TEXT_FIELD_CHARS + 1);
    expect(() => parseTranslationSaveArgs({
      source: oversized,
      translated: 'short',
      source_lang: 'en',
      target_lang: 'zh',
    })).toThrow();
  });

  it('save_repo_normal_path_and_folder_error_mapping', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'translation-save-'));
    const storage = createStorageService({ baseDir: root, dataLocalDir: root });
    let host: Awaited<ReturnType<typeof createTestHost>> | undefined;
    try {
      const report = await storage.migrations.runAll();
      expect(report.success, report.error ?? '').toBe(true);
      const conn: DatabaseHandle = storage.database('vfs');
      host = await createTestHost({ plugins: [vfsRepos], provide: { storage,
        paths: { dataSpaceDeviceId: async () => 'translation-owner-test' } } });
      const owner = {
        createTranslationInFolder: host.ctx.vfsRepo.translations.createTranslationInFolder.bind(host.ctx.vfsRepo.translations),
        updateTranslationMetadata,
      };

      const resolved = {
        source: 'hello',
        translated: '你好',
        sourceLang: 'en',
        targetLang: 'zh',
        meta: defaultCachedMeta(),
      };
      const rootArgs = parseTranslationSaveArgs({
        source: resolved.source,
        translated: resolved.translated,
        source_lang: resolved.sourceLang,
        target_lang: resolved.targetLang,
        title: 'Greeting',
        engine: 'llm',
        model: 'translation-model',
      });
      const saved = TranslationToolExecutor.persistTranslation(owner, conn, resolved, rootArgs);
      expect(saved.title).toBe('Greeting');
      expect(saved.sourceText).toBe('hello');
      expect(saved.translatedText).toBe('你好');

      const snapshot = buildPersistedMetadata(meta({
        formality: 'formal',
        domain: 'academic',
        terms: [['agent', '智能体']],
        partial: false,
        completedSegments: 1,
        segmentCount: 1,
      }), 'inline');
      TranslationToolExecutor.persistTranslationMetadata(owner, conn, saved.id, snapshot);
      const reloaded = host.ctx.vfsRepo.translations.getTranslation(conn, saved.id);
      expect(reloaded).toBeDefined();
      expect(reloaded).not.toBeNull();
      const metadata = reloaded!.metadata as Record<string, unknown>;
      expect(metadata.origin).toBe('chat_agent');
      expect(metadata.formality).toBe('formal');
      expect(metadata.glossary).toEqual([['agent', '智能体']]);

      expect(() => TranslationToolExecutor.persistTranslationMetadata(owner, conn, 'tr_missing', snapshot)).toThrow();

      const missingFolderArgs = parseTranslationSaveArgs({
        source: resolved.source,
        translated: resolved.translated,
        source_lang: resolved.sourceLang,
        target_lang: resolved.targetLang,
        title: 'Greeting',
        engine: 'llm',
        model: 'translation-model',
        folder_id: 'folder_missing',
      });
      let failure: unknown;
      try { TranslationToolExecutor.persistTranslation(owner, conn, resolved, missingFolderArgs); }
      catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(TranslationToolFailure);
      expect((failure as Error).message).toContain('FOLDER_NOT_FOUND');
      expect((failure as TranslationToolFailure).payload.retryable).toBe(false);
    } finally {
      await host?.dispose();
      storage.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('translate runs segments concurrently in order and cancels in-flight calls via AbortSignal', async () => {
    const longText = Array.from({ length: 5 }, (_, i) => `seg${i} ` + 'a'.repeat(MAX_PIPELINE_SEGMENT_CHARS - 5_000)).join('\n\n');
    let inFlight = 0;
    let peakInFlight = 0;
    const progressEvents: number[] = [];
    const executor = new TranslationToolExecutor();

    const orderedResult = await executor.execute(
      { id: 'call-ordered', name: 'builtin-translate_text', arguments: { text: longText, source_lang: 'en', target_lang: 'zh-CN' } },
      {
        sessionId: 'sess-concurrent',
        isCancelled: () => false,
        emitProgress: p => progressEvents.push(p.completedSegments),
        runner: {
          run: async req => {
            inFlight += 1;
            peakInFlight = Math.max(peakInFlight, inFlight);
            // Delay earlier segments longer so completion happens out-of-order.
            const delay = req.text.startsWith('seg0') ? 35 : 5;
            await new Promise(resolve => { setTimeout(resolve, delay); });
            inFlight -= 1;
            return {
              id: `resp-${req.session_id}`,
              translated_text: `[${req.text.slice(0, 4)}]`,
              engine: 'llm',
              model: 'm1',
              duration_ms: 10,
              created_at: '2026-01-01T00:00:00Z',
              session_id: req.session_id,
            };
          },
        },
      },
    );
    expect(orderedResult.success).toBe(true);
    const orderedOutput = orderedResult.output as Record<string, unknown>;
    expect(peakInFlight).toBeGreaterThan(1);
    expect(peakInFlight).toBeLessThanOrEqual(4);
    expect(orderedOutput.segment_count).toBe(5);
    expect(orderedOutput.translated_preview).toBe('[seg0][seg1][seg2][seg3][seg4]');
    expect(progressEvents.at(-1)).toBe(5);

    const controller = new AbortController();
    let seenAbortedSignal = false;
    let dispatchCount = 0;
    const pending = executor.execute(
      { id: 'call-abort', name: 'builtin-translate_text', arguments: { text: longText, source_lang: 'en', target_lang: 'zh-CN' } },
      {
        sessionId: 'sess-abort',
        isCancelled: () => controller.signal.aborted,
        signal: controller.signal,
        runner: {
          run: async (_req, signal) => {
            dispatchCount += 1;
            return await new Promise((_, reject) => {
              signal?.addEventListener('abort', () => {
                seenAbortedSignal = true;
                reject(new Error('aborted'));
              }, { once: true });
            });
          },
        },
      },
    );
    setTimeout(() => controller.abort(), 25);
    const abortResult = await pending;
    expect(abortResult.success).toBe(false);
    expect((abortResult.output as Record<string, unknown>).code).toBe('TRANSLATION_CANCELLED');
    expect(seenAbortedSignal).toBe(true);
    expect(dispatchCount).toBeLessThanOrEqual(4);
  });
});
