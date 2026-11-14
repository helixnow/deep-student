/**
 * OverlayScrollbars 样式表里「无内容量测」时隐藏视口子元素的规则
 * `[data-overlayscrollbars-viewport~=noContent]:not(#osFakeId) > *:not(#osFakeId)` 右侧没有可用的选择器特征，
 * Blink 因此给 `data-overlayscrollbars-viewport` 这个属性名建「整棵子树失效」：任何视口上这个属性的改写
 * 都让整片视口子树重算样式。库每轮 overflow 更新都先删后加地写两次这个属性（不比较新旧值），
 * 紧接着读 computed overflow 强制结算——长会话的消息列表每次四五千个元素。
 *
 * noContent 只在库量测非常规书写方向的滚动原点时设置；ScrollArea 的 flowDirectionStyles 只在 RTL 时
 * 返回方向，LTR 视口从不设置它。所以先把这条规则的子元素分支从样式表里拆掉，遇到 RTL 视口时在量测前原样补回。
 */

const NO_CONTENT_TOKEN = "noContent";

interface DetachedRule {
  rule: CSSStyleRule;
  original: string;
}

const scannedDocuments = new WeakSet<Document>();
const detachedRules = new WeakMap<Document, DetachedRule>();

function splitTopLevel(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < selector.length; i += 1) {
    const ch = selector[i];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth -= 1;
    else if (ch === "," && depth === 0) {
      parts.push(selector.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(selector.slice(start).trim());
  return parts;
}

function hasTopLevelChildCombinator(branch: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < branch.length; i += 1) {
    const ch = branch[i];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth -= 1;
    else if (ch === ">" && depth === 0) return true;
  }
  return false;
}

/** `noContent` 视口的子元素分支：拆掉后的选择器；规则里没有这种分支时返回 null。 */
export function withoutNoContentChildBranch(selectorText: string): string | null {
  if (!selectorText.includes("data-overlayscrollbars-viewport") || !selectorText.includes(NO_CONTENT_TOKEN)) return null;
  const branches = splitTopLevel(selectorText);
  const kept = branches.filter((branch) => !(branch.includes(NO_CONTENT_TOKEN) && hasTopLevelChildCombinator(branch)));
  if (kept.length === branches.length || kept.length === 0) return null;
  return kept.join(", ");
}

// 按下标遍历、命中即停：库样式表在入口 CSS 靠前，Array.from 会给几千条规则逐个建 CSSOM 包装对象。
// 不用 instanceof：样式表可能来自别的 realm（iframe 文档）。
function findNoContentChildRule(rules: CSSRuleList): { rule: CSSStyleRule; reduced: string } | null {
  for (let i = 0; i < rules.length; i += 1) {
    const rule = rules[i];
    const selector = (rule as CSSStyleRule).selectorText;
    if (typeof selector === "string") {
      const reduced = withoutNoContentChildBranch(selector);
      if (reduced !== null) return { rule: rule as CSSStyleRule, reduced };
      continue;
    }
    const nested = (rule as CSSGroupingRule).cssRules;
    const hit = nested ? findNoContentChildRule(nested) : null;
    if (hit) return hit;
  }
  return null;
}

/** 每个文档只扫描一次样式表；样式表里没有这条规则时什么也不做。 */
export function detachOverlayNoContentChildRule(doc: Document = document): void {
  if (scannedDocuments.has(doc)) return;
  scannedDocuments.add(doc);
  for (let i = 0; i < doc.styleSheets.length; i += 1) {
    let rules: CSSRuleList;
    try {
      rules = doc.styleSheets[i].cssRules;
    } catch {
      continue;
    }
    const hit = findNoContentChildRule(rules);
    if (!hit) continue;
    detachedRules.set(doc, { rule: hit.rule, original: hit.rule.selectorText });
    hit.rule.selectorText = hit.reduced;
    return;
  }
}

/** RTL 视口量测前调用：把拆掉的分支原样补回（之后不再拆）。 */
export function restoreOverlayNoContentChildRule(doc: Document = document): void {
  scannedDocuments.add(doc);
  const detached = detachedRules.get(doc);
  if (!detached) return;
  detachedRules.delete(doc);
  detached.rule.selectorText = detached.original;
}
