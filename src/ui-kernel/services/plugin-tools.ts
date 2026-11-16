/**
 * Titles of the agent tools that community / workshop plugins declare (`deepStudent.agentTools`,
 * docs/plugins/SDK.md §3.4). The Host lists them per plugin in the v2 UI manifest; chat surfaces (tool chips,
 * approval cards) read the title here instead of showing the generated `plugin_<digest>_<name>` name.
 *
 * Titles of tools seen earlier are kept (also across restarts) so a conversation recorded before a plugin was
 * disabled or removed still reads the same.
 */
const STORAGE_KEY = 'ds:plugin-agent-tool-titles';
const MAX_REMEMBERED = 200;
const NAME_PATTERN = /^plugin_[0-9a-f]{12}_([a-z][a-z0-9_]{1,31})$/;

let remembered: Map<string, string> | undefined;

function load(): Map<string, string> {
  if (remembered) return remembered;
  remembered = new Map();
  try {
    const stored = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? '{}') as Record<string, unknown>;
    for (const [name, title] of Object.entries(stored)) {
      if (NAME_PATTERN.test(name) && typeof title === 'string' && title) remembered.set(name, title);
    }
  } catch (error) {
    console.warn('[ui-kernel] stored plugin tool titles are unreadable; starting empty', error);
  }
  return remembered;
}

/** Whether `name` has the shape the Host gives plugin tools (it may belong to a plugin that is gone). */
export function isPluginAgentToolName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

/** The plugin-local part of a plugin tool name (`plugin_<digest>_lookup_timetable` → `lookup_timetable`). */
export function pluginAgentToolLocalName(name: string): string | undefined {
  return NAME_PATTERN.exec(name)?.[1];
}

/** The declared title of a plugin tool, when this renderer has seen it. */
export function pluginAgentToolTitle(name: string): string | undefined {
  return load().get(name);
}

/** Record the tools of the plugins in a v2 manifest. Entries that are not well formed are ignored. */
export function recordPluginAgentTools(plugins: readonly { agentTools?: readonly { name: string; title: string }[] }[]): void {
  const titles = load();
  let changed = false;
  for (const plugin of plugins) {
    for (const tool of plugin.agentTools ?? []) {
      if (typeof tool?.name !== 'string' || typeof tool.title !== 'string' || !tool.title || !NAME_PATTERN.test(tool.name)) continue;
      if (titles.get(tool.name) === tool.title) continue;
      // Re-insert so the most recently seen names survive the cap.
      titles.delete(tool.name);
      titles.set(tool.name, tool.title);
      changed = true;
    }
  }
  if (!changed) return;
  while (titles.size > MAX_REMEMBERED) titles.delete(titles.keys().next().value!);
  try { globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(titles))); }
  catch (error) { console.warn('[ui-kernel] plugin tool titles could not be stored', error); }
}

/** Test hook: forget everything, including the stored copy. */
export function resetPluginAgentToolsForTest(): void {
  remembered = new Map();
  try { globalThis.localStorage?.removeItem(STORAGE_KEY); }
  catch (error) { console.warn('[ui-kernel] plugin tool titles could not be cleared', error); }
}
