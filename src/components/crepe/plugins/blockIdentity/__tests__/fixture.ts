import { Crepe } from '@milkdown/crepe';
import { editorViewCtx } from '@milkdown/kit/core';
import { blockIdentityPlugin } from '../index';
import { togglePlugin } from '../../toggle';
import { calloutPlugin } from '../../callout';

export async function identityEditor(markdown: string) {
  const root = document.createElement('div'); document.body.append(root);
  const crepe = new Crepe({ root, defaultValue: markdown, features: {
    [Crepe.Feature.CodeMirror]: false, [Crepe.Feature.Latex]: false,
    [Crepe.Feature.Toolbar]: false, [Crepe.Feature.LinkTooltip]: false,
    [Crepe.Feature.ImageBlock]: false, [Crepe.Feature.BlockEdit]: false,
    [Crepe.Feature.Placeholder]: false,
  } });
  crepe.editor.use(togglePlugin()).use(calloutPlugin()).use(blockIdentityPlugin());
  await crepe.create();
  return { crepe, view: crepe.editor.ctx.get(editorViewCtx), root,
    destroy: async () => { await crepe.destroy(); root.remove(); } };
}
