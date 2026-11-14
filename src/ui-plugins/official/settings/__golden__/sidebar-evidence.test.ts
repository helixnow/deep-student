// @vitest-environment node
import { describe, expect, it } from 'vitest';
import golden from './sidebar.json';
import { legacySidebarEvidence } from './sidebar-legacy';

describe('fixed pre-change desktop settings sidebar evidence', () => {
  it('executes the original consumer and hook across platform, breakpoint, collapse and callback inputs', () => {
    const actual = legacySidebarEvidence();
    expect(actual.cases).toHaveLength(32);
    expect(actual).toEqual(golden);
  });
});
