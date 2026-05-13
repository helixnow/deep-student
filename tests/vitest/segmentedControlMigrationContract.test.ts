/**
 * Segmented-control migration contract
 *
 * Enforces that every surface previously sharing the `study-shell-segmented`
 * visual now routes through the shared `SegmentedControl` primitive, which
 * provides `role="radiogroup"` + `role="radio"` + arrow/Home/End keyboard
 * navigation per WAI-ARIA APG. The primitive's own behavioural tests live
 * in `src/components/ui/__tests__/SegmentedControl.test.tsx` — this file
 * exists to prevent consumer-level drift back to bespoke div wrappers.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (relativePath: string) =>
  readFileSync(resolve(process.cwd(), relativePath), 'utf-8');

// `minUsages` reflects how many <SegmentedControl ...> blocks must appear
// in the file. TodoMainPanel has two (quick-add + detail pane); the others
// have one.
const migrated: Array<{ path: string; minUsages: number }> = [
  { path: 'src/features/todo/components/TodoMainPanel.tsx', minUsages: 2 },
  { path: 'src/components/anki/TaskDashboardPage.tsx', minUsages: 1 },
  { path: 'src/components/skills-management/SkillsManagementPage.tsx', minUsages: 1 },
];

describe('segmented-control migration contract', () => {
  for (const { path, minUsages } of migrated) {
    describe(path, () => {
      const source = read(path);

      it('imports the shared SegmentedControl primitive', () => {
        expect(source).toMatch(/from '@\/components\/ui\/SegmentedControl'/);
      });

      it('renders through <SegmentedControl …> at least the expected number of times', () => {
        const re = /<SegmentedControl\b/g;
        const usages = (source.match(re) ?? []).length;
        expect(usages).toBeGreaterThanOrEqual(minUsages);
      });

      it('passes an ariaLabel prop for every SegmentedControl usage', () => {
        // Parsing JSX with regex is unreliable once generic type params
        // (`<SegmentedControl<FilterTab>`) and nested arrow functions enter
        // the picture. Counting is sufficient: `ariaLabel` is camelCase and
        // only used by this primitive in the codebase, so one ariaLabel
        // prop per `<SegmentedControl` opening is the minimum bar.
        const usages = (source.match(/<SegmentedControl\b/g) ?? []).length;
        const ariaLabels = (source.match(/\bariaLabel=/g) ?? []).length;
        expect(usages).toBeGreaterThanOrEqual(minUsages);
        expect(ariaLabels).toBeGreaterThanOrEqual(usages);
      });

      it('does not retain bespoke <div className="study-shell-segmented" …> wrappers', () => {
        // The primitive itself stamps `study-shell-segmented` onto its root,
        // so consumers should never hand-roll a <div> with the same class.
        expect(source).not.toMatch(/<div[^>]*className="[^"]*\bstudy-shell-segmented\b/);
        expect(source).not.toMatch(/<div[^>]*className={[^}]*['"]study-shell-segmented\b/);
      });
    });
  }
});
