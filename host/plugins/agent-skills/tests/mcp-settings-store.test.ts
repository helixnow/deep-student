import { describe, expect, it } from 'vitest';
import {
  parseAllowUnapprovedValue, readMcpAllowUnapproved, readMcpToolsList, restoreListSnapshot,
  writeMcpAllowUnapproved, writeMcpToolsList, MCP_ALLOW_UNAPPROVED_KEY, MCP_TOOLS_LIST_KEY,
} from '../src/tools/mcp-settings-store.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';

describe('mcp_settings_store.rs', () => {
  it('restore_list_snapshot_clones_entries', () => {
    const snapshot = [{ id: 'a', name: 'a', nested: { value: 1 } }];
    const restored = restoreListSnapshot(snapshot);
    expect(restored).toHaveLength(1);
    expect((restored[0] as { id: string }).id).toBe('a');
    // `Value` clones deeply; mutating the restored entry must not touch the snapshot.
    (restored[0] as { nested: { value: number } }).nested.value = 2;
    expect(snapshot[0]!.nested.value).toBe(1);
  });

  it('read_mcp_allow_unapproved_defaults_false_and_parses_true_case_insensitive', () => {
    expect(parseAllowUnapprovedValue('true')).toBe(true);
    expect(parseAllowUnapprovedValue('TRUE')).toBe(true);
    expect(parseAllowUnapprovedValue(' True \n')).toBe(true);
    expect(parseAllowUnapprovedValue('false')).toBe(false);
    expect(parseAllowUnapprovedValue('1')).toBe(false);
    expect(parseAllowUnapprovedValue('yes')).toBe(false);
    expect(parseAllowUnapprovedValue('')).toBe(false);
    expect(parseAllowUnapprovedValue(null)).toBe(false);
  });

  it('reads and writes the secure settings keys with exact error prefixes', async () => {
    const values = new Map<string, string>();
    const settings: SettingsStore = {
      save: (key, value) => { values.set(key, value); },
      get: key => values.get(key) ?? null,
      delete: key => values.delete(key),
      listByPrefix: () => [],
      deleteByPrefix: () => 0,
      saveSecret: async (key, value) => { values.set(key, value); },
      getSecret: async key => values.get(key) ?? null,
      deleteSecret: async key => values.delete(key),
    };

    await writeMcpToolsList(settings, [{ id: 'a' }]);
    expect(values.get(MCP_TOOLS_LIST_KEY)).toBe('[{"id":"a"}]');
    expect(await readMcpToolsList(settings)).toEqual([{ id: 'a' }]);

    await writeMcpAllowUnapproved(settings, true);
    expect(values.get(MCP_ALLOW_UNAPPROVED_KEY)).toBe('true');
    expect(await readMcpAllowUnapproved(settings)).toBe(true);

    values.set(MCP_TOOLS_LIST_KEY, 'broken');
    await expect(readMcpToolsList(settings)).rejects.toThrow(
      `failed to parse ${MCP_TOOLS_LIST_KEY} JSON:`,
    );
    values.set(MCP_TOOLS_LIST_KEY, '{}');
    await expect(readMcpToolsList(settings)).rejects.toThrow(
      `${MCP_TOOLS_LIST_KEY} is not a JSON array`,
    );
    values.set(MCP_TOOLS_LIST_KEY, '   ');
    expect(await readMcpToolsList(settings)).toEqual([]);
  });
});
