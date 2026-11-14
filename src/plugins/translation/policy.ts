import type { TranslationRequest } from '../../plugin-runtime/contracts/translation.js';

// Rust char::is_whitespace uses Unicode White_Space (not JS trim's BOM rules).
export const isWhitespace = (ch: string): boolean => /\p{White_Space}/u.test(ch);
export const trim = (text: string): string => text.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
export const trimEnd = (text: string): string => text.replace(/\p{White_Space}+$/u, '');
export const charLength = (text: string): number => Array.from(text).length;
export const tailChars = (text: string, count: number): string => Array.from(text).slice(-count).join('');
export interface TextSegment { content: string; separator: string }

function splitParagraphs(text: string): TextSegment[] {
  const chars = Array.from(text);
  const parts: TextSegment[] = [];
  let content = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch !== '\n') { content += ch; continue; }
    let separator = ch;
    let newlines = 1;
    while (i + 1 < chars.length && ['\n', '\r', ' ', '\t'].includes(chars[i + 1])) {
      const next = chars[++i];
      separator += next;
      if (next === '\n') newlines++;
    }
    if (newlines < 2) { content += separator; continue; }
    if (content) { parts.push({ content, separator }); content = ''; }
    else if (parts.length) parts[parts.length - 1].separator += separator;
  }
  if (content) parts.push({ content, separator: '' });
  return parts;
}

function sentenceChunks(text: string, target: number): TextSegment[] {
  const sentences: string[] = [];
  let current = '';
  for (const ch of text) {
    current += ch;
    if ('。！？；.!?;\n'.includes(ch)) { sentences.push(current); current = ''; }
  }
  if (current) sentences.push(current);
  const chunks: TextSegment[] = [];
  let buffer = '';
  let count = 0;
  const flush = () => { chunks.push({ content: buffer, separator: '' }); buffer = ''; count = 0; };
  for (const sentence of sentences) {
    const n = charLength(sentence);
    if (count > 0 && count + n > target) flush();
    if (n > target * 2) {
      if (buffer) flush();
      let piece = '';
      let pieceCount = 0;
      for (const ch of sentence) {
        piece += ch;
        if (++pieceCount >= target) {
          chunks.push({ content: piece, separator: '' }); piece = ''; pieceCount = 0;
        }
      }
      if (piece) chunks.push({ content: piece, separator: '' });
    } else { buffer += sentence; count += n; }
  }
  if (buffer) flush();
  for (let i = 1; i < chunks.length; i++) {
    const leading = chunks[i].content.match(/^\p{White_Space}+/u)?.[0] ?? '';
    if (leading) {
      chunks[i].content = chunks[i].content.slice(leading.length);
      chunks[i - 1].separator = leading;
    }
  }
  return chunks.filter((chunk) => trim(chunk.content) !== '');
}

export function buildSegments(text: string, target: number): TextSegment[] {
  if (!Number.isInteger(target) || target < 1) throw new Error('Segment target must be positive');
  const paragraphs = splitParagraphs(text);
  const single = () => [{ content: text, separator: '' }];
  if (!paragraphs.length) return single();
  const segments: TextSegment[] = [];
  let content = '';
  let count = 0;
  let separator = '';
  const flush = () => {
    segments.push({ content, separator }); content = ''; count = 0; separator = '';
  };
  for (const paragraph of paragraphs) {
    const n = charLength(paragraph.content);
    if (n > target * 2) {
      if (content) flush(); else separator = '';
      const chunks = sentenceChunks(paragraph.content, target);
      if (chunks.length) chunks[chunks.length - 1].separator = paragraph.separator;
      segments.push(...chunks);
      continue;
    }
    if (count > 0 && count + n > target) flush();
    if (count > 0) { content += separator; count += charLength(separator); }
    separator = paragraph.separator;
    content += paragraph.content;
    count += n;
  }
  if (content) flush();
  return segments.length ? segments : single();
}

export function detectSourceLang(text: string): string | undefined {
  const chars = Array.from(text).filter((c) => !isWhitespace(c)).slice(0, 400);
  if (!chars.length) return undefined;
  const counts = Array<number>(10).fill(0);
  for (const ch of chars) {
    const cp = ch.codePointAt(0)!;
    const between = (min: number, max: number) => cp >= min && cp <= max;
    const index = between(0x3040, 0x30ff) || between(0x31f0, 0x31ff) ? 0
      : between(0xac00, 0xd7af) || between(0x1100, 0x11ff) || between(0x3130, 0x318f) ? 1
      : between(0x4e00, 0x9fff) || between(0x3400, 0x4dbf) || between(0xf900, 0xfaff) ? 2
      : between(0x0400, 0x04ff) ? 3
      : between(0x0600, 0x06ff) || between(0x0750, 0x077f) ? 4
      : between(0x0e00, 0x0e7f) ? 5
      : between(0x0900, 0x097f) ? 6
      : between(0x0370, 0x03ff) ? 7
      : between(0x0041, 0x005a) || between(0x0061, 0x007a) ? 8
      : between(0x00c0, 0x024f) ? 9 : -1;
    if (index >= 0) counts[index]++;
  }
  const dominant = (n: number) => n * 5 >= chars.length;
  if (counts[0] > 0 && dominant(counts[0] + counts[2])) return 'ja';
  const languages = ['', 'ko', 'zh-CN', 'ru', 'ar', 'th', 'hi', 'el'];
  for (let i = 1; i < 8; i++) if (dominant(counts[i])) return languages[i];
  return dominant(counts[8]) && counts[9] * 20 < counts[8] ? 'en' : undefined;
}

const languageNames: Record<string, string> = {
  'zh-CN': 'Simplified Chinese (简体中文)', zh: 'Simplified Chinese (简体中文)',
  'zh-TW': 'Traditional Chinese (繁體中文)', en: 'English', ja: 'Japanese (日本語)',
  ko: 'Korean (한국어)', fr: 'French (français)', de: 'German (Deutsch)', es: 'Spanish (español)',
  ru: 'Russian (русский)', ar: 'Arabic (العربية)', pt: 'Portuguese (português)',
  'pt-BR': 'Brazilian Portuguese (português brasileiro)', it: 'Italian (italiano)',
  vi: 'Vietnamese (tiếng Việt)', th: 'Thai (ไทย)', hi: 'Hindi (हिन्दी)', tr: 'Turkish (Türkçe)',
  pl: 'Polish (polski)', nl: 'Dutch (Nederlands)', sv: 'Swedish (svenska)', la: 'Latin (Latina)',
  el: 'Greek (Ελληνικά)', uk: 'Ukrainian (українська)', id: 'Indonesian (Bahasa Indonesia)',
  ms: 'Malay (Bahasa Melayu)', auto: 'auto-detected language',
};
export const langFullName = (code: string): string => languageNames[code] ?? code;

const domains: Record<string, string> = {
  academic: 'You are an expert academic translator specializing in scholarly papers, theses, and research articles. Translate with precision, maintaining academic register and discipline-specific terminology. Preserve citation formats (e.g. [1], (Author, Year)), mathematical notation, and abbreviations. Ensure terminological consistency throughout. Only output the translated text.',
  technical: 'You are a professional technical translator specializing in software documentation, engineering, and IT content. Keep code snippets, variable names, command-line examples, and API references untranslated. Preserve markdown/HTML formatting. Translate technical terms accurately using industry-standard vocabulary. Only output the translated text.',
  literary: "You are a literary translator with expertise in creative writing. Prioritize natural fluency and emotional resonance over literal accuracy. Preserve rhetorical devices, metaphors, rhythm, and the author's unique voice. Adapt cultural references when necessary for the target audience. Only output the translated text.",
  legal: 'You are a certified legal translator. Translate with absolute precision using standard legal terminology in the target language. Preserve the exact structure of clauses, articles, and numbered sections. Do not paraphrase or simplify legal language. Only output the translated text.',
  medical: 'You are a medical translator with expertise in clinical and biomedical texts. Use standard medical terminology (ICD/MeSH terms where applicable). Preserve drug names, dosages, anatomical terms, and abbreviations accurately. Only output the translated text.',
  casual: 'You are a friendly translator for everyday conversations and social media content. Use natural, colloquial language that sounds native. Adapt idioms, slang, and cultural expressions appropriately. Only output the translated text.',
  general: 'You are a professional translator. Translate the given text accurately while preserving its tone, style, and formatting. Do not add explanations or notes. Only output the translated text.',
};
const latex = 'Write every math/chemistry formula in LaTeX wrapped in $...$ (inline) or $$...$$ (block) with paired delimiters; never output bare LaTeX (e.g. 10^5, \\frac), never use \\(...\\) or \\[...\\], and never wrap formulas in code fences.';

export function buildSystemPrompt(request: TranslationRequest): string {
  const domain = request.domain ?? 'general';
  let prompt = request.prompt_override && trim(request.prompt_override)
    ? request.prompt_override : domains[domain === 'conversation' ? 'casual' : domain] ?? domains.general;
  prompt += '\n\n' + latex;
  if (domain !== 'casual' && domain !== 'conversation') {
    if (request.formality === 'formal') prompt += '\n\nUse formal, polite language suitable for business or academic contexts.';
    if (request.formality === 'casual') prompt += '\n\nUse casual, conversational language.';
  }
  const entries = (request.glossary ?? []).map(([s, t]) => [trim(s), trim(t)]).filter(([s, t]) => s && t);
  if (entries.length) {
    prompt += '\n\nGlossary (you MUST use these exact translations for the specified terms, matching case-insensitively but preserving the target form exactly):';
    // Scalar-string JSON escaping, not serialization comparison of unordered objects.
    for (const [source, target] of entries) prompt += `\n- ${JSON.stringify(source)} → ${JSON.stringify(target)}`;
  }
  return prompt;
}

export function buildUserPrompt(request: TranslationRequest, text: string): string {
  const direction = request.src_lang === 'auto' ? `to ${langFullName(request.tgt_lang)}`
    : `from ${langFullName(request.src_lang)} to ${langFullName(request.tgt_lang)}`;
  return `Please translate the following text ${direction}:\n\n${text}`;
}

export function buildSegmentPrompt(request: TranslationRequest, text: string, index: number, total: number, tail?: string): string {
  const direction = request.src_lang === 'auto' ? `to ${langFullName(request.tgt_lang)}`
    : `from ${langFullName(request.src_lang)} to ${langFullName(request.tgt_lang)}`;
  let prompt = `This is part ${index} of ${total} of a longer document. Translate ONLY this part ${direction}. Keep terminology and style consistent across parts. Do not add headings, notes, part markers, or extra blank lines.\n\n`;
  if (tail !== undefined) prompt += `For continuity, the translation of the previous part ended with (do NOT repeat it):\n…${tail}\n\n`;
  return prompt + 'Text to translate:\n' + text;
}
