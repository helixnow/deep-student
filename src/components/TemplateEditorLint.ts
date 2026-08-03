/**
 * TemplateEditorLint
 * MinimalTemplateEditor 专属的轻量模板静态检查工具（无第三方依赖）。
 * 覆盖：未配对花括号、未闭合/错配的条件段、未定义字段引用、
 * 字段引用提取、字段重命名时的模板引用同步。
 */

export type TemplateLintIssueType =
  | 'unknown-field'
  | 'unbalanced-braces'
  | 'unclosed-section'
  | 'mismatched-section'
  | 'orphan-close';

export interface TemplateLintIssue {
  type: TemplateLintIssueType;
  /** 主要相关的字段名列表或标签文本 */
  detail: string;
  /** mismatched-section 时期望的开启标签 */
  expected?: string;
}

/** 模板过滤器前缀（Anki 语法），检查字段引用时先剥掉 */
const FILTER_PREFIX_PATTERN = /^(?:cloze|text|hint|type|furigana|kana|kanji)\s*:\s*/i;

/** 渲染管线内置可用的引用名（大小写不敏感） */
const BUILTIN_REFERENCES = new Set(['frontside', 'tags', 'tagsstring', '.']);

const TAG_SOURCE = '\\{\\{\\s*([#^/!&]?)\\s*([^{}]*?)\\s*\\}\\}';

interface ParsedTag {
  sigil: string;
  name: string;
  raw: string;
}

function parseTags(template: string): ParsedTag[] {
  const tags: ParsedTag[] = [];
  const pattern = new RegExp(TAG_SOURCE, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(template)) !== null) {
    tags.push({ sigil: match[1] ?? '', name: match[2] ?? '', raw: match[0] });
  }
  return tags;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 提取模板中引用到的字段名（剥掉过滤器前缀，排除注释/内置引用/'.'）。
 * 用于「字段是否已被模板使用」的标记与重命名前的引用统计。
 */
export function extractFieldReferences(template: string): Set<string> {
  const refs = new Set<string>();
  for (const tag of parseTags(template)) {
    if (tag.sigil === '!') continue;
    const name = tag.name.replace(FILTER_PREFIX_PATTERN, '').trim();
    if (!name || name === '.') continue;
    if (BUILTIN_REFERENCES.has(name.toLowerCase())) continue;
    refs.add(name);
  }
  return refs;
}

/**
 * 对单个模板做静态检查。
 * - 花括号配对
 * - 条件段 {{#X}}/{{^X}} 与 {{/X}} 的配对与嵌套
 * - 顶层未定义字段引用（section 内部上下文会变化，无法静态判断，故只查顶层）
 *
 * @param knownFields   模板声明的字段列表
 * @param extraKnownKeys 额外视为已知的键（如示例数据中的 key），减少误报
 */
export function lintTemplate(
  template: string,
  knownFields: string[],
  extraKnownKeys: string[] = [],
): TemplateLintIssue[] {
  const issues: TemplateLintIssue[] = [];

  const openCount = (template.match(/\{\{/g) || []).length;
  const closeCount = (template.match(/\}\}/g) || []).length;
  if (openCount !== closeCount) {
    issues.push({ type: 'unbalanced-braces', detail: '' });
  }

  const known = new Set<string>();
  knownFields.forEach(field => known.add(field.trim().toLowerCase()));
  extraKnownKeys.forEach(key => known.add(key.trim().toLowerCase()));
  const isKnown = (name: string) => {
    const lowered = name.toLowerCase();
    return known.has(lowered) || BUILTIN_REFERENCES.has(lowered);
  };

  const sectionStack: string[] = [];
  const unknown = new Set<string>();

  for (const tag of parseTags(template)) {
    if (tag.sigil === '!') continue;
    const name = tag.name.replace(FILTER_PREFIX_PATTERN, '').trim();
    if (!name || name === '.') continue;

    if (tag.sigil === '#' || tag.sigil === '^') {
      if (sectionStack.length === 0 && !isKnown(name)) unknown.add(name);
      sectionStack.push(name);
      continue;
    }
    if (tag.sigil === '/') {
      if (sectionStack.length === 0) {
        issues.push({ type: 'orphan-close', detail: `{{/${name}}}` });
      } else {
        const top = sectionStack[sectionStack.length - 1];
        if (top === name) {
          sectionStack.pop();
        } else {
          issues.push({
            type: 'mismatched-section',
            detail: `{{/${name}}}`,
            expected: `{{#${top}}}`,
          });
          sectionStack.pop();
        }
      }
      continue;
    }
    // 普通引用：仅检查顶层
    if (sectionStack.length === 0 && !isKnown(name)) unknown.add(name);
  }

  sectionStack.forEach(name => {
    issues.push({ type: 'unclosed-section', detail: `{{#${name}}}` });
  });

  if (unknown.size > 0) {
    issues.push({ type: 'unknown-field', detail: Array.from(unknown).join(', ') });
  }

  return issues;
}

/**
 * 将模板中对 oldName 的占位符引用（含 #/^// 段标签与 cloze:/text: 等过滤器）
 * 同步重命名为 newName，返回替换后的模板与替换次数。
 */
export function renameFieldReferences(
  template: string,
  oldName: string,
  newName: string,
): { result: string; count: number } {
  const trimmedOld = oldName.trim();
  if (!trimmedOld || trimmedOld === newName) {
    return { result: template, count: 0 };
  }
  const pattern = new RegExp(
    `(\\{\\{\\s*[#^/&]?\\s*(?:(?:cloze|text|hint|type|furigana|kana|kanji)\\s*:\\s*)?)${escapeRegExp(trimmedOld)}(\\s*\\}\\})`,
    'g',
  );
  let count = 0;
  const result = template.replace(pattern, (_match, before: string, after: string) => {
    count += 1;
    return `${before}${newName}${after}`;
  });
  return { result, count };
}
