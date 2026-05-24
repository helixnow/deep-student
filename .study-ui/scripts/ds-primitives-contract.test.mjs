import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = '/Users/ba7mlv/Documents/ui/study-ui';

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

test('button and surface stop importing Kumo and card wrapper exists', () => {
  const buttonSource = read('src/components/ui/button.tsx');
  const surfaceSource = read('src/components/ui/surface.tsx');

  assert.equal(
    buttonSource.includes('@cloudflare/kumo'),
    false,
    'button.tsx should not import from @cloudflare/kumo',
  );
  assert.equal(
    surfaceSource.includes('@cloudflare/kumo'),
    false,
    'surface.tsx should not import from @cloudflare/kumo',
  );
  assert.equal(
    existsSync(path.join(root, 'src/components/ui/card.tsx')),
    true,
    'card.tsx should exist',
  );
});

test('input exists and switch is backed by Radix instead of Kumo', () => {
  assert.equal(
    existsSync(path.join(root, 'src/components/ui/input.tsx')),
    true,
    'input.tsx should exist',
  );

  const switchSource = read('src/components/ui/switch.tsx');
  assert.equal(
    switchSource.includes('@radix-ui/react-switch'),
    true,
    'switch.tsx should import @radix-ui/react-switch',
  );
  assert.equal(
    switchSource.includes('@cloudflare/kumo'),
    false,
    'switch.tsx should not import from @cloudflare/kumo',
  );
});

test('dialog and tabs wrappers are backed by Radix primitives', () => {
  assert.equal(
    existsSync(path.join(root, 'src/components/ui/dialog.tsx')),
    true,
    'dialog.tsx should exist',
  );
  assert.equal(
    existsSync(path.join(root, 'src/components/ui/tabs.tsx')),
    true,
    'tabs.tsx should exist',
  );

  const dialogSource = read('src/components/ui/dialog.tsx');
  const tabsSource = read('src/components/ui/tabs.tsx');

  assert.equal(
    dialogSource.includes('@radix-ui/react-dialog'),
    true,
    'dialog.tsx should import @radix-ui/react-dialog',
  );
  assert.equal(
    tabsSource.includes('@radix-ui/react-tabs'),
    true,
    'tabs.tsx should import @radix-ui/react-tabs',
  );
});
