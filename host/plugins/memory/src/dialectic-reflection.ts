/**
 * Dialectic Reflection & Consolidation Engine (RFC-001 M2/M4).
 *
 * Inspired by Honcho's dialectic learner representation & Hermes' bounded-memory
 * distillation pressure: periodically analyzes the learner's HardRules + LearnerProfile
 * + Mastery relapse signals to produce transparent, auditable consolidation proposals:
 *   1. Relapse Alerts: weak points with repeated relapses or high evidence count
 *   2. Hard-Rule Deduplication / Compression Hints: when budget utilization > 80%
 *   3. Candidate Promotions: repeated preferences in `learnerProfile.preferences.others`
 *      that can be promoted to L1 HardRules
 *   4. Stale Weak-Point Retirement Candidates: weak points untouched beyond threshold days
 *
 * Pure deterministic analysis (no LLM required; never mutates silently).
 */
import {
  isChineseDominantText, normalizeRuleScope,
  type HardRulesDocument, type MemoryHardRule,
} from './hard-rules.ts';
import type { LearnerProfile } from './learner-profile.ts';

type LearnerWeakPoint = LearnerProfile['weak_points'][number];

export type ContradictionDimension =
  | 'length'
  | 'language'
  | 'format'
  | 'pace'
  | 'pedagogy'
  | 'style'
  | 'closing'
  | 'negation';

export interface TextContradiction {
  dimension: ContradictionDimension;
  reason: string;
}

export interface SupersededPreference {
  field: 'explanation_style' | 'language' | 'pace' | 'others';
  previousValue: string;
  retainedValue: string | null;
  dimension: ContradictionDimension;
  reason: string;
}

export interface ProfileReconciliationResult {
  changed: boolean;
  superseded: SupersededPreference[];
}

export type DialecticProposalKind =
  | 'relapse_focus'
  | 'resolve_rule_conflict'
  | 'promote_preference_to_rule'
  | 'compress_hard_rules'
  | 'retire_stale_weak_point';

export interface DialecticProposal {
  id: string;
  kind: DialecticProposalKind;
  title: string;
  rationale: string;
  severity: 'info' | 'attention';
  suggestedPayload?: Record<string, unknown>;
}

export interface DialecticReflectionReport {
  generatedAt: string;
  rulesBudgetRatio: number;
  profileBudgetRatio: number;
  activeWeakPointCount: number;
  proposals: DialecticProposal[];
  summary: string;
}

export interface DialecticReflectionInput {
  hardRules: HardRulesDocument;
  learnerProfile: LearnerProfile;
  rulesChars: number;
  rulesMaxChars: number;
  profileChars: number;
  profileMaxChars: number;
  nowMs?: number;
  staleDays?: number;
}

const DEFAULT_STALE_DAYS = 45;

function parseTimeMs(iso?: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}]+/gu, '');
}

// --- Generalizable multilingual polarity & contradiction detection ---

const BRIEF_LENGTH_RE = /(?:简短|精炼|极简|简洁|不超过\s*\d+\s*字|控制在\s*\d+\s*字以内|\d+\s*字以内|一句话|禁止长篇大论|不要太长|避免冗长|under\s+\d+\s+words|max(?:imum)?\s+\d+\s+words|concise|brief(?:\s+only)?|short\s+(?:answers?|replies?|responses?)|keep\s+(?:it|answers?|replies?)\s+short|ultra-?brief|tldr|簡潔|短く|要点のみ|concis|court|kurz|knapp|breve)/i;
const LONG_LENGTH_RE = /(?:极其详尽|详细推导|详尽展开|不得少于\s*\d+\s*字|不少于\s*\d+\s*字|至少\s*\d+\s*字|绝不允许省略任何|完整推导|至少(?:三|两|四|五)种.*解法|exhaustive|comprehensive|in-?depth|at\s+least\s+\d+\s+words|never\s+skip\s+(?:any\s+)?steps?|full\s+derivation|very\s+detailed|詳しく|詳細|détaillé|approfondi|ausführlich|detallado)/i;

const PACE_FAST_RE = /(?:快节奏|节奏快|进度快|跳过基础|直接进阶|fast\s+pace|quick\s+pace|skip\s+(?:the\s+)?basics?|advanced\s+pace|rapid\s+pace|go\s+fast|速め|テンポ速|rythme\s+rapide|schnell(?:es\s+Tempo)?|ritmo\s+rápido)/i;
const PACE_SLOW_RE = /(?:慢节奏|节奏慢|循序渐进|放慢|从零开始|步步拆解|slow\s+pace|gentle\s+pace|step\s+by\s+step\s+from\s+basics?|take\s+it\s+slow|walk\s+through\s+every\s+prerequisite|ゆっくり|丁寧|rythme\s+lent|langsam(?:es\s+Tempo)?|ritmo\s+lento)/i;

const DIRECT_PEDAGOGY_RE = /(?:先给?结论|直接给(?:最终)?答案|直奔结论|先答案后解释|direct\s+answer\s+first|give\s+(?:the\s+)?(?:direct|final)\s+answer\s+first|bottom\s+line\s+first|conclusion\s+first|straight\s+to\s+the\s+answer|結論から|直接答え)/i;
const SOCRATIC_PEDAGOGY_RE = /(?:不要直接给(?:最终)?答案|先给?(?:第一步)?提示|苏格拉底|先引导(?:思考)?|引导式|socratic|never\s+(?:give|reveal)\s+(?:the\s+)?(?:direct|final)\s+answer|don'?t\s+(?:give|reveal)\s+(?:the\s+)?answer\s+directly|hints?\s+first|guide\s+me\s+with\s+questions|ヒントを先|答えを直接言わない)/i;

const NEG_PREFIX = String.raw`(?:no|never|don'?t|do\s+not|avoid|stop|skip|without|drop|disable|ban|forbid|instead\s+of|rather\s+than|not|不要|不用|别用|禁止|严禁|避免|不再|取消|去掉|停止|而非|而不是|代替|取代|pas\s+de|sans|aucun(?:e|s)?|éviter|ne\s+pas\s+utiliser|keine[nmr]?|ohne|nicht|vermeide[n]?|sin|no\s+usar|evita(?:r)?)`;
const NEG_MOD = String.raw`(?:using|use|adding|add|including|include|writing|write|showing|show|giving|give|formatting(?:\s+as|\s+in)?|making|any|more|all|markdown|comparison|summary|structured|friendly|a|an|the|使用|采用|用|添加|附带|画|列|生成|输出|制作|展示|d'|de|des|les?|la|un(?:e)?|los?|las?)`;
const NEG_SUFFIX_CJK = String.raw`(?:不要|不用|别用|禁止|取消|なし|を使わない|は使わない|禁止|不要|금지|없이|사용\s*안)`;

function buildFeatureMatchers(nounPattern: string): { prefer: RegExp; avoid: RegExp } {
  const prefer = new RegExp(`(?:${nounPattern})`, 'i');
  const avoid = new RegExp(
    `(?:${NEG_PREFIX}\\s*(?:${NEG_MOD}\\s*){0,3}(?:${nounPattern})|(?:${nounPattern})\\s*${NEG_SUFFIX_CJK})`,
    'i',
  );
  return { prefer, avoid };
}

const TABLES_MATCHERS = buildFeatureMatchers(
  String.raw`\btables?\b|\btabular\b|表格|制表|表形式|表(?=[ではをに])|テーブル|tableaux?|tabellen?|tablas?|표\s*형식|표로`,
);
const BULLETS_MATCHERS = buildFeatureMatchers(
  String.raw`\bbullet(?:\s*(?:points?|lists?))?\b|\bbulleted\b|\bnumbered\s+lists?\b|要点列表|项目符号|分点列表|列表形式|无序列表|有序列表|箇条書き|listes?\s+à\s+puces?|puces?|stichpunkte[n]?|aufzählung(?:en)?|viñetas?|lista\s+con\s+viñetas|글머리\s*기호`,
);
const PROSE_MATCHERS = buildFeatureMatchers(
  String.raw`\bprose\b|\bparagraphs?\b|\bnarrative\b|纯文本段落|连贯段落|段落形式|散文式|文章形式|paragraphes?|fließtext|párrafos?`,
);
const MINDMAP_MATCHERS = buildFeatureMatchers(
  String.raw`\bmind\s*maps?\b|思维导图|脑图|マインドマップ|cartes?\s+mentales?`,
);
const EMOJI_MATCHERS = buildFeatureMatchers(
  String.raw`\bemojis?\b|表情符号|颜文字|絵文字|이모지`,
);
const ANALOGY_MATCHERS = buildFeatureMatchers(
  String.raw`\banalog(?:y|ies)\b|类比|比喻|例え話|analogies?|analogien?|analogías?`,
);
const QUIZ_MATCHERS = buildFeatureMatchers(
  String.raw`\bself-?check(?:\s+questions?)?\b|\bquiz(?:zes)?(?:\s+questions?)?\b|\bpractice\s+questions?\b|自测题|思考题|小思考题|变式(?:自测)?题|確認クイズ|練習問題`,
);

const EXCLUSIVE_FORMAT_OVERRIDE_RE = /(?:only|exclusively|strictly|always|solely|switch\s+to|from\s+now\s+on|instead\s+of|rather\s+than|只用|一律|改用|全部用|统一用|必须用|只以|仅用|uniquement|seulement|toujours|nur|immer|ausschließlich|solo|siempre|のみ|だけ)/i;

type BinaryPole = 'prefer' | 'avoid' | null;

function extractBinaryPolarity(text: string, matchers: { prefer: RegExp; avoid: RegExp }): BinaryPole {
  if (matchers.avoid.test(text)) return 'avoid';
  if (matchers.prefer.test(text)) return 'prefer';
  return null;
}

type FormatStructure = 'tables' | 'bullets' | 'prose' | 'mindmap';

function extractPrimaryStructure(text: string): FormatStructure | null {
  const structures: FormatStructure[] = [];
  if (extractBinaryPolarity(text, TABLES_MATCHERS) === 'prefer') structures.push('tables');
  if (extractBinaryPolarity(text, BULLETS_MATCHERS) === 'prefer') structures.push('bullets');
  if (extractBinaryPolarity(text, PROSE_MATCHERS) === 'prefer') structures.push('prose');
  if (extractBinaryPolarity(text, MINDMAP_MATCHERS) === 'prefer') structures.push('mindmap');
  return structures.length === 1 ? structures[0]! : null;
}

type CanonicalLanguage = 'en' | 'zh' | 'ja' | 'ko' | 'fr' | 'de' | 'es' | 'bilingual';

function buildLangDirectiveRe(englishNames: string, nativeDirectives: string): RegExp {
  return new RegExp(
    `(?:${nativeDirectives}|(?:${englishNames})\\s+only|(?:strictly|exclusively)\\s+in\\s+(?:${englishNames})|(?:reply|respond|answer|write|explain|speak)\\s+(?:(?:only|always|exclusively|strictly)\\s+)?in\\s+(?:${englishNames})|always\\s+use\\s+(?:${englishNames}))`,
    'i',
  );
}

const LANGUAGE_SPECS: ReadonlyArray<{
  code: Exclude<CanonicalLanguage, 'bilingual'>;
  directive: RegExp;
  standalone: RegExp;
  forbidden: RegExp;
}> = [
  {
    code: 'en',
    directive: buildLangDirectiveRe('english', '全英文|全部使用英文|只能用英文|只用英文|用英文(?:回答|回复|讲解|作答|输出)|英文回答|英文回复'),
    standalone: /^\s*(?:english|en(?:-us|-gb)?|英文|英语)\s*$/i,
    forbidden: /(?:禁止.*英文|严禁.*英文|不要.*英文|no\s+english|avoid\s+english|never\s+use\s+english)/i,
  },
  {
    code: 'zh',
    directive: buildLangDirectiveRe('chinese|mandarin', '全中文|全部使用中文|只能用中文|只用中文|大白话中文|东北.*中文|用中文(?:回答|回复|讲解|作答|输出)|中文回答|中文回复'),
    standalone: /^\s*(?:chinese|mandarin|zh(?:-cn|-tw)?|中文|汉语|简体中文|繁体中文)\s*$/i,
    forbidden: /(?:禁止.*中文|严禁.*中文|不要.*中文|no\s+chinese|avoid\s+chinese|never\s+use\s+chinese)/i,
  },
  {
    code: 'ja',
    directive: buildLangDirectiveRe('japanese', '全日语|全日文|只用日语|用日语(?:回答|回复|讲解)|日本語(?:のみ|だけ|で(?:回答|答え|説明))'),
    standalone: /^\s*(?:japanese|ja(?:-jp)?|日语|日文|日本語)\s*$/i,
    forbidden: /(?:禁止.*日[语文]|no\s+japanese|avoid\s+japanese|never\s+use\s+japanese)/i,
  },
  {
    code: 'ko',
    directive: buildLangDirectiveRe('korean', '全韩语|只用韩语|用韩语(?:回答|回复)|한국어(?:로|만)'),
    standalone: /^\s*(?:korean|ko(?:-kr)?|韩语|韩文|한국어)\s*$/i,
    forbidden: /(?:禁止.*韩[语文]|no\s+korean|avoid\s+korean|never\s+use\s+korean)/i,
  },
  {
    code: 'fr',
    directive: buildLangDirectiveRe('french', '全法语|只用法语|用法语(?:回答|回复)|(?:répond(?:ez|s)?|écri(?:vez|s)?)\\s+(?:toujours\\s+|uniquement\\s+)?en\\s+français|en\\s+français\\s+uniquement'),
    standalone: /^\s*(?:french|français|fr(?:-fr)?|法语|法文)\s*$/i,
    forbidden: /(?:禁止.*法[语文]|no\s+french|avoid\s+french|never\s+use\s+french)/i,
  },
  {
    code: 'de',
    directive: buildLangDirectiveRe('german', '全德语|只用德语|用德语(?:回答|回复)|auf\\s+deutsch(?:\\s+antworten)?|nur\\s+auf\\s+deutsch'),
    standalone: /^\s*(?:german|deutsch|de(?:-de)?|德语|德文)\s*$/i,
    forbidden: /(?:禁止.*德[语文]|no\s+german|avoid\s+german|never\s+use\s+german)/i,
  },
  {
    code: 'es',
    directive: buildLangDirectiveRe('spanish', '全西语|全西班牙语|只用西班牙语|用西班牙语(?:回答|回复)|(?:responde|escribe)\\s+(?:siempre\\s+|solo\\s+)?en\\s+español|solo\\s+en\\s+español'),
    standalone: /^\s*(?:spanish|español|es(?:-es)?|西班牙语|西语)\s*$/i,
    forbidden: /(?:禁止.*西班牙语|no\s+spanish|avoid\s+spanish|never\s+use\s+spanish)/i,
  },
];

const BILINGUAL_RE = /(?:双语|中英对照|中英文|英汉|bilingual|dual[- ]language)/i;

function extractLanguageSignal(
  text: string,
  treatAsLanguageField = false,
): { preferred: CanonicalLanguage | null; forbidden: Set<CanonicalLanguage> } {
  const forbidden = new Set<CanonicalLanguage>();
  for (const spec of LANGUAGE_SPECS) {
    if (spec.forbidden.test(text)) forbidden.add(spec.code);
  }
  if (BILINGUAL_RE.test(text)) {
    return { preferred: 'bilingual', forbidden };
  }
  const preferredMatches: CanonicalLanguage[] = [];
  for (const spec of LANGUAGE_SPECS) {
    if (forbidden.has(spec.code)) continue;
    if (spec.directive.test(text) || (treatAsLanguageField && spec.standalone.test(text))) {
      preferredMatches.push(spec.code);
    }
  }
  if (preferredMatches.length === 1) {
    return { preferred: preferredMatches[0]!, forbidden };
  }
  if (treatAsLanguageField && preferredMatches.length === 0) {
    // Allow descriptive L2 language values like "English (US)" or "中文讲解"
    const langMention: Array<[Exclude<CanonicalLanguage, 'bilingual'>, RegExp]> = [
      ['en', /\benglish\b|英文|英语/i],
      ['zh', /\bchinese\b|\bmandarin\b|中文|汉语/i],
      ['ja', /\bjapanese\b|日语|日文|日本語/i],
      ['ko', /\bkorean\b|韩语|韩文|한국어/i],
      ['fr', /\bfrench\b|français|法语|法文/i],
      ['de', /\bgerman\b|deutsch|德语|德文/i],
      ['es', /\bspanish\b|español|西班牙语|西语/i],
    ];
    const hits = langMention
      .filter(([code, re]) => !forbidden.has(code) && re.test(text))
      .map(([code]) => code);
    if (hits.length === 1) return { preferred: hits[0]!, forbidden };
  }
  return { preferred: null, forbidden };
}

const GENERIC_NEG_STOPWORDS = new Set([
  'the', 'this', 'that', 'these', 'those', 'more', 'most', 'some', 'any', 'all', 'very',
  'and', 'but', 'for', 'with', 'from', 'into', 'about', 'only', 'just', 'never', 'always',
  'use', 'using', 'used', 'add', 'adding', 'include', 'including', 'write', 'writing',
  'show', 'showing', 'give', 'giving', 'make', 'making', 'keep', 'prefer', 'explain',
  'reply', 'respond', 'format', 'formatting', 'instead', 'rather', 'avoid', 'stop', 'skip',
  'answer', 'answers', 'reply', 'replies', 'response', 'responses', 'question', 'questions',
  'explanation', 'explanations', 'content', 'text', 'output', 'rule', 'rules', 'part', 'parts',
  'long', 'short', 'too', 'much', 'many', 'extra', 'other', 'others', 'here', 'there',
  'direct', 'directly', 'final', 'step', 'steps', 'time', 'times', 'way', 'ways', 'thing', 'things',
  '回答', '回复', '内容', '问题', '部分', '解释', '说明', '答案', '结果', '方式', '东西', '时候', '这样', '那样',
  '使用', '采用', '添加', '附带', '输出', '生成',
]);

function stemToken(token: string): string {
  const lower = token.toLowerCase().trim();
  if (/^[a-z]{4,}$/.test(lower)) {
    if (lower.endsWith('ies') && lower.length > 4) return `${lower.slice(0, -3)}y`;
    if (lower.endsWith('es') && /(?:shes|ches|xes|zes|sses)$/.test(lower)) return lower.slice(0, -2);
    if (lower.endsWith('s') && !lower.endsWith('ss')) return lower.slice(0, -1);
  }
  return lower;
}

function extractNegatedTargets(text: string): string[] {
  const targets: string[] = [];
  const latinRe = /\b(?:no|never|don'?t|do\s+not|avoid|stop|skip|without|drop|disable|instead\s+of|rather\s+than)\s+(?:(?:using|use|adding|add|including|include|writing|write|showing|show|giving|give|generating|generate|making|make|formatting|format|any|more|markdown|a|an|the)\s+){0,3}([a-z][a-z0-9-]{2,24}(?:\s+[a-z][a-z0-9-]{2,20})?)/gi;
  for (const match of text.matchAll(latinRe)) {
    const raw = (match[1] ?? '').trim().toLowerCase();
    const words = raw.split(/\s+/).filter(w => w.length >= 3 && !GENERIC_NEG_STOPWORDS.has(w));
    if (words.length === 0) continue;
    const head = stemToken(words[0]!);
    if (head.length >= 3 && !GENERIC_NEG_STOPWORDS.has(head)) targets.push(head);
    if (words.length >= 2) {
      const tail = stemToken(words[1]!);
      if (tail.length >= 3 && !GENERIC_NEG_STOPWORDS.has(tail)) targets.push(tail);
    }
  }
  const cjkRe = /(?:不要|不用|别用|禁止|严禁|避免|不再|取消|去掉|停止|而非|而不是|代替|取代)(?:再)?(?:使用|采用|添加|附带|输出|生成|用|写|画)?([\u4e00-\u9fff]{2,6})/g;
  for (const match of text.matchAll(cjkRe)) {
    const phrase = (match[1] ?? '').trim().replace(/[了啦吧啊吗呢的哦]+$/, '');
    if (phrase.length >= 2 && !GENERIC_NEG_STOPWORDS.has(phrase)) {
      targets.push(phrase);
    }
  }
  return [...new Set(targets)];
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsAffirmativeTarget(text: string, target: string): boolean {
  const isLatin = /^[a-z0-9-]+$/i.test(target);
  const pattern = isLatin
    ? `\\b${escapeRegExp(target)}(?:s|es)?\\b`
    : escapeRegExp(target);
  const matchers = buildFeatureMatchers(pattern);
  return extractBinaryPolarity(text, matchers) === 'prefer';
}

export interface ContradictionCheckOptions {
  /** Set true when `olderText` comes directly from `learnerProfile.preferences.language`. */
  olderIsLanguageField?: boolean;
  /** Set true when `olderText` comes directly from `learnerProfile.preferences.pace`. */
  olderIsPaceField?: boolean;
}

/**
 * Generalizable multilingual contradiction detector between two interaction preferences/rules
 * (`newerText` vs `olderText`). Returns null when compatible or aligned.
 */
export function detectTextContradiction(
  newerText: string,
  olderText: string,
  options: ContradictionCheckOptions = {},
): TextContradiction | null {
  const a = newerText.trim();
  const b = olderText.trim();
  if (!a || !b) return null;

  // 1. Verbosity / length polarity
  const aBrief = BRIEF_LENGTH_RE.test(a);
  const aLong = LONG_LENGTH_RE.test(a);
  const bBrief = BRIEF_LENGTH_RE.test(b);
  const bLong = LONG_LENGTH_RE.test(b);
  if ((aBrief && !aLong && bLong && !bBrief) || (aLong && !aBrief && bBrief && !bLong)) {
    return { dimension: 'length', reason: 'conflicting verbosity/length preference' };
  }

  // 2. Language polarity
  const langA = extractLanguageSignal(a, false);
  const langB = extractLanguageSignal(b, options.olderIsLanguageField === true);
  if (langA.preferred !== null && langB.preferred !== null && langA.preferred !== langB.preferred) {
    return { dimension: 'language', reason: `conflicting language preference (${langA.preferred} vs ${langB.preferred})` };
  }
  if (langA.preferred !== null && langB.forbidden.has(langA.preferred)) {
    return { dimension: 'language', reason: `language ${langA.preferred} forbidden by other preference` };
  }
  if (langB.preferred !== null && langA.forbidden.has(langB.preferred)) {
    return { dimension: 'language', reason: `language ${langB.preferred} forbidden by newer rule` };
  }

  // 3. Format feature polarities (tables, bullets, prose, mindmap)
  const binaryChecks: ReadonlyArray<{
    dimension: ContradictionDimension;
    label: string;
    matchers: { prefer: RegExp; avoid: RegExp };
  }> = [
    { dimension: 'format', label: 'tables', matchers: TABLES_MATCHERS },
    { dimension: 'format', label: 'bullet lists', matchers: BULLETS_MATCHERS },
    { dimension: 'format', label: 'prose paragraphs', matchers: PROSE_MATCHERS },
    { dimension: 'format', label: 'mind maps', matchers: MINDMAP_MATCHERS },
    { dimension: 'style', label: 'emoji', matchers: EMOJI_MATCHERS },
    { dimension: 'style', label: 'analogies', matchers: ANALOGY_MATCHERS },
    { dimension: 'closing', label: 'closing self-check quiz', matchers: QUIZ_MATCHERS },
  ];
  for (const check of binaryChecks) {
    const pA = extractBinaryPolarity(a, check.matchers);
    const pB = extractBinaryPolarity(b, check.matchers);
    if (pA !== null && pB !== null && pA !== pB) {
      return { dimension: check.dimension, reason: `opposing ${check.label} polarity (${pA} vs ${pB})` };
    }
  }

  // 4. Exclusive primary format switch (e.g. "Always use prose paragraphs only" vs "Prefer markdown tables")
  const structA = extractPrimaryStructure(a);
  const structB = extractPrimaryStructure(b);
  if (
    structA !== null
    && structB !== null
    && structA !== structB
    && (EXCLUSIVE_FORMAT_OVERRIDE_RE.test(a) || EXCLUSIVE_FORMAT_OVERRIDE_RE.test(b))
  ) {
    return { dimension: 'format', reason: `conflicting primary output format (${structA} vs ${structB})` };
  }

  // 5. Pace polarity
  const aFast = PACE_FAST_RE.test(a);
  const aSlow = PACE_SLOW_RE.test(a);
  const bFast = PACE_FAST_RE.test(b) || (options.olderIsPaceField === true && /(?:^|\b)(?:fast|quick|rapid|快|较快)(?:\b|$)/i.test(b));
  const bSlow = PACE_SLOW_RE.test(b) || (options.olderIsPaceField === true && /(?:^|\b)(?:slow|gentle|慢|较慢)(?:\b|$)/i.test(b));
  if ((aFast && !aSlow && bSlow && !bFast) || (aSlow && !aFast && bFast && !bSlow)) {
    return { dimension: 'pace', reason: 'conflicting learning pace preference' };
  }

  // 6. Pedagogy directness polarity (direct answer vs Socratic hints)
  const aDirect = DIRECT_PEDAGOGY_RE.test(a);
  const aSocratic = SOCRATIC_PEDAGOGY_RE.test(a);
  const bDirect = DIRECT_PEDAGOGY_RE.test(b);
  const bSocratic = SOCRATIC_PEDAGOGY_RE.test(b);
  if ((aDirect && !aSocratic && bSocratic && !bDirect) || (aSocratic && !aDirect && bDirect && !bSocratic)) {
    return { dimension: 'pedagogy', reason: 'conflicting direct-answer vs Socratic-hints preference' };
  }

  // 7. Generalizable explicit-negation vs affirmative-feature matching (covers unseen OOD topics)
  const negatedByNewer = extractNegatedTargets(a);
  for (const target of negatedByNewer) {
    if (containsAffirmativeTarget(b, target)) {
      return { dimension: 'negation', reason: `newer rule negates '${target}' required by older preference` };
    }
  }
  const negatedByOlder = extractNegatedTargets(b);
  for (const target of negatedByOlder) {
    if (containsAffirmativeTarget(a, target)) {
      return { dimension: 'negation', reason: `older preference negates '${target}' required by newer rule` };
    }
  }

  return null;
}

function splitPreferenceClauses(text: string): string[] {
  const byMajor = text.split(/\s*[;；。\n]+\s*/).map(s => s.trim()).filter(Boolean);
  if (byMajor.length > 1) return byMajor;
  const byComma = text.split(/\s*[,，]+\s*/).map(s => s.trim()).filter(Boolean);
  return byComma.length > 1 ? byComma : [text.trim()];
}

function shouldRuleReconcilePreference(ruleScope: string, prefText: string): boolean {
  const normalized = normalizeRuleScope(ruleScope);
  if (normalized === 'global') return true;
  const colon = normalized.indexOf(':');
  const suffix = colon === -1 ? normalized : normalized.slice(colon + 1).trim();
  return suffix !== '' && prefText.toLowerCase().includes(suffix);
}

/**
 * Reconciles L2 `LearnerProfile.preferences` against an active/newly-upserted L1 HardRule.
 * Prunes or clears contradicting clauses/entries while preserving unrelated preferences.
 * When `respectRuleScope` is true (write-time), subject/mode-scoped rules do not wipe
 * global L2 preferences unless those preferences explicitly target the same scope.
 */
export function reconcileProfilePreferencesWithRule(
  profile: LearnerProfile,
  rule: Pick<MemoryHardRule, 'id' | 'instruction' | 'scope'>,
  options: { respectRuleScope?: boolean } = {},
): ProfileReconciliationResult {
  const respectScope = options.respectRuleScope ?? true;
  const superseded: SupersededPreference[] = [];
  let changed = false;

  const scalarFields: ReadonlyArray<{
    key: 'explanation_style' | 'language' | 'pace';
    checkOpts: ContradictionCheckOptions;
  }> = [
    { key: 'explanation_style', checkOpts: {} },
    { key: 'language', checkOpts: { olderIsLanguageField: true } },
    { key: 'pace', checkOpts: { olderIsPaceField: true } },
  ];

  for (const { key, checkOpts } of scalarFields) {
    const raw = profile.preferences[key];
    if (raw === null || raw === undefined || raw.trim() === '') continue;
    if (respectScope && !shouldRuleReconcilePreference(rule.scope, raw)) continue;
    const wholeConflict = detectTextContradiction(rule.instruction, raw, checkOpts);
    if (wholeConflict === null) continue;

    // Preserve any non-contradicting clauses in a compound preference string.
    const clauses = splitPreferenceClauses(raw);
    if (clauses.length > 1) {
      const kept = clauses.filter(clause => detectTextContradiction(rule.instruction, clause, checkOpts) === null);
      if (kept.length > 0 && kept.length < clauses.length) {
        const retainedValue = kept.join(isChineseDominantText(raw) ? '；' : '; ');
        profile.preferences[key] = retainedValue;
        superseded.push({
          field: key,
          previousValue: raw,
          retainedValue,
          dimension: wholeConflict.dimension,
          reason: wholeConflict.reason,
        });
        changed = true;
        continue;
      }
    }

    profile.preferences[key] = null;
    superseded.push({
      field: key,
      previousValue: raw,
      retainedValue: null,
      dimension: wholeConflict.dimension,
      reason: wholeConflict.reason,
    });
    changed = true;
  }

  if (profile.preferences.others.length > 0) {
    const keptOthers: string[] = [];
    for (const item of profile.preferences.others) {
      if (respectScope && !shouldRuleReconcilePreference(rule.scope, item)) {
        keptOthers.push(item);
        continue;
      }
      const conflict = detectTextContradiction(rule.instruction, item);
      if (conflict !== null) {
        superseded.push({
          field: 'others',
          previousValue: item,
          retainedValue: null,
          dimension: conflict.dimension,
          reason: conflict.reason,
        });
        changed = true;
      } else {
        keptOthers.push(item);
      }
    }
    if (keptOthers.length !== profile.preferences.others.length) {
      profile.preferences.others = keptOthers;
    }
  }

  return { changed, superseded };
}

/** Non-mutating projection helper: strips L2 preferences contradicted by active session L1 rules. */
export function filterProfileForActiveHardRules(
  profile: LearnerProfile,
  activeRules: readonly Pick<MemoryHardRule, 'id' | 'instruction' | 'scope'>[],
): LearnerProfile {
  if (activeRules.length === 0) return profile;
  const projected: LearnerProfile = {
    ...profile,
    preferences: {
      explanation_style: profile.preferences.explanation_style ?? null,
      language: profile.preferences.language ?? null,
      pace: profile.preferences.pace ?? null,
      others: [...profile.preferences.others],
    },
  };
  for (const rule of activeRules) {
    reconcileProfilePreferencesWithRule(projected, rule, { respectRuleScope: false });
  }
  return projected;
}

function scopesOverlap(a: string, b: string): boolean {
  const normA = normalizeRuleScope(a);
  const normB = normalizeRuleScope(b);
  return normA === 'global' || normB === 'global' || normA === normB;
}

function conflictDimensionLabel(dim: ContradictionDimension, chinese: boolean): string {
  if (chinese) {
    switch (dim) {
      case 'language': return '语言冲突';
      case 'length': return '篇幅冲突';
      case 'format': return '格式冲突';
      case 'pace': return '节奏冲突';
      case 'pedagogy': return '引导方式冲突';
      case 'style': return '风格冲突';
      case 'closing': return '收尾规则冲突';
      case 'negation': return '正反要求冲突';
    }
  }
  switch (dim) {
    case 'language': return 'language conflict';
    case 'length': return 'length conflict';
    case 'format': return 'format conflict';
    case 'pace': return 'pace conflict';
    case 'pedagogy': return 'pedagogy conflict';
    case 'style': return 'style conflict';
    case 'closing': return 'closing-rule conflict';
    case 'negation': return 'contradictory requirement';
  }
}

function detectRuleConflicts(rules: readonly HardRulesDocument['rules'][number][]): DialecticProposal[] {
  const conflicts: DialecticProposal[] = [];
  const seenPairs = new Set<string>();

  for (let i = 0; i < rules.length; i += 1) {
    for (let j = i + 1; j < rules.length; j += 1) {
      const a = rules[i]!;
      const b = rules[j]!;
      if (!scopesOverlap(a.scope, b.scope)) continue;
      const pairKey = [a.id, b.id].sort().join(':');
      if (seenPairs.has(pairKey)) continue;

      const contradiction = detectTextContradiction(a.instruction, b.instruction);
      if (contradiction === null) continue;
      seenPairs.add(pairKey);
      const chinese = isChineseDominantText(`${a.instruction} ${b.instruction}`);
      const conflictType = conflictDimensionLabel(contradiction.dimension, chinese);
      conflicts.push({
        id: `conflict:${pairKey}`,
        kind: 'resolve_rule_conflict',
        title: chinese
          ? `检测到规则${conflictType}：「${a.instruction.slice(0, 18)}…」与「${b.instruction.slice(0, 18)}…」互斥`
          : `Detected rule ${conflictType}: "${a.instruction.slice(0, 28)}…" vs "${b.instruction.slice(0, 28)}…"`,
        rationale: chinese
          ? `这两条常驻规则在「${conflictType}」上互相矛盾：规则 A「${a.instruction.slice(0, 48)}」vs 规则 B「${b.instruction.slice(0, 48)}」。建议删除其一或明确适用场景/作用域，避免 AI 回答无所适从。`
          : `These active rules conflict (${contradiction.reason}): Rule A "${a.instruction.slice(0, 48)}" vs Rule B "${b.instruction.slice(0, 48)}". Remove one or narrow their scopes so replies stay consistent.`,
        severity: 'attention',
        suggestedPayload: {
          conflictType,
          dimension: contradiction.dimension,
          ruleAId: a.id,
          ruleBId: b.id,
          ruleA: a.instruction,
          ruleB: b.instruction,
        },
      });
    }
  }
  return conflicts;
}

export function runDialecticReflection(input: DialecticReflectionInput): DialecticReflectionReport {
  const nowMs = input.nowMs ?? Date.now();
  const staleDays = Math.max(7, input.staleDays ?? DEFAULT_STALE_DAYS);
  const staleThresholdMs = staleDays * 24 * 60 * 60 * 1000;
  const rulesBudgetRatio = input.rulesMaxChars > 0 ? input.rulesChars / input.rulesMaxChars : 0;
  const profileBudgetRatio = input.profileMaxChars > 0 ? input.profileChars / input.profileMaxChars : 0;

  const proposals: DialecticProposal[] = [];

  // 0. Semantic rule contradictions should surface first as high-priority attention items
  for (const conflict of detectRuleConflicts(input.hardRules.rules)) {
    proposals.push(conflict);
  }

  // 1. High-evidence or recurring weak points deserve priority focus
  const recurringWeakPoints = input.learnerProfile.weak_points
    .filter((wp: LearnerWeakPoint) => wp.evidence_count >= 3)
    .sort((a, b) => b.evidence_count - a.evidence_count);
  for (const wp of recurringWeakPoints.slice(0, 3)) {
    proposals.push({
      id: `relapse:${wp.subject}:${wp.knowledge_point}`,
      kind: 'relapse_focus',
      title: `高频薄弱点：${wp.subject} · ${wp.knowledge_point}`,
      rationale: `已累计触发 ${wp.evidence_count} 次错因证据（${wp.error_pattern}），建议安排专项变式训练或设为阶段目标。`,
      severity: 'attention',
      suggestedPayload: {
        subject: wp.subject,
        knowledge_point: wp.knowledge_point,
        evidence_count: wp.evidence_count,
      },
    });
  }

  // 2. Stale weak points untouched for >= staleDays can be audited for retirement
  for (const wp of input.learnerProfile.weak_points) {
    const lastSeen = parseTimeMs(wp.last_seen);
    if (lastSeen !== null && nowMs - lastSeen >= staleThresholdMs) {
      const daysAgo = Math.floor((nowMs - lastSeen) / (24 * 60 * 60 * 1000));
      proposals.push({
        id: `retire:${wp.subject}:${wp.knowledge_point}`,
        kind: 'retire_stale_weak_point',
        title: `候选退场：${wp.subject} · ${wp.knowledge_point}`,
        rationale: `该薄弱点已超过 ${daysAgo} 天未再复发，若已掌握可从长期画像中移除以释放预算。`,
        severity: 'info',
        suggestedPayload: {
          subject: wp.subject,
          knowledge_point: wp.knowledge_point,
          daysAgo,
        },
      });
    }
  }

  // 3. Explicit preferences in profile that aren't yet promoted to L1 HardRules
  const existingRuleNorms = new Set(input.hardRules.rules.map(r => normalizeForMatch(r.instruction)));
  for (const pref of input.learnerProfile.preferences.others) {
    const trimmed = pref.trim();
    if (!trimmed || trimmed.length < 6) continue;
    const norm = normalizeForMatch(trimmed);
    const alreadyCovered = [...existingRuleNorms].some(rn => rn.includes(norm) || norm.includes(rn));
    const contradictingRule = input.hardRules.rules.find(
      rule => detectTextContradiction(rule.instruction, trimmed) !== null,
    );
    if (contradictingRule) {
      const conflict = detectTextContradiction(contradictingRule.instruction, trimmed)!;
      const chinese = isChineseDominantText(`${contradictingRule.instruction} ${trimmed}`);
      const conflictType = conflictDimensionLabel(conflict.dimension, chinese);
      proposals.push({
        id: `conflict:l1_l2:${contradictingRule.id}:${norm.slice(0, 20)}`,
        kind: 'resolve_rule_conflict',
        title: chinese
          ? `检测到 L1 硬规则与 L2 偏好${conflictType}：「${contradictingRule.instruction.slice(0, 18)}…」覆盖「${trimmed.slice(0, 18)}…」`
          : `Detected L1-vs-L2 ${conflictType}: "${contradictingRule.instruction.slice(0, 24)}…" supersedes "${trimmed.slice(0, 24)}…"`,
        rationale: chinese
          ? `L1 硬规则「${contradictingRule.instruction.slice(0, 48)}」与画像偏好「${trimmed.slice(0, 48)}」存在${conflictType}，建议清理过时的 L2 偏好。`
          : `L1 HardRule "${contradictingRule.instruction.slice(0, 48)}" contradicts L2 preference "${trimmed.slice(0, 48)}" (${conflict.reason}). Remove the stale L2 preference.`,
        severity: 'attention',
        suggestedPayload: {
          conflictType,
          dimension: conflict.dimension,
          ruleId: contradictingRule.id,
          rule: contradictingRule.instruction,
          supersededPreference: trimmed,
        },
      });
      continue;
    }
    if (!alreadyCovered && rulesBudgetRatio < 0.85) {
      proposals.push({
        id: `promote:${norm.slice(0, 24)}`,
        kind: 'promote_preference_to_rule',
        title: `可升级为 L1 硬规则：「${trimmed.slice(0, 32)}${trimmed.length > 32 ? '…' : ''}」`,
        rationale: '该偏好目前仅在画像软提示中，若希望每次新会话第 1 轮 100% 严格遵循，可一键升格为 L1 硬规则。',
        severity: 'info',
        suggestedPayload: { instruction: trimmed, scope: 'global' },
      });
    }
  }

  // 4. Hard-rules distillation pressure alert (> 80% budget)
  if (rulesBudgetRatio >= 0.8) {
    proposals.push({
      id: 'compress:hard_rules',
      kind: 'compress_hard_rules',
      title: `L1 硬规则预算已用 ${Math.round(rulesBudgetRatio * 100)}%（${input.rulesChars}/${input.rulesMaxChars}）`,
      rationale: '接近上限阈值，建议合并语义重复规则或将临时规则下沉到普通记忆笔记，以保持首轮提示高信噪比。',
      severity: 'attention',
      suggestedPayload: {
        rulesChars: input.rulesChars,
        rulesMaxChars: input.rulesMaxChars,
        ruleCount: input.hardRules.rules.length,
      },
    });
  }

  const summary = proposals.length === 0
    ? '当前长期记忆内核结构健康，暂无待处理的合并或退场建议。'
    : `共生成 ${proposals.length} 条记忆整理建议（含 ${proposals.filter(p => p.severity === 'attention').length} 条重点关注）。`;

  return {
    generatedAt: new Date(nowMs).toISOString(),
    rulesBudgetRatio: Number(rulesBudgetRatio.toFixed(3)),
    profileBudgetRatio: Number(profileBudgetRatio.toFixed(3)),
    activeWeakPointCount: input.learnerProfile.weak_points.length,
    proposals,
    summary,
  };
}
