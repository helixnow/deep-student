import { computePosition, flip, offset, shift } from '@floating-ui/dom';
import type { Node as ProseNode } from '@milkdown/prose/model';
import type {
  EditorView,
  NodeView,
  NodeViewConstructor,
  ViewMutationRecord,
} from '@milkdown/prose/view';
import { $view } from '@milkdown/kit/utils';
import { isComposingKeyEvent } from '@/utils/isComposingKeyEvent';

import {
  tCalloutCycleAriaLabel,
  tCalloutEditTitleAriaLabel,
  tCalloutFoldAriaLabel,
  tCalloutPickerAriaLabel,
  tCalloutTitleInputAriaLabel,
  tCalloutTitlePlaceholder,
} from './i18n';
import { createCalloutFoldChevronSvg, createCalloutIconSvg } from './icons';
import { CALLOUT_DATA_TYPE, calloutSchema } from './schema';
import { CALLOUT_TYPES, normalizeCalloutType, type CalloutType } from './types';

// Phosphor Check regular — 选中态指示
const PICKER_CHECK_PATH =
  'M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z';

function createPickerCheckSvg(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 256 256');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('crepe-callout__picker-check-svg');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', PICKER_CHECK_PATH);
  path.setAttribute('fill', 'currentColor');
  svg.appendChild(path);
  return svg;
}

/** Ensures at most one callout type picker is open across all callout instances. */
let activePickerClose: (() => void) | null = null;

class CalloutNodeView implements NodeView {
  dom: HTMLDivElement;
  contentDOM: HTMLDivElement;

  private readonly headerEl: HTMLDivElement;
  private readonly iconButton: HTMLButtonElement;
  private readonly foldButton: HTMLButtonElement;
  private readonly titleEl: HTMLDivElement;
  private readonly bodyEl: HTMLDivElement;
  private node: ProseNode;
  private readonly view: EditorView;
  private readonly getPos: () => number | undefined;

  // Readonly & local fold state
  private readonly editableObserver: MutationObserver | null;
  private lastEditable: boolean;
  private localCollapsed: boolean | undefined;

  // Type picker popover state
  private pickerEl: HTMLDivElement | null = null;
  private pickerItems: HTMLButtonElement[] = [];
  private pickerActiveIndex = 0;
  private pickerPositionToken = 0;
  private readonly closePickerSilently = () => this.closePicker(false);

  // Inline title editor state
  private isEditingTitle = false;
  private titleInput: HTMLInputElement | null = null;
  private titleComposing = false;
  private titleCompositionEndedAt = -Infinity;
  private pendingBlurCommitFrame: number | null = null;

  constructor(node: ProseNode, view: EditorView, getPos: () => number | undefined) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    this.lastEditable = view.editable;

    this.dom = document.createElement('div');
    this.dom.dataset.type = CALLOUT_DATA_TYPE;

    this.headerEl = document.createElement('div');
    this.headerEl.className = 'crepe-callout__header';
    this.headerEl.contentEditable = 'false';

    this.iconButton = document.createElement('button');
    this.iconButton.type = 'button';
    this.iconButton.className = 'crepe-callout__icon';
    this.iconButton.addEventListener('mousedown', this.onButtonMouseDown);
    this.iconButton.addEventListener('click', this.onIconClick);
    this.iconButton.addEventListener('keydown', this.onIconKeyDown);

    this.titleEl = document.createElement('div');
    this.titleEl.className = 'crepe-callout__title';
    this.titleEl.addEventListener('mousedown', this.onTitleMouseDown);
    this.titleEl.addEventListener('click', this.onTitleActivate);
    this.titleEl.addEventListener('dblclick', this.onTitleActivate);
    this.titleEl.addEventListener('keydown', this.onTitleKeyDown);

    this.foldButton = document.createElement('button');
    this.foldButton.type = 'button';
    this.foldButton.className = 'crepe-callout__fold';
    this.foldButton.appendChild(createCalloutFoldChevronSvg());
    this.foldButton.addEventListener('mousedown', this.onButtonMouseDown);
    this.foldButton.addEventListener('click', this.onFoldClick);

    this.headerEl.append(this.iconButton, this.titleEl, this.foldButton);

    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'crepe-callout__body';

    this.contentDOM = document.createElement('div');
    this.contentDOM.className = 'crepe-callout__content';
    this.bodyEl.appendChild(this.contentDOM);

    this.dom.append(this.headerEl, this.bodyEl);
    this.bindAttrs(node);

    if (typeof MutationObserver !== 'undefined' && this.view.dom) {
      this.editableObserver = new MutationObserver(() => {
        if (this.view.isDestroyed) return;
        const nextEditable = this.view.editable;
        if (nextEditable !== this.lastEditable) {
          this.lastEditable = nextEditable;
          this.bindAttrs(this.node);
        }
      });
      this.editableObserver.observe(this.view.dom, {
        attributes: true,
        attributeFilter: ['contenteditable'],
      });
    } else {
      this.editableObserver = null;
    }
  }

  private onButtonMouseDown = (event: MouseEvent) => {
    // Prevent editor from taking focus / selecting the node before click.
    event.preventDefault();
  };

  private onIconClick = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!this.view.editable) return;

    if (this.pickerEl) {
      this.closePicker(true);
      return;
    }
    this.openPicker();
  };

  private onIconKeyDown = (event: KeyboardEvent) => {
    if (!this.view.editable || isComposingKeyEvent(event)) return;
    if (event.key === 'ArrowDown' && !this.pickerEl) {
      event.preventDefault();
      event.stopPropagation();
      this.openPicker();
    }
  };

  private applyCollapsedState(collapsed: boolean) {
    this.dom.dataset.calloutCollapsed = collapsed ? 'true' : 'false';
    this.foldButton.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  }

  private onFoldClick = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!this.view.editable) {
      // Read-only mode: toggle locally in DOM without dispatching a ProseMirror transaction
      const currentCollapsed = this.localCollapsed ?? Boolean(this.node.attrs.collapsed);
      this.localCollapsed = !currentCollapsed;
      this.applyCollapsedState(this.localCollapsed);
      return;
    }

    this.localCollapsed = undefined;
    const pos = this.getPos();
    if (pos == null) return;

    this.view.dispatch(
      this.view.state.tr.setNodeMarkup(pos, undefined, {
        ...this.node.attrs,
        collapsed: !this.node.attrs.collapsed,
      }),
    );
  };

  // ── Type Picker Popover ───────────────────────────────────────────────────

  private openPicker() {
    if (!this.view.editable) return;

    if (this.isEditingTitle) {
      this.commitTitleEdit({ focusAfter: 'none' });
    }

    if (activePickerClose && activePickerClose !== this.closePickerSilently) {
      activePickerClose();
    }

    const currentType = normalizeCalloutType(String(this.node.attrs.type ?? 'note'));

    const picker = document.createElement('div');
    picker.className = 'crepe-callout__picker';
    picker.setAttribute('role', 'menu');
    picker.setAttribute('aria-label', tCalloutPickerAriaLabel());
    picker.style.visibility = 'hidden';
    picker.addEventListener('mousedown', this.onPickerMouseDown);

    const items: HTMLButtonElement[] = [];
    CALLOUT_TYPES.forEach((type, index) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `crepe-callout__picker-item crepe-callout__picker-item--${type}`;
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', type === currentType ? 'true' : 'false');
      item.dataset.calloutType = type;

      const iconWrap = document.createElement('span');
      iconWrap.className = `crepe-callout__picker-icon crepe-callout__picker-icon--${type}`;
      iconWrap.appendChild(createCalloutIconSvg(type));

      const label = document.createElement('span');
      label.className = 'crepe-callout__picker-label';
      label.textContent = tCalloutTitlePlaceholder(type);

      const check = document.createElement('span');
      check.className = 'crepe-callout__picker-check';
      check.setAttribute('aria-hidden', 'true');
      check.appendChild(createPickerCheckSvg());

      item.append(iconWrap, label, check);
      item.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.selectCalloutType(type, true);
      });
      item.addEventListener('focus', () => {
        this.pickerActiveIndex = index;
      });

      picker.appendChild(item);
      items.push(item);
    });

    document.body.appendChild(picker);
    this.pickerEl = picker;
    this.pickerItems = items;
    this.iconButton.setAttribute('aria-expanded', 'true');
    activePickerClose = this.closePickerSilently;

    const initialIndex = Math.max(0, CALLOUT_TYPES.indexOf(currentType));
    // Set roving tabindex synchronously so immediate keyboard navigation works,
    // then focus once computePosition reveals the popover.
    this.setPickerActiveIndex(initialIndex, false);
    this.positionPicker(picker);

    document.addEventListener('pointerdown', this.onPickerOutsidePointerDown, true);
    document.addEventListener('keydown', this.onPickerKeyDown, true);
    window.addEventListener('scroll', this.onPickerScroll, true);
    window.addEventListener('resize', this.onPickerResize);
  }

  private positionPicker(picker: HTMLDivElement) {
    const token = ++this.pickerPositionToken;

    // Synchronous initial coordinates as fallback if computePosition fails.
    const rect = this.iconButton.getBoundingClientRect();
    const viewportW = window.innerWidth || 1024;
    const viewportH = window.innerHeight || 768;
    const fallbackLeft = Math.max(8, Math.min(rect.left, viewportW - 180));
    const fallbackTop = Math.max(8, Math.min(rect.bottom + 6, viewportH - 220));
    picker.style.left = `${fallbackLeft}px`;
    picker.style.top = `${fallbackTop}px`;
    picker.style.transformOrigin = 'top left';

    void computePosition(this.iconButton, picker, {
      strategy: 'fixed',
      placement: 'bottom-start',
      middleware: [offset(6), flip(), shift({ padding: 8 })],
    })
      .then(({ x, y, placement }) => {
        if (token !== this.pickerPositionToken || this.pickerEl !== picker) return;
        picker.style.left = `${x}px`;
        picker.style.top = `${y}px`;
        const isTop = placement.startsWith('top');
        const isEnd = placement.endsWith('end');
        picker.style.transformOrigin = `${isTop ? 'bottom' : 'top'} ${isEnd ? 'right' : 'left'}`;
        picker.style.visibility = 'visible';
        this.pickerItems[this.pickerActiveIndex]?.focus({ preventScroll: true });
      })
      .catch(() => {
        if (token !== this.pickerPositionToken || this.pickerEl !== picker) return;
        picker.style.visibility = 'visible';
        this.pickerItems[this.pickerActiveIndex]?.focus({ preventScroll: true });
      });
  }

  private setPickerActiveIndex(index: number, focus: boolean) {
    if (this.pickerItems.length === 0) return;
    const bounded = ((index % this.pickerItems.length) + this.pickerItems.length) % this.pickerItems.length;
    this.pickerActiveIndex = bounded;
    this.pickerItems.forEach((item, idx) => {
      item.tabIndex = idx === bounded ? 0 : -1;
    });
    if (focus) {
      this.pickerItems[bounded]?.focus({ preventScroll: true });
    }
  }

  private selectCalloutType(type: CalloutType, returnFocus = false) {
    this.closePicker(returnFocus);
    if (!this.view.editable) return;

    const pos = this.getPos();
    if (pos == null) return;

    const currentType = normalizeCalloutType(String(this.node.attrs.type ?? 'note'));
    if (type === currentType) return;

    this.view.dispatch(
      this.view.state.tr.setNodeMarkup(pos, undefined, {
        ...this.node.attrs,
        type,
      }),
    );
  }

  private closePicker(returnFocus = false) {
    if (!this.pickerEl) return;

    this.pickerPositionToken += 1;
    document.removeEventListener('pointerdown', this.onPickerOutsidePointerDown, true);
    document.removeEventListener('keydown', this.onPickerKeyDown, true);
    window.removeEventListener('scroll', this.onPickerScroll, true);
    window.removeEventListener('resize', this.onPickerResize);

    this.pickerEl.removeEventListener('mousedown', this.onPickerMouseDown);
    this.pickerEl.remove();
    this.pickerEl = null;
    this.pickerItems = [];
    if (this.view.editable) {
      this.iconButton.setAttribute('aria-expanded', 'false');
    } else {
      this.iconButton.removeAttribute('aria-expanded');
    }

    if (activePickerClose === this.closePickerSilently) {
      activePickerClose = null;
    }

    if (returnFocus && this.iconButton.isConnected && !this.iconButton.disabled) {
      this.iconButton.focus({ preventScroll: true });
    }
  }

  private onPickerMouseDown = (event: MouseEvent) => {
    event.preventDefault();
  };

  private onPickerOutsidePointerDown = (event: Event) => {
    const target = event.target;
    if (target instanceof Node) {
      if (this.pickerEl?.contains(target) || this.iconButton.contains(target)) {
        return;
      }
    }
    this.closePicker(false);
  };

  private onPickerKeyDown = (event: KeyboardEvent) => {
    if (!this.pickerEl || isComposingKeyEvent(event)) return;

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        event.stopPropagation();
        this.setPickerActiveIndex(this.pickerActiveIndex + 1, true);
        break;
      case 'ArrowUp':
        event.preventDefault();
        event.stopPropagation();
        this.setPickerActiveIndex(this.pickerActiveIndex - 1, true);
        break;
      case 'Home':
        event.preventDefault();
        event.stopPropagation();
        this.setPickerActiveIndex(0, true);
        break;
      case 'End':
        event.preventDefault();
        event.stopPropagation();
        this.setPickerActiveIndex(this.pickerItems.length - 1, true);
        break;
      case 'Enter':
      case ' ': {
        event.preventDefault();
        event.stopPropagation();
        const chosen = CALLOUT_TYPES[this.pickerActiveIndex];
        if (chosen) {
          this.selectCalloutType(chosen, true);
        }
        break;
      }
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        this.closePicker(true);
        break;
      case 'Tab':
        this.closePicker(false);
        break;
      default:
        break;
    }
  };

  private onPickerScroll = (event: Event) => {
    const target = event.target;
    if (target instanceof Node && this.pickerEl?.contains(target)) return;
    this.closePicker(false);
  };

  private onPickerResize = () => {
    this.closePicker(false);
  };

  // ── Inline Editable Title ─────────────────────────────────────────────────

  private onTitleMouseDown = (event: MouseEvent) => {
    if (this.isEditingTitle) {
      // Allow native text selection / caret placement inside the input.
      event.stopPropagation();
      return;
    }
    if (!this.view.editable) return;
    // Prevent ProseMirror from stealing focus/selection before click activates edit mode.
    event.preventDefault();
    event.stopPropagation();
  };

  private onTitleActivate = (event: MouseEvent) => {
    if (this.isEditingTitle || !this.view.editable) return;
    event.preventDefault();
    event.stopPropagation();
    this.startEditingTitle();
  };

  private onTitleKeyDown = (event: KeyboardEvent) => {
    if (this.isEditingTitle || !this.view.editable || isComposingKeyEvent(event)) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      this.startEditingTitle();
    }
  };

  private startEditingTitle() {
    if (this.isEditingTitle || !this.view.editable) return;

    this.closePicker(false);

    const type = normalizeCalloutType(String(this.node.attrs.type ?? 'note'));
    const currentTitle = String(this.node.attrs.title ?? '');

    this.isEditingTitle = true;
    this.titleComposing = false;
    this.titleCompositionEndedAt = -Infinity;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'crepe-callout__title-input';
    input.value = currentTitle;
    input.placeholder = tCalloutTitlePlaceholder(type);
    input.setAttribute('aria-label', tCalloutTitleInputAriaLabel());

    input.addEventListener('compositionstart', this.onTitleInputCompositionStart);
    input.addEventListener('compositionend', this.onTitleInputCompositionEnd);
    input.addEventListener('keydown', this.onTitleInputKeyDown);
    input.addEventListener('blur', this.onTitleInputBlur);

    this.titleInput = input;
    this.titleEl.removeAttribute('tabindex');
    this.titleEl.removeAttribute('role');
    this.titleEl.removeAttribute('aria-label');
    this.titleEl.classList.remove('crepe-callout__title--placeholder');
    this.titleEl.classList.add('crepe-callout__title--editing');
    this.titleEl.replaceChildren(input);

    input.focus({ preventScroll: true });
    if (currentTitle) {
      input.select();
    }
  }

  private cancelPendingBlurCommit() {
    if (this.pendingBlurCommitFrame !== null) {
      cancelAnimationFrame(this.pendingBlurCommitFrame);
      this.pendingBlurCommitFrame = null;
    }
  }

  private detachTitleInput(): string {
    this.cancelPendingBlurCommit();
    const input = this.titleInput;
    const rawValue = input ? input.value : '';
    this.isEditingTitle = false;
    this.titleComposing = false;
    this.titleCompositionEndedAt = -Infinity;
    this.titleInput = null;

    if (input) {
      input.removeEventListener('compositionstart', this.onTitleInputCompositionStart);
      input.removeEventListener('compositionend', this.onTitleInputCompositionEnd);
      input.removeEventListener('keydown', this.onTitleInputKeyDown);
      input.removeEventListener('blur', this.onTitleInputBlur);
      input.remove();
    }
    this.titleEl.classList.remove('crepe-callout__title--editing');
    return rawValue;
  }

  private commitTitleEdit(options: { focusAfter: 'title' | 'none' }) {
    if (this.view.isDestroyed) return;
    if (!this.isEditingTitle) return;

    const rawValue = this.detachTitleInput();
    const nextTitle = rawValue.trim();
    const prevTitle = String(this.node.attrs.title ?? '').trim();

    if (this.view.editable && nextTitle !== prevTitle) {
      const pos = this.getPos();
      if (pos != null) {
        this.view.dispatch(
          this.view.state.tr.setNodeMarkup(pos, undefined, {
            ...this.node.attrs,
            title: nextTitle,
          }),
        );
      } else {
        this.bindAttrs(this.node);
      }
    } else {
      this.bindAttrs(this.node);
    }

    if (options.focusAfter === 'title' && this.titleEl.isConnected) {
      this.titleEl.focus({ preventScroll: true });
    }
  }

  private cancelTitleEdit(options: { focusAfter: 'title' | 'none' }) {
    if (!this.isEditingTitle) return;

    this.detachTitleInput();
    this.bindAttrs(this.node);

    if (options.focusAfter === 'title' && this.titleEl.isConnected) {
      this.titleEl.focus({ preventScroll: true });
    }
  }

  private onTitleInputCompositionStart = () => {
    this.titleComposing = true;
  };

  private onTitleInputCompositionEnd = () => {
    this.titleComposing = false;
    this.titleCompositionEndedAt = performance.now();
  };

  private onTitleInputKeyDown = (event: KeyboardEvent) => {
    // Allow global modifier shortcuts (e.g. Cmd/Ctrl+S, Cmd/Ctrl+F, Cmd/Ctrl+Shift+M/U)
    // to bubble up to the host shell; ProseMirror still ignores input events via stopEvent().
    const hasGlobalModifier = event.metaKey || event.ctrlKey;
    if (!hasGlobalModifier) {
      event.stopPropagation();
    }
    if (this.titleComposing || isComposingKeyEvent(event)) return;

    if (event.key === 'Enter' && !hasGlobalModifier) {
      // macOS WKWebView fires `compositionend` right before the confirming `keydown(Enter)`.
      // Swallow the first Enter within 100ms of compositionend instead of committing early.
      if (performance.now() - this.titleCompositionEndedAt < 100) {
        this.titleCompositionEndedAt = -Infinity;
        event.preventDefault();
        return;
      }
      event.preventDefault();
      this.commitTitleEdit({ focusAfter: 'title' });
      return;
    }

    if (event.key === 'Escape' && !hasGlobalModifier) {
      event.preventDefault();
      this.cancelTitleEdit({ focusAfter: 'title' });
    }
  };

  private onTitleInputBlur = () => {
    if (!this.isEditingTitle) return;
    if (this.titleComposing) {
      this.cancelPendingBlurCommit();
      this.pendingBlurCommitFrame = requestAnimationFrame(() => {
        this.pendingBlurCommitFrame = null;
        if (!this.isEditingTitle || this.view.isDestroyed) return;
        if (this.titleInput && document.activeElement === this.titleInput) return;
        this.commitTitleEdit({ focusAfter: 'none' });
      });
      return;
    }
    this.commitTitleEdit({ focusAfter: 'none' });
  };

  // ── NodeView Lifecycle ────────────────────────────────────────────────────

  private bindAttrs(node: ProseNode) {
    const type = normalizeCalloutType(String(node.attrs.type ?? 'note'));
    const title = String(node.attrs.title ?? '').trim();
    const editable = this.view.editable;
    this.lastEditable = editable;

    if (editable) {
      this.localCollapsed = undefined;
    } else {
      this.closePicker(false);
      if (this.isEditingTitle) {
        this.detachTitleInput();
      }
    }

    const collapsed = editable
      ? Boolean(node.attrs.collapsed)
      : (this.localCollapsed ?? Boolean(node.attrs.collapsed));

    this.dom.className = `crepe-callout crepe-callout--${type}`;
    this.dom.dataset.calloutType = type;
    this.dom.dataset.calloutTitle = title;
    this.applyCollapsedState(collapsed);

    this.iconButton.replaceChildren(createCalloutIconSvg(type));
    this.iconButton.disabled = !editable;
    this.iconButton.classList.toggle('crepe-callout__icon--readonly', !editable);
    if (editable) {
      this.iconButton.setAttribute('aria-haspopup', 'menu');
      this.iconButton.setAttribute('aria-expanded', this.pickerEl ? 'true' : 'false');
      this.iconButton.setAttribute('aria-label', tCalloutCycleAriaLabel());
      this.iconButton.title = tCalloutCycleAriaLabel();
    } else {
      this.iconButton.removeAttribute('aria-haspopup');
      this.iconButton.removeAttribute('aria-expanded');
      this.iconButton.removeAttribute('aria-label');
      this.iconButton.removeAttribute('title');
    }

    if (this.pickerEl) {
      this.pickerItems.forEach((item) => {
        item.setAttribute(
          'aria-checked',
          item.dataset.calloutType === type ? 'true' : 'false',
        );
      });
    }

    this.foldButton.setAttribute('aria-label', tCalloutFoldAriaLabel());
    this.foldButton.title = tCalloutFoldAriaLabel();

    if (this.isEditingTitle && this.titleInput) {
      this.titleInput.placeholder = tCalloutTitlePlaceholder(type as CalloutType);
      return;
    }

    this.titleEl.textContent = title || tCalloutTitlePlaceholder(type as CalloutType);
    this.titleEl.classList.toggle('crepe-callout__title--placeholder', !title);
    this.titleEl.classList.toggle('crepe-callout__title--editable', editable);

    if (editable) {
      this.titleEl.tabIndex = 0;
      this.titleEl.setAttribute('role', 'button');
      this.titleEl.setAttribute('aria-label', tCalloutEditTitleAriaLabel());
    } else {
      this.titleEl.removeAttribute('tabindex');
      this.titleEl.removeAttribute('role');
      this.titleEl.removeAttribute('aria-label');
    }
  }

  update(node: ProseNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.bindAttrs(node);
    return true;
  }

  stopEvent(event: Event): boolean {
    const target = event.target;
    if (!(target instanceof Node)) return false;
    if (this.pickerEl?.contains(target)) return true;
    return (
      this.headerEl.contains(target) ||
      this.iconButton.contains(target) ||
      this.foldButton.contains(target) ||
      this.titleEl.contains(target) ||
      Boolean(this.titleInput?.contains(target))
    );
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    if (mutation.target instanceof Node && this.headerEl.contains(mutation.target)) {
      return true;
    }
    if ((mutation.type as unknown) === 'selection') {
      return this.isEditingTitle;
    }
    if (mutation.target instanceof Node && this.contentDOM.contains(mutation.target)) {
      return false;
    }
    return true;
  }

  destroy() {
    this.editableObserver?.disconnect();
    this.closePicker(false);
    this.cancelPendingBlurCommit();
    if (this.isEditingTitle) {
      this.detachTitleInput();
    }
    this.iconButton.removeEventListener('mousedown', this.onButtonMouseDown);
    this.iconButton.removeEventListener('click', this.onIconClick);
    this.iconButton.removeEventListener('keydown', this.onIconKeyDown);
    this.titleEl.removeEventListener('mousedown', this.onTitleMouseDown);
    this.titleEl.removeEventListener('click', this.onTitleActivate);
    this.titleEl.removeEventListener('dblclick', this.onTitleActivate);
    this.titleEl.removeEventListener('keydown', this.onTitleKeyDown);
    this.foldButton.removeEventListener('mousedown', this.onButtonMouseDown);
    this.foldButton.removeEventListener('click', this.onFoldClick);
  }
}

export const calloutView = $view(calloutSchema.node, (): NodeViewConstructor => {
  return (node, view, getPos) => new CalloutNodeView(node, view, getPos);
});
