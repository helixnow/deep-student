import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = '/Users/ba7mlv/Documents/ui/study-ui';

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

test('settings sidebar group does not use a separate filled background surface', () => {
  const source = read('src/components/shell/Sidebar.tsx');

  assert.equal(
    source.includes('rounded-[20px] bg-secondary/92 p-2'),
    false,
    'settings sidebar group should not keep a filled gray background container',
  );
});

test('settings sidebar list keeps only a minimal inset from the shell edge', () => {
  const source = read('src/components/shell/Sidebar.tsx');

  assert.equal(source.includes('className="p-2"'), false, 'settings sidebar list should not keep the old p-2 inset');
  assert.equal(source.includes('px-2 py-1'), true, 'settings sidebar list should keep the quieter horizontal inset plus minimal vertical padding');
});

test('settings active row uses a quiet filled selection surface without border shadow emphasis', () => {
  const source = read('src/components/shell/Sidebar.tsx');

  assert.equal(
    source.includes('w-full rounded-2xl bg-interactive-selected text-sidebar-foreground cursor-default'),
    true,
    'settings active row should use the same fill-driven selection language as thread rows',
  );
  assert.equal(
    source.includes('shadow-sm shadow-black/5'),
    false,
    'settings active row should stop using a raised shadow treatment',
  );
  assert.equal(
    source.includes('border border-sidebar-border/70'),
    false,
    'settings active row should stop using a contrast border to simulate selection',
  );
});
