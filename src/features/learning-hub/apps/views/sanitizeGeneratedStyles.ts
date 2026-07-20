const DOCX_STYLE_SCOPE = '.docx-content-wrapper';

export interface SanitizeDocxStylesOptions {
  /**
   * Selector prepended to every document rule. Defaults to the shared
   * `.docx-content-wrapper` scope; pass an instance-unique selector (e.g.
   * `[data-docx-instance="…"]`) to isolate concurrent previews from each other.
   */
  scope?: string;
  /**
   * CSS custom property name (e.g. `--docx-font-scale`). When provided, every
   * `font-size` declaration is rewritten to `calc(<original> * var(<name>, 1))`
   * so the whole document can be re-scaled without flattening the size
   * hierarchy authored in the file.
   */
  fontScaleVar?: string;
}

function sanitizeDeclarations(
  style: CSSStyleDeclaration,
  allowFontSource: boolean,
  fontScaleVar?: string
): string {
  const declarations: string[] = [];
  for (const property of Array.from(style)) {
    const normalizedProperty = property.toLowerCase();
    let value = style.getPropertyValue(property).trim();
    if (!value) continue;
    if (normalizedProperty === 'behavior' || normalizedProperty === '-moz-binding') continue;
    if (/expression\s*\(|javascript\s*:/i.test(value)) continue;
    if (/url\s*\(/i.test(value)) {
      // @font-face 的 src 只放行本地二进制来源（data:/blob:），拒绝一切远程 URL。
      // data:application/octet-stream 必须在列：docx-preview 解码嵌入字体时
      // 创建的 Blob 未指定 MIME（new Blob([bytes])），useBase64URL 模式下
      // FileReader 序列化出的正是 octet-stream 前缀，过滤掉会丢失文档字体
      if (
        !allowFontSource ||
        !/url\(\s*["']?(?:data:(?:font\/|application\/(?:x-)?font|application\/octet-stream)|blob:)/i.test(value)
      ) {
        continue;
      }
    }
    if (
      fontScaleVar &&
      normalizedProperty === 'font-size' &&
      !value.includes(fontScaleVar)
    ) {
      value = `calc(${value} * var(${fontScaleVar}, 1))`;
    }
    const priority = style.getPropertyPriority(property);
    declarations.push(`${property}: ${value}${priority ? ` !${priority}` : ''};`);
  }
  return declarations.join(' ');
}

/**
 * Parse raw CSS text into rules without ever attaching anything to the live
 * `document`, so multiple previews sanitizing concurrently cannot observe each
 * other's parser artifacts.
 *
 * Preference order:
 * 1. Constructable stylesheet (`new CSSStyleSheet()` + `replaceSync`) — fully
 *    detached, supported by all modern engines shipping with Tauri.
 * 2. A throwaway document from `document.implementation.createHTMLDocument`.
 * 3. Legacy fallback: an inert (`media="not all"`) style briefly appended to
 *    `document.head` (pre-copy of the rules before removal keeps it race-safe
 *    for readers; only reached in environments lacking the two paths above).
 */
function parseCssRules(cssText: string): CSSRule[] {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(cssText);
    if (sheet.cssRules.length) return Array.from(sheet.cssRules);
  } catch {
    // Constructable stylesheets unsupported; fall through.
  }

  try {
    const parserDocument = document.implementation.createHTMLDocument('');
    const parserStyle = parserDocument.createElement('style');
    parserStyle.textContent = cssText;
    parserDocument.head.append(parserStyle);
    const rules = parserStyle.sheet?.cssRules;
    if (rules?.length) return Array.from(rules);
  } catch {
    // Detached document parsing unsupported; fall through.
  }

  const parserStyle = document.createElement('style');
  parserStyle.media = 'not all';
  parserStyle.textContent = cssText;
  document.head.append(parserStyle);
  const rules = parserStyle.sheet?.cssRules ? Array.from(parserStyle.sheet.cssRules) : [];
  parserStyle.remove();
  return rules;
}

/**
 * Scope docx-preview generated CSS to the preview root before attaching it to
 * the application document. Parsing through CSSOM prevents crafted OOXML
 * values from escaping into extra unscoped rules.
 */
export function sanitizeDocxGeneratedStyles(
  source: HTMLElement,
  options: SanitizeDocxStylesOptions = {}
): HTMLStyleElement[] {
  const scope = options.scope ?? DOCX_STYLE_SCOPE;
  const output: HTMLStyleElement[] = [];

  for (const sourceStyle of Array.from(source.querySelectorAll('style'))) {
    const rules = parseCssRules(sourceStyle.textContent ?? '');
    if (!rules.length) continue;

    const safeRules: string[] = [];
    for (const rule of rules) {
      if (rule.type === CSSRule.STYLE_RULE) {
        const styleRule = rule as CSSStyleRule;
        const declarations = sanitizeDeclarations(styleRule.style, false, options.fontScaleVar);
        if (!declarations) continue;
        const selectors = styleRule.selectorText
          .split(',')
          .map((selector) => selector.trim())
          .filter(Boolean)
          .map((selector) => `${scope} ${selector}`);
        if (selectors.length) safeRules.push(`${selectors.join(', ')} { ${declarations} }`);
      } else if (rule.type === CSSRule.FONT_FACE_RULE) {
        const declarations = sanitizeDeclarations((rule as CSSFontFaceRule).style, true);
        if (declarations) safeRules.push(`@font-face { ${declarations} }`);
      }
    }

    if (safeRules.length) {
      const style = document.createElement('style');
      style.textContent = safeRules.join('\n');
      output.push(style);
    }
  }
  return output;
}
