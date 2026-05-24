import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = '/Users/ba7mlv/Documents/ui/study-ui';
const runtimeFiles = [
  'src/styles/app.css',
  'src/components/ui/button.tsx',
  'src/components/ui/surface.tsx',
  'src/components/ui/switch.tsx',
  'src/components/ui/input.tsx',
  'src/components/ui/dialog.tsx',
  'src/components/ui/tabs.tsx',
];

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

test('runtime files no longer import Kumo styles or components', () => {
  for (const file of runtimeFiles) {
    const source = read(file);
    assert.equal(source.includes('@cloudflare/kumo'), false, `${file} should not reference @cloudflare/kumo`);
    assert.equal(source.includes('kumo-ui'), false, `${file} should not reference kumo-ui`);
  }
});

test('package runtime dependencies no longer include Kumo or legacy icon packages', () => {
  const packageJson = JSON.parse(read('package.json'));
  const dependencies = packageJson.dependencies ?? {};

  assert.equal('@cloudflare/kumo' in dependencies, false, 'package.json should remove @cloudflare/kumo');
  assert.equal('kumo-ui' in dependencies, false, 'package.json should remove kumo-ui');
  assert.equal('@base-ui/react' in dependencies, false, 'package.json should remove @base-ui/react');
  assert.equal('lucide-react' in dependencies, false, 'package.json should remove lucide-react');
});
