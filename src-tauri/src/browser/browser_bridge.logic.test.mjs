/**
 * Pure-logic unit tests for browser-bridge password / envelope helpers.
 * Run with: node --test src-tauri/src/browser/browser_bridge.logic.test.mjs
 *
 * Full DOM bridge is covered by INIT_SCRIPT string asserts in bridge.rs;
 * this file locks the password hard-reject contract without a browser.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, 'browser_bridge.js'), 'utf8');

describe('browser_bridge.js source contracts', () => {
  it('exposes required API surface', () => {
    for (const name of ['ready', 'snapshot', 'click', 'type', 'scroll', 'highlight']) {
      assert.match(src, new RegExp(`\\b${name}\\b`));
    }
    assert.match(src, /__dsBrowserBridge/);
    assert.match(src, /ax-lite/);
  });

  it('hard-rejects password typing', () => {
    assert.match(src, /password fields cannot be typed by agent bridge/);
    assert.match(src, /err\(\s*['"]BLOCKED['"]/);
    assert.match(src, /reason:\s*['"]password_field['"]/);
    assert.match(src, /current-password/);
    assert.match(src, /new-password/);
  });

  it('masks password values in snapshot', () => {
    assert.match(src, /\[password\]/);
  });

  it('returns ok/error envelope shape', () => {
    assert.match(src, /ok:\s*true/);
    assert.match(src, /ok:\s*false/);
    assert.match(src, /error:\s*\{\s*code:/);
  });

  it('activates click targets exactly once', () => {
    const pointerClick = src.match(/function pointerClick\([\s\S]*?\n  }\n\n  function click/)?.[0];
    assert.ok(pointerClick, 'pointerClick source should be present');
    assert.doesNotMatch(
      pointerClick,
      /dispatchEvent\(new MouseEvent\(['"]click['"], opts\)\);[\s\S]*?\.click\(\)/,
      'must not dispatch click and then call HTMLElement.click on the same path',
    );
    assert.match(pointerClick, /if \(typeof[\s\S]*?\.click === ['"]function['"]\)/);
    assert.match(pointerClick, /else \{\s*el\.dispatchEvent\(new MouseEvent\(['"]click['"], opts\)\)/);
  });
});
