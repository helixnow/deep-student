/**
 * 未解析 wikilink 点击 → 内联创建确认气泡（非 Modal）。
 *
 * 此前点击未解析链接会立即派发创建事件，误触即静默建出空笔记；
 * 现在先在链接旁弹出锚定小气泡确认（Enter 确认 / Esc 或点击外部取消），
 * 与 candidatePicker / hoverPreview 同族：单例 DOM + floating-ui fixed 定位。
 */

import { computePosition, flip, offset, shift } from '@floating-ui/dom';
import i18next from 'i18next';

const CLASS = 'crepe-wikilink-create-confirm';

let card: HTMLDivElement | null = null;
let currentAnchor: HTMLElement | null = null;
let currentConfirm: (() => void) | null = null;
let detachGlobalClose: (() => void) | null = null;
let openToken = 0;

function ensureCard(): HTMLDivElement {
  if (card) return card;
  const el = document.createElement('div');
  el.className = CLASS;
  el.style.display = 'none';
  // 气泡内点击不移走编辑器焦点（与 suggestOverlay 行为一致）
  el.addEventListener('mousedown', (event) => event.preventDefault());
  document.body.appendChild(el);
  card = el;
  return el;
}

async function positionCard(anchor: HTMLElement, el: HTMLElement): Promise<void> {
  const { x, y } = await computePosition(anchor, el, {
    // 卡片 CSS 为 position: fixed，strategy 必须一致，否则页面滚动后错位
    strategy: 'fixed',
    placement: 'bottom-start',
    middleware: [offset(6), flip(), shift({ padding: 8 })],
  });
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
}

function attachGlobalClose(): void {
  detachGlobalClose?.();
  const onPointerDown = (event: MouseEvent) => {
    const target = event.target;
    // 锚点自身的 mousedown 不关闭：交给 NodeView click 做 toggle，
    // 否则「再次点击链接收起」会先被这里关掉再立即重开
    if (target instanceof Node && (card?.contains(target) || currentAnchor?.contains(target))) return;
    closeWikilinkCreateConfirm();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeWikilinkCreateConfirm();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      const confirm = currentConfirm;
      closeWikilinkCreateConfirm();
      confirm?.();
      return;
    }
    // 修饰键不动气泡；其余按键（用户继续打字）收起气泡并放行事件，
    // 避免随后的 Enter 换行被误当成「确认创建」
    if (event.key === 'Shift' || event.key === 'Control' || event.key === 'Alt' || event.key === 'Meta') {
      return;
    }
    closeWikilinkCreateConfirm();
  };
  const onScroll = (event: Event) => {
    const target = event.target;
    if (target instanceof Node && card?.contains(target)) return;
    closeWikilinkCreateConfirm();
  };
  document.addEventListener('mousedown', onPointerDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('scroll', onScroll, true);
  detachGlobalClose = () => {
    document.removeEventListener('mousedown', onPointerDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('scroll', onScroll, true);
    detachGlobalClose = null;
  };
}

function renderCard(title: string): void {
  const el = ensureCard();
  el.replaceChildren();

  const text = document.createElement('div');
  text.className = `${CLASS}__text`;
  text.textContent = i18next.t('notes:wikilinkV2.createConfirm', {
    defaultValue: '创建新笔记「{{title}}」？',
    title,
  });
  el.appendChild(text);

  const actions = document.createElement('div');
  actions.className = `${CLASS}__actions`;

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = `${CLASS}__button`;
  cancel.textContent = i18next.t('notes:wikilinkV2.createConfirmCancel', {
    defaultValue: '取消',
  });
  cancel.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    closeWikilinkCreateConfirm();
  });
  actions.appendChild(cancel);

  const confirm = document.createElement('button');
  confirm.type = 'button';
  confirm.className = `${CLASS}__button ${CLASS}__button--primary`;
  confirm.textContent = i18next.t('notes:wikilinkV2.createConfirmAction', {
    defaultValue: '创建',
  });
  confirm.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const action = currentConfirm;
    closeWikilinkCreateConfirm();
    action?.();
  });
  actions.appendChild(confirm);

  el.appendChild(actions);
}

export interface WikilinkCreateConfirmOptions {
  /** 锚定元素（被点击的未解析 wikilink NodeView span） */
  anchor: HTMLElement;
  /** 将要创建的笔记标题（未解析 target） */
  title: string;
  /** 用户确认后的动作（通常派发 notes:create-from-wikilink） */
  onConfirm: () => void;
}

/** 气泡当前是否锚定在该元素上（供点击 toggle 判定）。 */
export function isWikilinkCreateConfirmOpenFor(anchor: HTMLElement): boolean {
  return currentAnchor === anchor && Boolean(card && card.style.display !== 'none');
}

export function openWikilinkCreateConfirm(options: WikilinkCreateConfirmOptions): void {
  const { anchor, title, onConfirm } = options;
  if (!title) return;

  const token = ++openToken;
  currentAnchor = anchor;
  currentConfirm = onConfirm;
  const el = ensureCard();
  renderCard(title);
  el.style.display = 'block';
  attachGlobalClose();
  void positionCard(anchor, el).then(() => {
    // 定位是异步的；期间被关闭/替换则不再显示旧气泡
    if (token !== openToken) return;
    if (!anchor.isConnected) closeWikilinkCreateConfirm();
  });
}

export function closeWikilinkCreateConfirm(): void {
  openToken += 1;
  detachGlobalClose?.();
  currentAnchor = null;
  currentConfirm = null;
  if (card) {
    card.style.display = 'none';
    card.replaceChildren();
  }
}

/**
 * 按实例关闭：仅当气泡归属 anchor 时才关闭。
 * NodeView destroy 使用，避免任一节点销毁误关其它链接刚弹出的气泡。
 */
export function closeWikilinkCreateConfirmFor(anchor: HTMLElement): void {
  if (currentAnchor !== anchor) return;
  closeWikilinkCreateConfirm();
}
