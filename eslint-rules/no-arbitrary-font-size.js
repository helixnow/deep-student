/**
 * ESLint 自定义规则：禁止 Tailwind 硬编码字号（text-[13px] 等）
 *
 * 背景：设置 → 外观 → 界面字号写的是 `--font-size-scale`
 * （src/config/fontConfig.ts → applyFontSizeToDocument），所有字号 token
 * （--font-size-2xs / xs / sm / base / md / lg / ui / --m-text-caption）都是
 * `calc(Npx * var(--font-size-scale))`。而 `text-[13px]` 是编译期常量，
 * 完全不参与缩放——用户把字号调到 130% 时，按钮标签仍是 13px，
 * 这正是"字号缩放没闭环"的根因。
 *
 * 允许的写法：
 *   - token 类：text-ui / text-sm / text-2xs / text-caption ...
 *   - 显式走 token 的任意值：text-[length:var(--font-size-ui)]
 *
 * @example
 * // ❌ 错误
 * <span className="text-[13px]" />
 * // ✅ 正确
 * <span className="text-ui" />
 */

/** 匹配 text-[13px] / md:text-[0.8rem] / data-[state=open]:text-[2em]，
 *  放过 text-[length:var(--font-size-ui)] 这类 token 引用 */
const ARBITRARY_FONT_SIZE = /(?<![a-zA-Z0-9])text-\[(?:length:)?\d*\.?\d+(?:px|rem|em|pt)\]/;

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description: '禁止 text-[Npx] 硬编码字号，必须使用参与 --font-size-scale 的字号 token 类',
      recommended: true,
    },
    messages: {
      noArbitraryFontSize:
        '❌ 禁止硬编码字号 "{{value}}"。它不参与设置里的界面字号缩放（--font-size-scale）。'
        + '请改用字号 token 类（text-2xs/xs/sm/base/md/lg/ui/caption，见 tailwind.config.js fontSize），'
        + '确需任意值时写 text-[length:var(--font-size-*)]。',
    },
    schema: [],
  },
  create(context) {
    const report = (node, value) => {
      const match = value.match(ARBITRARY_FONT_SIZE);
      if (!match) return;
      context.report({
        node,
        messageId: 'noArbitraryFontSize',
        data: { value: match[0].trim() },
      });
    };

    return {
      Literal(node) {
        if (typeof node.value === 'string') report(node, node.value);
      },
      TemplateElement(node) {
        const raw = node.value?.cooked ?? node.value?.raw ?? '';
        if (raw) report(node, raw);
      },
    };
  },
};
