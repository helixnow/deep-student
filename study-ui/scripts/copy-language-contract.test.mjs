import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = '/Users/ba7mlv/Documents/ui/study-ui';

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

test('settings and shell headings avoid bilingual English titles', () => {
  const settingsPanel = read('src/components/content/SettingsPanel.tsx');
  const sidebar = read('src/components/shell/Sidebar.tsx');

  const bannedLabels = [
    'Context Routing',
    'Appearance',
    'Status',
    'Recent Threads',
    'Agent IDE',
  ];

  for (const label of bannedLabels) {
    assert.equal(settingsPanel.includes(label) || sidebar.includes(label), false, `${label} should be removed from headings`);
  }
});
