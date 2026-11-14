/**
 * RemNote-style inline flashcard parser (`概念 >> 释义` QA & `{{...}}` Cloze).
 *
 * Re-exports the pure grammar & ProseMirror/Markdown compilers shared with the
 * Crepe inline-cards decoration plugin so editor indicators and FSRS persistence
 * stay 100% consistent.
 */
export {
  MAX_INLINE_CLOZES,
  compileInlineCardText,
  compileInlineCardsFromDoc,
  compileInlineCardsFromMarkdown,
  computeProtectedMask,
  textblockToScanText,
  type CompileInlineCardsOptions,
  type CompiledUnitContent,
  type InlineCardDocMatch,
  type InlineCardKind,
  type ParsedInlineCard,
} from '@/components/crepe/plugins/inlineCards/scanner';
