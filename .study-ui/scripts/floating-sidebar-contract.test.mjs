import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = '/Users/ba7mlv/Documents/ui/study-ui';

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

test('AppChrome renders the sidebar in a floating overlay layer above the main pane', () => {
  const source = read('src/components/shell/AppChrome.tsx');

  assert.equal(source.includes('data-floating-sidebar-layer'), true, 'AppChrome should include a dedicated floating sidebar layer');
  assert.equal(
    source.includes('relative z-20 shrink-0 overflow-hidden'),
    true,
    'floating sidebar wrapper should use relative flex layout with overflow hidden',
  );
});

test('AppChrome assigns the split seam to the main pane edge instead of overlaying the sidebar boundary', () => {
  const source = read('src/components/shell/AppChrome.tsx');

  assert.equal(
    source.includes('pointer-events-none absolute inset-y-0 z-30 w-px'),
    false,
    'split seam should stop rendering as a higher overlay outside the main pane',
  );
  assert.equal(
    source.includes('pointer-events-none absolute inset-y-0 left-0 z-20 w-px'),
    true,
    'split seam should render from the main pane left edge',
  );
});

test('floating sidebar uses the pass-through pointer-event strategy on wrapper and surface', () => {
  const source = read('src/components/shell/Sidebar.tsx');

  assert.equal(source.includes('data-floating-sidebar-surface'), true, 'Sidebar should label the floating interactive surface');
  assert.equal(source.includes('pointer-events-auto'), true, 'Sidebar surface should remain interactive');
  assert.equal(
    source.includes('isSidebarVisible ? "w-72" : "w-0"'),
    false,
    'Sidebar should stop collapsing by reserved sibling-column width',
  );
});

test('floating sidebar keeps translucent and opaque surface treatments distinct', () => {
  const source = read('src/lib/app-shell.ts');

  assert.equal(source.includes('export function getSidebarSurfaceClass('), true, 'app-shell should expose a sidebar surface helper');
  assert.equal(
    source.includes('windowBackgroundPreference === "opaque"'),
    true,
    'sidebar surface helper should preserve opaque vs translucent mode switching',
  );
  assert.equal(source.includes('bg-[color:var(--shell-panel)]'), true, 'translucent sidebar surface should use the shared shell panel token');
});
