import { describe, expect, it } from 'vitest';
import type { SettingRow, SettingsWithConn } from '../../../platform/settings/api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { ChatExecutionContext, ToolResultInfo } from '../../chat/api.ts';
import { SettingsModelsRuntimeExecutor } from '../src/settings_models_tool_runtime.ts';
import { EMPTY_MODEL_ASSIGNMENTS } from '../src/config_store.ts';

const conn = {} as SqlExecutor;
function settingsTable() {
  const rows = new Map<string, string>();
  const seenConns: SqlExecutor[] = [];
  const settings: SettingsWithConn = {
    getWithConn: (db, key) => { seenConns.push(db); return rows.get(key) ?? null; },
    saveWithConn: (db, key, value) => { seenConns.push(db); rows.set(key, value); },
    deleteWithConn: (_db, key) => rows.delete(key),
    listByPrefixWithConn: (db, prefix): SettingRow[] => { seenConns.push(db);
      return [...rows].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value, updatedAt: 't' })); },
    deleteByPrefixWithConn: () => 0,
  };
  return { rows, seenConns, settings };
}

function chatContext(overrides: { main_db?: SqlExecutor | null; llm_manager?: object | null }) {
  const trace: unknown[] = [];
  const blocks: ToolResultInfo[] = [];
  const context = {
    block_id: 'blk_settings', main_db: overrides.main_db ?? null, llm_manager: overrides.llm_manager ?? null,
    emitToolCallStart: (name: string, args: unknown, id: string | null) => trace.push(['start', name, args, id]),
    emitToolCallEnd: (payload: unknown) => trace.push(['end', payload]),
    emitToolCallError: (error: string) => trace.push(['error', error]),
    saveToolBlock: (result: ToolResultInfo) => blocks.push(result),
  } as unknown as ChatExecutionContext;
  return { context, trace, blocks };
}

function runtime(table: ReturnType<typeof settingsTable>, events: [string, unknown][]) {
  return new SettingsModelsRuntimeExecutor({
    settings: table.settings,
    manager: { getApiConfigs: async () => [], getVendorConfigs: async () => [], getModelProfiles: async () => [],
      getModelAssignments: async () => ({ ...EMPTY_MODEL_ASSIGNMENTS }), saveVendorModelConfigs: async () => {} },
    voiceInput: { isAsrModel: () => false, asrProviderSupported: () => true },
    emit: (event, payload) => { events.push([event, payload]); },
    warn: () => {},
  });
}

describe('SettingsModelsRuntimeExecutor (chat tool runtime binding)', () => {
  it('keeps the Rust executor identity, routing and sensitivity', () => {
    const executor = runtime(settingsTable(), []);
    expect(executor.name()).toBe('SettingsModelsToolExecutor');
    expect(['builtin-settings_get', 'settings_set', 'mcp_model_profile_add'].map(name => executor.canHandle(name)))
      .toEqual([true, true, true]);
    expect(executor.canHandle('builtin-settings_delete')).toBe(false);
    expect(['builtin-model_profile_add', 'builtin-settings_set', 'builtin-model_assignments_get']
      .map(name => executor.sensitivityLevel(name))).toEqual(['high', 'medium', 'low']);
    expect(executor.concurrencyClass('builtin-model_assignments_get')).toBe('read_only');
  });

  it('writes through the call\'s main_db connection and emits the change app-wide', async () => {
    const table = settingsTable(), events: [string, unknown][] = [];
    const { context, blocks } = chatContext({ main_db: conn });
    const result = await runtime(table, events).execute({ id: 'call_s', name: 'builtin-settings_set',
      arguments: { key: 'theme', value: 'dark' } }, context);
    expect(result).toMatchObject({ success: true, blockId: 'blk_settings', toolCallId: 'call_s',
      output: { key: 'theme', value: 'dark', previous_value: null, changed: true, event_emitted: true } });
    expect(table.rows.get('theme')).toBe('dark');
    expect(table.seenConns.every(db => db === conn)).toBe(true);
    expect(events).toEqual([['chat_v2://settings_changed', { action: 'set', key: 'theme' }]]);
    expect(blocks).toEqual([result]);
  });

  it('reports DEPENDENCY_UNAVAILABLE when the call carries no main_db or llm_manager (Rust Option::None)', async () => {
    const table = settingsTable();
    const noDb = chatContext({ main_db: null, llm_manager: {} });
    const settings = await runtime(table, []).execute({ id: 'c1', name: 'builtin-settings_get', arguments: { prefix: 'theme' } }, noDb.context);
    expect(settings).toMatchObject({ success: false, output: null });
    expect(JSON.parse(settings.error!)).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', message: 'The settings database is unavailable.' });
    const noLlm = chatContext({ main_db: conn, llm_manager: null });
    const models = await runtime(table, []).execute({ id: 'c2', name: 'builtin-model_assignments_get', arguments: {} }, noLlm.context);
    expect(JSON.parse(models.error!)).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', message: 'The model manager is unavailable.' });
    expect(noLlm.trace.at(-1)).toEqual(['error', models.error]);
  });
});
