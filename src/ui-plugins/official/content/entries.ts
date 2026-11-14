import type { SlotEntry } from '@/ui-kernel/slots';
import type { ContentCodeBlockContribution, ContentMenuContribution } from '@/ui-kernel/contracts/content';
import { contentMenuRows } from './menu';
import { mathCodeBlock, latexCodeBlock } from './markdown';

const languageDefinitions = [
  ['mermaid', { kind: 'mermaid' }],
  ['svg', { kind: 'svg' }],
  ['html', { kind: 'html' }],
  ['htm', { kind: 'html' }],
  ['xml', { kind: 'xml' }],
  ['vega-lite', { kind: 'rich', capability: 'charts', richRendererKind: 'vega-lite' }],
  ['vega', { kind: 'rich', capability: 'charts', richRendererKind: 'vega-lite' }],
  ['dot', { kind: 'rich', capability: 'graphviz', richRendererKind: 'dot' }],
  ['abc', { kind: 'rich', capability: 'music', richRendererKind: 'abc' }],
  ['wavedrom', { kind: 'rich', capability: 'timing', richRendererKind: 'wavedrom' }],
  ['mol', { kind: 'rich', capability: 'chemicalFiles', richRendererKind: 'molecule-2d' }],
  ['molfile', { kind: 'rich', capability: 'chemicalFiles', richRendererKind: 'molecule-2d' }],
  ['sdf', { kind: 'rich', capability: 'chemicalFiles', richRendererKind: 'molecule-2d' }],
  ['pdb', { kind: 'rich', capability: 'molecular3d', richRendererKind: 'molecule-3d' }],
  ['geojson', { kind: 'rich', capability: 'geojson', richRendererKind: 'geojson' }],
] as const;

// Stable, synchronous data only. The plugin registers these exact objects;
// lightweight windows read them without a Cordis root or loading any page.
export const officialMarkdownEntries: readonly SlotEntry<ContentCodeBlockContribution>[] = [
  { id: 'codeblock:math', key: 'math', order: 10, owner: 'dstu.ui.content', origin: 'builtin', value: mathCodeBlock },
  { id: 'codeblock:latex', key: 'latex', order: 20, owner: 'dstu.ui.content', origin: 'builtin', value: latexCodeBlock },
  ...languageDefinitions.map(([language, definition], index) => ({
    id: `codeblock:${language}`, key: language, order: (index + 3) * 10,
    owner: 'dstu.ui.content', origin: 'builtin' as const, value: { codeBlock: definition },
  })),
];

export const officialMenuEntries: readonly SlotEntry<ContentMenuContribution>[] = contentMenuRows
  .map(item => ({ id: item.id, order: item.order, owner: 'dstu.ui.content', origin: 'builtin' as const, value: item }))
  .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
