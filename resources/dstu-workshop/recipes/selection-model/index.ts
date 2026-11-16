// Recipe (Host half): let the UI half ask the user's configured dialogue model for a short text.
//
// - Declare "service:pluginModel" in package.json permissions and inject it here. It is the only model entry for
//   plugins: one prompt in, one text out, on the model the user configured. No keys, no provider settings.
// - Expose one method to the UI half through meta.remote. The Host appends { signal } as the last argument.
// - Keep the prompt small (limit 8000 characters) and say exactly what shape you want back.
// - Reject with a plain { error_type, message, details } object for failures the user can fix or retry (no model
//   configured, provider error): the UI half shows `message`, and the Host does not log it as an internal crash.

interface PluginModel {
  complete(request: { prompt: string; system?: string }, options?: { signal?: AbortSignal }): Promise<{ text: string }>;
}

/** An expected failure, in the shape the Host passes to the UI half unchanged. */
const failure = (message: string) => ({ error_type: 'Unknown', message, details: null });
const reason = (error: unknown) => (error instanceof Error ? error.message : String((error as { message?: unknown } | null)?.message ?? error));

const SYSTEM = [
  '你是帮学生记忆的助手。把用户给的一段话编成一首顺口的口诀：',
  '恰好四句，每句七个字左右，押韵，保留原文的关键词，不要编造原文没有的内容。',
  '只输出这四句，每句一行，不要标题、编号、解释或引号。',
].join('');

export default {
  name: '__PLUGIN_ID__',
  meta: { id: '__PLUGIN_ID__', version: '1.0.0', ui: './ui.js', provides: ['__SERVICE__'], remote: { '__SERVICE__': ['mnemonic'] } },
  inject: ['pluginModel'],
  apply(ctx: { provide(name: string, service: unknown): void; pluginModel: PluginModel }) {
    ctx.provide('__SERVICE__', {
      async mnemonic(text: unknown, call?: { signal?: AbortSignal }) {
        const selected = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
        if (!selected) throw failure('没有选中文字');
        let answer: { text: string };
        try { answer = await ctx.pluginModel.complete({ system: SYSTEM, prompt: selected.slice(0, 2000) }, { signal: call?.signal }); }
        catch (error) { throw failure(reason(error)); }
        const lines = answer.text.split(/\r?\n/).map(line => line.replace(/^[\s\d.、·*-]+/, '').trim()).filter(Boolean).slice(0, 4);
        if (!lines.length) throw failure('模型没有给出内容，请再试一次');
        return { lines };
      },
    });
  },
};
