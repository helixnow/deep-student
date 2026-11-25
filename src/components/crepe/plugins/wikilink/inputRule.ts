/**
 * 输入 `[[target]]` / `[[target|label]]` 时转为 wikilink atom；
 * 同时通过 ProseMirror 插件在粘贴、IME 提交、程序化写入以及切入只读阅读模式时，
 * 将正文里残留的纯文本 `[[...]]` 自动提升为可点击的 wikilink atom 节点。
 */

import { InputRule } from '@milkdown/prose/inputrules';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';
import { $inputRule, $prose } from '@milkdown/kit/utils';

import { isInCodeContext } from './codeContext';
import {
  AUTOMD_PLACEHOLDER_PATTERN,
  parseWikiLinkInner,
  wikiLinkGlobalPattern,
} from './format';
import { WIKILINK_NODE_NAME, wikilinkSchema } from './schema';

const INLINE_CODE_MARK_NAMES = new Set(['inlineCode', 'code']);

export const WIKILINK_PROMOTE_META = 'crepeWikilinkPromote';
export const wikilinkNormalizeKey = new PluginKey('crepeWikilinkNormalize');

export interface PromotePlainTextWikilinksOptions {
  /**
   * 跳过当前光标/选区仍位于 `[[...]]` 内部的片段（编辑态避免在用户于 `foo]]` 前刚输入 `[[` 时抢先成链）。
   * 切入只读/阅读模式时传 `false`，确保所有有效双链都渲染为无方括号的芯片。
   */
  skipSelectionSpan?: boolean;
  /** 是否记入撤销历史；切换阅读模式时的静默归一化传 `false`。 */
  addToHistory?: boolean;
}

/**
 * 扫描文档中的纯文本节点，将代码上下文与 automd 占位符之外的 `[[target]]` / `[[target|label]]`
 * 提升为 `wikilink` atom 节点。无匹配时返回 `null`。
 */
export function promotePlainTextWikilinks(
  state: EditorState,
  options: PromotePlainTextWikilinksOptions = {},
): Transaction | null {
  const wikilinkType = state.schema.nodes[WIKILINK_NODE_NAME];
  if (!wikilinkType) return null;

  const { skipSelectionSpan = false, addToHistory } = options;
  const { selection } = state;
  const replacements: Array<{ from: number; to: number; target: string; label: string }> = [];

  state.doc.descendants((node, pos, parent) => {
    if (node.type.spec.code) return false;
    if (!node.isText || !node.text) return true;
    if (parent?.type.spec.code) return true;
    if (node.marks.some((mark) => INLINE_CODE_MARK_NAMES.has(mark.type.name))) return true;
    if (!node.text.includes('[[')) return true;

    const pattern = wikiLinkGlobalPattern();
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(node.text))) {
      const inner = match[1] ?? '';
      if (AUTOMD_PLACEHOLDER_PATTERN.test(inner)) continue;
      const parsed = parseWikiLinkInner(inner);
      if (!parsed) continue;

      const from = pos + match.index;
      const to = from + match[0].length;
      if (isInCodeContext(state, from)) continue;

      if (skipSelectionSpan) {
        const selectionInside =
          selection.from < to &&
          selection.to > from &&
          (selection.from > from || !selection.empty);
        if (selectionInside) continue;
      }

      replacements.push({
        from,
        to,
        target: parsed.target,
        label: parsed.label,
      });
    }
    return true;
  });

  if (replacements.length === 0) return null;

  let tr = state.tr;
  for (let i = replacements.length - 1; i >= 0; i -= 1) {
    const item = replacements[i]!;
    tr = tr.replaceWith(
      item.from,
      item.to,
      wikilinkType.create({ target: item.target, label: item.label }),
    );
  }
  tr.setMeta(WIKILINK_PROMOTE_META, true);
  if (addToHistory === false) {
    tr.setMeta('addToHistory', false);
  }
  return tr;
}

/**
 * 在文本末尾匹配完整 `[[...]]`（含可选别名）并替换为 atom。
 * 与补全浮层互补：粘贴或快速敲完闭合括号时也能成链。
 * 代码块 / 行内 code 内不生效（与解析层跳过规则对齐）。
 */
export const wikilinkInputRule = $inputRule(
  (ctx) =>
    new InputRule(/\[\[([^[\]\r\n]+?)\]\]$/, (state, match, start, end) => {
      if (isInCodeContext(state, start)) return null;
      const inner = match[1] ?? '';
      if (AUTOMD_PLACEHOLDER_PATTERN.test(inner)) return null;
      const parsed = parseWikiLinkInner(inner);
      if (!parsed) return null;
      const node = wikilinkSchema.type(ctx).create({
        target: parsed.target,
        label: parsed.label,
      });
      return state.tr.replaceWith(start, end, node);
    }),
);

/**
 * 粘贴、IME 提交与只读阅读模式切换时的 `[[wikilink]]` 归一化插件：
 * - 粘贴/批量写入/IME 提交后，将光标外的完整 `[[...]]` 立即转为 atom 节点；
 * - 撤销/重做（`history$`）不强制重新提升；
 * - 切入只读阅读模式（`editable: () => false`）时，将全部有效纯文本 `[[...]]` 提升为可点击芯片。
 */
export const wikilinkNormalizePlugin = $prose(() => {
  let isComposing = false;
  let promoting = false;

  const dispatchPromotion = (
    view: EditorView,
    options: PromotePlainTextWikilinksOptions,
  ): void => {
    if (promoting || view.isDestroyed || view.composing) return;
    const tr = promotePlainTextWikilinks(view.state, options);
    if (!tr) return;
    promoting = true;
    try {
      view.dispatch(tr);
    } finally {
      promoting = false;
    }
  };

  return new Plugin({
    key: wikilinkNormalizeKey,
    appendTransaction(transactions, _oldState, newState) {
      if (isComposing || promoting) return null;
      if (!transactions.some((tr) => tr.docChanged)) return null;
      if (
        transactions.some(
          (tr) =>
            Boolean(tr.getMeta(WIKILINK_PROMOTE_META)) ||
            Boolean(tr.getMeta('history$')) ||
            Boolean(tr.getMeta('composition')),
        )
      ) {
        return null;
      }
      return promotePlainTextWikilinks(newState, { skipSelectionSpan: true });
    },
    props: {
      handleDOMEvents: {
        compositionstart() {
          isComposing = true;
          return false;
        },
        compositionend(view) {
          isComposing = false;
          queueMicrotask(() => {
            dispatchPromotion(view, { skipSelectionSpan: view.editable });
          });
          return false;
        },
      },
    },
    view(editorView) {
      if (!editorView.editable) {
        dispatchPromotion(editorView, { skipSelectionSpan: false, addToHistory: false });
      }
      return {
        update(view) {
          if (!view.editable) {
            dispatchPromotion(view, { skipSelectionSpan: false, addToHistory: false });
          }
        },
      };
    },
  });
});
