// Recipe (Host half): explain a passage selected in the PDF reader, and keep the explanation as a note.
//
// - The UI half sends the selected text plus the page and document title (from the pdf.selectionToolbar context).
// - pluginModel.complete asks the user's own dialogue model; studyData.notes.create writes into the learner's notes.
// - Reject with a plain { error_type, message, details } object for failures the user can fix or retry.

interface PluginModel { complete(request: { prompt: string; system?: string }, options?: { signal?: AbortSignal }): Promise<{ text: string }> }
interface StudyData { notes: { create(input: { title: string; content?: string; tags?: string[] }): Promise<{ id: string; title: string }> } }

export interface Passage { text: string; page?: number; documentTitle?: string }

const failure = (message: string) => ({ error_type: 'Unknown', message, details: null });
const reason = (error: unknown) => (error instanceof Error ? error.message : String((error as { message?: unknown } | null)?.message ?? error));

const SYSTEM = '你是耐心的老师。用中文、面向高中生讲清楚下面这段教材原文：先用一两句话说它的意思，'
  + '再解释其中的关键概念，必要时举一个简单的例子。不超过 250 字，不要复述原文。';

function cleanPassage(value: unknown): Passage {
  const passage = (value ?? {}) as Partial<Passage>;
  const text = typeof passage.text === 'string' ? passage.text.replace(/\s+/g, ' ').trim() : '';
  if (!text) throw failure('没有选中文字');
  return {
    text: text.slice(0, 3000),
    ...(typeof passage.page === 'number' ? { page: passage.page } : {}),
    ...(typeof passage.documentTitle === 'string' ? { documentTitle: passage.documentTitle } : {}),
  };
}

export default {
  name: '__PLUGIN_ID__',
  meta: { id: '__PLUGIN_ID__', version: '1.0.0', ui: './ui.js', provides: ['__SERVICE__'], remote: { '__SERVICE__': ['explain', 'save'] } },
  inject: ['pluginModel', 'studyData'],
  apply(ctx: { provide(name: string, service: unknown): void; pluginModel: PluginModel; studyData: StudyData }) {
    ctx.provide('__SERVICE__', {
      async explain(value: unknown, call?: { signal?: AbortSignal }): Promise<{ text: string }> {
        const passage = cleanPassage(value);
        try { return { text: (await ctx.pluginModel.complete({ system: SYSTEM, prompt: passage.text }, { signal: call?.signal })).text.trim() }; }
        catch (error) { throw failure(reason(error)); }
      },
      async save(value: unknown, explanation: unknown): Promise<{ noteId: string }> {
        const passage = cleanPassage(value);
        const source = [passage.documentTitle, passage.page ? `第 ${passage.page} 页` : ''].filter(Boolean).join(' · ');
        const content = `> ${passage.text}\n\n${typeof explanation === 'string' ? explanation : ''}${source ? `\n\n来源：${source}` : ''}`;
        try {
          const note = await ctx.studyData.notes.create({ title: `讲解：${passage.text.slice(0, 20)}`, content, tags: ['PDF 讲解'] });
          return { noteId: note.id };
        } catch (error) { throw failure(reason(error)); }
      },
    });
  },
};
