export default {
  name: '__PLUGIN_ID__',
  meta: { id: '__PLUGIN_ID__', version: '1.0.0', ui: './ui.js', provides: ['__SERVICE__'], remote: { '__SERVICE__': ['today'] } },
  apply(ctx: { provide(name: string, service: unknown): void }) {
    ctx.provide('__SERVICE__', { today() { return { word: 'recall', meaning: '回忆；回想' }; } });
  },
};
