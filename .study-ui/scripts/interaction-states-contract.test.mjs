import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = '/Users/ba7mlv/Documents/ui/study-ui';

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

test('shared interactive components avoid border-driven hover styles', () => {
  const files = [
    'src/components/ui/button.tsx',
    'src/components/ui/tabs.tsx',
    'src/components/shell/ShellButton.tsx',
    'src/components/shell/WindowControls.tsx',
  ];

  for (const file of files) {
    const source = read(file);
    assert.equal(source.includes('hover:border'), false, `${file} should not use hover:border styles`);
    assert.equal(
      source.includes('data-[state=active]:border'),
      false,
      `${file} should not use border-driven selected styles`,
    );
  }
});

test('shared interactive components expose fill-driven hover or selected states', () => {
  const buttonSource = read('src/components/ui/button.tsx');
  const tabsSource = read('src/components/ui/tabs.tsx');
  const shellButtonSource = read('src/components/shell/ShellButton.tsx');
  const windowControlsSource = read('src/components/shell/WindowControls.tsx');

  assert.equal(buttonSource.includes('hover:bg-'), true, 'button.tsx should use fill hover states');
  assert.equal(tabsSource.includes('data-[state=active]:bg-'), true, 'tabs.tsx should use fill selected states');
  assert.equal(
    shellButtonSource.includes('buttonToneClassNames.ghost'),
    true,
    'ShellButton.tsx should reuse ghost tone tokens that include fill hover states',
  );
  assert.equal(
    shellButtonSource.includes('hover:bg-'),
    false,
    'ShellButton.tsx should not duplicate hover fill strings when token reuse already provides them',
  );
  assert.equal(windowControlsSource.includes('hover:bg-'), true, 'WindowControls.tsx should use fill hover states');
});
