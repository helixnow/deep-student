#!/usr/bin/env node
// Execute the built entry graph, not source modules transformed by Vitest.
// This catches chunk initialization cycles before an installer is published.
// IPC stays pending: this checks entry evaluation + the first React render,
// not backend initialization or WebView compatibility.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const dist = path.resolve(process.argv[2] || 'dist');
const html = readFileSync(path.join(dist, 'index.html'), 'utf8');
const entry = html.match(/<script\b[^>]*type="module"[^>]*src="([^"]+)"/);
assert.ok(entry, 'production index.html must contain a module entry');
const dom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (!(key in globalThis)) {
    Object.defineProperty(globalThis, key, Object.getOwnPropertyDescriptor(dom.window, key));
  }
}
for (const key of ['navigator', 'localStorage', 'sessionStorage', 'Event', 'CustomEvent', 'EventTarget']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
window.matchMedia = globalThis.matchMedia = media => ({
  media, matches: false, addListener() {}, removeListener() {},
  addEventListener() {}, removeEventListener() {},
});
window.ResizeObserver = globalThis.ResizeObserver = class {
  observe() {} unobserve() {} disconnect() {}
};
window.IntersectionObserver = globalThis.IntersectionObserver = class {
  observe() {} unobserve() {} disconnect() {}
};
window.HTMLCanvasElement.prototype.getContext = () => null;
// Node imports already load the modules; do not fetch browser preload hints.
const supports = window.DOMTokenList.prototype.supports;
window.DOMTokenList.prototype.supports = function (token) {
  return token === 'modulepreload' || supports.call(this, token);
};
let callbackId = 0;
window.__TAURI_INTERNALS__ = {
  invoke: () => new Promise(() => {}),
  transformCallback: () => ++callbackId,
  metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
};
const fail = error => {
  console.error('Production frontend startup failed:', error);
  process.exit(1);
};
process.on('unhandledRejection', fail);
window.addEventListener('error', event => fail(event.error || event.message));
setTimeout(() => fail(new Error('entry evaluation / initial render timed out')), 10_000);
try {
  await import(pathToFileURL(path.resolve(dist, entry[1])));
  const root = document.getElementById('root');
  for (let attempt = 0; attempt < 100; attempt++) {
    if (root?.childElementCount && !root.querySelector('[data-dstu-react-placeholder]')) {
      console.log('Production entry evaluated and React replaced the boot placeholder.');
      process.exit(0);
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('React did not replace the boot placeholder');
} catch (error) {
  fail(error);
}
