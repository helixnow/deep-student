import { createTimer, type MilkdownPlugin } from '@milkdown/ctx';
import { nodesCtx, schemaTimerCtx, remarkPluginsCtx, parserCtx, prosePluginsCtx, SchemaReady } from '@milkdown/kit/core';
import { Fragment, Slice, type Node as ProseNode } from '@milkdown/prose/model';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import { BLOCK_ID_ATTR, BLOCK_ID_PATTERN, blockMarker, newBlockId, remarkBlockIdentity } from './markdown';
import { handleBlockLinkClick } from './links';
import { normalizeMarkdown } from '../../normalizeMarkdown';

export * from './markdown';
export * from './links';

export const blockIdentityKey = new PluginKey<boolean>('dsBlockIdentity');
const hasRootIdentity = (doc: ProseNode) => {
  let found = false;
  doc.forEach(node => { if (node.attrs[BLOCK_ID_ATTR]) found = true; });
  return found;
};

/** Copy creates new identities; nested nodes never advertise stable addresses. */
export function copyBlockWithFreshIdentity(node: ProseNode, root = true): ProseNode {
  if (node.isText) return node;
  const children: ProseNode[] = [];
  node.forEach(child => children.push(copyBlockWithFreshIdentity(child, false)));
  return node.type.create({ ...node.attrs,
    ...(BLOCK_ID_ATTR in node.attrs ? { [BLOCK_ID_ATTR]: root && node.attrs[BLOCK_ID_ATTR] ? newBlockId() : null } : {}),
  }, Fragment.fromArray(children), node.marks);
}

/** Extend the actual registered schema after its own dependencies have settled. */
function identitySchema(): MilkdownPlugin {
  const ready = createTimer('BlockIdentitySchemaReady');
  return ctx => {
    ctx.record(ready);
    ctx.update(schemaTimerCtx, timers => [...timers, ready]);
    return async () => {
      await Promise.all(ctx.get(schemaTimerCtx).filter(timer => timer !== ready).map(timer => ctx.wait(timer)));
      ctx.update(remarkPluginsCtx, plugins => [...plugins, { plugin: remarkBlockIdentity, options: undefined }]);
      ctx.update(nodesCtx, nodes => nodes.map(([name, spec]): (typeof nodes)[number] => {
        if (name === 'doc') return [name, { ...spec,
          parseMarkdown: { ...spec.parseMarkdown, runner(state, node, type) {
            state.openNode(type);
            for (const child of node.children ?? []) {
              const parent = state.top()!;
              const before = parent.content.length;
              state.next(child);
              const id = child[BLOCK_ID_ATTR];
              if (!id) continue;
              if (parent.content.length !== before + 1) throw new Error('Identity block did not parse as one node.');
              const parsed = parent.pop()!;
              if (!(BLOCK_ID_ATTR in parsed.attrs)) throw new Error('Unsupported identity block schema.');
              parent.push(parsed.type.create({ ...parsed.attrs, [BLOCK_ID_ATTR]: id }, parsed.content, parsed.marks));
            }
          } },
          toMarkdown: { ...spec.toMarkdown, runner(state, node) {
            state.openNode('root');
            const seen = new Set<string>();
            node.forEach(child => {
              const id = child.attrs[BLOCK_ID_ATTR];
              if (id) {
                if (seen.has(id)) throw new Error(`Duplicate block ID: ${id}`);
                seen.add(id);
                state.addNode('html', undefined, blockMarker(id));
              }
              if (id && child.type.name === 'paragraph' && !child.content.size) state.addNode('html', undefined, '<br />');
              else state.next(child);
            });
          } },
        }];
        if (!spec.group?.split(' ').includes('block')) return [name, spec];
        return [name, { ...spec, attrs: { ...spec.attrs, [BLOCK_ID_ATTR]: { default: null } },
          toDOM: spec.toDOM ? (node) => {
            const dom = spec.toDOM!(node);
            if (!node.attrs[BLOCK_ID_ATTR] || !Array.isArray(dom)) return dom;
            const [tag, attrs, ...rest] = dom;
            const data = { 'data-ds-block-id': node.attrs[BLOCK_ID_ATTR] };
            return attrs && typeof attrs === 'object' && !Array.isArray(attrs) && !(attrs instanceof window.Node)
              ? [tag, { ...attrs, ...data }, ...rest] : [tag, data, ...dom.slice(1)];
          } : undefined,
          parseDOM: spec.parseDOM?.map(rule => 'tag' in rule ? { ...rule, getAttrs(dom) {
            const attrs = rule.getAttrs ? rule.getAttrs(dom) : rule.attrs ?? {};
            if (attrs === false) return false;
            const id = typeof dom === 'string' ? null : dom.getAttribute('data-ds-block-id');
            return { ...attrs, [BLOCK_ID_ATTR]: id && BLOCK_ID_PATTERN.test(id) ? id : null };
          } } : rule),
        }];
      }));
      ctx.done(ready);
      return () => { ctx.clearTimer(ready); };
    };
  };
}

export function blockIdentityPlugin() {
  const behavior: MilkdownPlugin = ctx => async () => {
    await ctx.wait(SchemaReady);
    const plugin = new Plugin({
    key: blockIdentityKey,
    state: {
      init: (_config, state) => hasRootIdentity(state.doc),
      apply: (tr, enabled) => tr.getMeta(blockIdentityKey) ?? (enabled || hasRootIdentity(tr.doc)),
    },
    props: {
      handleDOMEvents: { click: handleBlockLinkClick },
      handlePaste(view, event) {
        const data = event.clipboardData;
        if (!view.editable || !data || data.getData('text/html') || view.state.selection.$from.parent.type.spec.code) return false;
        const text = data.getData('text/plain');
        if (!text.includes('<!-- ds:block-id=')) return false;
        try {
          normalizeMarkdown(ctx, text);
          const parsed = ctx.get(parserCtx)(text);
          if (!parsed) return true;
          const nodes: ProseNode[] = [];
          parsed.forEach(node => nodes.push(copyBlockWithFreshIdentity(node, Boolean(blockIdentityKey.getState(view.state)))));
          view.dispatch(view.state.tr.replaceSelection(Slice.maxOpen(Fragment.fromArray(nodes))).setMeta('uiEvent', 'paste'));
        } catch { /* Reject malformed/colliding imports without altering the document. */ }
        return true;
      },
      transformPasted(slice, view) {
        if (view.dragging?.move) return slice;
        const nodes: ProseNode[] = [];
        // A clipboard paste must not bypass the explicit whole-note format upgrade
        // (or generate metadata for an unknown/unloaded legacy suffix).
        slice.content.forEach(node => nodes.push(copyBlockWithFreshIdentity(node, Boolean(blockIdentityKey.getState(view.state)))));
        return new Slice(Fragment.fromArray(nodes), slice.openStart, slice.openEnd);
      },
    },
    appendTransaction(transactions, _old, state) {
      if (!transactions.some(tr => tr.docChanged)) return null;
      const seen = new Set<string>();
      const tr = state.tr;
      state.doc.descendants((node, pos, parent) => {
        const id = node.attrs[BLOCK_ID_ATTR];
        const root = parent === state.doc;
        if (!id) {
          // After an explicit whole-note upgrade, user-created root blocks join the
          // existing envelope. The unpersisted empty trailing paragraph is not a block.
          if (root && blockIdentityKey.getState(state) && BLOCK_ID_ATTR in node.attrs
            && !(node === state.doc.lastChild && node.type.name === 'paragraph' && !node.content.size)) {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, [BLOCK_ID_ATTR]: newBlockId() });
          }
          return;
        }
        if (!root || seen.has(id)) tr.setNodeMarkup(pos, undefined, {
          ...node.attrs, [BLOCK_ID_ATTR]: root ? newBlockId() : null,
        });
        if (root) seen.add(id);
      });
      return tr.docChanged ? tr : null;
    },
    });
    ctx.update(prosePluginsCtx, plugins => [plugin, ...plugins]);
    return () => { ctx.update(prosePluginsCtx, plugins => plugins.filter(entry => entry !== plugin)); };
  };
  return [identitySchema(), behavior];
}
