import { describe, expect, it } from 'vitest';

interface SplitCase {
  module: string;
  splitIn: string;
  /** Runtime export keys of the file at `splitIn^`. */
  preSplit: readonly string[];
  addedSince: readonly string[];
  load: () => Promise<Record<string, unknown>>;
}

const CASES: readonly SplitCase[] = [{
  module: 'src/tool_executor.ts',
  splitIn: '68002934',
  preSplit: [
    'ALLOWED_DOMAINS', 'ALLOWED_FORMALITY', 'MAX_FOLDER_ID_CHARS', 'MAX_LANGUAGE_CODE_CHARS', 'MAX_METADATA_CHARS',
    'MAX_PIPELINE_SEGMENT_CHARS', 'MAX_PROMPT_OVERRIDE_CHARS', 'MAX_RESULT_ID_CHARS', 'MAX_RESULT_READ_CHUNK_CHARS',
    'MAX_TERMS', 'MAX_TERM_CHARS', 'MAX_TITLE_CHARS', 'MAX_TOOL_TEXT_FIELD_CHARS', 'MAX_TRANSLATED_OUTPUT_CHARS',
    'MAX_TRANSLATION_TEXT_CHARS', 'MIN_TRANSLATED_OUTPUT_CHARS', 'OUTPUT_EXPANSION_FACTOR', 'STALE_CLAIM_REDEEM_AFTER_MS',
    'TRANSLATE_TEXT_TOOL', 'TRANSLATION_RESULT_CACHE_MAX_CHARS', 'TRANSLATION_RESULT_CACHE_MAX_ENTRIES',
    'TRANSLATION_RESULT_READ_TOOL', 'TRANSLATION_RESULT_TTL_MS', 'TRANSLATION_SAVE_TOOL', 'TranslationResultCache',
    'TranslationToolExecutor', 'TranslationToolFailure', 'buildPersistedMetadata', 'checkpointFailure',
    'defaultCachedMeta', 'ensureNotCancelled', 'invalidArgument', 'mapSaveError', 'parseTerms', 'parseTranslateArgs',
    'parseTranslationResultReadArgs', 'parseTranslationSaveArgs', 'persistTranslation', 'persistTranslationMetadata',
    'replaceTranslationResultCache', 'resolveSaveSource', 'resolveToolExecutor', 'splitTranslationText',
    'translatedOutputLimit', 'translationError', 'translationErrorValue', 'translationFailure', 'unicodePreview',
    'validateLanguageCode', 'withTranslationCache',
  ],
  addedSince: ['splitCodePoints'],
  load: () => import('../src/tool_executor.ts'),
}];

describe('split files keep exporting their pre-split surface', () => {
  it.each(CASES)('$module (split in $splitIn)', async ({ preSplit, addedSince, load }) => {
    expect(Object.keys(await load()).sort()).toEqual([...preSplit, ...addedSince].sort());
  });
});
