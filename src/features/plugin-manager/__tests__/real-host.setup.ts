/** Install DOM before React is imported, without replacing native Node URL/Uint8Array/TextEncoder. */
import { JSDOM } from 'jsdom';
import { afterAll, vi } from 'vitest';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'SVGElement', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  const value = (dom.window as unknown as Record<string, unknown>)[name];
  vi.stubGlobal(name, typeof value === 'function' && ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'].includes(name) ? value.bind(dom.window) : value);
}
afterAll(() => { dom.window.close(); vi.unstubAllGlobals(); });
