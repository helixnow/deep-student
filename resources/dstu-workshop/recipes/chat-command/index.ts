// Recipe (Host half): turn a sentence typed in the chat input into a flashcard in the learner's card library.
//
// - pluginModel writes the front / back; ask for JSON and parse it defensively (models add prose or code fences).
// - studyData.cards.create saves the card and, by default, adds it to the review queue.

interface PluginModel { complete(request: { prompt: string; system?: string }, options?: { signal?: AbortSignal }): Promise<{ text: string }> }
interface StudyData { cards: { create(input: { front: string; back: string; tags?: string[] }): Promise<{ id: string; front: string; back: string }> } }

const failure = (message: string) => ({ error_type: 'Unknown', message, details: null });
const reason = (error: unknown) => (error instanceof Error ? error.message : String((error as { message?: unknown } | null)?.message ?? error));

const SYSTEM = '把用户给的知识点做成一张记忆卡片。只输出一个 JSON 对象：{"front": "问题", "back": "答案"}。'
  + '问题要具体、只问一件事；答案简洁准确。不要输出 JSON 以外的任何文字。';

function parseCard(text: string): { front: string; back: string } | null {
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) return null;
  try {
    const value = JSON.parse(match[0]) as { front?: unknown; back?: unknown };
    return typeof value.front === 'string' && typeof value.back === 'string' && value.front.trim() && value.back.trim()
      ? { front: value.front.trim(), back: value.back.trim() } : null;
  } catch {
    return null;
  }
}

export default {
  name: '__PLUGIN_ID__',
  meta: { id: '__PLUGIN_ID__', version: '1.0.0', ui: './ui.js', provides: ['__SERVICE__'], remote: { '__SERVICE__': ['makeCard'] } },
  inject: ['pluginModel', 'studyData'],
  apply(ctx: { provide(name: string, service: unknown): void; pluginModel: PluginModel; studyData: StudyData }) {
    ctx.provide('__SERVICE__', {
      async makeCard(value: unknown, call?: { signal?: AbortSignal }): Promise<{ id: string; front: string; back: string }> {
        const text = typeof value === 'string' ? value.trim() : '';
        if (!text) throw failure('在 /card 后面写上要记住的内容');
        let answer: { text: string };
        try { answer = await ctx.pluginModel.complete({ system: SYSTEM, prompt: text.slice(0, 2000) }, { signal: call?.signal }); }
        catch (error) { throw failure(reason(error)); }
        const card = parseCard(answer.text);
        if (!card) throw failure('模型没有给出卡片，请换个说法再试');
        try { return await ctx.studyData.cards.create({ ...card, tags: ['聊天制卡'] }); }
        catch (error) { throw failure(reason(error)); }
      },
    });
  },
};
