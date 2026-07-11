const DOCX_STYLE_SCOPE = '.docx-content-wrapper';

function sanitizeDeclarations(style: CSSStyleDeclaration, allowFontSource: boolean): string {
  const declarations: string[] = [];
  for (const property of Array.from(style)) {
    const normalizedProperty = property.toLowerCase();
    const value = style.getPropertyValue(property).trim();
    if (!value) continue;
    if (normalizedProperty === 'behavior' || normalizedProperty === '-moz-binding') continue;
    if (/expression\s*\(|javascript\s*:/i.test(value)) continue;
    if (/url\s*\(/i.test(value)) {
      if (!allowFontSource || !/url\(\s*["']?(?:data:(?:font\/|application\/font)|blob:)/i.test(value)) {
        continue;
      }
    }
    const priority = style.getPropertyPriority(property);
    declarations.push(`${property}: ${value}${priority ? ` !${priority}` : ''};`);
  }
  return declarations.join(' ');
}

/**
 * Scope docx-preview generated CSS to the preview root before attaching it to
 * the application document. Parsing through CSSOM prevents crafted OOXML
 * values from escaping into extra unscoped rules.
 */
export function sanitizeDocxGeneratedStyles(source: HTMLElement): HTMLStyleElement[] {
  const output: HTMLStyleElement[] = [];

  for (const sourceStyle of Array.from(source.querySelectorAll('style'))) {
    const parserStyle = document.createElement('style');
    parserStyle.media = 'not all';
    parserStyle.textContent = sourceStyle.textContent ?? '';
    document.head.append(parserStyle);
    const rules = parserStyle.sheet?.cssRules;
    if (!rules) {
      parserStyle.remove();
      continue;
    }

    const safeRules: string[] = [];
    for (const rule of Array.from(rules)) {
      if (rule.type === CSSRule.STYLE_RULE) {
        const styleRule = rule as CSSStyleRule;
        const declarations = sanitizeDeclarations(styleRule.style, false);
        if (!declarations) continue;
        const selectors = styleRule.selectorText
          .split(',')
          .map((selector) => selector.trim())
          .filter(Boolean)
          .map((selector) => `${DOCX_STYLE_SCOPE} ${selector}`);
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
    parserStyle.remove();
  }
  return output;
}
