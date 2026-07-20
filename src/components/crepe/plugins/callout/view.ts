import type { Node as ProseNode } from '@milkdown/prose/model';
import type {
  EditorView,
  NodeView,
  NodeViewConstructor,
  ViewMutationRecord,
} from '@milkdown/prose/view';
import { $view } from '@milkdown/utils';

import {
  tCalloutCycleAriaLabel,
  tCalloutFoldAriaLabel,
  tCalloutTitlePlaceholder,
} from './i18n';
import { createCalloutFoldChevronSvg, createCalloutIconSvg } from './icons';
import { CALLOUT_DATA_TYPE, calloutSchema } from './schema';
import { nextCalloutType, normalizeCalloutType, type CalloutType } from './types';

class CalloutNodeView implements NodeView {
  dom: HTMLDivElement;
  contentDOM: HTMLDivElement;

  private readonly iconButton: HTMLButtonElement;
  private readonly foldButton: HTMLButtonElement;
  private readonly titleEl: HTMLDivElement;
  private readonly bodyEl: HTMLDivElement;
  private node: ProseNode;
  private readonly view: EditorView;
  private readonly getPos: () => number | undefined;

  constructor(node: ProseNode, view: EditorView, getPos: () => number | undefined) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;

    this.dom = document.createElement('div');
    this.dom.dataset.type = CALLOUT_DATA_TYPE;

    const header = document.createElement('div');
    header.className = 'crepe-callout__header';
    header.contentEditable = 'false';

    this.iconButton = document.createElement('button');
    this.iconButton.type = 'button';
    this.iconButton.className = 'crepe-callout__icon';
    this.iconButton.addEventListener('mousedown', this.onButtonMouseDown);
    this.iconButton.addEventListener('click', this.onIconClick);

    this.titleEl = document.createElement('div');
    this.titleEl.className = 'crepe-callout__title';

    this.foldButton = document.createElement('button');
    this.foldButton.type = 'button';
    this.foldButton.className = 'crepe-callout__fold';
    this.foldButton.appendChild(createCalloutFoldChevronSvg());
    this.foldButton.addEventListener('mousedown', this.onButtonMouseDown);
    this.foldButton.addEventListener('click', this.onFoldClick);

    header.append(this.iconButton, this.titleEl, this.foldButton);

    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'crepe-callout__body';

    this.contentDOM = document.createElement('div');
    this.contentDOM.className = 'crepe-callout__content';
    this.bodyEl.appendChild(this.contentDOM);

    this.dom.append(header, this.bodyEl);
    this.bindAttrs(node);
  }

  private onButtonMouseDown = (event: MouseEvent) => {
    // Prevent editor from taking focus / selecting the node before click.
    event.preventDefault();
  };

  private onIconClick = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!this.view.editable) return;

    const pos = this.getPos();
    if (pos == null) return;

    const next = nextCalloutType(String(this.node.attrs.type ?? 'note'));
    this.view.dispatch(
      this.view.state.tr.setNodeMarkup(pos, undefined, {
        ...this.node.attrs,
        type: next,
      }),
    );
  };

  private onFoldClick = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!this.view.editable) return;

    const pos = this.getPos();
    if (pos == null) return;

    this.view.dispatch(
      this.view.state.tr.setNodeMarkup(pos, undefined, {
        ...this.node.attrs,
        collapsed: !this.node.attrs.collapsed,
      }),
    );
  };

  private bindAttrs(node: ProseNode) {
    const type = normalizeCalloutType(String(node.attrs.type ?? 'note'));
    const title = String(node.attrs.title ?? '').trim();
    const collapsed = Boolean(node.attrs.collapsed);

    this.dom.className = `crepe-callout crepe-callout--${type}`;
    this.dom.dataset.calloutType = type;
    this.dom.dataset.calloutTitle = title;
    this.dom.dataset.calloutCollapsed = collapsed ? 'true' : 'false';

    this.iconButton.replaceChildren(createCalloutIconSvg(type));
    this.iconButton.setAttribute('aria-label', tCalloutCycleAriaLabel());
    this.iconButton.title = tCalloutCycleAriaLabel();

    this.foldButton.setAttribute('aria-label', tCalloutFoldAriaLabel());
    this.foldButton.title = tCalloutFoldAriaLabel();
    this.foldButton.setAttribute('aria-expanded', collapsed ? 'false' : 'true');

    this.titleEl.textContent = title || tCalloutTitlePlaceholder(type as CalloutType);
    this.titleEl.classList.toggle('crepe-callout__title--placeholder', !title);
  }

  update(node: ProseNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.bindAttrs(node);
    return true;
  }

  stopEvent(event: Event): boolean {
    const target = event.target;
    if (!(target instanceof Element)) return false;
    return this.iconButton.contains(target) || this.foldButton.contains(target);
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    if ((mutation.type as unknown) === 'selection') return false;
    if (mutation.target instanceof Node && this.contentDOM.contains(mutation.target)) {
      return false;
    }
    return true;
  }

  destroy() {
    this.iconButton.removeEventListener('mousedown', this.onButtonMouseDown);
    this.iconButton.removeEventListener('click', this.onIconClick);
    this.foldButton.removeEventListener('mousedown', this.onButtonMouseDown);
    this.foldButton.removeEventListener('click', this.onFoldClick);
  }
}

export const calloutView = $view(calloutSchema.node, (): NodeViewConstructor => {
  return (node, view, getPos) => new CalloutNodeView(node, view, getPos);
});
