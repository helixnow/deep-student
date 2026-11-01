import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { readAppShellSource } from '@/app/__tests__/appShellSources';

describe('App phosphor import conflict contract', () => {
  it('keeps the resolved phosphor icon import without merge markers', () => {
    const appSource = readAppShellSource();

    assert.doesNotMatch(appSource, /^(<<<<<<<|=======|>>>>>>>)/mu);
    assert.match(
      appSource,
      /import\s*\{\s*CaretLeft,\s*CaretRight,\s*CircleNotch,\s*Terminal,\s*Warning,\s*X\s*\}\s*from\s*'@phosphor-icons\/react';/u,
    );
    assert.doesNotMatch(appSource, /\bArrowLeft\b/u);
  });
});
