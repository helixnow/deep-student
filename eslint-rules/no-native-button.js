/**
 * ESLint 自定义规则：禁止使用原生 <button> 元素
 * 
 * 根据 AGENTS.md 规范，所有按钮必须使用 NotionButton 组件。
 * 
 * @example
 * // ❌ 错误
 * <button onClick={handleClick}>点击</button>
 * 
 * // ✅ 正确
 * <NotionButton onClick={handleClick}>点击</NotionButton>
 */

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'suggestion',
    docs: {
      description: '禁止使用原生 <button> 元素，请使用 NotionButton 组件',
      recommended: true,
    },
    messages: {
      noNativeButton: '❌ 禁止使用原生 <button> 元素。请使用 NotionButton (@/components/ui/NotionButton)。参见 AGENTS.md 规范。',
    },
    schema: [], // 无配置选项
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        // 检查是否是 <button> 元素
        if (
          node.name &&
          node.name.type === 'JSXIdentifier' &&
          node.name.name === 'button'
        ) {
          context.report({
            node,
            messageId: 'noNativeButton',
          });
        }
      },
    };
  },
};
