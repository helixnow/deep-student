import { Crepe } from '@milkdown/crepe';
import { afterEach, describe, expect, it } from 'vitest';

import { applyCrepePlugins } from '../index';

describe('Crepe plugin stack lifecycle', () => {
  const roots: HTMLElement[] = [];

  afterEach(() => {
    roots.splice(0).forEach((root) => root.remove());
  });

  it('creates and destroys an editor with the complete default plugin stack', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    roots.push(root);

    const crepe = new Crepe({ root, defaultValue: '# Integrated editor' });
    applyCrepePlugins(crepe);

    await crepe.create();

    expect(root.querySelector('.ProseMirror')).not.toBeNull();
    expect(crepe.getMarkdown()).toContain('Integrated editor');

    await crepe.destroy();
  }, 5_000);
});
