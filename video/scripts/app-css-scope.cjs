'use strict';
// 把主应用样式的选择器收进 .ds-app 作用域：宣传片里只有包在 AppSurface 里的真实组件吃到这些规则，
// 手绘镜头（内联样式）不受 Tailwind preflight 与全局 token 影响。scripts/app-css.mjs 与 webpack 的 CSS 预处理共用。
const postcss = require('postcss');

const SCOPE = '.ds-app';
const ROOT = /^(?::root|html)(?![\w-])/;
const BODY = /^(?:body|#root)(?![\w-])/;

const scopeSelector = (selector) => {
  const s = selector.trim();
  if (s.startsWith(SCOPE)) return [s];
  if (s === '*') return [SCOPE, `${SCOPE} *`];
  if (ROOT.test(s)) return [s.replace(ROOT, SCOPE).replace(/\s+(?:body|#root)(?![\w-])/g, '')];
  if (BODY.test(s)) return [s.replace(BODY, SCOPE)];
  return [`${SCOPE} ${s}`];
};

const scopePlugin = () => ({
  postcssPlugin: 'ds-app-scope',
  Once(root) {
    root.walkRules((rule) => {
      const parent = rule.parent;
      if (parent && parent.type === 'atrule' && /keyframes$/i.test(parent.name)) return;
      rule.selectors = [...new Set(rule.selectors.flatMap(scopeSelector))];
    });
  },
});
scopePlugin.postcss = true;

const scopeCss = (css, from) => postcss([scopePlugin()]).process(css, { from, map: false }).css;

module.exports = { SCOPE, scopeSelector, scopePlugin, scopeCss };
