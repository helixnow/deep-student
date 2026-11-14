// An ordinary HostPlugin. No second runtime, commands or profile mutation.
export default {
  name: '__PLUGIN_ID__',
  meta: { id: '__PLUGIN_ID__', version: '1.0.0', provides: ['__SERVICE__'], remote: { '__SERVICE__': ['review'] } },
  apply(ctx: { provide(name: string, service: unknown): void }) {
    ctx.provide('__SERVICE__', {
      review(words: string[]) { return words.map(word => ({ word, prompt: `Recall: ${word}` })); },
    });
  },
};
