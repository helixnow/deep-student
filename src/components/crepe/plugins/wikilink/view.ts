/**
 * wikilink NodeView：解析态样式 + 点击跳转/创建
 * 只读模式下仍可点击；不可编辑（atom + contenteditable=false）。
 */

import type { Node as ProseNode } from '@milkdown/prose/model';
import type { EditorView, NodeView } from '@milkdown/prose/view';
import { $view } from '@milkdown/utils';

import { wikilinkSchema, WIKILINK_NODE_NAME } from './schema';
import { splitWikiLinkTarget } from './format';
import {
  dispatchCreateFromWikilink,
  dispatchOpenNote,
  normalizeResolve,
  type WikilinkPluginConfig,
  type WikilinkResolver,
} from './types';

function displayText(node: ProseNode): string {
  const label = (node.attrs.label as string) || '';
  const target = (node.attrs.target as string) || '';
  return label || target || '';
}

function createWikilinkView(
  resolve: WikilinkResolver | undefined,
): (node: ProseNode, view: EditorView, getPos: () => number | undefined) => NodeView {
  return (initialNode) => {
    let node = initialNode;
    const dom = document.createElement('span');
    dom.setAttribute('data-type', WIKILINK_NODE_NAME);
    dom.setAttribute('contenteditable', 'false');
    dom.setAttribute('spellcheck', 'false');
    dom.classList.add('crepe-wikilink');

    const apply = (n: ProseNode) => {
      const target = (n.attrs.target as string) || '';
      const label = (n.attrs.label as string) || '';
      const { noteTarget, heading } = splitWikiLinkTarget(target);
      const { resolved } = normalizeResolve(resolve, noteTarget);
      dom.setAttribute('data-target', target);
      dom.setAttribute('data-label', label);
      if (heading) dom.setAttribute('data-heading', heading);
      else dom.removeAttribute('data-heading');
      dom.setAttribute('data-resolved', resolved ? 'true' : 'false');
      dom.classList.toggle('crepe-wikilink--unresolved', !resolved);
      dom.textContent = displayText(n);
      dom.title = target;
    };

    apply(node);

    const onClick = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const target = (node.attrs.target as string) || '';
      if (!target) return;
      const { noteTarget, heading } = splitWikiLinkTarget(target);
      if (!noteTarget) return;
      const { resolved, noteId } = normalizeResolve(resolve, noteTarget);
      if (resolved) {
        dispatchOpenNote(noteTarget, noteId || noteTarget, heading);
      } else {
        dispatchCreateFromWikilink(noteTarget);
      }
    };

    const onIndexUpdated = (event: Event) => {
      const changedTarget = (event as CustomEvent<{ target?: string }>).detail?.target?.trim();
      const nodeTarget = splitWikiLinkTarget((node.attrs.target as string) || '').noteTarget;
      if (!changedTarget || changedTarget === nodeTarget) apply(node);
    };

    dom.addEventListener('click', onClick);
    window.addEventListener('notes:wikilink-index-updated', onIndexUpdated);
    dom.addEventListener('mousedown', (event) => {
      // 避免只读/编辑态下 mousedown 抢焦点导致选区跳动
      if (event.button === 0) event.preventDefault();
    });

    return {
      dom,
      update(updated) {
        if (updated.type.name !== WIKILINK_NODE_NAME) return false;
        node = updated;
        apply(node);
        return true;
      },
      selectNode() {
        dom.classList.add('crepe-wikilink--selected');
      },
      deselectNode() {
        dom.classList.remove('crepe-wikilink--selected');
      },
      stopEvent: () => true,
      ignoreMutation: () => true,
      destroy() {
        dom.removeEventListener('click', onClick);
        window.removeEventListener('notes:wikilink-index-updated', onIndexUpdated);
      },
    };
  };
}

export function createWikilinkViewPlugin(config: WikilinkPluginConfig = {}) {
  return $view(wikilinkSchema.node, () => createWikilinkView(config.resolve));
}
