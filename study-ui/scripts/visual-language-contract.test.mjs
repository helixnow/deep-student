import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = '/Users/ba7mlv/Documents/ui/study-ui';

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

test('light theme uses the requested gray and white foundation', () => {
  const source = read('src/styles/app.css');

  assert.equal(source.includes('--background: #FFFFFF;'), true, 'background should be #FFFFFF');
  assert.equal(source.includes('--secondary: #F9F9F9;'), true, 'secondary should be #F9F9F9');
  assert.equal(source.includes('--interactive-hover: #E9E9E9;'), true, 'interactive hover should be #E9E9E9');
  assert.equal(source.includes('--interactive-selected: #E9E9E9;'), true, 'interactive selected should be #E9E9E9');
});

test('shell removes explicit border separators from chrome surfaces', () => {
  const titlebar = read('src/components/shell/Titlebar.tsx');
  const sidebar = read('src/components/shell/Sidebar.tsx');

  assert.equal(titlebar.includes('via-border'), false, 'titlebar should not draw a border separator');
  assert.equal(sidebar.includes('border-r border-sidebar-border'), false, 'sidebar should not draw a right border');
  assert.equal(sidebar.includes('border-t border-sidebar-border'), false, 'sidebar should not draw a footer border');
});
