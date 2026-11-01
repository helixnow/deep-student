import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { readAppShellSource } from '@/app/__tests__/appShellSources';

describe('App update notification source', () => {
  it('does not render a startup update modal when an update becomes available', () => {
    const source = readAppShellSource();

    assert.doesNotMatch(source, /function StartupUpdateNotification\(/u);
    assert.doesNotMatch(source, /<StartupUpdateNotification updater=\{updater\}\s*\/>/u);
  });
});
