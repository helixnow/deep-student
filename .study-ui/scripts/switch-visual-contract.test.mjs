import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = '/Users/ba7mlv/Documents/ui/study-ui';

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

test('switch uses the newer compact track and thumb geometry', () => {
  const source = read('src/components/ui/switch.tsx');

  assert.equal(
    source.includes('h-8 w-[3.25rem]'),
    true,
    'Switch track should use the compact h-8 / 3.25rem footprint',
  );
  assert.equal(
    source.includes('size-7'),
    true,
    'Switch thumb should use the compact size-7 thumb',
  );
});

test('switch defaults to the shared input surface and semantic border tokens', () => {
  const source = read('src/components/ui/switch.tsx');

  assert.equal(source.includes('border border-border/70'), true, 'Switch should use the shared semantic border token');
  assert.equal(source.includes('bg-input'), true, 'Switch should use the shared input surface token');
  assert.equal(source.includes('bg-black/12 dark:bg-white/16'), false, 'Switch should no longer use hardcoded neutral fills');
});
