import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = '/Users/ba7mlv/Documents/ui/study-ui';
const tokenFile = path.join(root, 'src/styles/app.css');
const contentFiles = [
  'src/components/content/SettingsPanel.tsx',
  'src/components/content/SettingsDemoPanel.tsx',
  'src/components/content/ThreadCanvas.tsx',
];

const requiredTokens = [
  '--background',
  '--foreground',
  '--muted',
  '--border',
  '--accent',
  '--ring',
  '--card',
  '--input',
  '--overlay',
];

test('app.css defines light and dark semantic design tokens', () => {
  const source = readFileSync(tokenFile, 'utf8');

  assert.ok(source.includes(':root'), 'app.css should define light theme tokens on :root');
  assert.ok(
    source.includes('[data-theme="dark"]'),
    'app.css should define dark theme tokens on [data-theme="dark"]',
  );

  for (const token of requiredTokens) {
    assert.ok(source.includes(token), `app.css should define ${token}`);
  }
});

test('content components stop depending on Kumo token class names', () => {
  for (const file of contentFiles) {
    const source = readFileSync(path.join(root, file), 'utf8');
    assert.equal(source.includes('kumo-'), false, `${file} should not use Kumo token classes`);
  }
});
