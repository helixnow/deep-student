/**
 * Slash 菜单扩展：callout / toggle 插入路径。
 */

import { Editor, editorViewCtx, rootCtx } from '@milkdown/core';
import { commonmark } from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';
import { describe, expect, it } from 'vitest';

import { calloutPlugin } from '../callout';
import { TOGGLE_TYPE, togglePlugin } from '../toggle';
import {
  appendCalloutToggleSlashItems,
  insertEmptyCallout,
  insertEmptyToggle,
  type SlashGroupBuilder,
} from '../slashMenuExtras';

describe('appendCalloutToggleSlashItems', () => {
  it('adds callout and toggle to existing advanced group', () => {
    const items: Array<{ key: string; label: string }> = [];
    const builder: SlashGroupBuilder = {
      getGroup: (key) => {
        expect(key).toBe('advanced');
        return {
          addItem: (itemKey, item) => {
            items.push({ key: itemKey, label: item.label });
            return undefined;
          },
        };
      },
      addGroup: () => {
        throw new Error('should use existing advanced group');
      },
    };

    appendCalloutToggleSlashItems(builder);

    expect(items.map((i) => i.key)).toEqual(['callout', 'toggle']);
  });

  it('creates advanced group when missing', () => {
    const items: string[] = [];
    let createdKey = '';
    const builder: SlashGroupBuilder = {
      getGroup: () => {
        throw new Error('missing');
      },
      addGroup: (key, _label) => {
        createdKey = key;
        return {
          addItem: (itemKey) => {
            items.push(itemKey);
            return undefined;
          },
        };
      },
    };

    appendCalloutToggleSlashItems(builder);
    expect(createdKey).toBe('advanced');
    expect(items).toEqual(['callout', 'toggle']);
  });
});

describe('slash insert actions', () => {
  async function createEditor() {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const editor = Editor.make();
    editor.config((ctx) => {
      ctx.set(rootCtx, root);
    });
    editor.use(commonmark).use(gfm).use(calloutPlugin()).use(togglePlugin());
    await editor.create();
    return {
      editor,
      destroy: async () => {
        await editor.destroy();
        root.remove();
      },
    };
  }

  it('insertEmptyCallout creates a note callout', async () => {
    const { editor, destroy } = await createEditor();
    try {
      editor.action((ctx) => {
        insertEmptyCallout(ctx);
      });
      const view = editor.ctx.get(editorViewCtx);
      let found: { type: string; title: string } | null = null;
      view.state.doc.descendants((node) => {
        if (node.type.name === 'callout') {
          found = {
            type: String(node.attrs.type),
            title: String(node.attrs.title ?? ''),
          };
        }
      });
      expect(found).toEqual({ type: 'note', title: '' });
    } finally {
      await destroy();
    }
  });

  it('insertEmptyToggle creates an open toggle', async () => {
    const { editor, destroy } = await createEditor();
    try {
      editor.action((ctx) => {
        insertEmptyToggle(ctx);
      });
      const view = editor.ctx.get(editorViewCtx);
      let found: { open: boolean; title: string } | null = null;
      view.state.doc.descendants((node) => {
        if (node.type.name === TOGGLE_TYPE) {
          found = {
            open: Boolean(node.attrs.open),
            title: String(node.attrs.title ?? ''),
          };
        }
      });
      expect(found).toEqual({ open: true, title: '' });
    } finally {
      await destroy();
    }
  });
});
