import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
import agentSkills from '../../agent-skills/index.ts';
import notes from '../index.ts';
import type { SettingRow, SettingsStore } from '../../../platform/settings/api.ts';
import vfsRepos from '../../vfs-repos/index.ts';

function memorySettings(): SettingsStore {
  const values = new Map<string, string>();
  return {
    save(key, value) { values.set(key, value); },
    get(key) { return values.get(key) ?? null; },
    delete(key) { return values.delete(key); },
    listByPrefix(prefix) {
      return [...values]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]): SettingRow => ({ key, value, updatedAt: '' }));
    },
    deleteByPrefix(prefix) {
      const doomed = [...values.keys()].filter((key) => key.startsWith(prefix));
      for (const key of doomed) values.delete(key);
      return doomed.length;
    },
    async saveSecret(key, value) { values.set(key, value); },
    async getSecret(key) { return values.get(key) ?? null; },
    async deleteSecret(key) { return values.delete(key); },
  };
}

describe('notes Agent tool registration', () => {
  it('contributes the three executors through the production notes entry', async () => {
    const host = await createTestHost();
    const storage = createStorageService({
      baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir,
    });
    try {
      await storage.migrations.runAll();
      host.ctx.provide('settings', memorySettings());
      host.ctx.provide('storage', storage);
      await host.install(pathsPlugin, agentSkills, vfsRepos, notes);

      const registered = host.ctx.agentTools.toolExecutors();
      const names = registered.map((executor) => executor.name());
      expect(names).toContain('CanvasToolExecutor');
      expect(names).toContain('UserTodoExecutor');
      expect(names).toContain('NotesImportExecutor');

      const canvas = registered.find((executor) => executor.name() === 'CanvasToolExecutor')!;
      expect(canvas.canHandle('builtin-note_read')).toBe(true);
      expect(canvas.canHandle('builtin-user_todo_create_item')).toBe(false);
      const todo = registered.find((executor) => executor.name() === 'UserTodoExecutor')!;
      expect(todo.canHandle('builtin-user_todo_create_item')).toBe(true);
      expect(todo.canHandle('builtin-notes_import')).toBe(false);
      const importer = registered.find((executor) => executor.name() === 'NotesImportExecutor')!;
      expect(importer.canHandle('builtin-notes_import')).toBe(true);
      expect(importer.canHandle('builtin-note_read')).toBe(false);

      // L04's first-match dispatch (executor_registry.rs::get_executor).
      const dispatch = (toolName: string) =>
        registered.find((executor) => executor.canHandle(toolName))?.name() ?? null;
      expect(dispatch('builtin-note_append')).toBe('CanvasToolExecutor');
      expect(dispatch('builtin-user_todo_list_items')).toBe('UserTodoExecutor');
      expect(dispatch('builtin-notes_import')).toBe('NotesImportExecutor');
      expect(dispatch('builtin-web_search')).toBeNull();
    } finally {
      await host.dispose();
      storage.dispose();
    }
  }, 180000);

  it('V01-07: executors follow the notes and agentTools scopes across unload and reinstall', async () => {
    const host = await createTestHost();
    const storage = createStorageService({
      baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir,
    });
    const NOTES_EXECUTORS = ['CanvasToolExecutor', 'UserTodoExecutor', 'NotesImportExecutor'];
    const notesExecutors = () => host.ctx.agentTools.toolExecutors()
      .map((executor) => executor.name())
      .filter((name) => NOTES_EXECUTORS.includes(name));
    try {
      await storage.migrations.runAll();
      host.ctx.provide('settings', memorySettings());
      host.ctx.provide('storage', storage);
      await host.install(pathsPlugin, agentSkills, vfsRepos, notes);
      expect(notesExecutors()).toEqual(NOTES_EXECUTORS);

      await host.unload('dstu.notes');
      expect(notesExecutors()).toEqual([]);
      await host.install(notes);
      expect(notesExecutors()).toEqual(NOTES_EXECUTORS);

      await host.unload('dstu.agent-skills');
      await host.install(agentSkills);
      expect(notesExecutors()).toEqual(NOTES_EXECUTORS);
    } finally {
      await host.dispose();
      storage.dispose();
    }
  }, 180000);
});
