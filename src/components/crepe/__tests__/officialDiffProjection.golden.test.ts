/**
 * FE-B9 evidence before `EditorPurpose = 'diff'` exists: what the AI change review projection assembles and shows.
 *
 * The review view is a disposable Crepe instance (`officialDiffAdapter.ts`) with a fixed official plugin stack; today
 * no `editor.extensions` entry reaches it. This records, for three baseline/target pairs:
 * - `uses`: the ordered `editor.use` descriptors of that instance (the fixed official stack plus Crepe's features);
 * - `pending`: the review groups the projection reports (block ranges);
 * - `controls`: the accept/reject buttons with their labels and disabled state;
 * - `titles`: the read-only toggle/callout titles the adapter adds;
 * - `markdownAfterAcceptAll`: the serialized document once every group is accepted.
 *
 * After the `purpose` / `purposes` contract lands, entries that do not list `'diff'` must leave every field equal.
 * Captured before the migration; the golden is never rewritten.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Editor } from '@milkdown/kit/core';
import type { EditorView } from '@milkdown/prose/view';
import { afterAll, beforeAll, expect, it } from 'vitest';
import i18next from 'i18next';
import { createOfficialDiffAdapter } from '../officialDiffAdapter';

const GOLDEN = 'src/components/crepe/__tests__/__golden__/official-diff.json';
const capture = process.env.W18_CAPTURE_GOLDEN === '1';

const uses: string[] = [];
const realMake = Editor.make;

function describeEditorUse(plugin: unknown): string {
  const list = Array.isArray(plugin) ? plugin.flat(Infinity) : [plugin];
  const names = list.map((item) => {
    const meta = (item as { meta?: { displayName?: string; package?: string } }).meta;
    if (meta?.displayName) return `${meta.package ? `${meta.package}:` : ''}${meta.displayName}`;
    const name = (item as { name?: string }).name;
    return name && name !== 'anonymous' ? name : '·';
  });
  return `${list.length}× ${names.join(' ')}`;
}

beforeAll(async () => {
  await i18next.init({ lng: 'zh-CN', resources: {} });
  // `use` is an instance property on Milkdown's Editor; record every stack the review Crepe assembles.
  Editor.make = function make() {
    const editor = realMake.call(Editor);
    const use = editor.use;
    editor.use = (plugin) => {
      uses.push(describeEditorUse(plugin));
      use.call(editor, plugin);
      return editor;
    };
    return editor;
  };
});
afterAll(() => { Editor.make = realMake; });

const FIXTURES: Array<{ name: string; baseline: string; target: string }> = [
  { name: 'prose', baseline: 'Keep.\n\nRemove.\n\nAnchor.\n\nOld.', target: 'Keep.\n\nAnchor.\n\nNew.' },
  { name: 'table', baseline: '| A | B |\n| - | - |\n| old | $x^2$ |\n\nAnchor.', target: '| A | B |\n| - | - |\n| fresh | $x^3$ |\n\nAnchor.' },
  {
    name: 'toggle-callout',
    baseline: '> [!toggle]- Old title\n>\n> > [!note] Inner old\n\nAnchor.',
    target: '> [!toggle] New title\n>\n> > [!tip] Inner new\n\nAnchor.',
  },
];

it('records the official review projection and its plugin stack', async () => {
  const result: Record<string, unknown> = {};
  for (const fixture of FIXTURES) {
    const root = document.createElement('div');
    document.body.append(root);
    uses.length = 0;
    const adapter = await createOfficialDiffAdapter({
      root,
      baseline: fixture.baseline,
      target: fixture.target,
      onDecision: async () => undefined,
      onError: (error) => { throw error; },
    });
    try {
      const view = adapter.view as EditorView;
      const buttons = (action: 'accept' | 'reject') => Array.from(root.querySelectorAll<HTMLButtonElement>(`.milkdown-diff-${action}`));
      const controls = (['accept', 'reject'] as const).flatMap((action) => buttons(action).map((button) => ({
        action,
        label: button.textContent,
        disabled: button.disabled,
      })));
      const projection = {
        uses: [...uses],
        pending: adapter.pending().map((change) => ({
          fromA: change.fromA, toA: change.toA, fromB: change.fromB, toB: change.toB,
        })),
        controls,
        titles: Array.from(root.querySelectorAll('[data-review-title]')).map((node) => node.textContent),
        markdownAfterAcceptAll: '',
      };
      await adapter.acceptAll();
      projection.markdownAfterAcceptAll = adapter.crepe.getMarkdown();
      expect(view.state.doc.eq(adapter.parse(projection.markdownAfterAcceptAll))).toBe(true);
      result[fixture.name] = projection;
    } finally {
      await adapter.destroy();
      root.remove();
    }
  }
  if (capture) {
    try {
      writeFileSync(GOLDEN, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
    } catch (error) {
      throw new Error(`could not write ${GOLDEN}: ${String(error)}`);
    }
  }
  expect(result).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')));
}, 120_000);
