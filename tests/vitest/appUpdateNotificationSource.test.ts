import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'vitest';

const appPath = path.resolve(process.cwd(), 'src/App.tsx');

describe('App update notification source', () => {
  it('does not render a startup update modal when an update becomes available', () => {
    const source = readFileSync(appPath, 'utf8');

    assert.doesNotMatch(source, /function StartupUpdateNotification\(/u);
    assert.doesNotMatch(source, /<StartupUpdateNotification updater=\{updater\}\s*\/>/u);
  });
});
