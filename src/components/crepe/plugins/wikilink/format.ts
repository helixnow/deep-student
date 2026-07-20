/**
 * [[target|label]] 解析 / 序列化，与 src/features/notes/wikilinks.ts 规则兼容：
 * - 第一个 `|` 分割 target / label
 * - 两侧 trim；空 target 无效
 */

export interface WikiLinkParts {
  target: string;
  /** 无别名时为空字符串（PM attrs 更易处理） */
  label: string;
}

export interface WikiLinkTargetParts {
  /** Note ID or title used by the resolver. */
  noteTarget: string;
  /** Optional in-note heading after the first `#`. */
  heading: string | undefined;
}

const WIKI_LINK_INNER = /\[\[([^\]\r\n]+?)\]\]/g;

/** 将 target(+可选 label) 格式化为 双链文本 */
export function formatWikiLink(target: string, label?: string | null): string {
  const t = target.trim();
  const l = (label ?? '').trim();
  if (!t) return '';
  return l ? `[[${t}|${l}]]` : `[[${t}]]`;
}

/** 解析 `target` 或 `target|label` 内部片段（不含外层括号） */
export function parseWikiLinkInner(source: string): WikiLinkParts | null {
  const separator = source.indexOf('|');
  const target = (separator === -1 ? source : source.slice(0, separator)).trim();
  if (!target) return null;
  const label = separator === -1 ? '' : source.slice(separator + 1).trim();
  return { target, label };
}

/** 从完整 `[[...]]` 文本解析；失败返回 null */
export function parseWikiLinkText(raw: string): WikiLinkParts | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[[') || !trimmed.endsWith(']]')) return null;
  return parseWikiLinkInner(trimmed.slice(2, -2));
}

/** Split an compatible `Note#Heading` destination without changing its source form. */
export function splitWikiLinkTarget(target: string): WikiLinkTargetParts {
  const separator = target.indexOf('#');
  if (separator < 0) {
    return { noteTarget: target.trim(), heading: undefined };
  }
  const noteTarget = target.slice(0, separator).trim();
  const heading = target.slice(separator + 1).trim();
  return { noteTarget, heading: heading || undefined };
}

/**
 * 在一段纯文本中查找全部 wiki link 匹配（不含 fenced code 处理；
 * remark 侧只 visit text，天然跳过 code 的 value）。
 */
export function findWikiLinksInText(text: string): Array<WikiLinkParts & { start: number; end: number; raw: string }> {
  const links: Array<WikiLinkParts & { start: number; end: number; raw: string }> = [];
  WIKI_LINK_INNER.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WIKI_LINK_INNER.exec(text))) {
    const parts = parseWikiLinkInner(match[1]);
    if (!parts) continue;
    links.push({
      ...parts,
      raw: match[0],
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return links;
}

/** 用于 InputRule / remark 的全局正则（每次使用前重置 lastIndex） */
export function wikiLinkGlobalPattern(): RegExp {
  return /\[\[([^\]\r\n]+?)\]\]/g;
}
