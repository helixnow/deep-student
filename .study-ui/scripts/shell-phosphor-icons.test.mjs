import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const shellIconFiles = [
  'src/lib/sidebar-data.tsx',
  'src/components/shell/Sidebar.tsx',
  'src/components/shell/WindowControls.tsx',
];

test('shell-visible icon files use Phosphor imports instead of Lucide', () => {
  for (const file of shellIconFiles) {
    const source = readFileSync(file, 'utf8');
    assert.ok(
      source.includes('@phosphor-icons/react'),
      `${file} should import shell-visible icons from @phosphor-icons/react`,
    );
    assert.equal(
      source.includes('from "lucide-react"') || source.includes("from 'lucide-react'"),
      false,
      `${file} should no longer import shell-visible icons from lucide-react`,
    );
  }
});

test('sidebar toggles use sidebar-shaped phosphor icons instead of caret-line glyphs', () => {
  const appChrome = readFileSync('src/components/shell/AppChrome.tsx', 'utf8');
  const sidebar = readFileSync('src/components/shell/Sidebar.tsx', 'utf8');

  assert.equal(appChrome.includes('CaretLineLeft') || appChrome.includes('CaretLineRight'), false);
  assert.equal(sidebar.includes('CaretLineLeft') || sidebar.includes('CaretLineRight'), false);
  assert.ok(appChrome.includes('Sidebar')); 
  assert.ok(sidebar.includes('SidebarSimple') || sidebar.includes('Sidebar'));
});
