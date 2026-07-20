/**
 * 输入 `[[target]]` / `[[target|label]]` 时转为 wikilink atom
 */

import { InputRule } from '@milkdown/prose/inputrules';
import { $inputRule } from '@milkdown/utils';

import { isInCodeContext } from './codeContext';
import { parseWikiLinkInner } from './format';
import { wikilinkSchema } from './schema';

/**
 * 在文本末尾匹配完整 `[[...]]`（含可选别名）并替换为 atom。
 * 与补全浮层互补：粘贴或快速敲完闭合括号时也能成链。
 * 代码块 / 行内 code 内不生效（与解析层跳过规则对齐）。
 */
export const wikilinkInputRule = $inputRule(
  (ctx) =>
    new InputRule(/\[\[([^\]\r\n]+?)\]\]$/, (state, match, start, end) => {
      if (isInCodeContext(state, start)) return null;
      const parsed = parseWikiLinkInner(match[1] ?? '');
      if (!parsed) return null;
      const node = wikilinkSchema.type(ctx).create({
        target: parsed.target,
        label: parsed.label,
      });
      return state.tr.replaceWith(start, end, node);
    }),
);
