import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = '/Users/ba7mlv/Documents/ui/study-ui';

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

test('theme provider syncs native window appearance alongside dataset and storage updates', () => {
  const source = read('src/components/theme/theme-provider.tsx');

  assert.equal(
    source.includes('applyNativeWindowAppearance({'),
    true,
    'ThemeProvider should sync the native window appearance when theme state changes',
  );
});
