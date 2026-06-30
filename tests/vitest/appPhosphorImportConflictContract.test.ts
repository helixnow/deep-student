import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'vitest';

describe('App phosphor import conflict contract', () => {
  it('keeps the resolved phosphor icon import without merge markers', () => {
    const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf-8');

    assert.doesNotMatch(appSource, /^(<<<<<<<|=======|>>>>>>>)/mu);
    assert.match(
      appSource,
      /import\s*\{\s*CaretLeft,\s*CaretRight,\s*CircleNotch,\s*DownloadSimple,\s*Terminal,\s*Warning,\s*X\s*\}\s*from\s*'@phosphor-icons\/react';/u,
    );
    assert.doesNotMatch(appSource, /\bArrowLeft\b/u);
  });
});
