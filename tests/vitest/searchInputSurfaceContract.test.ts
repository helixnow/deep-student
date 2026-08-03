import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sharedStyles = readFileSync(
  resolve(process.cwd(), 'src/shared/styles/deep-student.css'),
  'utf-8',
);
const workbenchStyles = readFileSync(
  resolve(process.cwd(), 'src/features/workbench/styles/workbench.css'),
  'utf-8',
);

describe('search input surface contract', () => {
  it('does not force global search inputs to paint over component shells', () => {
    const searchRules = sharedStyles.matchAll(
      /input\[type="search"\][^{]*\{([^}]*)\}/g,
    );

    for (const [, declarations] of searchRules) {
      expect(declarations).not.toMatch(/background(?:-color)?\s*:/);
    }
  });

  it('leaves focus borders and shadows under component ownership', () => {
    expect(sharedStyles).not.toMatch(/html body input[^\{]*:focus/);
    expect(sharedStyles).not.toMatch(
      /input\[type="search"\][^\{]*:focus[^\{]*\{[^}]*?(?:border-color|box-shadow)\s*:/,
    );
  });

  it('limits workbench transparency to wrapper-owned search fields', () => {
    expect(workbenchStyles).not.toMatch(
      /\[data-wb-workbench-root\]\s+input\[type='search'\]/,
    );
    expect(workbenchStyles).toContain('.wb-apps-search-wrap');
    expect(workbenchStyles).toContain('.finder-search');
    expect(workbenchStyles).toContain('.wb-fc-search');
  });
});
