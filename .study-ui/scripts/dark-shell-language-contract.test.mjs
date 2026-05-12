import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = '/Users/ba7mlv/Documents/ui/study-ui';

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

test('dark theme uses black sidebar and #181818 main surfaces', () => {
  const source = read('src/styles/app.css');

  assert.equal(source.includes('--background: #181818;'), true, 'dark main background should be #181818');
  assert.equal(source.includes('--sidebar: #000000;'), true, 'dark sidebar should be #000000');
  assert.equal(source.includes('--shell-backdrop: #181818;'), true, 'dark shell backdrop should be #181818');
  assert.equal(
    source.includes('--interactive-selected: rgba(255, 255, 255, 0.14);'),
    true,
    'selected sidebar row should use the updated translucent fill token',
  );
});

test('inactive and active thread rows both use pure white text in the sidebar', () => {
  const source = read('src/components/shell/Sidebar.tsx');

  assert.equal(
    source.includes('bg-interactive-selected text-sidebar-foreground') ||
      source.includes('bg-interactive-selected text-sidebar-foreground\n'),
    true,
    'active thread row should use selected fill with sidebar foreground text',
  );
  assert.equal(
    source.includes(': "rounded-2xl text-sidebar-foreground hover:bg-interactive-hover hover:text-sidebar-foreground"') ||
      source.includes(': "rounded-2xl text-sidebar-foreground hover:bg-interactive-hover hover:text-sidebar-foreground"\n'),
    true,
    'inactive thread rows should also use sidebar foreground text',
  );
});
