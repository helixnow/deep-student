// Recipe (Host half): an automation. Every evening it reads the notes the learner changed today, asks the model for a
// short summary, saves the summary as a new note and sends a system notification that opens the plugin's view.
//
// - Declare every service in package.json permissions ("service:studyData", "service:pluginSchedule",
//   "service:pluginNotify", "service:pluginModel") and inject them here.
// - pluginSchedule.daily(id, 'HH:MM', run) runs in the Host even when no window shows the plugin. A run missed while
//   the app was closed happens once on the next start (run.catchUp is true). Jobs are cancelled when the plugin
//   unloads; a job that throws is logged and runs again next time.
// - studyData reads and writes the learner's own notes (and cards, questions, review, todos, resources).
// - pluginNotify.notify({ title, body, view }) shows a system notification; clicking it opens `view` (an id the UI
//   half registered with ctx.ui.views.register).
// - Expose what the UI half needs through meta.remote: here the last summary and a "run now" method.

interface StudyNote { id: string; title: string; updatedAt: string }
interface StudyNoteWithContent extends StudyNote { content: string }
interface StudyData {
  notes: {
    list(options?: { updatedSince?: string; limit?: number }): Promise<StudyNote[]>;
    get(id: string): Promise<StudyNoteWithContent | null>;
    create(input: { title: string; content?: string; tags?: string[] }): Promise<StudyNoteWithContent>;
  };
}
interface JobRun { catchUp: boolean; signal: AbortSignal }
interface PluginSchedule { daily(id: string, time: string, run: (run: JobRun) => unknown): () => void }
interface PluginNotify { notify(input: { title: string; body: string; view?: string }): Promise<{ delivered: boolean }> }
interface PluginModel { complete(request: { prompt: string; system?: string }, options?: { signal?: AbortSignal }): Promise<{ text: string }> }

export interface Summary { noteId: string; title: string; text: string; notes: number; at: string }

/** An expected failure, in the shape the Host passes to the UI half unchanged. */
const failure = (message: string) => ({ error_type: 'Unknown', message, details: null });
const reason = (error: unknown) => (error instanceof Error ? error.message : String((error as { message?: unknown } | null)?.message ?? error));

const SYSTEM = '你是学习教练。根据学生今天写或改过的笔记，用中文写一份简短的学习总结：先一句话概括今天学了什么，'
  + '再列出 3–5 个要点（每条一行，以「- 」开头），最后给一条明天的复习建议。只根据笔记内容，不要编造。';

function startOfToday(): Date {
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  return day;
}

export default {
  name: '__PLUGIN_ID__',
  meta: { id: '__PLUGIN_ID__', version: '1.0.0', ui: './ui.js', provides: ['__SERVICE__'], remote: { '__SERVICE__': ['latest', 'runNow'] } },
  inject: ['studyData', 'pluginSchedule', 'pluginNotify', 'pluginModel'],
  apply(ctx: {
    provide(name: string, service: unknown): void;
    studyData: StudyData; pluginSchedule: PluginSchedule; pluginNotify: PluginNotify; pluginModel: PluginModel;
  }) {
    let latest: Summary | null = null;

    async function summarize(signal?: AbortSignal): Promise<Summary | null> {
      const today = startOfToday();
      const changed = (await ctx.studyData.notes.list({ updatedSince: today.toISOString(), limit: 30 }))
        .filter(note => !note.title.startsWith('学习总结'));
      if (!changed.length) return null;
      const parts: string[] = [];
      for (const note of changed.slice(0, 12)) {
        const full = await ctx.studyData.notes.get(note.id);
        if (full) parts.push(`## ${full.title}\n${full.content.slice(0, 600)}`);
      }
      const answer = await ctx.pluginModel.complete({ system: SYSTEM, prompt: parts.join('\n\n').slice(0, 7000) }, { signal });
      const date = today.toLocaleDateString('zh-CN');
      const note = await ctx.studyData.notes.create({ title: `学习总结 ${date}`, content: answer.text, tags: ['学习总结'] });
      latest = { noteId: note.id, title: note.title, text: answer.text, notes: changed.length, at: new Date().toISOString() };
      await ctx.pluginNotify.notify({ title: '今天的学习总结写好了', body: `整理了 ${changed.length} 篇笔记，点开查看`, view: 'summary' });
      return latest;
    }

    ctx.pluginSchedule.daily('nightly-summary', '22:00', run => summarize(run.signal));

    ctx.provide('__SERVICE__', {
      latest(): Summary | null { return latest; },
      async runNow(call?: { signal?: AbortSignal }): Promise<Summary | null> {
        try { return await summarize(call?.signal); }
        catch (error) { throw failure(reason(error)); }
      },
    });
  },
};
