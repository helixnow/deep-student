const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const EDITABLE_SELECTOR = [
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
  '[role="textbox"]',
].join(', ');

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as HTMLElement).tagName !== 'string') return false;
  const el = target as HTMLElement;
  if (EDITABLE_TAGS.has(el.tagName) || el.isContentEditable) return true;
  return typeof el.closest === 'function' && Boolean(el.closest(EDITABLE_SELECTOR));
}
