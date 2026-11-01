/**
 * ESLint 自定义规则：禁止在 JSX className/style 中硬编码颜色
 *
 * 背景：主题色全部由 CSS 变量提供（src/styles/theme-colors.css →
 * tailwind.config.js 的 `hsl(var(--primary))` 等），暗色模式、高对比度与
 * 主题切换都只改变量。`#fff`、`rgba(0,0,0,.5)`、`bg-[#1e1e1e]` 是编译期
 * 常量，切主题时不会跟着变——这是"暗色模式下白块/黑字"类缺陷的根源。
 *
 * 两类命中（保持窄口径，避免误报）：
 *   1. hardcodedColor —— JSX `className` / `style` 属性值（含其内部的
 *      cn()/clsx() 参数、三元分支、style 对象值、模板字符串）里出现的
 *      `#rgb` / `#rrggbb` / `#rrggbbaa` 与 `rgb(` / `rgba(` / `hsl(` / `hsla(` 字面量。
 *      `hsl(var(--x))` / `rgb(var(--x) / .5)` 这类 CSS 变量引用放过。
 *   2. arbitraryColorClass —— 任意位置字符串里的 Tailwind 任意值颜色类：
 *      `bg-[#…]` / `text-[#…]` / `border-[#…]` / `ring-[rgba(…)]` 等。
 *
 * 不拦：SVG `fill` / `stroke` 等其他属性、非 JSX 上下文的颜色常量（如图表
 * 配色表）、`url(#id)` 片段引用。
 *
 * 本轮 warn，存量由 config/lint-ratchet-baseline.json 冻结。
 *
 * @example
 * // ❌ 错误
 * <div className="bg-[#1e1e1e]" />
 * <div style={{ color: '#333', background: 'rgba(0,0,0,0.5)' }} />
 * // ✅ 正确
 * <div className="bg-muted text-foreground" />
 * <div style={{ color: 'hsl(var(--foreground))' }} />
 */

/** 十六进制颜色：前面不能是字母数字/`&`/`(`（排除 url(#id)、&#123; 实体；
 *  `_` 放行，以命中 shadow-[0_0_0_1px_#fff]），长度 3/4/6/8，
 *  后面不能接单词字符或 `-`（排除 #section-id 之类锚点） */
const HEX_COLOR = /(?<![0-9A-Za-z&(])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/;

/** 颜色函数：参数首个非空字符不是 var( 才算硬编码 */
const COLOR_FN = /(?<![\w-])(?:rgba?|hsla?)\((?!\s*var\()[^)]*\)?/i;

/** Tailwind 任意值颜色类：bg-[#fff] / hover:text-[#333] / border-t-[rgba(0,0,0,.1)] */
const ARBITRARY_COLOR_CLASS =
  /(?<![\w-])(?:bg|text|border(?:-[trblxyse])?|ring|ring-offset|outline|divide|fill|stroke|from|via|to|shadow|accent|caret|decoration|placeholder)-\[(?:color:)?(?:#[0-9a-fA-F]{3,8}(?![0-9a-fA-F])|(?:rgba?|hsla?)\((?!\s*var\())[^\]\s]*\]?/;

const TARGET_ATTRS = new Set(['className', 'style']);

/** 最近的 JSX 属性是否为 className/style */
const inTargetAttribute = (ancestors) => {
  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    const node = ancestors[i];
    if (node.type === 'JSXAttribute') {
      return node.name?.type === 'JSXIdentifier' && TARGET_ATTRS.has(node.name.name);
    }
    if (node.type === 'JSXElement' || node.type === 'JSXFragment') return false;
  }
  return false;
};

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'suggestion',
    docs: {
      description: '禁止在 JSX className/style 中硬编码颜色（hex / rgb() / hsl() / bg-[#…]），必须使用主题 token',
      recommended: true,
    },
    messages: {
      hardcodedColor:
        '❌ 硬编码颜色 "{{value}}"。它不随主题/暗色模式切换。'
        + '请改用主题 token 类（bg-muted / text-foreground / border-border …）'
        + '或 CSS 变量（hsl(var(--primary))）。',
      arbitraryColorClass:
        '❌ Tailwind 任意值颜色类 "{{value}}"。它不随主题/暗色模式切换。'
        + '请改用 tailwind.config.js 中的语义色（bg-primary / text-muted-foreground …），'
        + '确需任意值时写 bg-[hsl(var(--x))]。',
    },
    schema: [],
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    const check = (node, value) => {
      const cls = value.match(ARBITRARY_COLOR_CLASS);
      if (cls) {
        context.report({ node, messageId: 'arbitraryColorClass', data: { value: cls[0] } });
        return;
      }
      const ancestors = sourceCode.getAncestors ? sourceCode.getAncestors(node) : context.getAncestors();
      if (!inTargetAttribute(ancestors)) return;
      const hit = value.match(HEX_COLOR) ?? value.match(COLOR_FN);
      if (hit) context.report({ node, messageId: 'hardcodedColor', data: { value: hit[0].trim() } });
    };

    return {
      Literal(node) {
        if (typeof node.value === 'string') check(node, node.value);
      },
      TemplateElement(node) {
        const raw = node.value?.cooked ?? node.value?.raw ?? '';
        if (raw) check(node, raw);
      },
    };
  },
};
