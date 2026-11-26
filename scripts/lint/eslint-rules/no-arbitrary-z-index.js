/**
 * ESLint 自定义规则：禁止散点硬编码 z-index 数值
 *
 * 背景：层级规范集中在 src/config/zIndex.ts（Z_INDEX 常量）与
 * src/styles/theme-colors.css 的 --z-* 变量（Tailwind z-modal / z-popover /
 * z-toast / z-tooltip 等工具类的数值来源），两表互为镜像。组件里每写一个
 * `z-[9999]` 或 `style={{ zIndex: 3001 }}`，就多一个不在规范里的层级，
 * "toast 被 modal 盖住"一类缺陷（2026-07 移动端审计 H-2）由此而来。
 *
 * 两类命中（保持窄口径）：
 *   1. arbitraryZClass —— 任意位置字符串里的 Tailwind `z-[50]` / `-z-[1]` /
 *      `md:z-[100]` / `z-[-1]`（方括号内为数字字面量）。放过 `z-[var(--z-modal)]`。
 *   2. numericStyleZIndex —— JSX `style={{ zIndex: 50 }}` 对象字面量里的数字
 *      字面量（含负数）。`zIndex: Z_INDEX.modal`、变量与表达式放过。
 *
 * 本轮 warn，存量由 config/lint-ratchet-baseline.json 冻结。
 *
 * @example
 * // ❌ 错误
 * <div className="z-[9999]" />
 * <div style={{ zIndex: 3001 }} />
 * // ✅ 正确
 * <div className="z-modal" />
 * <div style={{ zIndex: Z_INDEX.modal }} />
 */

/** z-[50] / -z-[1] / hover:z-[10] / z-[-1]；排除 xz-[…] 与 var()/theme() 任意值 */
const ARBITRARY_Z_CLASS = /(?<![\w-])-?z-\[-?\d+\]/;

const isNumericLiteral = (node) =>
  (node?.type === 'Literal' && typeof node.value === 'number')
  || (node?.type === 'UnaryExpression'
    && (node.operator === '-' || node.operator === '+')
    && node.argument?.type === 'Literal'
    && typeof node.argument.value === 'number');

const isZIndexKey = (prop) => {
  if (prop.type !== 'Property' || prop.kind !== 'init') return false;
  const key = prop.key;
  if (!prop.computed && key.type === 'Identifier') return key.name === 'zIndex';
  return key.type === 'Literal' && (key.value === 'zIndex' || key.value === 'z-index');
};

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'suggestion',
    docs: {
      description: '禁止 z-[N] 与 style zIndex 数字字面量，层级必须走 Z_INDEX / z-* token',
      recommended: true,
    },
    messages: {
      arbitraryZClass:
        '❌ 任意值 z-index 类 "{{value}}"。请改用层级 token 类'
        + '（z-dropdown / z-sticky / z-overlay / z-modal / z-popover / z-toast / z-tooltip，'
        + '见 tailwind.config.js zIndex），或 z-[var(--z-*)]。',
      numericStyleZIndex:
        '❌ style 中硬编码 zIndex: {{value}}。请改用 src/config/zIndex.ts 的 Z_INDEX 常量，'
        + '新增层级须同步 Z_INDEX 与 theme-colors.css 的 --z-* 变量。',
    },
    schema: [],
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    const checkClass = (node, value) => {
      const match = value.match(ARBITRARY_Z_CLASS);
      if (match) context.report({ node, messageId: 'arbitraryZClass', data: { value: match[0] } });
    };

    return {
      Literal(node) {
        if (typeof node.value === 'string') checkClass(node, node.value);
      },
      TemplateElement(node) {
        const raw = node.value?.cooked ?? node.value?.raw ?? '';
        if (raw) checkClass(node, raw);
      },
      'JSXAttribute[name.name="style"] > JSXExpressionContainer > ObjectExpression'(node) {
        for (const prop of node.properties) {
          if (!isZIndexKey(prop) || !isNumericLiteral(prop.value)) continue;
          context.report({
            node: prop.value,
            messageId: 'numericStyleZIndex',
            data: { value: sourceCode.getText(prop.value) },
          });
        }
      },
    };
  },
};
