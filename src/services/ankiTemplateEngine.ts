/**
 * Anki 模板渲染引擎
 *
 * 目标：以 Anki 官方模板语法为基准的纯函数渲染器，替代原先
 * “正则预处理 + Mustache” 的多段管线。特性：
 *
 * - 字段插值：{{Field}} / {{{Field}}} / {{&Field}}（Anki 语义：不做 HTML 转义，
 *   安全性由下游 DOMPurify + 沙箱 iframe 保证）
 * - 条件段：{{#Field}}...{{/Field}}、反条件段 {{^Field}}...{{/Field}}，支持任意嵌套
 * - 数组迭代：section 值为数组时逐项渲染，支持 {{.}} 与对象项属性、点号路径 {{a.b}}
 * - 过滤器：{{cloze:Field}}（含 c1/c2 多卡序号与 ::hint 提示）、{{hint:Field}}
 *   （内联 <details> 点击展开，无 JS）、{{type:Field}}、{{text:Field}}、
 *   {{furigana:Field}} / {{kana:Field}} / {{kanji:Field}}，且支持链式过滤器
 * - 特殊字段：{{FrontSide}}、{{Tags}}、{{Deck}}、{{Subdeck}}、{{Card}}、{{Type}}
 * - 字段解析大小写不敏感，支持字段名含空格
 * - [sound:xxx] 标签渲染策略（badge / strip / keep）
 * - 模板编译缓存（同一模板字符串重复渲染不重复解析）
 * - 渲染错误结构化返回，绝不抛出异常
 */

export type AnkiTemplateSide = 'front' | 'back';

export type TemplateRenderIssueCode =
  | 'unclosed-section'
  | 'unbalanced-close'
  | 'unknown-filter'
  | 'unsupported-tag'
  | 'invalid-tag'
  | 'frontside-on-front'
  | 'render-exception';

export interface TemplateRenderIssue {
  code: TemplateRenderIssueCode;
  /** 可直接供 UI 内联展示的中文信息 */
  message: string;
  /** 触发问题的原始标签内容（若有） */
  tag?: string;
}

export interface TemplateRenderResult {
  html: string;
  issues: TemplateRenderIssue[];
  /** issues 为空时为 true */
  ok: boolean;
}

export interface AnkiSpecialFields {
  tags?: string[] | string;
  deck?: string;
  subdeck?: string;
  /** {{Card}} - 卡片模板名 */
  cardName?: string;
  /** {{Type}} - 笔记类型名 */
  noteTypeName?: string;
}

export type SoundTagStrategy = 'badge' | 'strip' | 'keep';

export interface AnkiRenderOptions {
  side?: AnkiTemplateSide;
  /** 已渲染的正面 HTML，用于 {{FrontSide}} */
  frontSide?: string;
  /**
   * cloze 卡序号（c1/c2...）。null/undefined 表示不区分序号：
   * 正面隐藏全部 cloze，背面全部揭示（与历史行为一致）。
   * 指定序号时仅对应序号被遮挡/高亮，其余以原文展示（Anki 语义）。
   */
  clozeOrdinal?: number | null;
  special?: AnkiSpecialFields;
  /** [sound:...] 处理策略，默认 badge（内联徽标，不加载资源） */
  soundStrategy?: SoundTagStrategy;
}

// ─────────────────────────────────────────────────────────────────────────────
// AST
// ─────────────────────────────────────────────────────────────────────────────

interface TextNode {
  type: 'text';
  value: string;
}

interface VarNode {
  type: 'var';
  /** 目标字段名（已 trim，可含空格） */
  name: string;
  /** 由外到内的过滤器名（小写） */
  filters: string[];
  raw: string;
}

interface SectionNode {
  type: 'section';
  name: string;
  inverted: boolean;
  children: TemplateNode[];
  raw: string;
}

type TemplateNode = TextNode | VarNode | SectionNode;

export interface CompiledTemplate {
  nodes: TemplateNode[];
  /** 解析阶段发现的结构问题（每次渲染都会带出） */
  issues: TemplateRenderIssue[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 编译缓存（FIFO，上限 200 条）
// ─────────────────────────────────────────────────────────────────────────────

const COMPILE_CACHE_LIMIT = 200;
const compileCache = new Map<string, CompiledTemplate>();

export function clearAnkiTemplateCache(): void {
  compileCache.clear();
}

export function getAnkiTemplateCacheSize(): number {
  return compileCache.size;
}

// ─────────────────────────────────────────────────────────────────────────────
// 解析
// ─────────────────────────────────────────────────────────────────────────────

/** 已知过滤器集合（小写） */
const KNOWN_FILTERS = new Set([
  'cloze',
  'cloze-only',
  'hint',
  'type',
  'text',
  'furigana',
  'kana',
  'kanji',
  'nc',
]);

/** 形如 {{c1::...}} 的内联 cloze 标记不是模板标签，保持原样输出 */
const INLINE_CLOZE_TAG = /^c\d+::/;

const TAG_PATTERN = /\{\{\{([\s\S]*?)\}\}\}|\{\{([\s\S]*?)\}\}/g;

export function compileAnkiTemplate(template: string): CompiledTemplate {
  const source = typeof template === 'string' ? template : '';
  const cached = compileCache.get(source);
  if (cached) return cached;

  const issues: TemplateRenderIssue[] = [];
  const root: TemplateNode[] = [];
  const stack: SectionNode[] = [];
  const currentChildren = () =>
    stack.length > 0 ? stack[stack.length - 1].children : root;

  let lastIndex = 0;
  const regex = new RegExp(TAG_PATTERN.source, 'g');
  let match: RegExpExecArray | null;

  while ((match = regex.exec(source)) !== null) {
    if (match.index > lastIndex) {
      currentChildren().push({ type: 'text', value: source.slice(lastIndex, match.index) });
    }
    lastIndex = regex.lastIndex;

    const rawContent = (match[1] ?? match[2] ?? '').trim();
    const rawTag = match[0];

    if (!rawContent) {
      issues.push({ code: 'invalid-tag', message: '空的模板标签', tag: rawTag });
      continue;
    }

    // 内联 cloze 标记（通常存在于字段数据里，防御性处理模板内联场景）
    if (INLINE_CLOZE_TAG.test(rawContent)) {
      currentChildren().push({ type: 'text', value: rawTag });
      continue;
    }

    const head = rawContent[0];

    if (head === '!') {
      continue; // 注释
    }

    if (head === '=' || head === '>') {
      issues.push({
        code: 'unsupported-tag',
        message: `不支持的模板标签 {{${rawContent}}}`,
        tag: rawContent,
      });
      continue;
    }

    if (head === '#' || head === '^') {
      const name = rawContent.slice(1).trim();
      if (!name) {
        issues.push({ code: 'invalid-tag', message: '缺少名称的条件段', tag: rawContent });
        continue;
      }
      const node: SectionNode = {
        type: 'section',
        name,
        inverted: head === '^',
        children: [],
        raw: rawContent,
      };
      currentChildren().push(node);
      stack.push(node);
      continue;
    }

    if (head === '/') {
      const name = rawContent.slice(1).trim();
      if (stack.length === 0) {
        issues.push({
          code: 'unbalanced-close',
          message: `多余的结束标签 {{/${name}}}`,
          tag: rawContent,
        });
        continue;
      }
      const open = stack[stack.length - 1];
      if (open.name.toLowerCase() !== name.toLowerCase()) {
        issues.push({
          code: 'unbalanced-close',
          message: `结束标签 {{/${name}}} 与开始标签 {{#${open.name}}} 不匹配`,
          tag: rawContent,
        });
        // 尽力恢复：若栈内存在同名开标签则一路弹出，否则忽略该关闭标签
        const matchIndex = stack.findIndex(
          (section) => section.name.toLowerCase() === name.toLowerCase(),
        );
        if (matchIndex >= 0) {
          stack.length = matchIndex;
        }
        continue;
      }
      stack.pop();
      continue;
    }

    // 变量 / 过滤器插值
    let body = rawContent;
    if (head === '&') {
      body = rawContent.slice(1).trim();
    }
    const parts = body.split(':');
    const fieldName = (parts.pop() ?? '').trim();
    const filters = parts.map((part) => part.trim().toLowerCase()).filter(Boolean);
    if (!fieldName && filters.length > 0) {
      issues.push({
        code: 'invalid-tag',
        message: `过滤器缺少字段名 {{${rawContent}}}`,
        tag: rawContent,
      });
      continue;
    }
    for (const filter of filters) {
      if (!KNOWN_FILTERS.has(filter) && !filter.startsWith('tts')) {
        issues.push({
          code: 'unknown-filter',
          message: `未知的模板过滤器「${filter}」，已按普通字段渲染`,
          tag: rawContent,
        });
      }
    }
    currentChildren().push({ type: 'var', name: fieldName, filters, raw: rawContent });
  }

  if (lastIndex < source.length) {
    currentChildren().push({ type: 'text', value: source.slice(lastIndex) });
  }

  while (stack.length > 0) {
    const open = stack.pop()!;
    issues.push({
      code: 'unclosed-section',
      message: `条件段 {{${open.inverted ? '^' : '#'}${open.name}}} 缺少结束标签 {{/${open.name}}}`,
      tag: open.raw,
    });
  }

  const compiled: CompiledTemplate = { nodes: root, issues };

  if (compileCache.size >= COMPILE_CACHE_LIMIT) {
    const oldestKey = compileCache.keys().next().value;
    if (oldestKey !== undefined) compileCache.delete(oldestKey);
  }
  compileCache.set(source, compiled);
  return compiled;
}

// ─────────────────────────────────────────────────────────────────────────────
// 字段解析
// ─────────────────────────────────────────────────────────────────────────────

const normalizeKey = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');

interface LookupHit {
  found: boolean;
  value: unknown;
}

const MISS: LookupHit = { found: false, value: undefined };

function resolveInObject(source: Record<string, unknown>, key: string): LookupHit {
  if (Object.prototype.hasOwnProperty.call(source, key)) {
    return { found: true, value: source[key] };
  }
  const trimmed = key.trim();
  if (trimmed !== key && Object.prototype.hasOwnProperty.call(source, trimmed)) {
    return { found: true, value: source[trimmed] };
  }
  const lowered = trimmed.toLowerCase();
  for (const candidate of Object.keys(source)) {
    if (candidate.toLowerCase() === lowered) {
      return { found: true, value: source[candidate] };
    }
  }
  const normalized = normalizeKey(trimmed);
  if (normalized) {
    for (const candidate of Object.keys(source)) {
      if (normalizeKey(candidate) === normalized) {
        return { found: true, value: source[candidate] };
      }
    }
  }
  return MISS;
}

function isPlainLookupTarget(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function lookupNamed(frames: unknown[], name: string): LookupHit {
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    const frame = frames[i];
    if (isPlainLookupTarget(frame)) {
      const hit = resolveInObject(frame, name);
      if (hit.found) return hit;
    }
  }
  return MISS;
}

function lookupValue(frames: unknown[], rawName: string): LookupHit {
  const name = rawName.trim();
  if (!name) return MISS;
  if (name === '.') {
    return { found: true, value: frames[frames.length - 1] };
  }
  // 优先整名（字段名可含点号），否则按点号路径遍历
  const direct = lookupNamed(frames, name);
  if (direct.found) return direct;

  if (name.includes('.')) {
    const segments = name.split('.').map((segment) => segment.trim()).filter(Boolean);
    if (segments.length < 2) return MISS;
    let current = lookupNamed(frames, segments[0]);
    if (!current.found) return MISS;
    for (let i = 1; i < segments.length; i += 1) {
      if (!isPlainLookupTarget(current.value)) return MISS;
      current = resolveInObject(current.value, segments[i]);
      if (!current.found) return MISS;
    }
    return current;
  }
  return MISS;
}

// ─────────────────────────────────────────────────────────────────────────────
// 值的字符串化 / 真值判定
// ─────────────────────────────────────────────────────────────────────────────

export function toDisplayString(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (item === undefined || item === null) return '';
        if (
          typeof item === 'string' ||
          typeof item === 'number' ||
          typeof item === 'boolean' ||
          typeof item === 'bigint'
        ) {
          return String(item);
        }
        try {
          return JSON.stringify(item);
        } catch {
          return String(item);
        }
      })
      .join(', ');
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Mustache 语义的真值判定：''、0、false、null、undefined、[] 为假 */
function isTruthySectionValue(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (value === '' || value === 0) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'number') return !Number.isNaN(value);
  return true;
}

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');

// ─────────────────────────────────────────────────────────────────────────────
// Cloze
// ─────────────────────────────────────────────────────────────────────────────

const CLOZE_MARKER_PATTERN = /\{\{c(\d+)::([\s\S]*?)\}\}/g;

export function parseClozeBody(body: string): { text: string; hint: string | null } {
  const hintIndex = body.lastIndexOf('::');
  if (hintIndex === -1) {
    return { text: body, hint: null };
  }
  const text = body.slice(0, hintIndex);
  const hint = body.slice(hintIndex + 2);
  return { text, hint: hint || null };
}

export interface ApplyClozeOptions {
  side: AnkiTemplateSide;
  ordinal?: number | null;
}

/**
 * 渲染字段中的 {{cN::answer::hint}} 标记。
 * - 正面：目标序号（未指定则全部）替换为 [...]（可带 hint），其余序号原文展示
 * - 背面：目标序号（未指定则全部）以 cloze-revealed 包裹，其余序号原文展示
 */
export function applyClozeMarkup(text: string, options: ApplyClozeOptions): string {
  const { side, ordinal } = options;
  return text.replace(CLOZE_MARKER_PATTERN, (_match, indexText: string, body: string) => {
    const clozeIndex = Number.parseInt(indexText, 10);
    const { text: clozeText, hint } = parseClozeBody(body);
    const isTarget = ordinal === undefined || ordinal === null || clozeIndex === ordinal;

    if (side === 'back') {
      if (!isTarget) return clozeText;
      return `<span class="cloze-revealed" data-cloze-ordinal="${clozeIndex}">${clozeText}</span>`;
    }
    if (!isTarget) return clozeText;
    const hintMarkup = hint ? `<span class="cloze-hint">${hint}</span>` : '';
    return `<span class="cloze" data-cloze-ordinal="${clozeIndex}">[...]</span>${hintMarkup}`;
  });
}

export function stripClozeMarkup(text: string): string {
  return text.replace(CLOZE_MARKER_PATTERN, (_match, _index, body: string) => parseClozeBody(body).text);
}

/** 提取字段文本中出现的全部 cloze 序号（去重升序），供多卡拆分使用 */
export function extractClozeOrdinals(text: string): number[] {
  const ordinals = new Set<number>();
  const regex = new RegExp(CLOZE_MARKER_PATTERN.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const parsed = Number.parseInt(match[1], 10);
    if (Number.isFinite(parsed)) ordinals.add(parsed);
  }
  return [...ordinals].sort((a, b) => a - b);
}

// ─────────────────────────────────────────────────────────────────────────────
// 日语注音（furigana / kana / kanji）
// ─────────────────────────────────────────────────────────────────────────────

const FURIGANA_PATTERN = /([^\s>[\]]+)\[([^[\]]+)\]/g;

function applyFurigana(text: string, mode: 'furigana' | 'kana' | 'kanji'): string {
  return text.replace(FURIGANA_PATTERN, (_match, base: string, reading: string) => {
    if (mode === 'kana') return reading;
    if (mode === 'kanji') return base;
    return `<ruby>${base}<rt>${reading}</rt></ruby>`;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// [sound:...] 标签
// ─────────────────────────────────────────────────────────────────────────────

const SOUND_TAG_PATTERN = /\[sound:([^\]]+)\]/gi;

export function applySoundTagStrategy(html: string, strategy: SoundTagStrategy): string {
  if (strategy === 'keep') return html;
  return html.replace(SOUND_TAG_PATTERN, (_match, file: string) => {
    if (strategy === 'strip') return '';
    const safeName = escapeHtml(file.trim());
    return (
      `<span class="anki-sound" role="img" aria-label="audio" data-sound-file="${safeName}">` +
      `<span class="anki-sound-icon" aria-hidden="true">&#9834;</span>` +
      `<span class="anki-sound-name">${safeName}</span>` +
      `</span>`
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 渲染
// ─────────────────────────────────────────────────────────────────────────────

interface RenderState {
  frames: unknown[];
  side: AnkiTemplateSide;
  frontSide: string;
  clozeOrdinal: number | null;
  special: AnkiSpecialFields;
  issues: TemplateRenderIssue[];
}

function resolveSpecialField(name: string, state: RenderState): string | null {
  switch (name.trim().toLowerCase()) {
    case 'frontside': {
      if (state.side === 'front') {
        state.issues.push({
          code: 'frontside-on-front',
          message: '{{FrontSide}} 只能用于背面模板',
          tag: name,
        });
        return '';
      }
      return state.frontSide;
    }
    case 'tags': {
      const tags = state.special.tags;
      if (tags === undefined || tags === null) return '';
      return Array.isArray(tags) ? tags.join(', ') : String(tags);
    }
    case 'deck':
      return state.special.deck ?? '';
    case 'subdeck':
      return state.special.subdeck ?? state.special.deck ?? '';
    case 'card':
      return state.special.cardName ?? '';
    case 'type':
      return state.special.noteTypeName ?? '';
    default:
      return null;
  }
}

function renderHintMarkup(fieldName: string, content: string): string {
  if (!content) return '';
  const label = escapeHtml(fieldName.trim() || 'Hint');
  return (
    `<details class="anki-hint">` +
    `<summary class="anki-hint-summary">${label}</summary>` +
    `<span class="anki-hint-content">${content}</span>` +
    `</details>`
  );
}

function renderTypeMarkup(fieldName: string, content: string, side: AnkiTemplateSide): string {
  const safeField = escapeHtml(fieldName.trim());
  if (side === 'front') {
    return `<span class="anki-type-input" data-anki-type-field="${safeField}" role="textbox" aria-label="${safeField}"></span>`;
  }
  return `<span class="anki-type-answer" data-anki-type-field="${safeField}">${content}</span>`;
}

function applyFilters(node: VarNode, rawValue: unknown, state: RenderState): string {
  let text = toDisplayString(rawValue);
  // 过滤器由内（右）向外（左）依次应用
  for (let i = node.filters.length - 1; i >= 0; i -= 1) {
    const filter = node.filters[i];
    switch (filter) {
      case 'cloze':
        text = applyClozeMarkup(text, { side: state.side, ordinal: state.clozeOrdinal });
        break;
      case 'cloze-only': {
        // 仅保留目标 cloze 的答案文本
        const ordinal = state.clozeOrdinal;
        const pieces: string[] = [];
        const regex = new RegExp(CLOZE_MARKER_PATTERN.source, 'g');
        let match: RegExpExecArray | null;
        while ((match = regex.exec(text)) !== null) {
          const clozeIndex = Number.parseInt(match[1], 10);
          if (ordinal === undefined || ordinal === null || clozeIndex === ordinal) {
            pieces.push(parseClozeBody(match[2]).text);
          }
        }
        text = pieces.join(', ');
        break;
      }
      case 'hint':
        text = renderHintMarkup(node.name, text);
        break;
      case 'type':
        text = renderTypeMarkup(node.name, text, state.side);
        break;
      case 'text':
        text = stripClozeMarkup(text);
        break;
      case 'furigana':
        text = applyFurigana(text, 'furigana');
        break;
      case 'kana':
        text = applyFurigana(text, 'kana');
        break;
      case 'kanji':
        text = applyFurigana(text, 'kanji');
        break;
      default:
        // 未知过滤器（含 tts）：忽略过滤器本身，保留字段值。
        break;
    }
  }
  return text;
}

function renderNodes(nodes: TemplateNode[], state: RenderState): string {
  let output = '';
  for (const node of nodes) {
    if (node.type === 'text') {
      output += node.value;
      continue;
    }

    if (node.type === 'var') {
      const hit = lookupValue(state.frames, node.name);
      let value: unknown = hit.value;
      if (!hit.found) {
        const special = resolveSpecialField(node.name, state);
        if (special !== null) {
          value = special;
        } else {
          // 缺失字段按 Mustache 语义渲染为空字符串（不产生噪音错误）
          value = undefined;
        }
      }
      output += applyFilters(node, value, state);
      continue;
    }

    // section
    const hit = lookupValue(state.frames, node.name);
    const value = hit.found ? hit.value : undefined;
    const truthy = isTruthySectionValue(value);

    if (node.inverted) {
      if (!truthy) {
        output += renderNodes(node.children, state);
      }
      continue;
    }

    if (!truthy) continue;

    if (Array.isArray(value)) {
      for (const item of value) {
        state.frames.push(item);
        output += renderNodes(node.children, state);
        state.frames.pop();
      }
      continue;
    }

    state.frames.push(value);
    output += renderNodes(node.children, state);
    state.frames.pop();
  }
  return output;
}

/**
 * 渲染 Anki 模板。纯函数、永不抛出。
 */
export function renderAnkiTemplate(
  template: string,
  data: Record<string, unknown> | null | undefined,
  options: AnkiRenderOptions = {},
): TemplateRenderResult {
  try {
    const compiled = compileAnkiTemplate(template ?? '');
    const state: RenderState = {
      frames: [data ?? {}],
      side: options.side ?? 'front',
      frontSide: options.frontSide ?? '',
      clozeOrdinal: options.clozeOrdinal ?? null,
      special: options.special ?? {},
      issues: [...compiled.issues],
    };
    let html = renderNodes(compiled.nodes, state);
    html = applySoundTagStrategy(html, options.soundStrategy ?? 'badge');
    return { html, issues: state.issues, ok: state.issues.length === 0 };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      html: '',
      issues: [
        {
          code: 'render-exception',
          message: `模板渲染异常：${message}`,
        },
      ],
      ok: false,
    };
  }
}
